/**
 * 「这次连哪台」的解析与优先级。
 *
 * 这一组钉的是三件在别处会偷偷分叉的事：
 *
 *   1. **「没配过」是 `null`**，不是 `{ mode: "local" }` —— 后者会把首启压成「用户选过本地」；
 *   2. **显式压过落盘**（地址来自 `--server` / `AI_ZEN_SERVER_URL`，凭证来自
 *      `AI_ZEN_SERVER_TOKEN`），与包里 `resolveToken` 的优先级逐字一致；
 *   3. **`local` 传 `undefined`**（不是空串）—— 空串在连接层里的语义是「显式给了个空值」。
 *
 * 全部不碰 `process.env`：环境由用例传进来（`env.ts` 已经把它做成了值）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { Daemon } from "@ai-zen/agents-server";
import {
  connectionFile,
  connectionTargetOf,
  normalizeServerAddress,
  readConnectPlan,
  saveConnectPlan,
} from "./connection.js";
import { settleConnection } from "./tui/connection-gate.js";
import type { CliEnv } from "./env.js";

const REMOTE_URL = "wss://ai-zen.example.com/ai-zen";

let dir: string;
let env: CliEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-cli-connection-"));
  env = { aiZenDir: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 往盘上放一份配置（绕过 `saveConnectPlan`，用来造「用户上次选过」的状态） */
function seed(raw: unknown): void {
  const file = connectionFile(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(raw), "utf-8");
}

describe("落点", () => {
  it("在 <aiZenDir>/cli/connection.json（与桌面端各存各的）", () => {
    expect(connectionFile({ aiZenDir: "/home/u/.ai-zen" })).toBe(
      "/home/u/.ai-zen/cli/connection.json",
    );
  });
});

describe("readConnectPlan：三种情形分得开", () => {
  it("既没显式地址也没落盘配置 → settings 为 null（没配过）", async () => {
    const plan = await readConnectPlan(env);
    expect(plan.settings).toBeNull();
    expect(plan.explicit).toBe(false);
  });

  it("只有 AI_ZEN_SERVER_TOKEN 不算配过（凭证答的是「拿什么进门」，不是「连哪台」）", async () => {
    const plan = await readConnectPlan({ ...env, serverToken: "tok" });
    expect(plan.settings).toBeNull();
  });

  it("落盘配置 → 用它，且标记为「不是显式的」（所以成功之后也不该再写盘）", async () => {
    seed({ mode: "remote", serverUrl: REMOTE_URL });
    const plan = await readConnectPlan(env);
    expect(plan.settings).toEqual({ mode: "remote", serverUrl: REMOTE_URL });
    expect(plan.explicit).toBe(false);
  });

  it("显式地址压过落盘配置，且标记 explicit（命令行的意思不写进记忆）", async () => {
    seed({ mode: "remote", serverUrl: "wss://saved.example.com" });
    const plan = await readConnectPlan({ ...env, serverUrl: REMOTE_URL, serverToken: "tok" });
    expect(plan.settings).toEqual({ mode: "remote", serverUrl: REMOTE_URL, serverToken: "tok" });
    expect(plan.explicit).toBe(true);
  });
});

describe("connectionTargetOf：递给连接层的两个值", () => {
  it("local → 两个 undefined（走发现文件 + 本机 run/token）", () => {
    expect(connectionTargetOf({ settings: { mode: "local" }, explicit: false }, env)).toEqual({
      serverUrl: undefined,
      serverToken: undefined,
    });
  });

  it("remote → 原样（盘上残留的两个字段在 local 下不会被传出去）", () => {
    const target = connectionTargetOf(
      { settings: { mode: "remote", serverUrl: REMOTE_URL }, explicit: false },
      env,
    );
    expect(target).toEqual({ serverUrl: REMOTE_URL, serverToken: undefined });
  });

  it("显式凭证压过落盘那份（「这次就用它」压过「上次填的」）", () => {
    const target = connectionTargetOf(
      {
        settings: { mode: "remote", serverUrl: REMOTE_URL, serverToken: "saved" },
        explicit: false,
      },
      { ...env, serverToken: "from-env" },
    );
    expect(target.serverToken).toBe("from-env");
  });

  it("显式凭证对 local 同样生效（本机 daemon + AI_ZEN_SERVER_TOKEN 是一条真路）", () => {
    const target = connectionTargetOf(
      { settings: { mode: "local" }, explicit: false },
      {
        ...env,
        serverToken: "from-env",
      },
    );
    expect(target).toEqual({ serverUrl: undefined, serverToken: "from-env" });
  });
});

