/**
 * 本进程事实的组装根里那两件事：`projectDirs()`（项目级路径的唯一来源）与
 * 「显式服务端地址 / 凭证」的优先级与早期校验。
 *
 * 为什么这两组都留在客户端：它们验的是**本进程**的事实（目录布局、argv / env 里的地址与
 * 凭证），而不是配置读写那套已经搬到服务端的行为 —— 后者的用例在 `@ai-zen/agents-server`
 * 的 `ConfigService.test.ts`。
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { join } from "path";
import * as config from "./config.js";

describe("projectDirs（cwd 是参数，不是模块求值快照）", () => {
  // 为什么是函数：`export const PROJECT_* = join(process.cwd(), …)` 那套写法在模块求值
  // 那一刻就把启动目录焊死，之后换目录（测试换临时根、将来服务端一个进程服务多个工作区）
  // 全部悄悄落到启动时的那个目录里 —— 不报错，只是写错地方。
  it("传入不同 cwd → 拿到各自的路径（互不影响）", () => {
    const a = config.projectDirs("/work/proj-a");
    const b = config.projectDirs("/work/proj-b");

    expect(a.skills).toBe(join("/work/proj-a", ".ai-zen", "skills"));
    expect(b.skills).toBe(join("/work/proj-b", ".ai-zen", "skills"));
    expect(a.skills).not.toBe(b.skills);
  });

  it("三项项目级 MCP 配置都在同一个 cwd 下，顺序里的三处不会串", () => {
    const dirs = config.projectDirs("/p");
    expect(dirs.sharedMcpConfig).toBe(join("/p", ".mcp.json"));
    expect(dirs.mcpConfig).toBe(join("/p", ".ai-zen", "mcp.json"));
    expect(dirs.agentsMcpConfig).toBe(join("/p", ".agents", "mcp.json"));
  });

  it("不传参时取当前 cwd（组装根唯一一处读全局）", () => {
    expect(config.projectDirs().root).toBe(join(process.cwd(), ".ai-zen"));
    expect(config.projectDirs().handoffs).toBe(join(process.cwd(), ".ai-zen", "handoffs"));
  });
});

/**
 * 显式服务端地址与凭证（`--server` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN`）。
 *
 * 这一组钉的是**优先级**与**早期校验**：地址一旦能指向远端，凭证就不能只从本地文件读，
 * 而「哪个值赢」这件事只该在 config.ts 里判一次（连接层、诊断、将来的设置面板都问它）。
 *
 * 环境变量在这里直接改 `process.env`：`isolate: false` 的进程内共享模块下，用例之间必须
 * 自己收尾（`beforeEach` 存、`afterEach` 还原），否则下一个文件会读到上一个文件留下的地址。
 */
describe("显式服务端地址与凭证（D9 / D11 / D12）", () => {
  const ENV_URL = "AI_ZEN_SERVER_URL";
  const ENV_TOKEN = "AI_ZEN_SERVER_TOKEN";
  let savedUrl: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedUrl = process.env[ENV_URL];
    savedToken = process.env[ENV_TOKEN];
    delete process.env[ENV_URL];
    delete process.env[ENV_TOKEN];
    // argv 那一半是「存进来的」，不随 env 自动清 —— 每个用例都从「这次没给 --server」开始
    config.setServerUrlFlag(undefined);
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = savedUrl;
    if (savedToken === undefined) delete process.env[ENV_TOKEN];
    else process.env[ENV_TOKEN] = savedToken;
    config.setServerUrlFlag(undefined);
  });

  it("两样都没给 → undefined（= 走发现文件，连接层那条默认路）", () => {
    expect(config.explicitServerUrl()).toBeUndefined();
  });

  it("AI_ZEN_SERVER_URL 生效", () => {
    process.env[ENV_URL] = "wss://example.com/ai-zen";
    expect(config.explicitServerUrl()).toBe("wss://example.com/ai-zen");
  });

  it("--server 覆盖 AI_ZEN_SERVER_URL", () => {
    process.env[ENV_URL] = "wss://from-env.example.com";
    config.setServerUrlFlag("wss://from-flag.example.com");
    expect(config.explicitServerUrl()).toBe("wss://from-flag.example.com");
  });

  it("环境变量只有空白 = 没设（`AI_ZEN_SERVER_URL=` 是「别用它」的写法，不是非法地址）", () => {
    process.env[ENV_URL] = "   ";
    expect(config.explicitServerUrl()).toBeUndefined();
    expect(config.serverUrlError()).toBeNull();
  });

  it("--server 给了却没值（空串）≠ 没给：不当成「回落到环境变量」", () => {
    process.env[ENV_URL] = "wss://from-env.example.com";
    config.setServerUrlFlag("");
    expect(config.explicitServerUrl()).toBe("");
    // 而它作为地址是不合法的，早期校验必须说话（下一条用例断言措辞）
    expect(config.serverUrlError()).toContain("--server");
  });

  it("AI_ZEN_SERVER_TOKEN：设了就取它（去空白），没设 / 空白 → undefined（让客户端回落读文件）", () => {
    process.env[ENV_TOKEN] = "  s3cret  ";
    expect(config.explicitServerToken()).toBe("s3cret");
    process.env[ENV_TOKEN] = "   ";
    expect(config.explicitServerToken()).toBeUndefined();
    delete process.env[ENV_TOKEN];
    expect(config.explicitServerToken()).toBeUndefined();
  });

  it("合法地址 → 没有错误可报（四种 scheme 都收，含 nginx 子路径）", () => {
    for (const url of [
      "ws://127.0.0.1:8790",
      "wss://example.com/ai-zen",
      "http://example.com",
      "https://example.com/ai-zen/",
    ]) {
      config.setServerUrlFlag(url);
      expect(config.serverUrlError()).toBeNull();
    }
  });

  it("没给地址 → 没有错误可报（默认那条路不归这里管）", () => {
    expect(config.serverUrlError()).toBeNull();
  });

  // 判据用包里导出的 `parseServerUrl`，所以措辞也是它那一份：**带原值**。
  // 这正是「早期报错」要的东西 —— 用户得认出自己敲的那一行里哪个字符不对。
  it("非法地址 → 一条带原值的人话（不是一句「地址不合法」）", () => {
    config.setServerUrlFlag("example.com:8790");
    const problem = config.serverUrlError();
    expect(problem).toContain("example.com:8790");
    expect(problem).toContain("不是合法的服务端地址");
  });

  it("非 ws/http 的 scheme 同样算非法（`ftp://` 不是「以后会支持」）", () => {
    config.setServerUrlFlag("ftp://example.com");
    expect(config.serverUrlError()).toContain("ftp://example.com");
  });
});
