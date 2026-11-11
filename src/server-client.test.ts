/**
 * 绑定层（`server-client/index.ts`）的两件事。
 *
 * 1. 「服务端包坐标」的漂移检查：`SERVER_PACKAGE` 里的版本号必须等于仓库里
 *    `@ai-zen/agents-server` 的实际版本。它是**跨仓手工同步**的字符串（CLI 与 agents 是两个
 *    git 仓），没有编译器会替我们检查 —— 而错了的表现是「第一次要拉起服务端时 npx 报
 *    notarget」，用户看到的只是 CLI 起不来。
 *
 * 2. 显式地址 / 凭证真的被递到了线上（D9 / D10 / D11）：`--server` / `AI_ZEN_SERVER_URL`、
 *    `AI_ZEN_SERVER_TOKEN` 从 `env.ts` 解析成一份 `CliEnv`，经过 `createServerConnection(env)` /
 *    `readServerStatus({…})`，最终要出现在那条 socket 的 `hello` 里。
 *
 * 第 2 条**不 mock 构造函数**：这里真起一台 Daemon（`port: 0`），然后用那对工厂造出来的连接去
 * 连它、`ping` 它。只断言「`toHaveBeenCalledWith(…)`」的写法即使把两个值递反了也是绿的
 * —— 而「地址与凭证必须同源」正是这一批的全部内容，它得能被观测到才有意义。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Daemon } from "@ai-zen/agents-server";
import {
  CLIENT_INFO,
  SERVER_PACKAGE,
  connectToServer,
  createServerConnection,
  readServerStatus,
} from "./server-client/index.js";
import { resolveCliEnv, type CliEnv } from "./env.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";

const require = createRequire(import.meta.url);

describe("SERVER_PACKAGE 与服务端包版本一致", () => {
  it("常量里的版本号 == `@ai-zen/agents-server/package.json` 的 version", () => {
    // 开发期它是 devDependency（`link:`），所以解析到的就是仓库里那一份
    const packageJsonPath = require.resolve("@ai-zen/agents-server/package.json");
    const { name, version } = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      name: string;
      version: string;
    };

    expect(SERVER_PACKAGE).toBe(`${name}@${version}`);
  });
});

// ==================== 显式地址与凭证（D9 / D10 / D11）====================

/** 客户端那侧的 `AI_ZEN_DIR`（远程场景：这里既没有发现文件，也没有凭证文件） */
const zen = useTempAiZenDir("aiz-client-side-");

/** 服务端那侧的目录：凭证由它 `start()` 时生成，发现文件也只写在这里 */
let serverDir: string;
let daemon: Daemon | null = null;

const ENV_URL = "AI_ZEN_SERVER_URL";
const ENV_TOKEN = "AI_ZEN_SERVER_TOKEN";
let savedUrl: string | undefined;
let savedToken: string | undefined;

/** 服务端 `start()` 写在 `<serverDir>/run/token` 的那串凭证 */
function serverToken(): string {
  return readFileSync(join(serverDir, "run", "token"), "utf-8").trim();
}

/** 服务端地址（`ws://` 是本机 daemon 唯一的听法：它永不实现 TLS） */
function serverUrl(): string {
  return `ws://127.0.0.1:${daemon!.port}`;
}

/**
 * 这一次的事实 —— 走生产同一条解析路（`resolveCliEnv`），只把 argv 那一半作为参数。
 *
 * 用例不再有「`setServerUrlFlag()` 往模块里塞值」那一步：`--server` 现在是**入参**，不在任何
 * 模块状态里，所以「上一个文件残留了一个 flag」这类串味从根上没了。
 */
function envNow(serverUrlFlag?: string): CliEnv {
  return resolveCliEnv({ env: process.env, serverUrlFlag });
}

beforeEach(async () => {
  savedUrl = process.env[ENV_URL];
  savedToken = process.env[ENV_TOKEN];
  delete process.env[ENV_URL];
  delete process.env[ENV_TOKEN];
  zen.pin();

  serverDir = mkdtempSync(join(tmpdir(), "aiz-server-side-"));
  // 不注入 token：让它像生产那样自己生成一份到 `run/token`（「回落到文件」那条才有东西可读）
  daemon = new Daemon({ aiZenDir: serverDir, port: 0, version: "0.0.0-test" });
  await daemon.start();
});

afterEach(async () => {
  await daemon?.stop("test teardown");
  daemon = null;
  rmSync(serverDir, { recursive: true, force: true });
  if (savedUrl === undefined) delete process.env[ENV_URL];
  else process.env[ENV_URL] = savedUrl;
  if (savedToken === undefined) delete process.env[ENV_TOKEN];
  else process.env[ENV_TOKEN] = savedToken;
});

afterAll(() => {
  zen.cleanup();
});

/**
 * 造一条连接、借它说一句话、收掉。
 *
 * 断言用的是 `ping` 的回执 —— 它只有真握过手（带着对的凭证）才拿得到，所以「连上了」与
 * 「进得去」两件事一次说完。
 */