describe("saveConnectPlan：只写这一处", () => {
  it("写下去的那一份能读回来（roundtrip）", async () => {
    await saveConnectPlan(env, { mode: "remote", serverUrl: REMOTE_URL, serverToken: "tok" });
    const plan = await readConnectPlan(env);
    expect(plan.settings).toEqual({ mode: "remote", serverUrl: REMOTE_URL, serverToken: "tok" });
  });

  it("切回本地保存 → 盘上连远端那两个键都没有了（不用的钥匙不留）", async () => {
    await saveConnectPlan(env, { mode: "remote", serverUrl: REMOTE_URL, serverToken: "tok" });
    await saveConnectPlan(env, { mode: "local" });
    const plan = await readConnectPlan(env);
    expect(plan.settings).toEqual({ mode: "local" });
    expect(plan.settings?.serverToken).toBeUndefined();
  });
});

describe("normalizeServerAddress：没写 scheme 就补 ws://", () => {
  it("裸 host:port → ws://", () => {
    expect(normalizeServerAddress("10.0.0.5:8790")).toBe("ws://10.0.0.5:8790");
  });

  it("写了 scheme 就一个字符都不动（不猜加密）", () => {
    for (const url of [REMOTE_URL, "ws://127.0.0.1:8790", "https://example.com/ai-zen"]) {
      expect(normalizeServerAddress(url)).toBe(url);
    }
  });

  it("首尾空白去掉；空串还是空串（交给校验去说话）", () => {
    expect(normalizeServerAddress("  10.0.0.5:8790\n")).toBe("ws://10.0.0.5:8790");
    expect(normalizeServerAddress("   ")).toBe("");
  });
});

/**
 * 探活 + 落盘（真 daemon、真 socket）。
 *
 * 单测里探活一直是假件，于是「真连一次」与「真写一份」的接缝没人盖：凭证从服务端的
 * `run/token` 读出来、`ensureServer` 的显式地址那条路（只连不拉起）、`0600` 落盘。这条用例
 * 把它们一次走完 —— 没有 TTY，也不起界面。
 */
describe("探活 + 落盘：屏上选了一个能连的远程", () => {
  it("连得上 → 宿主把那一份原样写进 <aiZenDir>/cli/connection.json", async () => {
    const serverDir = mkdtempSync(join(tmpdir(), "aiz-probe-server-"));
    const clientDir = mkdtempSync(join(tmpdir(), "aiz-probe-client-"));
    const daemon = new Daemon({ aiZenDir: serverDir, port: 0, version: "0.0.0-test" });
    await daemon.start();
    try {
      const token = readFileSync(join(serverDir, "run", "token"), "utf-8").trim();
      const chosen = {
        mode: "remote" as const,
        serverUrl: `ws://127.0.0.1:${daemon.port}`,
        serverToken: token,
      };

      const result = await settleConnection({
        plan: { settings: null, explicit: false },
        env: { aiZenDir: clientDir },
        showConnectScreen: async (input) => {
          // 屏上那次「提交并测试」：宿主给的 connect 返回 null = 真连上了
          expect(await input.connect(chosen)).toBeNull();
          return { kind: "connected", settings: chosen };
        },
      });

      expect(result.ok).toBe(true);
      const stored = JSON.parse(readFileSync(connectionFile({ aiZenDir: clientDir }), "utf-8"));
      expect(stored).toEqual(chosen);
    } finally {
      await daemon.stop("test teardown").catch(() => {});
      rmSync(serverDir, { recursive: true, force: true });
      rmSync(clientDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("连不上 → 原样一句话回去，盘上一份都没写", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "aiz-probe-client-"));
    try {
      const result = await settleConnection({
        plan: { settings: null, explicit: false },
        env: { aiZenDir: clientDir },
        showConnectScreen: async (input) => {
          const failure = await input.connect({ mode: "remote", serverUrl: "ws://127.0.0.1:1" });
          expect(failure).toBeTruthy();
          return { kind: "exit" };
        },
      });

      expect(result.ok).toBe(false);
      await expect(readConnectPlan({ aiZenDir: clientDir })).resolves.toEqual({
        settings: null,
        explicit: false,
      });
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  }, 30_000);
});
