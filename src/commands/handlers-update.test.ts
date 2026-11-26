// `/upgrade` —— 客户端那一半：查发布标签 → 挑最高的一版 → 跟正在跑的那版比 → 交给宿主（PRD 3.8 / 2.3，
// `trd/host-infrastructure.md` 的三段分工）。
//
// ## 这一组用例钉的是需求，不是实现
//
// | 需求 | 用例 |
// |---|---|
// | 在所有发布标签里挑版本最高的（alpha 比 latest 新时选 alpha） | 「有新版本」那条断言递上去的是 alpha |
// | 不比宿主正在跑的那版新就不告诉它 | 「已是最新」那条 |
// | 告诉宿主的是**确切版本号**，且只有这一格 | 「有新版本」那条的入参断言 |
// | 回执到了才回连接屏，句子用回执里的那一版 | 「有新版本」那条的 `exit` 断言 |
// | 宿主回 `not_available`（这一版 registry 上没有）时原话上屏、不回连接屏 | 「宿主拒绝」那条 |
// | 客户端不再预下、不再记版本（pin 归宿主） | 「一次 npx 都不跑」「本机没有 host-version.json」 |
// | 逐步骤报进度（PRD 3.8） | 「逐步骤报进度」那条 |
// | 调宿主之前问一次，三件事说清（目标版本 / 宿主做哪一半 / 会踢掉谁） | 「调宿主之前先问一句」那三条 |
// | 选「否」时一次 `host.upgrade` 都没有 | 「选「否」」那条 |
//
// ## npm 一次都不真跑、一次盘都不碰
//
// `ChatCommandHost.runNpm` 是注入口（与 `notice` / `api` 同一个路子）：这里的假实现只按 argv
// 回答，于是「查发布标签」在 CI 里不连 registry。安装那一步已经不在客户端了，所以这里没有
// npx 的位置 —— 真跑起来的那一半（`npx -y <pkg>@<pin> serve`）是启动方式的事。
import { existsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand, type ChatCommandHost } from "./handlers.js";
import type { ChatSessionLike, HostConnection } from "../session/types.js";
import type { NpmCli, RunNpm } from "../npm.js";
import { setLocale, t } from "../i18n/index.js";
import { STAGE_TEXT } from "../host-stage.js";
import { hostVersionFile } from "../host-version.js";
import { useTempAiZenDir } from "../test-support/temp-dir.js";
import { QUIET_LOG } from "../test-support/log.js";

const zen = useTempAiZenDir("aiz-upgrade-");
afterAll(() => zen.cleanup());

beforeEach(() => {
  // 每条用例都从「中文 + 干净的数据根」开始（句子按界面语言取）
  zen.pin();
  setLocale("zh");
});

const HOST_PKG = "@ai-zen/agents-host";
/** 正在跑的宿主版本 */
const CURRENT = "1.0.0-alpha.2";
/** registry 上比它新的那一版（发布常态：alpha 比 latest 新） */
const NEWER = "1.1.0-alpha.3";
/** registry 上比它旧的那一格（`latest`） */
const OLDER = "0.9.0";

/** 一次 procedure 调用的记录 */
interface CallRecord {
  method: string;
  params: Record<string, unknown>;
}

/** 一次 npm 调用的记录（argv 原样） */
interface NpmCall {
  cli: NpmCli;
  args: string[];
}

/** 这一幕剧本：谁怎么答 */
interface Scenario {
  /** `npm view … dist-tags` 的 stdout（对象或原样字符串） */
  distTags?: Record<string, string> | string;
  /** `npm view` 的退出码（非 0 = registry 连不上 / npm 不可用） */
  tagsStatus?: number;
  /** 宿主此刻跑的版本（`host.version`），缺省 {@link CURRENT} */
  hostVersion?: string;
  /** `host.upgrade` 回执里的版本（缺省 = 递上去的那一版） */
  upgradedVersion?: string;
  /** `host.upgrade` 的拒绝原话（宿主渲染好的人话）；给了就当它报错 */
  upgradeError?: string;
}

