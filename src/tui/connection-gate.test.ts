/**
 * 连接门 —— 「先试上次那台，不行才摆屏」这条启动顺序。
 *
 * 这一组用假屏 + 假探活钉住六件只能靠读代码确认的事：
 *
 *   1. 首启不探活：没配过的时候一次 I/O 都不做（探活会在没有显式地址时拉起本地宿主，
 *      等于首启装一个宿主，而用户根本没做过这个决定）；
 *   2. 探通了不写盘：启动时探的那一份本来就是上次记住的（或是命令行临时给的），再写一次
 *      是空转，而命令行那份写下去会改掉用户默认连的机器；
 *   3. 本机一律走下载屏（阶段与真原因只有那块屏说得清），远程一次都不走它；
 *   4. 屏上选完才写盘，而且只在连上之后写（连不上就不留一个已知是错的配置）；
 *   5. 本机折回：下载屏上按 `Esc` / 拉不起来 → 带着原因回连接屏，改走远程仍然能落盘；
 *   6. 退出就是不连（`ok: false`），没有悄悄降级成本地这一支。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { settleConnection } from "./connection-gate.js";
import type { ShowConnectScreen, ShowHostDownloadScreen } from "./connection-gate.js";
import type { ConnectionSettings, HostLaunchStage } from "../server-client/index.js";
import type { ConnectHostOptions, ProbeResult } from "../connection.js";
import { connectionFile, readConnectPlan } from "../connection.js";
import type { CliEnv } from "../env.js";
import type { ConnectScreenResult } from "./screens/connect.js";
import type { HostDownloadScreenResult } from "./screens/host-download.js";

const LOCAL: ConnectionSettings = { mode: "local" };
/** 远端那一份：地址与凭证的字段名照 `settings.ts`（`url` / `token`），不是旧的 `serverUrl` */
const REMOTE: ConnectionSettings = { mode: "remote", url: "wss://ai-zen.example.com" };

let env: CliEnv;
let dirs: string[] = [];

/** 每个用例一个临时数据根：写盘那几条会真的落盘，共用一个目录会互相看见 */
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "aiz-gate-"));
  dirs.push(dir);
  env = { aiZenDir: dir };
});

/** 用例结束收掉临时目录（写盘那几条留了 `connection.json`） */
const cleanup = () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
};

/** 一个按剧本回答的假连接屏：记下宿主递进来的上下文，返回给定的结局 */
function fakeConnectScreen(outcomes: ConnectScreenResult[]) {
  const seen: Parameters<ShowConnectScreen>[0][] = [];
  const screen: ShowConnectScreen = async (input) => {
    seen.push(input);
    const next = outcomes.shift();
    if (!next) throw new Error("假连接屏没有更多剧本了（宿主弹屏次数超出预期）");
    return next;
  };
  return { screen, seen };
}

/** 一个按剧本回答的假下载屏 */
function fakeDownloadScreen(outcomes: HostDownloadScreenResult[]) {
  const seen: Parameters<ShowHostDownloadScreen>[0][] = [];
  const screen: ShowHostDownloadScreen = async (input) => {
    seen.push(input);
    const next = outcomes.shift();
    if (!next) throw new Error("假下载屏没有更多剧本了（宿主弹屏次数超出预期）");
    return next;
  };
  return { screen, seen };
}

/** 「一次都不该弹」的屏：远程那条路上下载屏不该出现，首启那条路上两块屏的次序也不该乱 */
const neverShown = async (): Promise<never> => {
  throw new Error("这块屏不该被弹出");
};

/** 一条探活：按剧本回答，记下递下去的那份设置 */
function fakeProbe(answer: () => ProbeResult) {
  const seen: ConnectHostOptions[] = [];
  const probe = async (options: ConnectHostOptions): Promise<ProbeResult> => {
    seen.push(options);
    return answer();
  };
  return { probe, seen };
}

