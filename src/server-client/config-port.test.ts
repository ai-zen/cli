/**
 * `ConfigPort` 的两个实现。
 *
 * 分两段测，因为它们是两条**不同的落盘位置**：
 *
 *   · local —— 包一层现有本地函数：验的是「行为与改造前一致」（真读真写临时目录）；
 *   · remote —— 走服务端的 `config.*` / `agent.*`：验的是「客户端不碰磁盘也能拿到同一份
 *     事实」，用的是真 Daemon + 真 socket + 服务端自己的临时目录。
 *
 * 两段都用临时目录，绝不碰 `~/.ai-zen`：本地段靠 `useTempAiZenDir()` 把 `AI_ZEN_DIR`
 * 钉到临时根，远程段把目录作为 `aiZenDir` 注入 Daemon。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_ADMIN_METHODS,
  AGENT_METHODS,
  CONFIG_METHODS,
  ConfigService,
  Daemon,
  FileSessionStore,
  SessionAgentFactory,
  SessionManager,
  WORKSPACE_METHODS,
  createAgentHandlers,
  createConfigHandlers,
  createSessionHandlers,
  type AgentLike,
  type ServerEvent,
} from "@ai-zen/agents-server";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { useTempAiZenDir } from "../test-support/temp-dir.js";
import { createLocalConfigPort, createRemoteConfigPort } from "./config-port.js";
import { SocketServerClient } from "./socket-server-client.js";
import type { ClientInfo, ServerClient } from "./types.js";

/** 临时根：`pin()` 把 env 与路径一起重算，`cleanup()` 收尾时连 env 一起还原 */
const zen = useTempAiZenDir("aiz-config-port-");
const localDir = zen.dir;

const NOW = "2026-01-01T00:00:00.000Z";

