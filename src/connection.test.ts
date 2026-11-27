/**
 * 「这次连哪台」的解析、优先级与探活。
 *
 * 这一组钉的是三件在别处会各自分叉的事：
 *
 *   1. 「没配过」是 `null`，不是 `{ mode: "local" }` —— 后者会把首启压成「用户选过本地」，
 *      于是第一次启动就拉起一个宿主；
 *   2. 显式压过落盘（地址来自 `--server` / `AI_ZEN_SERVER_URL`，凭证来自
 *      `AI_ZEN_SERVER_TOKEN`），与 `ensureHost` 的「显式 > `<数据根>/run/token`」同一个方向；
 *   3. 连一次就是连上：新契约没有 `ping`，握手（`host.hello`）本身校验凭证 —— 于是探活只需
 *      「`ensureHost` 成了没有」，诊断只需「问一句 `host.version`」。
 *
 * 连接层本身（WebSocket、握手、重连、补拉）是 `@ai-zen/agents-client` 的用例范围，这里一律注入
 * 假件：本文件验的是接线（哪一份设置、哪一串凭证、连哪个地址被递了下去）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boundCall,
  connectHost,
  connectionFile,
  launchLogFile,
  probeConnection,
  readConnectPlan,
  readHostStatus,
  saveConnectPlan,
} from "./connection.js";
import { getLocale } from "./i18n/index.js";
import { hostVersionFile, rememberHostVersion } from "./host-version.js";
import {
  type ClientOptions,
  type ConnectionSettings,
  type EnsureHostOptions,
  type EnsureHostResult,
  type HostClient,
  type HostTarget,
} from "./server-client/index.js";
import type { CliEnv } from "./env.js";
import { AGENTS_HOST_RANGE } from "./version.js";

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

/** 造一台「活着的本机宿主」的痕迹：发现文件 + 凭证文件 */
function seedLocalHost(host = "127.0.0.1", port = 8790, token = "local-token"): void {
  mkdirSync(join(dir, "run"), { recursive: true });
  writeFileSync(join(dir, "run", "host.json"), JSON.stringify({ pid: 4242, host, port }), "utf-8");
  writeFileSync(join(dir, "run", "token"), `${token}\n`, "utf-8");
}

/**
 * 一条假连接：只长着被测代码用到的那几件事。
 *
 * `api.host.version.query()` 之外的 procedure 都不打桩 —— 本文件验的是接线（哪一份设置、
 * 哪一串凭证、连哪个地址被递了下去），不验某条 procedure 怎么回。
 */
function fakeClient(): { client: HostClient; closed: () => boolean } {
  let closed = false;
  const client = {
    api: { host: { version: { query: async () => VERSION } } },
    subscribe: () => () => {},
    reconnect: async () => {},
    close: async () => {
      closed = true;
    },
  } as unknown as HostClient;
  return { client, closed: () => closed };
}

/** `host.version` 的一份出参（宿主这一版只报版本这一格） */
const VERSION = { version: "0.1.0-alpha.0" };

/** `ensureHost` 成功时的结果（`client` 换成假件，其余字段原样） */
function ensureResult(target: HostTarget, client: HostClient): EnsureHostResult {
  return { client, target, started: false, explicit: false, dataRoot: dir };
}

describe("落点", () => {
  it("在 <aiZenDir>/cli/connection.json（与桌面端各存各的）", () => {
    expect(connectionFile({ aiZenDir: "/home/u/.ai-zen" })).toBe(
      // `join` 而不是手写 `/`：这条断言验的是「落到哪」，不是「这个平台用什么分隔符」
      join("/home/u/.ai-zen", "cli", "connection.json"),
    );
  });

  it("拉起日志在 <aiZenDir>/logs/cli/launch.log（CLI 那一格）", () => {
    expect(launchLogFile({ aiZenDir: "/home/u/.ai-zen" })).toBe(
      join("/home/u/.ai-zen", "logs", "cli", "launch.log"),
    );
  });
});

