// `/update`：从 registry 的**全部 dist-tag** 里挑最新的版本装上，装完按全局目录里的
// 实际版本判断装成了没，再问一句要不要重启生效。
//
// 不打真机：所有子进程调用一律打桩（真跑 `npm i -g` 会覆盖用户机器上的全局安装），
// 全局安装目录用临时目录伪造。
//
// `/update` 的 npm 调用是**异步** `spawn`（`spawnSync` 会把事件循环钉死、动画停摆），
// 所以这里的桩要造一个「下一 tick 才发事件」的假 child，贴近真实 spawn 的语义。
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import { t } from "../../i18n/index.js";
import { CLI_VERSION } from "../../version.js";
import { runCommand, type ChatCommandHost } from "./chat-commands.js";
import type { ChatSession } from "../chat-session.js";

const state = vi.hoisted(() => ({
  /** `npm view <pkg> dist-tags --json` 的 stdout */
  distTags: "",
  /** dist-tags 查询的退出码 */
  tagsStatus: 0,
  /** `npm root -g` 的返回值（全局安装目录） */
  root: "",
  /** 安装命令的退出码 */
  installStatus: 0,
  /** 安装命令的 spawn 错误（模拟 npm 不存在） */
  installError: undefined as Error | undefined,
  /** 每次 spawn 的入参，供断言 */
  spawns: [] as Array<{ cmd: string; args: string[] }>,
}));

/** 造一个假 child：下一次微任务才发 data / close，等价于真实 spawn 的异步时序 */
function fakeChild(opts: { stdout?: string; code?: number | null; error?: Error } = {}) {
  const child = new EventEmitter() as any;
  const stdout = new EventEmitter() as any;
  child.stdout = stdout;
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    if (opts.stdout) stdout.emit("data", opts.stdout);
    child.emit("close", opts.code ?? 0);
  });
  return child;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // 其余命令（`/editor` 等）仍走同步版，保持原桩
    spawnSync: () => ({ stdout: "", status: 0 }),
    spawn: (cmd: string, args: string[] = []) => {
      state.spawns.push({ cmd, args });
      if (args[0] === "root") return fakeChild({ stdout: state.root });
      if (args[0] === "view") return fakeChild({ stdout: state.distTags, code: state.tagsStatus });
      return fakeChild({ code: state.installStatus, error: state.installError });
    },
  };
});