function definitionOf(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    messages: [],
    modelId: "some-old-model",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

describe("createLocalConfigPort：进程内模式（包一层本地函数）", () => {
  beforeEach(async () => {
    // 进程内共享模块：别的文件会改 `AI_ZEN_DIR`，每个用例前钉回本文件的临时根
    zen.pin();
    // 每例从空目录开始：上个用例写下的配置 / 定义不能漏进来
    await fs.rm(localDir, { recursive: true, force: true });
  });

  afterAll(() => {
    zen.cleanup();
  });

  it("readConfig / saveConfig：改一个字段写回，再读得到（真的落盘）", async () => {
    const port = createLocalConfigPort();

    // 空目录下第一次读会初始化出厂配置（端点 / 模型 / 目录），这是本地模式原有的行为
    const before = await port.readConfig();
    expect(Array.isArray(before.endpoints)).toBe(true);
    expect(before.maxToolOutput).not.toBe(4242);

    await port.saveConfig({ ...before, maxToolOutput: 4242 });

    expect((await port.readConfig()).maxToolOutput).toBe(4242);
    // 不只是内存里对：盘上那份也得是它
    const onDisk = JSON.parse(readFileSync(join(localDir, "config.json"), "utf-8")) as {
      maxToolOutput?: number;
    };
    expect(onDisk.maxToolOutput).toBe(4242);
  });

  it("readMcpConfig：文件不存在是空配置，坏文件是「可展示的状态」而不是空配置", async () => {
    const port = createLocalConfigPort();

    // 不存在：正常的空配置（`ok: true`）
    expect(await port.readMcpConfig("global")).toEqual({ ok: true, config: { mcpServers: {} } });

    // 写一份再读回来：作用域参数真的转给了本地函数（落点是 `<AI_ZEN_DIR>/mcp.json`）
    const mcpConfig = { mcpServers: { demo: { command: "echo", args: ["hi"] } } };
    await port.writeMcpConfig(mcpConfig, "global");
    expect(await port.readMcpConfig("global")).toEqual({ ok: true, config: mcpConfig });

    // 坏文件：`ok: false` + 有 error 原文，且**不冒充**「没有服务器」——
    // 编辑屏要能显示「这个文件坏了」，用户才不会一保存就把原内容覆盖掉
    await fs.writeFile(join(localDir, "mcp.json"), "{ bad json", "utf-8");
    const broken = await port.readMcpConfig("global");
    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error("unreachable: 坏文件不该被当成可用的配置");
    expect(broken.error).toMatch(/JSON/i);
    expect(broken).not.toHaveProperty("config");
  });

  it("readAgentStore：能列出 agents / subAgents，save / remove 都落到对应目录", async () => {
    const port = createLocalConfigPort();
    // 先读一次配置：出厂初始化会把 agents / sub-agents 目录与出厂定义一起放出来
    await port.readConfig();

    const initial = await port.readAgentStore();
    expect(initial.agents.map((def) => def.id)).toContain("default");
    expect(initial.subAgents.length).toBeGreaterThan(0);

    await initial.save("agent", definitionOf("port-agent"));
    await initial.save("subagent", definitionOf("port-sub"));

    // 重新读一次快照：列表来自磁盘，不是上面那次 list 的缓存
    const listed = await port.readAgentStore();
    expect(listed.agents.map((def) => def.id)).toContain("port-agent");
    expect(listed.subAgents.map((def) => def.id)).toContain("port-sub");
    expect(existsSync(join(localDir, "agents", "port-agent.json"))).toBe(true);
    expect(existsSync(join(localDir, "sub-agents", "port-sub.json"))).toBe(true);

    await listed.remove("agent", "port-agent");
    expect((await port.readAgentStore()).agents.map((def) => def.id)).not.toContain("port-agent");
  });

  it("setModel：写 definition.modelId 并清空 modelParams（换模型即重置思考强度）", async () => {
    const port = createLocalConfigPort();
    // 出厂配置里已经有模型；换到一个**存在**的模型上（不存在是另一条错误路径）
    const config = await port.readConfig();
    const targetModelId = config.models[0].id;

    const definition = definitionOf("port-agent", {
      name: "Port Agent",
      modelParams: { thinking: { type: "disabled" } },
    });
    await fs.mkdir(join(localDir, "agents"), { recursive: true });
    await fs.writeFile(
      join(localDir, "agents", "port-agent.json"),
      JSON.stringify(definition, null, 2),
      "utf-8",
    );

    await port.setModel("port-agent", targetModelId);

    const onDisk = JSON.parse(
      await fs.readFile(join(localDir, "agents", "port-agent.json"), "utf-8"),
    ) as AgentDefinition;
    expect(onDisk.modelId).toBe(targetModelId);
    // 旧模型的思考参数对新模型可能非法，所以是**清掉**（不是留空对象）
    expect(onDisk).not.toHaveProperty("modelParams");
    // 其它字段一个都不能丢：写入是「读 → 改字段 → 写回」
    expect(onDisk.name).toBe("Port Agent");
  });
});

// ==================================================================
// 客户端模式：真 Daemon + 真 socket + 服务端自己的临时目录
// ==================================================================

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let connection: SocketServerClient | null = null;

/**
 * 配置面一个会话都不开，`SessionManager` 只是 `createSessionHandlers` 的必填依赖
 * （`workspace.resolve` 归那个 handler 管）。真被调用到就说明用例跑偏了，所以直接报错。
 */
function unusedAgent(): AgentLike {
  throw new Error("config-port 的用例不该拉起 Agent");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-config-port-remote-"));
  manager = new SessionManager({
    createAgent: async () => unusedAgent(),
    nextSessionId: () => "chat_test",
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
  });
});