/** 假的 npm：只回答 `npm view`，别的命令行一次都不跑 */
function fakeNpm(scenario: Scenario, calls: NpmCall[]): RunNpm {
  return async (cli, args) => {
    calls.push({ cli, args });
    const status = scenario.tagsStatus ?? 0;
    if (status !== 0) return { code: status, stdout: "", stderr: "npm error code EAI_AGAIN" };
    const tags = scenario.distTags ?? { latest: OLDER, alpha: NEWER };
    const stdout = typeof tags === "string" ? tags : JSON.stringify(tags);
    return { code: 0, stdout, stderr: "" };
  };
}

function createHost(scenario: Scenario = {}) {
  const notices: Array<{ text: string; tone?: string }> = [];
  const calls: CallRecord[] = [];
  const npmCalls: NpmCall[] = [];
  const hostVersion = scenario.hostVersion ?? CURRENT;

  // 这一条命令只碰两条 procedure：`host.version`（现在跑的是哪一版）与 `host.upgrade`（换过去）
  const api = {
    host: {
      version: {
        query: async () => {
          calls.push({ method: "host.version", params: {} });
          return { version: hostVersion };
        },
      },
      upgrade: {
        mutate: async (params: { version: string }) => {
          calls.push({ method: "host.upgrade", params });
          if (scenario.upgradeError !== undefined) throw new Error(scenario.upgradeError);
          return { version: scenario.upgradedVersion ?? params.version, restarting: true as const };
        },
      },
    },
  } as unknown as ChatCommandHost["api"];

  const host: ChatCommandHost = {
    session: {
      agentId: "default",
      sessionId: "sess-1",
      workspaceId: "ws-1",
      messages: [],
    } as unknown as ChatSessionLike,
    api,
    // 这一条命令不该再走旧路：真被调到就当场红
    call: (() => {
      throw new Error("/upgrade 不该再走 call");
    }) as unknown as HostConnection["call"],
    // 这条命令不碰工作区，但接口上它是必填的（「这台宿主是不是本机」是连接的事实）
    workspaceHost: { local: true, key: "local" },
    // 这条命令不写本机记忆，但接口上它是必填的（日志出口从参数上递）
    logger: QUIET_LOG,
    notice: (text, tone) => notices.push({ text, tone }),
    clearTranscript: vi.fn(),
    exit: vi.fn(),
    suspendTerminal: async (fn: () => void | Promise<void>) => {
      await fn();
    },
    openWizard: vi.fn(async () => {}),
    openKeyEditor: vi.fn(async () => {}),
    ensureKey: vi.fn(async () => true),
    doExit: vi.fn(async () => {}),
    // 缺省「问就答是」：没有单独安排的用例走的是「确认之后交给宿主」那一路。
    // 要验「否」与「问什么」的用例自己换一个（`capturePick`）。
    pick: vi.fn(async () => "yes"),
    askForm: vi.fn(async () => ({ action: "cancel" as const })),
    newSession: vi.fn(async () => "conv-new"),
    liveSessions: [],
    // 这条命令不删会话，但接口上它是必填的（`/delete` 那一手动登记表的口子）
    dropSession: vi.fn(),
    // 同上：`/delete` / `/ws delete` 真删之前报个名（这条命令不碰它们）
    expectOwnRemoval: () => () => {},
    setInputText: vi.fn(),
    setEffortView: vi.fn(),
    refreshLocale: vi.fn(),
    runNpm: fakeNpm(scenario, npmCalls),
  };
  return {
    host,
    notices,
    calls,
    npmCalls,
    text: () => notices.map((notice) => notice.text).join("\n"),
    errors: () => notices.filter((notice) => notice.tone === "error"),
  };
}

describe("/upgrade：已经是最新的就不告诉宿主", () => {
  it("registry 上没有比正在跑的那版更高的标签：只报一句，不问宿主也不重启", async () => {
    const { host, notices, calls, npmCalls, errors } = createHost({
      // 两个 tag 都不比 CURRENT 新
      distTags: { latest: OLDER, alpha: CURRENT },
      hostVersion: CURRENT,
    });

    await runCommand("upgrade", "/upgrade", host);

    // 只查了一次 registry、问了一次宿主版本；`host.upgrade` 一次都没调
    expect(npmCalls.map((call) => call.cli)).toEqual(["npm"]);
    expect(calls.map((call) => call.method)).toEqual(["host.version"]);
    expect(host.exit).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
    // 客户端不再记版本：pin 归宿主（`<数据根>/run/next-version.json`），本机这一格没人写
    expect(existsSync(hostVersionFile(zen.dir))).toBe(false);
    expect(notices.at(-1)).toEqual({
      text: t("cmd.upgrade.newest", { version: CURRENT }),
      tone: "info",
    });
  });
});