describe("配过（远程）：先试上次那台", () => {
  it("探通 → 直接继续，**不弹屏、不写盘、不走下载屏**", async () => {
    const saves: ConnectionSettings[] = [];
    const screen = fakeConnectScreen([]); // 一次都不该弹
    const { probe, seen } = fakeProbe(() => ({ ok: true }));

    const result = await settleConnection({
      initial: REMOTE,
      env,
      showConnectScreen: screen.screen,
      showHostDownloadScreen: neverShown,
      probe,
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result).toEqual({ ok: true, settings: REMOTE });
    // 探活拿到的就是「这次的事实 + 上次那一份」：连接层按它连，不在这里另拼一套
    expect(seen).toEqual([{ env, settings: REMOTE }]);
    expect(screen.seen).toHaveLength(0);
    expect(saves).toHaveLength(0);
    cleanup();
  });

  it("探不通 → 弹一次屏，把**原因**与**上次那份**一起递进去", async () => {
    const screen = fakeConnectScreen([{ kind: "exit" }]);

    const result = await settleConnection({
      initial: REMOTE,
      env,
      showConnectScreen: screen.screen,
      showHostDownloadScreen: neverShown,
      probe: async () => ({ ok: false, message: "连不上 wss://ai-zen.example.com" }),
      save: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(screen.seen).toHaveLength(1);
    expect(screen.seen[0]!.reason).toContain("连不上");
    expect(screen.seen[0]!.initial).toEqual(REMOTE);
    cleanup();
  });
});

describe("配过（本机）：交给下载屏", () => {
  it("宿主本来就在跑 → 下载屏报连上、直接用这份，**不写盘、不弹连接屏**", async () => {
    const saves: ConnectionSettings[] = [];
    const download = fakeDownloadScreen([{ kind: "connected" }]);
    const connectScreen = fakeConnectScreen([]);

    const result = await settleConnection({
      initial: LOCAL,
      env,
      showConnectScreen: connectScreen.screen,
      showHostDownloadScreen: download.screen,
      probe: async () => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result).toEqual({ ok: true, settings: LOCAL });
    expect(download.seen).toHaveLength(1);
    expect(connectScreen.seen).toHaveLength(0);
    expect(saves).toHaveLength(0);
    cleanup();
  });

  it("阶段与取消的手柄原样递给探活（下载屏就靠这两个）", async () => {
    const stages: HostLaunchStage[] = [];
    const controller = new AbortController();
    const { probe, seen } = fakeProbe(() => ({ ok: true }));

    const result = await settleConnection({
      initial: LOCAL,
      env,
      showConnectScreen: neverShown,
      showHostDownloadScreen: async (input) => {
        const reason = await input.connect({
          onStage: (stage) => stages.push(stage),
          signal: controller.signal,
        });
        expect(reason).toBeNull();
        return { kind: "connected" };
      },
      probe,
      save: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(typeof seen[0]!.onStage).toBe("function");
    expect(seen[0]!.signal).toBe(controller.signal);
    // 假探活不报阶段：这条只验「手柄递下去了」；阶段顺序是连接层的用例管的
    expect(stages).toEqual([]);
    cleanup();
  });

  it("拉不起来、用户在下载屏上折回 → 带原因回连接屏；改走远程仍能落盘", async () => {
    const saves: ConnectionSettings[] = [];
    const download = fakeDownloadScreen([{ kind: "fallback", reason: "npm error 404 not found" }]);
    const connectScreen = fakeConnectScreen([{ kind: "connected", settings: REMOTE }]);

    const result = await settleConnection({
      initial: LOCAL,
      env,
      showConnectScreen: connectScreen.screen,
      showHostDownloadScreen: download.screen,
      probe: async () => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result).toEqual({ ok: true, settings: REMOTE });
    // 折回时那句真原因带到了连接屏上（用户要知道「本机这条路为什么不行」）
    expect(connectScreen.seen[0]!.reason).toBe("npm error 404 not found");
    expect(saves).toEqual([REMOTE]);
    cleanup();
  });
});

describe("首启：不探活，直接摆屏", () => {
  it("一次探活都不做（否则会悄悄拉起一个本地宿主）", async () => {
    const screen = fakeConnectScreen([{ kind: "exit" }]);
    const { probe, seen } = fakeProbe(() => ({ ok: true }));

    const result = await settleConnection({
      initial: null,
      env,
      showConnectScreen: screen.screen,
      showHostDownloadScreen: neverShown,
      probe,
      save: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
    // 首启形态：没有原因，也没有可预填的东西
    expect(screen.seen[0]!.reason).toBeUndefined();
    expect(screen.seen[0]!.initial).toBeNull();
    cleanup();
  });
});

describe("开场就摆屏（openWith）：`/shutdown` 关掉宿主之后", () => {
  /**
   * 关掉宿主之后回到门里，不能先试一次：本机那条路上「试」就是 `ensureHost` ——
   * 它会当场再拉起一个宿主，把用户刚才那一下抵消掉（关了又开，等于没关）。
   */
  it("本机：一次探活都不做，直接把「宿主已关闭」当原因摆屏", async () => {
    const screen = fakeConnectScreen([{ kind: "exit" }]);
    const { probe, seen } = fakeProbe(() => ({ ok: true }));

    const result = await settleConnection({
      initial: LOCAL,
      env,
      openWith: { reason: "宿主已关闭" },
      showConnectScreen: screen.screen,
      showHostDownloadScreen: neverShown,
      probe,
      save: async () => {},
    });

    expect(result.ok).toBe(false);
    // 探活与下载屏都不该被碰到（下载屏就是「拉起一个」）
    expect(seen).toHaveLength(0);
    expect(screen.seen).toHaveLength(1);
    expect(screen.seen[0]!.reason).toBe("宿主已关闭");
    // 预填仍是上次那份：用户很可能就在这台机器上重新拉起一台
    expect(screen.seen[0]!.initial).toEqual(LOCAL);
    cleanup();
  });

  it("屏上重新选本机并拉起来 → 照旧走下载屏并写盘", async () => {
    const saves: ConnectionSettings[] = [];
    const download = fakeDownloadScreen([{ kind: "connected" }]);
    const screen = fakeConnectScreen([{ kind: "chosen", settings: LOCAL }]);

    const result = await settleConnection({
      initial: LOCAL,
      env,
      openWith: { reason: "宿主已关闭" },
      showConnectScreen: screen.screen,
      showHostDownloadScreen: download.screen,
      probe: async () => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result).toEqual({ ok: true, settings: LOCAL });
    expect(download.seen).toHaveLength(1);
    expect(saves).toEqual([LOCAL]);
    cleanup();
  });
});

describe("屏上选完：连上了才写盘", () => {
  it("远程：屏里验过（connect 返回 null）→ 写盘一次，带着用户选的那份继续", async () => {
    const saves: ConnectionSettings[] = [];
    const screen = fakeConnectScreen([{ kind: "connected", settings: REMOTE }]);

    const result = await settleConnection({
      initial: null,
      env,
      showConnectScreen: async (input) => {
        // 模拟屏里的「提交并测试」：宿主给的 connect 返回 null 表示通了
        expect(await input.connect(REMOTE)).toBeNull();
        return screen.screen(input);
      },
      showHostDownloadScreen: neverShown,
      probe: async () => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result).toEqual({ ok: true, settings: REMOTE });
    expect(saves).toEqual([REMOTE]);
    cleanup();
  });

  it("本机：屏上只选定（chosen）→ 下载屏拉起来之后才写盘", async () => {
    const saves: ConnectionSettings[] = [];
    const download = fakeDownloadScreen([{ kind: "connected" }]);

    const result = await settleConnection({
      initial: null,
      env,
      showConnectScreen: async () => ({ kind: "chosen", settings: LOCAL }),
      showHostDownloadScreen: download.screen,
      probe: async () => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result).toEqual({ ok: true, settings: LOCAL });
    expect(download.seen).toHaveLength(1);
    expect(saves).toEqual([LOCAL]);
    cleanup();
  });

  it("本机又失败了一次 → 再摆一次连接屏，预填的是**刚选的那份**（不是盘上那份）", async () => {
    const connectScreen = fakeConnectScreen([
      { kind: "chosen", settings: LOCAL },
      { kind: "exit" },
    ]);
    const download = fakeDownloadScreen([{ kind: "fallback", reason: "拉不起来" }]);

    const result = await settleConnection({
      initial: null,
      env,
      showConnectScreen: connectScreen.screen,
      showHostDownloadScreen: download.screen,
      probe: async () => ({ ok: true }),
      save: async () => {},
    });

    expect(result.ok).toBe(false);
    // 本机只拉了一次：第二次选的就是「退出」
    expect(download.seen).toHaveLength(1);
    expect(connectScreen.seen).toHaveLength(2);
    expect(connectScreen.seen[1]!.initial).toEqual(LOCAL);
    expect(connectScreen.seen[1]!.reason).toBe("拉不起来");
    cleanup();
  });

  it("远程没验通（connect 返回原因）→ 不写盘（宿主也就不会走到写盘那一步）", async () => {
    const saves: ConnectionSettings[] = [];
    const screen = fakeConnectScreen([{ kind: "exit" }]);

    const result = await settleConnection({
      initial: null,
      env,
      showConnectScreen: async (input) => {
        expect(await input.connect(REMOTE)).toContain("连不上");
        return screen.screen(input);
      },
      showHostDownloadScreen: neverShown,
      probe: async () => ({ ok: false, message: "连不上 wss://ai-zen.example.com" }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result.ok).toBe(false);
    expect(saves).toHaveLength(0);
    cleanup();
  });

  /**
   * 真写一份：探活是假件，但落盘走缺省实现（`saveConnectPlan` → `writeSettings`）。
   *
   * 这条盖的是接缝本身 —— `<aiZenDir>/cli/connection.json` 的路径由 `connectionFile` 决定，
   * 而「屏上选的那一份原样落盘、再读回来还是它」只有真写一次才验得到。
   */
  it("落盘走缺省实现：盘上那一份读回来与屏上选的一致", async () => {
    const chosen: ConnectionSettings = {
      mode: "remote",
      url: "ws://127.0.0.1:8790",
      token: "token-from-screen",
    };

    const result = await settleConnection({
      initial: null,
      env,
      showConnectScreen: async (input) => {
        expect(await input.connect(chosen)).toBeNull();
        return { kind: "connected", settings: chosen };
      },
      showHostDownloadScreen: neverShown,
      probe: async () => ({ ok: true }),
    });

    expect(result).toEqual({ ok: true, settings: chosen });
    const stored = JSON.parse(readFileSync(connectionFile(env), "utf-8")) as unknown;
    expect(stored).toEqual(chosen);
    // 再读一遍：这一份就是下一次启动会去试的那一份
    await expect(readConnectPlan(env)).resolves.toEqual(chosen);
    cleanup();
  });
});