afterEach(async () => {
  connection?.close();
  connection = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一份最小配置与 Agent 定义。
 *
 * 两个模型：`test-model` 是定义里原本在用的，`alt-model` 是 `setModel` 的目标 ——
 * 只有一个模型就断言不了「modelId 变了」。
 */
function seed(): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      models: [
        {
          id: "test-model",
          name: "Test",
          endpointId: "e",
          tokenThresholds: { handoff: 1, guard: 2 },
          custom: true,
        },
        {
          id: "alt-model",
          name: "Alt",
          endpointId: "e",
          tokenThresholds: { handoff: 1, guard: 2 },
          custom: true,
        },
      ],
      defaultAgent: "default",
      version: 4,
    }),
  );
  writeFileSync(
    join(dir, "agents", "default.json"),
    JSON.stringify({
      id: "default",
      name: "默认",
      modelId: "test-model",
      // 换模型要清掉的正是它
      modelParams: { thinking: { type: "disabled" } },
      messages: [],
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function start(): Promise<void> {
  seed();
  const factory = new SessionAgentFactory({ aiZenDir: dir, homeDir: dir });
  const configService = new ConfigService({
    configFile: join(dir, "config.json"),
    agentsDir: join(dir, "agents"),
    subAgentsDir: join(dir, "sub-agents"),
    globalMcpFile: join(dir, "mcp.json"),
    workspacesRoot: join(dir, "workspaces"),
  });

  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: {
      ...createSessionHandlers({
        manager: manager!,
        workspacesRoot: join(dir, "workspaces"),
        // 客户端**不给** path 时服务端落在这个目录上：项目作用域的 mcp.json 就在它下面
        defaultWorkspacePath: dir,
      }),
      ...createAgentHandlers({ factory, config: configService }),
      ...createConfigHandlers({ config: configService }),
    },
  });
  await daemon.start();
  connection = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
}

describe("createRemoteConfigPort：客户端模式（配置落在服务端）", () => {
  it("readConfig / saveConfig：改一个字段写回，读回来是新的", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });

    const before = await port.readConfig();
    expect(before.models.map((model) => model.id)).toEqual(["test-model", "alt-model"]);

    await port.saveConfig({ ...before, maxToolOutput: 4242 });

    expect((await port.readConfig()).maxToolOutput).toBe(4242);
    // 落盘发生在**服务端**那个目录里（客户端进程一个字节都没写）
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as {
      maxToolOutput?: number;
    };
    expect(onDisk.maxToolOutput).toBe(4242);
  });

  it("readMcpConfig / writeMcpConfig（project）：工作区由服务端解析，文件落在工作区里", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });

    // 没有文件时是空配置；project 作用域要的 workspaceId 由服务端用它自己的目录解析
    // （Daemon 的 defaultWorkspacePath = dir），所以这里不必也不该上送路径
    expect(await port.readMcpConfig("project")).toEqual({ ok: true, config: { mcpServers: {} } });

    const mcpConfig = { mcpServers: { demo: { command: "echo", args: ["hi"] } } };
    await port.writeMcpConfig(mcpConfig, "project");
    expect(await port.readMcpConfig("project")).toEqual({ ok: true, config: mcpConfig });

    // 项目级 mcp.json 的位置是 `<工作区>/.ai-zen/mcp.json`，而工作区 = 服务端的目录
    expect(existsSync(join(dir, ".ai-zen", "mcp.json"))).toBe(true);
  });

  it("readAgentStore / save：定义真的写进了服务端的定义目录", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });

    const store = await port.readAgentStore();
    expect(store.agents.map((def) => def.id)).toEqual(["default"]);
    expect(store.subAgents).toEqual([]);

    await store.save("agent", definitionOf("remote-agent", { name: "Remote Agent" }));

    expect(existsSync(join(dir, "agents", "remote-agent.json"))).toBe(true);
    // 快照重新从服务端读：列表不是上一次 list 的残留
    expect((await port.readAgentStore()).agents.map((def) => def.id).sort()).toEqual([
      "default",
      "remote-agent",
    ]);
  });

  it("setModel：modelId 变了，modelParams 被清空（换模型即重置思考强度的回归保护）", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });

    await port.setModel("default", "alt-model");

    // 从服务端重新读一遍定义（不是拿本地拼的那份）
    const def = (await port.readAgentStore()).agents.find((item) => item.id === "default")!;
    expect(def.modelId).toBe("alt-model");
    expect(def).not.toHaveProperty("modelParams");

    // 盘上那份也是：换模型写的是 Agent 定义，不是会话
    const onDisk = JSON.parse(readFileSync(join(dir, "agents", "default.json"), "utf-8")) as {
      modelId?: string;
      modelParams?: unknown;
    };
    expect(onDisk.modelId).toBe("alt-model");
    expect(onDisk.modelParams).toBeUndefined();
  });
});

// ==================================================================
// 连接策略：懒连接、复用、断后重建、项目作用域不带路径
// ==================================================================

