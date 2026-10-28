// `/update`：从 registry 的**全部 dist-tag** 里挑最新的版本装上，装完按全局目录里的
// 实际版本判断要不要提示重启。
//
// 不打真机：所有子进程调用一律走 `spawnSync` 打桩（真跑 `npm i -g` 会覆盖用户机器上的
// 全局安装），全局安装目录用临时目录伪造。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** 每次 spawnSync 的入参，供断言 */
  spawns: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: string, args: string[] = []) => {
      state.spawns.push({ cmd, args });
      if (args[0] === "root") return { stdout: state.root, status: 0 };
      if (args[0] === "view") return { stdout: state.distTags, status: state.tagsStatus };
      return { status: state.installStatus, error: state.installError };
    },
  };
});

/** 造一个假的全局安装目录：`<root>/@ai-zen/cli/package.json` */
function fakeGlobalInstall(root: string, version: string): void {
  const dir = join(root, "@ai-zen", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ai-zen/cli", version }), "utf-8");
}

function createHost() {
  const notices: Array<{ text: string; tone?: "info" | "error" }> = [];
  const host = {
    session: { messages: [], agentId: "default", modelId: "m1" } as unknown as ChatSession,
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
    setPickerState: vi.fn(),
    setConfirmState: vi.fn(),
    setInputText: vi.fn(),
    setEffortView: vi.fn(),
    refreshLocale: vi.fn(),
  } as unknown as ChatCommandHost;
  const installs = () =>
    state.spawns.filter((s) => s.args[0] === "install").map((s) => s.args.join(" "));
  return { host, notices, installs, text: () => notices.map((n) => n.text).join("\n") };
}

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aizen-update-"));
  state.root = root;
  state.distTags = JSON.stringify({ latest: "0.9.0", alpha: "1.0.0-alpha.99" });
  state.tagsStatus = 0;
  state.installStatus = 0;
  state.installError = undefined;
  state.spawns = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("/update：装最新版（不区分 alpha / 正式版）", () => {
  it("alpha 比 latest 新时选 alpha，并报告 旧 → 新 + 重启提示", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    const { host, notices, installs, text } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()).toEqual(["install -g @ai-zen/cli@1.0.0-alpha.99"]);
    expect(text()).toContain("1.0.0-alpha.99");
    expect(text()).toContain(CLI_VERSION);
    // 最后一条是重启提示：进程里跑的还是旧代码
    expect(notices.at(-1)!.text).toContain(CLI_VERSION);
    expect(notices.every((n) => n.tone !== "error")).toBe(true);
  });

  it("正式版追上之后反过来选正式版", async () => {
    state.distTags = JSON.stringify({ latest: "9.9.9", alpha: "1.0.0-alpha.99" });
    fakeGlobalInstall(root, "9.9.9");
    const { host, installs } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()).toEqual(["install -g @ai-zen/cli@9.9.9"]);
  });

  it("registry 上没有比当前更新的版本：只报「已是最新」，不装也不催重启", async () => {
    state.distTags = JSON.stringify({ latest: "0.9.0" }); // 比当前运行的 alpha 旧
    const { host, notices, installs, text } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(text()).toContain(CLI_VERSION);
  });

  it("安装失败：error 语气上报，且不提「重启生效」", async () => {
    fakeGlobalInstall(root, "1.0.0-alpha.99");
    state.installStatus = 1;
    const { host, notices, text } = createHost();

    await runCommand("update", "/update", host);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.tone).toBe("error");
    expect(text()).toContain("exit 1");
  });

  it("npm 不存在（spawn 报错）：把错误原样报出来", async () => {
    state.installError = new Error("spawnSync npm ENOENT");
    const { host, notices, text } = createHost();

    await runCommand("update", "/update", host);

    expect(notices[0]!.tone).toBe("error");
    expect(text()).toContain("ENOENT");
  });

  it("dist-tags 查不到（npm 报错 / 输出不是 JSON）：不装，直接报错", async () => {
    state.tagsStatus = 1;
    const { host, notices, installs } = createHost();

    await runCommand("update", "/update", host);

    expect(installs()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.tone).toBe("error");
  });
});
