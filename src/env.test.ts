/**
 * `env.ts` —— 本进程事实的**唯一解析点**，与显式服务端地址/凭证的优先级与早期校验
 *（D9 / D11 / D12）。
 *
 * 这一组钉三件事：
 *
 *   1. **优先级**：地址一旦能指向远端，凭证就不能只从本地文件读，而「哪个值赢」只在这里判
 *      一次（连接层、诊断、将来的设置面板都问它）；
 *   2. **三种情形分得开**：`--server` 没给 / 给了空串 / 给了地址 —— 后两者混成一个
 *      「没给」就是「用户以为指定了远端，实际连回本机」；
 *   3. **根只有一个主人**：`applyCliEnv()` 之后 `cliEnv()` 拿到的就是那一份，而没设置时它
 *      **抛错**而不是自己去读 `process.env`。
 *
 * 用例**不碰 `process.env`**：`resolveCliEnv()` 是纯函数，收的还是调用方给的 env 对象。这
 * 正是这一步改动的目的 —— 原来这一组要靠 `setServerUrlFlag()` 往模块里塞值、再在
 * `beforeEach` / `afterEach` 里擦，`isolate: false` 下漏一次就串到别的文件去。
 */

import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { applyCliEnv, cliEnv, resolveCliEnv, serverUrlError } from "./env.js";

const ENV_URL = "AI_ZEN_SERVER_URL";
const ENV_TOKEN = "AI_ZEN_SERVER_TOKEN";

describe("resolveCliEnv：配置根（AI_ZEN_DIR > <home>/.ai-zen）", () => {
  it("AI_ZEN_DIR 优先", () => {
    const env = resolveCliEnv({ env: { AI_ZEN_DIR: "/tmp/aiz", HOME: "/home/u" } });
    expect(env.aiZenDir).toBe("/tmp/aiz");
  });

  it("没有 AI_ZEN_DIR → <home>/.ai-zen", () => {
    const env = resolveCliEnv({ env: { HOME: "/home/u" } });
    expect(env.aiZenDir).toBe(join("/home/u", ".ai-zen"));
  });

  it("空串的 AI_ZEN_DIR 等于没设（`AI_ZEN_DIR=` 是「别用它」的写法）", () => {
    const env = resolveCliEnv({ env: { AI_ZEN_DIR: "", HOME: "/home/u" } });
    expect(env.aiZenDir).toBe(join("/home/u", ".ai-zen"));
  });

  it("没有 HOME 时退到 USERPROFILE（Windows）", () => {
    const env = resolveCliEnv({ env: { USERPROFILE: "C:\\Users\\u" } });
    expect(env.aiZenDir).toBe(join("C:\\Users\\u", ".ai-zen"));
  });
});

describe("resolveCliEnv：显式地址的三种情形", () => {
  it("两样都没给 → undefined（= 走发现文件，连接层那条默认路）", () => {
    expect(resolveCliEnv({ env: {} }).serverUrl).toBeUndefined();
  });

  it("AI_ZEN_SERVER_URL 生效", () => {
    const env = resolveCliEnv({ env: { [ENV_URL]: "wss://example.com/ai-zen" } });
    expect(env.serverUrl).toBe("wss://example.com/ai-zen");
  });

  it("--server 覆盖 AI_ZEN_SERVER_URL", () => {
    const env = resolveCliEnv({
      env: { [ENV_URL]: "wss://from-env.example.com" },
      serverUrlFlag: "wss://from-flag.example.com",
    });
    expect(env.serverUrl).toBe("wss://from-flag.example.com");
  });

  it("环境变量只有空白 = 没设（不是一条非法地址）", () => {
    const env = resolveCliEnv({ env: { [ENV_URL]: "   " } });
    expect(env.serverUrl).toBeUndefined();
    expect(serverUrlError(env)).toBeNull();
  });

  it("--server 给了却没值（空串）≠ 没给：不当成「回落到环境变量」", () => {
    const env = resolveCliEnv({
      env: { [ENV_URL]: "wss://from-env.example.com" },
      serverUrlFlag: "",
    });
    expect(env.serverUrl).toBe("");
    // 而它作为地址是不合法的，早期校验必须说话（措辞见下一条用例）
    expect(serverUrlError(env)).toContain("--server");
  });
});