/** 一条记下「调了什么」的假连接：验的是端口的连接策略，不是服务端 */
interface RecordedCall {
  method: string;
  params?: unknown;
}

function fakeClient(calls: RecordedCall[]): ServerClient & { closed: boolean } {
  const client = {
    address: { host: "127.0.0.1", port: 0 },
    closed: false,
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case CONFIG_METHODS.get:
          return { config: { endpoints: [], models: [] } } as T;
        case CONFIG_METHODS.reasoningPresets:
          return { presets: {} } as T;
        case CONFIG_METHODS.mcpGet:
          return { ok: true, config: { mcpServers: {} } } as T;
        case WORKSPACE_METHODS.resolve:
          return { workspaceId: "ws_fake", path: "/srv/proj" } as T;
        case AGENT_ADMIN_METHODS.list:
          return { agents: [], subAgents: [] } as T;
        default:
          return { saved: true } as T;
      }
    },
    on<E extends ServerEvent["event"]>(
      _event: E,
      _listener: (payload: Extract<ServerEvent, { event: E }>) => void,
    ): () => void {
      return () => {};
    },
    close(): void {
      client.closed = true;
    },
  };
  return client;
}

describe("createRemoteConfigPort：连接的懒建与重建（注入假连接）", () => {
  it("构造时不连；第一次调用才建，之后复用同一条", async () => {
    const calls: RecordedCall[] = [];
    let connects = 0;
    const port = createRemoteConfigPort({
      connect: async () => {
        connects += 1;
        return fakeClient(calls);
      },
    });

    // 构造完一个连接都还没建：配置面可能在会话之前就要用，那时也不该白连一条
    expect(connects).toBe(0);

    const config = await port.readConfig();
    expect(connects).toBe(1);
    await port.saveConfig(config);
    await port.setModel("default", "m");
    await port.readAgentStore();

    expect(connects).toBe(1);
    expect(calls.map((call) => call.method)).toEqual([
      CONFIG_METHODS.get,
      CONFIG_METHODS.save,
      AGENT_METHODS.setModel,
      AGENT_ADMIN_METHODS.list,
    ]);
  });

  it("连接已关闭 → 下一次调用重建一条（服务端可以随时重启）", async () => {
    const first: RecordedCall[] = [];
    const second: RecordedCall[] = [];
    const clients: Array<ServerClient & { closed: boolean }> = [];
    let connects = 0;
    const port = createRemoteConfigPort({
      connect: async () => {
        connects += 1;
        const client = fakeClient(connects === 1 ? first : second);
        clients.push(client);
        return client;
      },
    });

    await port.readConfig();
    expect(connects).toBe(1);

    clients[0]!.closed = true;
    await port.readConfig();

    expect(connects).toBe(2);
    expect(second.map((call) => call.method)).toEqual([CONFIG_METHODS.get]);
  });

  it("project 作用域：不带 path 地问服务端，问一次就缓存", async () => {
    const calls: RecordedCall[] = [];
    const port = createRemoteConfigPort({
      connect: async () => fakeClient(calls),
    });

    await port.readMcpConfig("project");
    await port.writeMcpConfig({ mcpServers: {} }, "project");

    const resolves = calls.filter((call) => call.method === WORKSPACE_METHODS.resolve);
    expect(resolves).toHaveLength(1);
    // 不带 path：工作区在哪是服务端的事实，客户端不替它决定
    expect(resolves[0]!.params).toEqual({});

    expect(calls.filter((call) => call.method === CONFIG_METHODS.mcpGet)[0]!.params).toEqual({
      scope: "project",
      workspaceId: "ws_fake",
    });
    expect(calls.filter((call) => call.method === CONFIG_METHODS.mcpSave)[0]!.params).toMatchObject({
      scope: "project",
      workspaceId: "ws_fake",
    });
  });

  it("global 作用域不问工作区（多一次往返，也多一个会漂的答案）", async () => {
    const calls: RecordedCall[] = [];
    const port = createRemoteConfigPort({
      connect: async () => fakeClient(calls),
    });

    await port.readMcpConfig("global");

    expect(calls.map((call) => call.method)).toEqual([CONFIG_METHODS.mcpGet]);
    expect(calls[0]!.params).toEqual({ scope: "global" });
  });
});