describe("/upgrade：有新版本 → 告诉宿主 → 回连接屏", () => {
  it("挑全部标签里最高的那个（alpha 比 latest 新时选 alpha），把确切版本递上去，回执到了才回连接屏", async () => {
    const { host, calls, npmCalls, errors } = createHost({
      distTags: { latest: OLDER, alpha: NEWER },
      hostVersion: CURRENT,
    });

    await runCommand("upgrade", "/upgrade", host);

    // 查：带 `--prefer-online`（不加会被 npm 的元数据缓存把「有新版」读成「已是最新」）
    const view = npmCalls[0]!;
    expect(view.cli).toBe("npm");
    expect(view.args.slice(0, 2)).toEqual(["view", HOST_PKG]);
    expect(view.args).toContain("dist-tags");
    expect(view.args).toContain("--json");
    expect(view.args).toContain("--prefer-online");

    // 交：入参只有确切版本号这一格（不递范围、不递 tag）
    expect(calls).toEqual([
      { method: "host.version", params: {} },
      { method: "host.upgrade", params: { version: NEWER } },
    ]);

    // 回了 `restarting` 就回连接屏（宿主马上要退出，留着只会看到一串重连失败）
    expect(host.exit).toHaveBeenCalledWith({
      backToConnect: t("cmd.upgrade.backToConnect", { version: NEWER }),
    });
    expect(errors()).toEqual([]);
    // 一次 npx 都不跑（预下那一步已经不在客户端了），本机也不记版本
    expect(npmCalls.filter((call) => call.cli === "npx")).toEqual([]);
    expect(existsSync(hostVersionFile(zen.dir))).toBe(false);
  });

  it("上屏那句话用回执里的版本（宿主写下 pin 的那一版），不是自己打算递的那个字符串", async () => {
    const { host } = createHost({
      hostVersion: CURRENT,
      // 宿主归一过之后回了一个不同的号：屏幕上该相信它
      upgradedVersion: "1.1.0",
    });

    await runCommand("upgrade", "/upgrade", host);

    expect(host.exit).toHaveBeenCalledWith({
      backToConnect: t("cmd.upgrade.backToConnect", { version: "1.1.0" }),
    });
  });

  it("逐步骤报进度：查询 → 发现 → 交给宿主，一条不少（PRD 3.8）", async () => {
    const { host, notices } = createHost({ hostVersion: CURRENT });

    await runCommand("upgrade", "/upgrade", host);

    expect(notices.map((notice) => notice.text)).toEqual([
      t(STAGE_TEXT.resolving),
      t("cmd.upgrade.found", { current: CURRENT, target: NEWER }),
      t("cmd.upgrade.handoff", { version: NEWER }),
    ]);
  });
});

/**
 * 调宿主之前的那一次确认（PRD 3.8「逐步骤显示进度；装完确认再重启」）。
 *
 * 装包与拉起归启动方式之后，客户端看不见「装完」那一刻，于是确认只能落在交之前 —— 而且只许
 * 问此刻真知道的事：目标是哪一版（对着正在跑的哪一版）、宿主做哪一半、这台机器上还有谁会被
 * 断开。
 */
