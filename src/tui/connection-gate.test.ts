/**
 * 连接门 —— 「先试上次那台，不行才摆屏」这条启动顺序。
 *
 * 这一组用假屏 + 假探活把四件只能靠读代码确认的事咬死：
 *
 *   1. **首启不探活**：没配过的时候一次 I/O 都不做（探活会在没有显式地址时**拉起**本地服务端
 *      —— 首启悄悄装一个服务端，用户根本没做过这个决定）；
 *   2. **探通了不写盘**：启动时探的那一份本来就是上次记住的（或是命令行临时给的），再写一次
 *      是空转，而命令行那份写下去会改掉用户默认连的机器；
 *   3. **屏上选完才写盘**，而且只在**连上之后**写（连不上就不留一个已知是错的配置）；
 *   4. **退出就是不连**（`ok: false`），没有「悄悄降级成本地」这一支。
 */

import { describe, expect, it } from "vitest";
import { settleConnection } from "./connection-gate.js";
import type { ShowConnectScreen } from "./connection-gate.js";
import type { ConnectionSettings } from "../server-client/index.js";
import type { ConnectPlan, ProbeResult } from "../connection.js";
import type { CliEnv } from "../env.js";

const LOCAL: ConnectionSettings = { mode: "local" };
const REMOTE: ConnectionSettings = { mode: "remote", serverUrl: "wss://ai-zen.example.com" };

const env: CliEnv = { aiZenDir: "/tmp/aiz-gate-test" };

/** 一个按剧本回答的假屏：记下宿主递进来的上下文，返回给定的结局 */
function fakeScreen(outcomes: Awaited<ReturnType<ShowConnectScreen>>[]) {
  const seen: Parameters<ShowConnectScreen>[0][] = [];
  const screen: ShowConnectScreen = async (input) => {
    seen.push(input);
    const next = outcomes.shift();
    if (!next) throw new Error("假屏没有更多剧本了（宿主弹屏次数超出预期）");
    return next;
  };
  return { screen, seen };
}

describe("配过：先试上次那台", () => {
  it("探通 → 直接继续，**不弹屏、不写盘**", async () => {
    const saves: ConnectionSettings[] = [];
    const screen = fakeScreen([]); // 一次都不该弹

    const result = await settleConnection({
      plan: { settings: REMOTE, explicit: false } satisfies ConnectPlan,
      env,
      showConnectScreen: screen.screen,
      probe: async (): Promise<ProbeResult> => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings).toEqual(REMOTE);
      expect(result.source.serverUrl).toBe(REMOTE.serverUrl);
    }
    expect(screen.seen).toHaveLength(0);
    expect(saves).toHaveLength(0);
  });

  it("探不通 → 弹一次屏，把**原因**与**上次那份**一起递进去", async () => {
    const screen = fakeScreen([{ kind: "exit" }]);

    const result = await settleConnection({
      plan: { settings: REMOTE, explicit: false },
      env,
      showConnectScreen: screen.screen,
      probe: async (): Promise<ProbeResult> => ({
        ok: false,
        message: "连不上 wss://ai-zen.example.com",
      }),
      save: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(screen.seen).toHaveLength(1);
    expect(screen.seen[0]!.reason).toContain("连不上");
    expect(screen.seen[0]!.initial).toEqual(REMOTE);
  });

  it("显式的地址探通了也不写盘（命令行是这一次的表态）", async () => {
    const saves: ConnectionSettings[] = [];

    await settleConnection({
      plan: { settings: REMOTE, explicit: true },
      env,
      showConnectScreen: fakeScreen([]).screen,
      probe: async (): Promise<ProbeResult> => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(saves).toHaveLength(0);
  });
});

describe("首启：不探活，直接摆屏", () => {
  it("一次探活都不做（否则会悄悄拉起一个本地服务端）", async () => {
    let probes = 0;
    const screen = fakeScreen([{ kind: "exit" }]);

    const result = await settleConnection({
      plan: { settings: null, explicit: false },
      env,
      showConnectScreen: screen.screen,
      probe: async (): Promise<ProbeResult> => {
        probes += 1;
        return { ok: true };
      },
      save: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(probes).toBe(0);
    // 首启形态：没有原因，也没有可预填的东西
    expect(screen.seen[0]!.reason).toBeUndefined();
    expect(screen.seen[0]!.initial).toBeNull();
  });
});

describe("屏上选完：连上了才写盘", () => {
  it("屏里连上（connect 返回 null）→ 写盘一次，带着用户选的那份继续", async () => {
    const saves: ConnectionSettings[] = [];
    const screen = fakeScreen([{ kind: "connected", settings: LOCAL }]);

    const result = await settleConnection({
      plan: { settings: null, explicit: false },
      env,
      showConnectScreen: async (input) => {
        // 模拟屏里的「提交并测试」：宿主给的 connect 返回 null 表示通了
        expect(await input.connect(LOCAL)).toBeNull();
        return screen.screen(input);
      },
      probe: async (): Promise<ProbeResult> => ({ ok: true }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings).toEqual(LOCAL);
      // local 递下去的是两个 undefined：连接层靠它走发现文件 + 本机 run/token
      expect(result.source).toEqual({
        aiZenDir: env.aiZenDir,
        serverUrl: undefined,
        serverToken: undefined,
      });
    }
    expect(saves).toEqual([LOCAL]);
  });

  it("屏里没连上（connect 返回原因）→ 不写盘（宿主也就不会走到写盘那一步）", async () => {
    const saves: ConnectionSettings[] = [];
    const screen = fakeScreen([{ kind: "exit" }]);

    const result = await settleConnection({
      plan: { settings: null, explicit: false },
      env,
      showConnectScreen: async (input) => {
        expect(await input.connect(REMOTE)).toContain("连不上");
        return screen.screen(input);
      },
      probe: async (): Promise<ProbeResult> => ({
        ok: false,
        message: "连不上 wss://ai-zen.example.com",
      }),
      save: async (_env, settings) => void saves.push(settings),
    });

    expect(result.ok).toBe(false);
    expect(saves).toHaveLength(0);
  });
});