async function pingViaAssembly(env: CliEnv): Promise<void> {
  const connection = createServerConnection(env);
  try {
    const client = await connection.client();
    expect(await client.call("ping")).toEqual({ pong: true });
  } finally {
    connection.close();
  }
}

describe("createServerConnection：显式地址真的出现在了那条 socket 上", () => {
  it("AI_ZEN_SERVER_URL → 连的就是它（本机没有任何发现文件也一样）", async () => {
    process.env[ENV_URL] = serverUrl();
    process.env[ENV_TOKEN] = serverToken();

    await pingViaAssembly(envNow());
  });

  it("--server 覆盖 AI_ZEN_SERVER_URL（环境里那个地址上没人监听）", async () => {
    process.env[ENV_URL] = "ws://127.0.0.1:1";
    process.env[ENV_TOKEN] = serverToken();

    // 若 --server 没赢，这一跳会连到 127.0.0.1:1 上，用例当场红
    await pingViaAssembly(envNow(serverUrl()));
  });

  it("给了显式地址就只连、不拉起（D10）：地址没人时抛的是「连不上那个地址」", async () => {
    process.env[ENV_URL] = "ws://127.0.0.1:1";
    const connection = createServerConnection(envNow());
    try {
      // 拉起那条路会白等满 10s 再报「server did not become reachable」；这里的错误必须
      // 指向显式地址本身，而且很快就到（用例超时就够长了，不用另设）
      await expect(connection.client()).rejects.toThrow(/显式指定的服务端 127\.0\.0\.1:1/);
    } finally {
      connection.close();
    }
  }, 15_000);
});

describe("connectToServer：同一条 `ensureServer` 出口，同样的两个值", () => {
  it("显式地址 + 显式凭证 → 连得上、ping 得通", async () => {
    process.env[ENV_URL] = serverUrl();
    process.env[ENV_TOKEN] = serverToken();

    const client = await connectToServer(envNow());
    try {
      expect(await client.call("ping")).toEqual({ pong: true });
    } finally {
      client.close();
    }
  });
});

describe("凭证：AI_ZEN_SERVER_TOKEN 递下去，没设就回落读文件（D9）", () => {
  it("错的那一串连不上（服务端回 unauthorized）", async () => {
    process.env[ENV_URL] = serverUrl();
    process.env[ENV_TOKEN] = "这不是本机 daemon 的那一串";

    const connection = createServerConnection(envNow());
    try {
      await expect(connection.client()).rejects.toThrow(/unauthorized/);
    } finally {
      connection.close();
    }
  });

  it("没设时不传：客户端回落到 <aiZenDir>/run/token（文件在才进得去）", async () => {
    process.env[ENV_URL] = serverUrl();

    // 文件不在 → 没有凭证可用 → 服务端回 unauthorized（这条同时证明「不传」不是「随便就进」）
    const bare = createServerConnection(envNow());
    try {
      await expect(bare.client()).rejects.toThrow(/unauthorized/);
    } finally {
      bare.close();
    }

    // 把服务端那串摆到**客户端自己**的 `run/` 下（两机之间这一步是 scp / 密钥挂载）
    mkdirSync(join(zen.dir, "run"), { recursive: true });
    writeFileSync(join(zen.dir, "run", "token"), `${serverToken()}\n`, "utf-8");

    await pingViaAssembly(envNow());
  });
});

describe("readServerStatus：显式地址时不读发现文件（D13）", () => {
  it("本机没有 server.json，但显式地址可达 → running: true（而不是 no descriptor）", async () => {
    const status = await readServerStatus({
      // 这个目录里既没有 run/server.json，也没有 run/token：两样都得靠显式值
      aiZenDir: zen.dir,
      clientInfo: CLIENT_INFO,
      serverUrl: serverUrl(),
      serverToken: serverToken(),
    });

    expect(status.running).toBe(true);
    if (status.running) {
      // 答话的确实是**这一台**（同进程起的）：pid 与它自己的发现文件目录都是它的
      expect(status.pid).toBe(process.pid);
      expect(status.descriptorPath).toContain(serverDir);
    }
  });

  it("同类场景下不给显式地址 → 仍然只看发现文件（no descriptor）", async () => {
    const status = await readServerStatus({ aiZenDir: zen.dir, clientInfo: CLIENT_INFO });

    // 这句「不是没在跑、也不是连不上」的话正是远程场景必须被替换掉的那个答案
    expect(status).toEqual({ running: false, reason: "no descriptor" });
  });

  it("显式地址不可达 → 说的是那个地址，不是 no descriptor", async () => {
    const status = await readServerStatus({
      aiZenDir: zen.dir,
      clientInfo: CLIENT_INFO,
      serverUrl: "ws://127.0.0.1:1",
    });

    expect(status.running).toBe(false);
    if (!status.running) {
      expect(status.reason).not.toBe("no descriptor");
      expect(status.reason).toContain("127.0.0.1:1");
    }
  });
});