describe("/upgrade：调宿主之前先问一句", () => {
  /** 接管选择器：记下标题与两个选项，并立即作答 */
  function capturePick(host: ChatCommandHost, answer: string | null) {
    const seen = { title: "", labels: [] as string[], values: [] as string[], times: 0 };
    host.pick = async (title, items) => {
      seen.times += 1;
      seen.title = title;
      seen.labels = items.map((item) => item.label);
      seen.values = items.map((item) => item.value);
      return answer;
    };
    return seen;
  }

  it("那一句三件事都说到：目标版本对着当前版本、宿主验完就退出、同机其他客户端也断开", async () => {
    const { host } = createHost({ hostVersion: CURRENT });
    const seen = capturePick(host, "no");

    await runCommand("upgrade", "/upgrade", host);

    // 两档（是 / 否），与 `/shutdown` 同一个交互形状
    expect(seen.times).toBe(1);
    expect(seen.values).toEqual(["yes", "no"]);
    expect(seen.labels).toEqual([t("cmd.upgrade.confirm"), t("cmd.upgrade.cancel")]);
    // ① 目标是哪一版，对着正在跑的哪一版
    expect(seen.title).toContain(NEWER);
    expect(seen.title).toContain(CURRENT);
    // ② 宿主做哪一半（验完退出），装包与拉起归启动方式 —— 用的是 `host-stage.ts` 那两句文案
    expect(seen.title).toContain(t(STAGE_TEXT.installing));
    expect(seen.title).toContain(t(STAGE_TEXT.starting));
    // ③ 会踢掉谁：一台机器一个宿主，同机其他客户端一起断
    expect(seen.title).toContain("其他客户端");
  });

  it("选「否」：一次 `host.upgrade` 都没有，不回连接屏，只说一句没有升级", async () => {
    const { host, calls, notices } = createHost({ hostVersion: CURRENT });
    capturePick(host, "no");

    await runCommand("upgrade", "/upgrade", host);

    // 问到这一步就停：读版本读过（那一步是为了说出目标对着哪一版），写一次都没有
    expect(calls.map((call) => call.method)).toEqual(["host.version"]);
    expect(calls.filter((call) => call.method === "host.upgrade")).toEqual([]);
    expect(host.exit).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({
      text: t("cmd.upgrade.cancelled", { current: CURRENT }),
      tone: "info",
    });
  });

  it("Esc / 覆盖层被关掉（回 null）：与选「否」同一支，`host.upgrade` 一次都没调", async () => {
    const { host, calls } = createHost({ hostVersion: CURRENT });
    capturePick(host, null);

    await runCommand("upgrade", "/upgrade", host);

    expect(calls.map((call) => call.method)).toEqual(["host.version"]);
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("选「是」之后才调 `host.upgrade`（顺序：先问、后交）", async () => {
    const { host, calls } = createHost({ hostVersion: CURRENT });
    const seen = capturePick(host, "yes");

    await runCommand("upgrade", "/upgrade", host);

    expect(seen.times).toBe(1);
    expect(calls).toEqual([
      { method: "host.version", params: {} },
      { method: "host.upgrade", params: { version: NEWER } },
    ]);
    expect(host.exit).toHaveBeenCalledWith({
      backToConnect: t("cmd.upgrade.backToConnect", { version: NEWER }),
    });
  });
});

describe("/upgrade：两个失败各有各的人话（不静默、不假装成功）", () => {
  it("查不到 registry（npm 报错）：不问宿主，按错误语气说清", async () => {
    const { host, npmCalls, errors } = createHost({ tagsStatus: 1 });

    await runCommand("upgrade", "/upgrade", host);

    expect(npmCalls.map((call) => call.cli)).toEqual(["npm"]);
    expect(errors()).toEqual([
      { text: t("cmd.upgrade.tagsFailed", { pkg: HOST_PKG }), tone: "error" },
    ]);
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("宿主回 not_available（这一版 registry 上没有）：原话上屏、不回连接屏（服务还在跑）", async () => {
    const rejection = "拿不到 1.1.0-alpha.3 这一版（registry 上没有）";
    const { host, calls, errors } = createHost({
      hostVersion: CURRENT,
      upgradeError: rejection,
    });

    await runCommand("upgrade", "/upgrade", host);

    // 没重试：只递了一次
    expect(calls.filter((call) => call.method === "host.upgrade")).toHaveLength(1);
    expect(errors()).toEqual([
      {
        text: t("cmd.upgrade.rejected", {
          version: NEWER,
          error: rejection,
          current: CURRENT,
        }),
        tone: "error",
      },
    ]);
    // 宿主把「这一版不存在」挡在了弄死服务之前：它还在跑，这一屏也还连得上
    expect(host.exit).not.toHaveBeenCalled();
  });
});