describe("readConnectPlan：三种情形分得开", () => {
  it("既没显式地址也没落盘配置 → null（没配过）", async () => {
    expect(await readConnectPlan(env)).toBeNull();
  });

  it("只有 AI_ZEN_SERVER_TOKEN 不算配过（凭证答的是「拿什么进门」，不是「连哪台」）", async () => {
    expect(await readConnectPlan({ ...env, serverToken: "tok" })).toBeNull();
  });

  it("落盘配置 → 原样读回来（字段是 client 的 url / token，不是旧的 serverUrl / serverToken）", async () => {
    seed({ mode: "remote", url: REMOTE_URL, token: "saved" });
    expect(await readConnectPlan(env)).toEqual({
      mode: "remote",
      url: REMOTE_URL,
      token: "saved",
    });
  });

  it("盘上那份是旧形状（serverUrl / serverToken）→ 读不回来 = 没配过（没有兼容层）", async () => {
    seed({ mode: "remote", serverUrl: REMOTE_URL, serverToken: "saved" });
    // 旧的 `serverUrl` 在新形状里没有对应字段：远程却没有 `url` = 这份配置不可用
    expect(await readConnectPlan(env)).toBeNull();
  });

  it("显式地址压过落盘配置（命令行的意思不写进记忆）", async () => {
    seed({ mode: "remote", url: "wss://saved.example.com" });
    expect(await readConnectPlan({ ...env, serverUrl: REMOTE_URL })).toEqual({
      mode: "remote",
      url: REMOTE_URL,
    });
  });

  it("显式凭证压过落盘那份（「这次就用它」压过「上次填的」）", async () => {
    seed({ mode: "remote", url: REMOTE_URL, token: "saved" });
    expect(await readConnectPlan({ ...env, serverToken: "from-env" })).toEqual({
      mode: "remote",
      url: REMOTE_URL,
      token: "from-env",
    });
  });

  it("local 模式下显式凭证不进设置（本机那条路的凭证是 <aiZenDir>/run/token）", async () => {
    seed({ mode: "local" });
    expect(await readConnectPlan({ ...env, serverToken: "from-env" })).toEqual({ mode: "local" });
  });
});

describe("saveConnectPlan：仅生成这一处", () => {
  it("写下去的那一份能读回来（roundtrip）", async () => {
    await saveConnectPlan(env, { mode: "remote", url: REMOTE_URL, token: "tok" });
    expect(await readConnectPlan(env)).toEqual({
      mode: "remote",
      url: REMOTE_URL,
      token: "tok",
    });
  });

  it("切回本地保存 → 盘上连远端那两个键都没有了（不用的钥匙不留）", async () => {
    await saveConnectPlan(env, { mode: "remote", url: REMOTE_URL, token: "tok" });
    await saveConnectPlan(env, { mode: "local" });
    const settings = await readConnectPlan(env);
    expect(settings).toEqual({ mode: "local" });
    expect(settings?.token).toBeUndefined();
  });
});