describe("resolveCliEnv：显式凭证", () => {
  it("设了就取它（去空白）；空白 / 没设 → undefined（让客户端回落读文件）", () => {
    expect(resolveCliEnv({ env: { [ENV_TOKEN]: "  s3cret  " } }).serverToken).toBe("s3cret");
    expect(resolveCliEnv({ env: { [ENV_TOKEN]: "   " } }).serverToken).toBeUndefined();
    expect(resolveCliEnv({ env: {} }).serverToken).toBeUndefined();
  });
});

describe("serverUrlError：早期校验（D12）", () => {
  // 判据用包里导出的 `parseServerUrl`，所以措辞也是它那一份：**带原值**。
  // 这正是「早期报错」要的东西 —— 用户得认出自己敲的那一行里哪个字符不对。
  it("合法地址 → 没有错误可报（四种 scheme 都收，含 nginx 子路径）", () => {
    for (const url of [
      "ws://127.0.0.1:8790",
      "wss://example.com/ai-zen",
      "http://example.com",
      "https://example.com/ai-zen/",
    ]) {
      expect(serverUrlError({ aiZenDir: "/tmp/aiz", serverUrl: url })).toBeNull();
    }
  });

  it("没给地址 → 没有错误可报（默认那条路不归这里管）", () => {
    expect(serverUrlError({ aiZenDir: "/tmp/aiz" })).toBeNull();
  });

  it("非法地址 → 一条带原值的人话（不是一句「地址不合法」）", () => {
    const problem = serverUrlError({ aiZenDir: "/tmp/aiz", serverUrl: "example.com:8790" });
    expect(problem).toContain("example.com:8790");
    expect(problem).toContain("不是合法的服务端地址");
  });

  it("非 ws/http 的 scheme 同样算非法（`ftp://` 不是「以后会支持」）", () => {
    expect(serverUrlError({ aiZenDir: "/tmp/aiz", serverUrl: "ftp://example.com" })).toContain(
      "ftp://example.com",
    );
  });

  it("`--server` 给了却没值 → 一句对症的话，不是「空串不是合法地址」", () => {
    expect(serverUrlError({ aiZenDir: "/tmp/aiz", serverUrl: "" })).toBe(
      "--server 需要一个地址（例：--server wss://example.com/ai-zen）",
    );
  });
});

describe("applyCliEnv / cliEnv：根只有一个写点、一个读点", () => {
  // 这一组是「健康单根」最小的一条钉子：根钉下去之后，谁问都问到同一份。
  afterAll(() => {
    // 还原成进程此刻真实的 env：`isolate: false` 下模块图是共享的，别把假根留给后面的文件
    applyCliEnv(resolveCliEnv({ env: process.env }));
  });

  it("applyCliEnv 之后 cliEnv() 原样给回来（同一个对象，不是拷贝）", () => {
    const mine = { aiZenDir: "/tmp/aiz-pinned", serverUrl: "ws://127.0.0.1:9" };
    applyCliEnv(mine);
    expect(cliEnv()).toBe(mine);
    expect(cliEnv().serverUrl).toBe("ws://127.0.0.1:9");
  });

  it("后一次 applyCliEnv 覆盖前一次（`/lang` 那类「换根」的路径只有一个入口）", () => {
    applyCliEnv({ aiZenDir: "/tmp/first" });
    expect(cliEnv().aiZenDir).toBe("/tmp/first");
    applyCliEnv({ aiZenDir: "/tmp/second" });
    expect(cliEnv().aiZenDir).toBe("/tmp/second");
  });
});