/** 造一个假的全局安装目录：`<root>/@ai-zen/cli/package.json` */
function fakeGlobalInstall(root: string, version: string): void {
  const dir = join(root, "@ai-zen", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ai-zen/cli", version }), "utf-8");
}

function createHost(options: { confirmAnswer?: boolean; withHistory?: boolean } = {}) {
  const { confirmAnswer = true, withHistory = true } = options;
  const notices: Array<{ text: string; tone?: "info" | "error" }> = [];
  const confirms: string[] = [];
  const restarts = { count: 0 };
  const saves = { count: 0 };
  const host = {
    session: {
      messages: withHistory
        ? [{ role: AgentNS.Role.User, content: "hi" }]
        : [{ role: AgentNS.Role.Assistant, content: "yo" }],
      agentId: "default",
      modelId: "m1",
      save: async () => {
        saves.count += 1;
        return "conv-id";
      },
    } as unknown as ChatSession,
    notice: (text: string, tone?: "info" | "error") => notices.push({ text, tone }),
    clearTranscript: vi.fn(),
    rows: 24,
    exit: vi.fn(),
    suspendTerminal: async (fn: () => void | Promise<void>) => {
      await fn();
    },
    openWizard: vi.fn(async () => {}),
    openKeyEditor: vi.fn(async () => {}),
    doExit: vi.fn(async () => {}),
    restartProcess: async () => {
      restarts.count += 1;
    },
    setPickerState: vi.fn(),
    // 真实宿主是同一次函数式更新里「关覆盖层 + 结算 Promise」，这里直接结算
    setConfirmState: (update: any) => {
      const request = typeof update === "function" ? update(null) : update;
      if (!request) return;
      confirms.push(request.question);
      request.resolve(confirmAnswer);
    },
    setInputText: vi.fn(),
    setEffortView: vi.fn(),
    refreshLocale: vi.fn(),
  } as unknown as ChatCommandHost;
  const installs = () =>
    state.spawns.filter((s) => s.args[0] === "install").map((s) => s.args.join(" "));
  const quoted = (name: string) =>
    state.spawns.find((s) => s.args[0] === name)?.args.join(" ") ?? "";
  return {
    host,
    notices,
    confirms,
    restarts,
    saves,
    installs,
    quoted,
    text: () => notices.map((n) => n.text).join("\n"),
  };
}

let root = "";
/** 安装前打到真实终端的那段头部（`process.stdout.write`），测试里收进变量 */
let terminalOut = "";
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aizen-update-"));
  state.root = root;
  state.distTags = JSON.stringify({ latest: "0.9.0", alpha: "1.0.0-alpha.99" });
  state.tagsStatus = 0;
  state.installStatus = 0;
  state.installError = undefined;
  state.spawns = [];
  terminalOut = "";
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    terminalOut += String(chunk);
    return true;
  });
});
afterEach(() => {
  writeSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("/update：装最新版（不区分 alpha / 正式版）", () => {
  it("alpha 比 latest 新时选 alpha，报告 旧 → 新，确认后重启", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    const { host, notices, confirms, restarts, saves, installs, text } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()).toEqual([
      "install -g @ai-zen/cli@1.0.0-alpha.99 --prefer-online --no-fund",
    ]);
    expect(text()).toContain("1.0.0-alpha.99");
    expect(text()).toContain(CLI_VERSION);
    expect(notices.every((n) => n.tone !== "error")).toBe(true);
    // 装完先问一句，再重启；重启前把当前对话落盘
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("1.0.0-alpha.99");
    expect(saves.count).toBe(1);
    expect(restarts.count).toBe(1);
  });

  it("拒绝重启：不重启、仍提示手动重启，但对话照样已落盘", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    const { host, notices, restarts, saves, text } = createHost({ confirmAnswer: false });

    await runCommand("update", "/update", host);

    expect(restarts.count).toBe(0);
    expect(saves.count).toBe(0);
    // 最后一句是「重启 ai 后生效」（用 t() 比对，不绑死语言）
    expect(notices.at(-1)!.text).toBe(t("cmd.update.restart", { current: CLI_VERSION }));
  });

  it("刚开的新会话（无用户消息）不落盘，避免留下空会话文件", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    const { host, saves, restarts } = createHost({ withHistory: false });

    await runCommand("update", "/update", host);

    expect(saves.count).toBe(0);
    // 但重启照做
    expect(restarts.count).toBe(1);
  });

  it("正式版追上之后反过来选正式版", async () => {
    state.distTags = JSON.stringify({ latest: "9.9.9", alpha: "1.0.0-alpha.99" });
    fakeGlobalInstall(root, "9.9.9");
    const { host, installs } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()[0]).toContain("@ai-zen/cli@9.9.9");
  });

  it("registry 上没有比当前更新的版本：只报「已是最新」，不装也不催重启", async () => {
    state.distTags = JSON.stringify({ latest: "0.9.0" }); // 比当前运行的 alpha 旧
    const { host, notices, confirms, restarts, installs, text } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()).toEqual([]);
    expect(confirms).toEqual([]);
    expect(restarts.count).toBe(0);
    expect(notices).toHaveLength(2); // 「正在查询」+「已是最新」
    expect(text()).toContain(CLI_VERSION);
  });

  it("安装失败：error 语气上报，且不弹确认框、不提重启", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    state.installStatus = 1;
    const { host, notices, confirms, restarts, text } = createHost();

    await runCommand("update", "/update", host);

    const errors = notices.filter((n) => n.tone === "error");
    expect(errors).toHaveLength(1);
    expect(text()).toContain("exit 1");
    expect(confirms).toEqual([]);
    expect(restarts.count).toBe(0);
  });

  it("npm 不存在（spawn 报错）：把错误原样报出来", async () => {
    state.installError = new Error("spawn npm ENOENT");
    const { host, notices, restarts, text } = createHost();

    await runCommand("update", "/update", host);

    expect(notices.some((n) => n.tone === "error")).toBe(true);
    expect(text()).toContain("ENOENT");
    expect(restarts.count).toBe(0);
  });

  it("dist-tags 查不到（npm 报错 / 输出不是 JSON）：不装，直接报错", async () => {
    state.tagsStatus = 1;
    const { host, notices, installs } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()).toEqual([]);
    expect(notices.some((n) => n.tone === "error")).toBe(true);
  });
});

describe("/update：过程信息（不再只有一个转圈）", () => {
  it("依次报出「查询 → 发现 → 装好」，而不是等装完才吭声", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    const { host, notices, text } = createHost();

    await runCommand("update", "/update", host);

    expect(notices).toHaveLength(3);
    expect(notices[0]!.text).toBe(t("cmd.update.checking", { pkg: "@ai-zen/cli" }));
    expect(notices[1]!.text).toContain("1.0.0-alpha.99");
    expect(notices[2]!.text).toContain("✅");
    expect(text()).toContain(CLI_VERSION);
  });

  it("移交终端前先打出「装什么 / 装到哪 / 跑什么命令」", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    const { host } = createHost();

    await runCommand("update", "/update", host);

    expect(terminalOut).toContain("@ai-zen/cli@1.0.0-alpha.99");
    expect(terminalOut).toContain(root);
    expect(terminalOut).toContain("--prefer-online");
  });

  it("查询带上 --prefer-online：避免 npm 元数据缓存把「有新版」读成「已是最新」", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    const { host, quoted } = createHost();

    await runCommand("update", "/update", host);

    expect(quoted("view")).toContain("--prefer-online");
  });
});