describe("connectHost：把 CLI 的事实绑到 ensureHost 上", () => {
  it("数据根、拉起日志、设置、语言一起递下去；结果原样返回（连接被包成 CLI 那一份）", async () => {
    const settings: ConnectionSettings = { mode: "remote", url: REMOTE_URL, token: "tok" };
    const { client } = fakeClient();
    const seen: EnsureHostOptions[] = [];

    const result = await connectHost({
      env,
      settings,
      ensure: async (options) => {
        seen.push(options);
        return ensureResult({ host: "ai-zen.example.com", port: 443 }, client);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      dataRoot: dir,
      // 库里不再替调用方挑日志放哪一格：CLI 把自己的那份拉起日志坐标递进去
      launchLog: join(dir, "logs", "cli", "launch.log"),
      settings,
      // 宿主按这条连接的语言渲染句子：CLI 的界面语言就是它
      language: getLocale(),
    });
    // `client` 被包成 CLI 的 `HostConnection`：`api` 与语言是同一份，另加镜像与旧路那几格
    expect(result.client.api).toBe(client.api);
    expect(result.client.language).toBe(getLocale());
  });

  it("local 设置原样递下去（连哪儿由库决定：发现文件 + run/token）", async () => {
    const seen: EnsureHostOptions[] = [];
    await connectHost({
      env,
      settings: { mode: "local" },
      ensure: async (options) => {
        seen.push(options);
        return ensureResult({ host: "127.0.0.1", port: 8790 }, fakeClient().client);
      },
    });
    expect(seen[0].settings).toEqual({ mode: "local" });
  });

  it("显式凭证在递下去之前就压过了设置里那份", async () => {
    const seen: EnsureHostOptions[] = [];
    await connectHost({
      env: { ...env, serverToken: "from-env" },
      settings: { mode: "remote", url: REMOTE_URL, token: "saved" },
      ensure: async (options) => {
        seen.push(options);
        return ensureResult({ host: "ai-zen.example.com", port: 443 }, fakeClient().client);
      },
    });
    expect(seen[0].settings).toEqual({ mode: "remote", url: REMOTE_URL, token: "from-env" });
  });

  it("宿主版本范围、阶段回调与取消信号一起递下去（本机拉起就靠这三样）", async () => {
    const seen: EnsureHostOptions[] = [];
    const stages: string[] = [];
    const controller = new AbortController();

    await connectHost({
      env,
      settings: { mode: "local" },
      onStage: (stage) => stages.push(stage),
      signal: controller.signal,
      ensure: async (options) => {
        seen.push(options);
        // 连接层把阶段交回给调用方：下载屏就是这一条线的消费者
        options.onStage?.("resolving");
        return ensureResult({ host: "127.0.0.1", port: 8790 }, fakeClient().client);
      },
    });

    // 范围是构建时从本包 devDependencies 注入的那一段（直接跑 TS 时读 package.json 同一个字段）：
    // 它必须是 semver range，不能是 `link:` 那种本地路径 —— npx 只认前者
    expect(seen[0].versionRange).toBe(AGENTS_HOST_RANGE);
    expect(AGENTS_HOST_RANGE).toMatch(/^[\^~]?\d+\.\d+\.\d+/);
    expect(stages).toEqual(["resolving"]);
    expect(seen[0].signal).toBe(controller.signal);
  });

  it("磁盘上没记录（没升级过）→ 拉宿主的版本范围就是构建时那一段", async () => {
    const seen: EnsureHostOptions[] = [];
    await connectHost({
      env,
      settings: { mode: "local" },
      ensure: async (options) => {
        seen.push(options);
        return ensureResult({ host: "127.0.0.1", port: 8790 }, fakeClient().client);
      },
    });
    expect(seen[0].versionRange).toBe(AGENTS_HOST_RANGE);
  });

  it("`/upgrade` 记过版本 → 递给 npx 的就是那一版确切版本（不再用范围）", async () => {
    await rememberHostVersion(dir, "1.2.3");
    const seen: EnsureHostOptions[] = [];
    await connectHost({
      env,
      settings: { mode: "local" },
      ensure: async (options) => {
        seen.push(options);
        return ensureResult({ host: "127.0.0.1", port: 8790 }, fakeClient().client);
      },
    });
    expect(seen[0].versionRange).toBe("1.2.3");
  });

  it("记录文件内容不合法 → 报错并指出是哪个文件（不当作「没升级过」）", async () => {
    mkdirSync(dirname(hostVersionFile(dir)), { recursive: true });
    writeFileSync(hostVersionFile(dir), '{"version": 3}', "utf-8");
    await expect(
      connectHost({
        env,
        settings: { mode: "local" },
        ensure: async () => ensureResult({ host: "127.0.0.1", port: 8790 }, fakeClient().client),
      }),
    ).rejects.toThrow(hostVersionFile(dir));
  });
});

describe("probeConnection：连上就算过，连完就关", () => {
  it("成功 → ok，且那条连接当场关掉（探活不该在宿主那边留下常驻连接）", async () => {
    const { client, closed } = fakeClient();
    const result = await probeConnection({
      env,
      settings: { mode: "local" },
      ensure: async () => ensureResult({ host: "127.0.0.1", port: 8790 }, client),
    });

    expect(result).toEqual({ ok: true });
    expect(closed()).toBe(true);
  });

  it("失败 → 那句能上屏的话，且设置里的凭证被抹掉", async () => {
    const result = await probeConnection({
      env,
      settings: { mode: "remote", url: REMOTE_URL, token: "s3cret" },
      ensure: async () => {
        throw new Error("unauthorized：凭证 s3cret 不被接受");
      },
    });

    expect(result).toEqual({ ok: false, message: "unauthorized：凭证 *** 不被接受" });
  });
});

describe("readHostStatus：此刻在不在跑（绝不拉起）", () => {
  it("本机没有发现文件 → 不在跑，原因是那份文件的路径", async () => {
    const status = await readHostStatus(env, {
      connect: async () => {
        throw new Error("不该连：没有发现文件就没有可连的地址");
      },
    });

    expect(status.running).toBe(false);
    if (!status.running) expect(status.reason).toContain(join(dir, "run", "host.json"));
  });

  it("本机有发现文件 → 连文件里的地址、用 run/token 的凭证，答话的是那台宿主的版本", async () => {
    seedLocalHost("127.0.0.1", 8790, "local-token");
    const { client, closed } = fakeClient();
    const seen: ClientOptions[] = [];

    const status = await readHostStatus(env, {
      connect: async (options) => {
        seen.push(options);
        return client;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("ws://127.0.0.1:8790");
    expect(seen[0].token).toBe("local-token");
    expect(status).toEqual({ running: true, endpoint: "127.0.0.1:8790", host: VERSION });
    expect(closed()).toBe(true);
  });

  it("显式地址 → 连那个地址（本机的发现文件不看），凭证来自设置", async () => {
    // 盘上摆一台「本机宿主」，显式地址必须压过它
    seedLocalHost("127.0.0.1", 8790);
    const seen: ClientOptions[] = [];

    await readHostStatus(
      { ...env, serverUrl: REMOTE_URL, serverToken: "tok" },
      {
        connect: async (options) => {
          seen.push(options);
          return fakeClient().client;
        },
      },
    );

    expect(seen[0].url).toBe("wss://ai-zen.example.com:443/ai-zen");
    expect(seen[0].token).toBe("tok");
  });

  it("显式地址指向本机回环且没给凭证 → 回落读 <aiZenDir>/run/token", async () => {
    seedLocalHost("127.0.0.1", 8790, "local-token");
    const seen: ClientOptions[] = [];

    await readHostStatus(
      { ...env, serverUrl: "ws://127.0.0.1:8790" },
      {
        connect: async (options) => {
          seen.push(options);
          return fakeClient().client;
        },
      },
    );

    expect(seen[0].token).toBe("local-token");
  });

  it("连不上 → 不在跑，原因是那句话（不是「没有发现文件」）", async () => {
    const status = await readHostStatus(
      { ...env, serverUrl: "ws://127.0.0.1:1" },
      {
        connect: async () => {
          throw new Error("连不上宿主（127.0.0.1:1）");
        },
      },
    );

    expect(status).toEqual({ running: false, reason: "连不上宿主（127.0.0.1:1）" });
  });
});

describe("boundCall：把 call 当值递下去", () => {
  it("返回的就是那一个函数（旧路是闭包，本来就不吃 `this`）", async () => {
    const seen: string[] = [];
    const fake = {
      call: async (method: string) => {
        seen.push(method);
        return method;
      },
    } as unknown as Parameters<typeof boundCall>[0];
    const detached = boundCall(fake);

    expect(detached).toBe(fake.call);
    await expect(detached("host.version" as never, {} as never)).resolves.toBe("host.version");
    expect(seen).toEqual(["host.version"]);
  });
});
