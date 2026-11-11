/**
 * `RemoteChatSession` 的端到端测试：真 socket + 真 Daemon + 真存档（临时目录）+ 假 Agent。
 *
 * 这是「TUI 换源」的护栏：屏幕要的那几个事实（消息、阶段、模型、用量、id）全都必须
 * 只能从服务端拿到，而 `send()` 的语义要**与进程内模式一致**（一轮跑完才 resolve）。
 *
 * 工作区那几件事也在这里定死：本地服务端（loopback）时客户端递自己的 cwd、远端不递、
 * `@` 补全的清单来自服务端磁盘、续接问 `session.last`。用例里的会话默认显式传
 * `path: workspaceDir`（要断言「跑在哪个目录」就得有确定的期望值），不传 path 的
 * 「本地取 cwd」那条另有专门用例。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createSessionHandlers,
  FileSessionStore,
  SessionManager,
  type AgentLike,
  type CreateAgentInput,
  type ModelLevel,
} from "@ai-zen/agents-server";
import { AgentNS } from "@ai-zen/agents-core";
import { RemoteSessions } from "./server-client/index.js";
import type { ModelParams } from "./server-client/index.js";
import { ServerConnection, SocketServerClient } from "./server-client/index.js";
import type { ServerClient } from "./server-client/index.js";
import type {
  AutoMigrateTriggerInfo,
  AppConfig,
  HandoffMode,
  ReasoningPresets,
} from "@ai-zen/agents-sdk";
import { runCommand, type ChatCommandHost } from "./commands/handlers.js";
import { setLocale } from "./i18n/index.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";
import { RemoteChatSession } from "./session.js";
import { clientWorkspacePath } from "./server-client/index.js";
import type { ConfigPort } from "./server-client/index.js";
import type { ChatSessionNotifier } from "./session/types.js";

class FakeAgent implements AgentLike {
  messages: any[] = [];
  lastUsage: AgentNS.Usage | undefined = undefined;
  /** 三级解析的档位（真件由 SDK 的 `createAgent` 给；假件照抄这一位） */
  modelLevel: ModelLevel = "agent";
  /**
   * 交接要用的那几面（真件是 SDK 的 `SdkAgent`）；无 write 工具 → 走摘要模式。
   *
   * 形状照抄真件：SDK 交给 Agent 的是**解析之后**的定义，服务端的快照就从这上面读
   * `modelId` / `modelParams`（`modelIdOf` / `agentModelParamsOf`）。所以假件也必须由
   * `createAgent` 把服务端递进来的这两个值抄上去 —— 否则「换完模型，快照里就是新模型」
   * 永远测不出来：假件永远说 `test-model`。
   */
  definition: { messages: any[]; modelId: string; modelParams?: Record<string, unknown> } = {
    messages: [] as any[],
    modelId: "test-model",
  };
  tools: Array<{ function?: { name?: string } }> = [];
  model = "test-model";
  modelConfig: Record<string, unknown> = {};
  client: unknown = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: DOC } }] }) } },
  };
  scope = { cwd: "/work/proj" };
  use(_plugin: unknown): void {}
  sent: string[] = [];
  aborted = 0;

  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };

  send(input: string): Promise<unknown> {
    this.sent.push(input);
    return Promise.resolve();
  }
  abort(): void {
    this.aborted++;
  }
  /** 手动驱动 SDK 时序：测试就是服务端那一侧的「模型」 */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

/** 交接文档正文（SDK 有 400 字节阈值） */
const DOC = `# 交接\n\n${"- 桩\n".repeat(80)}`;

let dir: string;
/**
 * 服务端自己的工作目录（Daemon 的 `defaultWorkspacePath`）。
 *
 * 客户端不再上送 `process.cwd()`：会话的工作目录由服务端决定，所以它就是每个用例里
 * 「这段会话到底跑在哪个目录」的期望值。
 */
let workspaceDir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let agent: FakeAgent;
let client: SocketServerClient | null = null;
let session: RemoteChatSession | null = null;
/** `open()` 造的那条连接（用例要拿它手上那条 client 做断言） */
let sessionConnection: ServerConnection | null = null;
let notices: Array<{ text: string; tone: "info" | "error" }>;
let changes: number;
/**
 * 下一次重连要连到哪个端口 —— 由用例在**断线之后**才填进来。
 *
 * 重连的第一跳就在 `close` 通知里立刻发生，而新 Daemon 的端口要等它起来才知道
 * （`port: 0` 由系统分配）。用一个信号把两者接上：注入的重连函数先等端口再连，
 * 于是「断线 → 起新服务端 → 重连」既不需要固定 `sleep`，也不会白白撞掉几次尝试。
 */
let nextServer: PortSignal;
/** 默认注入的重连被调了几次 */
let reconnectCalls: number;

/**
 * 拼图片内容块要读配置（端点 / 视觉能力），绝不能读真实 `~/.ai-zen`。
 * 进程内共享模块下只有 `pin()` 能让路径真的生效（见 test-support/temp-dir.ts）。
 */
const zen = useTempAiZenDir("aiz-remote-chat-");

/**
 * 配置面：图片链路按「服务端那份配置」判断端点能力，这里就是临时根里那份文件。
 *
 * 别让它走真实实现 —— `createRemoteConfigPort()` 会 `ensureServer`（拉起一个真进程）。
 */
const testConfigPort: ConfigPort = {
  readConfig: async () => JSON.parse(readFileSync(join(zen.dir, "config.json"), "utf-8")),
  readConfigFile: async () => ({
    config: JSON.parse(readFileSync(join(zen.dir, "config.json"), "utf-8")),
    path: join(zen.dir, "config.json"),
  }),
  saveConfig: async () => {},
  readReasoningPresets: async () => ({}) as never,
  readMcpConfig: async () => ({ ok: true, config: { mcpServers: {} } }) as never,
  writeMcpConfig: async () => {},
  readAgentStore: async () =>
    ({ agents: [], subAgents: [], save: async () => {}, remove: async () => {} }) as never,
  setModel: async () => {},
  setDefaultAgent: async () => {},
  setDefaultModel: async () => {},
};

/**
 * `/model` / `/think` 读的那份配置面：两个模型同端点、都带 Key，策略表有两档。
 *
 * 与 `testConfigPort` 分开是因为它答的是**另一个问题** —— 上面那个只为图片链路提供
 * 端点能力，而这两条命令要的是「可切换的模型列表 + 可选的思考档位」。
 */
const commandConfig: ConfigPort = {
  ...testConfigPort,
  readConfig: async () =>
    ({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      models: [
        {
          id: "test-model",
          name: "Test",
          endpointId: "e",
          tokenThresholds: { handoff: 1000, guard: 2000 },
          reasoningPreset: "effort",
        },
        {
          id: "alt-model",
          name: "Alt",
          endpointId: "e",
          tokenThresholds: { handoff: 1000, guard: 2000 },
          reasoningPreset: "effort",
        },
      ],
      defaultAgent: "default",
      version: 4,
    }) as AppConfig,
  readReasoningPresets: async () =>
    ({
      effort: { levels: { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" } } },
    }) as ReasoningPresets,
};

/**
 * 命令层的宿主假件（只造 `/model` / `/think` 会碰到的口子）。
 *
 * 会话是**真件**（真 socket + 真服务端 + 真存档）：这两条用例要断言的正是「写完之后状态里
 * 是什么」，而那份状态只能由包里的 `applySnapshot` 产生 —— 假会话上断言等于自问自答。
 * 要假的只有界面那几个回调与配置面。
 */
function commandHost(opened: RemoteChatSession, config: ConfigPort): ChatCommandHost {
  return {
    session: opened,
    config,
    notice: (text, tone) => notices.push({ text, tone: tone ?? "info" }),
    clearTranscript: () => {},
    rows: 24,
    exit: () => {},
    suspendTerminal: async (fn) => {
      await fn();
    },
    openWizard: async () => {},
    openKeyEditor: async () => {},
    doExit: () => {},
    restartProcess: async () => {},
    pick: async () => null,
    confirm: async () => false,
    setInputText: () => {},
    setEffortView: () => {},
    refreshLocale: () => {},
  };
}

const notifier: ChatSessionNotifier = {
  onChange: () => {
    changes += 1;
  },
  onNotice: (text, tone) => notices.push({ text, tone }),
};

beforeEach(() => {
  setLocale("zh");
  zen.pin();
  // 图片链路要按实发模型名反查端点：`test-model` 与 FakeAgent 的 model 同名
  writeFileSync(
    join(zen.dir, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      // `vision: true` 才走真图片内容块（否则 SDK 会把它降级成文本提示，测不到链路）
      models: [{ id: "test-model", name: "Test", endpointId: "e", custom: true, vision: true }],
      defaultAgent: "default",
      version: 4,
    }),
  );
  dir = mkdtempSync(join(tmpdir(), "aiz-remote-chat-"));
  workspaceDir = join(dir, "proj");
  // 服务端的工作目录得真的存在（生产里它就是服务端进程的 cwd）
  mkdirSync(workspaceDir, { recursive: true });
  agent = new FakeAgent();
  notices = [];
  changes = 0;
  nextServer = portSignal();
  reconnectCalls = 0;
  manager = newManager();
  agentClaimed = false;
});

afterEach(async () => {
  session?.dispose();
  session = null;
  sessionConnection = null;
  client?.close();
  client = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  zen.cleanup();
});

/**
 * 等到条件成立（或超时）。
 *
 * 真 socket 上的事件没有确定性时机：`send` 的受理与事件的到达都依赖事件循环，
 * 固定 `sleep(20)` 在机器一忙时就翻车。这里只等到**该发生的事发生**，不猜时长。
 */
async function waitUntil(what: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 同上，但条件本身要**问服务端**（异步）：`/new` 与 `dispose()` 发的 `session.close` 都是
 * 「帧发出去就算完」的，落地时间只能轮询。
 */
async function waitUntilAsync(what: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 一个可以先发后到的端口：`promise` 给重连等，`settle()` 由用例在新 Daemon 起来后调 */
interface PortSignal {
  readonly promise: Promise<number>;
  settle: (port: number) => void;
}

function portSignal(): PortSignal {
  let settle!: (port: number) => void;
  const promise = new Promise<number>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** 一个**新的** SessionManager（同一个 `dir`、同一份存档根）。
 *
 * 重连用例要“换一台服务端”：新实例的内存里没有那段会话，只能从盘上把它装回来 ——
 * 这正是 `session.attach` 的「盘上有就装回来」那条路。
 */
/** `createAgent` 最近一次收到的入参：用例要靠它拿服务端注入的 `resolveMode` */
let lastAgentInput: CreateAgentInput | undefined;
/** 上面那个假 Agent 已经被哪一段会话认领了（见 `createAgent` 的注释） */
let agentClaimed = false;

function newManager(): SessionManager {
  let counter = 0;
  return new SessionManager({
    createAgent: async (input) => {
      lastAgentInput = input;
      /**
       * **新会话 = 空的新 Agent**（与生产一致：`session.create` 现造一个，不继承上一段
       * 的消息）。共用同一个假件会把「`/new` 之后快照是空的」这个事实掩盖掉 —— 那正是
       * 客户端自己 `currentMessages = []` 遮住的也正是这件事。
       *
       * 首次建 Agent 时保留用例预置的那个（用例经常先 `agent.messages = [...]` 再
       * `open()`）；之后的 `reload` / `setAgent` 由服务端的 `adoptAgent` 把消息搬过去，
       * 所以「保留消息」那几条仍然成立。
       */
      if (agentClaimed) agent = new FakeAgent();
      agentClaimed = true;
      // 真服务端这一跳会按 `input.modelId` / `input.modelParams` **重建** Agent，快照里的
      // `modelId` / `modelParams` 就是从重建后的定义里读的（`modelIdOf` / `agentModelParamsOf`）。
      // 不抄的话「换完模型快照里就是新模型」测的是假件的默认值，不是服务端的行为。
      if (input.modelId) {
        agent.model = input.modelId;
        agent.definition.modelId = input.modelId;
      }
      /**
       * 档位也照真件抄：`input.modelId` 只在**会话级覆盖**存在时才会从服务端递下来
       * （`SessionManager` 只把 `session.modelId` 塞进 `createAgent` 的入参），所以它一出现，
       * 真件的 `resolveModel` 就会把档位解析成 `session`。
       *
       * 不抄的话假件永远说 `agent`，而 `/think` 的写路径正是按它分叉的 —— 会话级那条
       * 会永远进不了用例。
       */
      agent.modelLevel = input.modelId ? "session" : "agent";
      // `null` / 没给 = 不带覆盖（与「从来没设过」同一条路），所以只有真给了才抄
      if (input.modelParams == null) delete agent.definition.modelParams;
      else agent.definition.modelParams = input.modelParams as Record<string, unknown>;
      return agent;
    },
    nextSessionId: () => `chat_${++counter}`,
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
    handoff: { aiZenDir: join(dir, "ai-zen"), homeDir: dir },
  });
}

function newDaemon(): Daemon {
  return new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: createSessionHandlers({
      manager: manager!,
      workspacesRoot: join(dir, "workspaces"),
      // 客户端不上送路径：开会话用它（**服务端**的目录）
      defaultWorkspacePath: workspaceDir,
    }),
  });
}

async function connectTo(port: number): Promise<SocketServerClient> {
  return await SocketServerClient.connect({
    address: { host: "127.0.0.1", port },
    client: { name: "@ai-zen/cli", version: "0.0.0-test" },
  });
}

/**
 * 默认注入的「重建」：等用例交出端口，再连过去（生产里这就是 `ServerConnection` 的
 * `connect`）—— 用例一律走注入而不是 `vi.mock`。
 */
const reconnectToNextServer = async (): Promise<ServerClient> => {
  reconnectCalls += 1;
  return await connectTo(await nextServer.promise);
};

/**
 * 造一条**由用例控制重建**的连接。
 *
 * 生产的连接归组装根（一个进程一条）；用例要的是一条能指向「另一个端口」的：
 * 第一次 `client()` 交出已经连好的那条，之后交给 `reconnect`。
 * 这样 `ServerConnection` 的三条不变式（查活 / 单飞 / 重新订阅 `events.watch`）在用例里
 * 跑的就是**生产那份实现**，而不是测试自己又写一遍。
 */
function connectionFor(
  client: ServerClient,
  reconnect: () => Promise<ServerClient> = reconnectToNextServer,
): ServerConnection {
  let seeded: ServerClient | null = client;
  return new ServerConnection({
    connect: async () => {
      if (seeded) {
        const first = seeded;
        seeded = null;
        return first;
      }
      return await reconnect();
    },
  });
}

/**
 * 盯着一个 promise（不 await 它）：回调里写，用例轮询着等。
 *
 * 用对象回读而不是局部变量：`then` 回调里的赋值不算进 TS 的控制流，局部变量会被收窄成
 * 初始化值（读到的类型和运行时不是一回事）；对象的属性不受这个收窄影响。
 */
interface Watch<T> {
  settled: boolean;
  value?: T;
  error?: Error;
}

function watch<T>(promise: Promise<T>): Watch<T> {
  const watched: Watch<T> = { settled: false };
  void promise.then(
    (value) => {
      watched.value = value;
      watched.settled = true;
    },
    (error) => {
      watched.error = error as Error;
      watched.settled = true;
    },
  );
  return watched;
}

/**
 * 服务端那侧的“断线”：停掉当前 Daemon，并在**同目录**起一个新的（新端口、新 SessionManager）。
 *
 * 返回新 Daemon 的端口 —— 用例接着 `nextServer.settle(port)` 把重连引到它上面。
 */
async function restartServer(reason = "test disconnect"): Promise<number> {
  if (daemon) {
    await daemon.stop(reason);
    daemon = null;
  }
  // 旧连接跟着旧 Daemon 一起没了；之后的调用要么走会话自己的重连，要么就该失败
  client = null;
  manager?.dispose();
  manager = newManager();
  daemon = newDaemon();
  await daemon.start();
  return daemon.port;
}

/**
 * 起服务端 + 连一条连接。
 *
 * 分出来单独一步：有些用例（续接）要**在开会话之前**先往服务端的存档目录里造一份旧档，
 * 而那个目录属于哪个工作区只有服务端知道（`workspace.resolve` 说了算）。
 */
async function startServer(): Promise<SocketServerClient> {
  if (client) return client;
  daemon = newDaemon();
  await daemon.start();
  client = await connectTo(daemon.port);
  return client;
}

/** `open()` 的第二个参数：用例只关心「重建到哪」与「用哪份假配置」 */
interface TestDeps {
  reconnect?: () => Promise<ServerClient>;
  config?: ConfigPort;
}

/** 起服务端并开一段远程会话。
 *
 * 默认把 `path` 固定成服务端的工作目录：用例里要断言「这档会话跑在哪个目录」时，
 * 期望值就必须是确定的。**不传 `path`** 的那种情况（本地取客户端 cwd）另有专门用例。
 */
async function open(
  input: {
    path?: string;
    agentId?: string;
    sessionId?: string;
    resume?: boolean;
    /** 自动迁移的选择器（`ChatSessionOptions.requestMode` 的同一个回调） */
    requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
  } = {},
  deps: TestDeps = { reconnect: reconnectToNextServer, config: testConfigPort },
): Promise<RemoteChatSession> {
  const connected = await startServer();
  const connection = connectionFor(connected, deps.reconnect ?? reconnectToNextServer);
  sessionConnection = connection;
  session = await RemoteChatSession.open(connection, { path: workspaceDir, ...input }, notifier, {
    config: deps.config ?? testConfigPort,
  });
  return session;
}

/**
 * 那条连接上**此刻**的 client（重连之后就是新的那一条）。
 *
 * 连接与重建都是 `ServerConnection` 的事，所以「接上了没有」就它说了算
 * （`closed === false` 就是「手上这条还活着」）。
 */
async function currentClient(): Promise<ServerClient> {
  return await sessionConnection!.client();
}

/**
 * 服务端认定的默认工作区 → 它的存档 store（与 `SessionManager.storeFor` 同一个目录）。
 *
 * 服务端才是存档与指针的真相源，所以「造一段旧档」也造在**它**认定的那个工作区里：
 * 路径用 `workspace.resolve`（不带 path）问来，不在测试里推导 id 算法。
 */
async function defaultStore(): Promise<FileSessionStore> {
  const { workspaceId } = await new RemoteSessions(await startServer()).resolveWorkspace();
  return new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) });
}

/**
 * 「这段会话落在哪个工作区」—— 问服务端，不读客户端的私有字段。
 *
 * 工作区身份是**服务端的事实**（`workspace.resolve` 说了算），客户端手上那个 id 从来不是
 * 契约的一部分（`session.ts` 也不保存它）。用例要它的时候就问服务端要 ——
 * 这也正是「客户端不该自己推导 id 算法」那条规矩的用例版本。
 */
async function workspaceIdOf(path: string | undefined): Promise<string> {
  return (await new RemoteSessions(await startServer()).resolveWorkspace(path)).workspaceId;
}

describe("RemoteChatSession：开一段会话", () => {
  it("快照就是屏幕的全部事实：消息 / 阶段 / 模型 / id 都从服务端来", async () => {
    agent.messages = [{ role: "user", content: "上次聊到这儿" }];
    const opened = await open();

    expect(opened.currentId).toBe("chat_1");
    expect(opened.modelId).toBe("test-model");
    // 档位也是服务端解析的结果（假件手工装配的定义档）：`/model` 的选择器靠它标「当前生效档」
    expect(opened.modelLevel).toBe("agent");
    expect(opened.phase).toBeNull();
    expect(opened.messages).toEqual([{ role: "user", content: "上次聊到这儿" }]);
    // 还没人委派：栏目不出现（有子 Agent 才有这一栏）
    expect(opened.subAgents).toEqual([]);
  });
});

describe("RemoteChatSession：工作区归谁决定", () => {
  it("本地服务端（loopback）：不传 path 就用客户端 cwd —— 会话落在你敲 `ai` 的那个目录", async () => {
    const opened = await open({ path: undefined });

    // 判据是**会话真的跑在哪个目录**（`workspace.files` 扫的就是那个目录的磁盘）：
    // 不传 path 时客户端递的是自己的 cwd（本仓根），所以清单里应该有本仓的文件。
    // 这是「在项目里敲 `ai` 就接着这个项目」的全部依据。
    const entries = await opened.listWorkspaceFiles();
    expect(entries).toContainEqual({ path: "package.json", dir: false });
  });

  it("远端（非 loopback）：不递 cwd，用服务端自己的工作目录", async () => {
    // 判据就是地址：两机部署时客户端把自己进程的目录送上去，服务端根本没有那个目录
    expect(clientWorkspacePath("127.0.0.1", "/work/a")).toBe("/work/a");
    expect(clientWorkspacePath("localhost", "/work/a")).toBe("/work/a");
    expect(clientWorkspacePath("[::1]", "/work/a")).toBe("/work/a");
    expect(clientWorkspacePath("127.8.9.10", "/work/a")).toBe("/work/a");
    expect(clientWorkspacePath("192.168.1.20", "/work/a")).toBeUndefined();
    expect(clientWorkspacePath("ai.example.com", "/work/a")).toBeUndefined();
    // `0.0.0.0` 是监听地址，不是连接目标：不该当成「本地」
    expect(clientWorkspacePath("0.0.0.0", "/work/a")).toBeUndefined();
  });

  it("明确给了 path 就以它为准（同一个工作区里换会话用得上）", async () => {
    // 造一个只在那个目录里存在的文件：清单里有它，就说明会话真的跑在那个目录
    writeFileSync(join(workspaceDir, "only-here.txt"), "hi\n", "utf-8");
    const opened = await open({ path: workspaceDir });

    const entries = await opened.listWorkspaceFiles();
    expect(entries).toContainEqual({ path: "only-here.txt", dir: false });
  });

  it("listWorkspaceFiles：清单来自服务端磁盘，既有文件也有祖先目录条目", async () => {
    // 造几个**服务端那边**的真文件：补全扫的是会话真正跑在哪个目录
    mkdirSync(join(workspaceDir, "src", "tui"), { recursive: true });
    writeFileSync(join(workspaceDir, "README.md"), "# 服务端那边的文件\n", "utf-8");
    writeFileSync(join(workspaceDir, "src", "app.ts"), "export const app = 1;\n", "utf-8");
    writeFileSync(
      join(workspaceDir, "src", "tui", "chat.tsx"),
      "export const Chat = 1;\n",
      "utf-8",
    );

    const opened = await open();
    const entries = await opened.listWorkspaceFiles();

    // 文件条目：路径相对工作区根、`/` 分隔、不带 `./` 前缀
    expect(entries).toContainEqual({ path: "README.md", dir: false });
    expect(entries).toContainEqual({ path: "src/app.ts", dir: false });
    expect(entries).toContainEqual({ path: "src/tui/chat.tsx", dir: false });
    // 祖先目录条目（`dir: true`）：没有它们，远程模式下「钻目录」这个能力就不存在了
    expect(entries).toContainEqual({ path: "src", dir: true });
    expect(entries).toContainEqual({ path: "src/tui", dir: true });
    for (const entry of entries) expect(entry.path.startsWith("/")).toBe(false);
  });

  it("resume：上一轮会话的 id 与消息都由服务端给（客户端不搬消息）", async () => {
    const store = await defaultStore();
    await store.write({
      id: "chat_archived",
      agentId: "default",
      messages: [{ role: "user", content: "上次聊到这儿" }],
    });
    await store.setLastSession("chat_archived");

    const opened = await open({ resume: true });

    // id 是 `session.last` 给的那一个（客户端只说「接着上次」，没说接哪一段）
    expect(opened.currentId).toBe("chat_archived");
    // 消息来自 `session.snapshot`：服务端 `session.create` 把存档装进了 Agent
    expect(opened.messages).toEqual([{ role: "user", content: "上次聊到这儿" }]);
    expect(agent.messages).toEqual([{ role: "user", content: "上次聊到这儿" }]);
  });

  it("resume 但没有指针：开一段新会话，不报错", async () => {
    // 有存档、但「上一轮会话」指针没指它（从未保存过 / 已被改名）
    const store = await defaultStore();
    await store.write({
      id: "chat_archived",
      agentId: "default",
      messages: [{ role: "user", content: "没人指着的旧档" }],
    });

    const opened = await open({ resume: true });

    expect(opened.currentId).not.toBe("chat_archived");
    expect(opened.currentId).toBe("chat_1"); // 服务端分配的新 id
    expect(opened.messages).toEqual([]);
  });

  it("明确的 sessionId 优先于 resume：/load 选中的那段不被指针覆盖", async () => {
    const store = await defaultStore();
    await store.write({
      id: "chat_last",
      agentId: "default",
      messages: [{ role: "user", content: "指针指的那段" }],
    });
    await store.setLastSession("chat_last");
    await store.write({
      id: "chat_picked",
      agentId: "default",
      messages: [{ role: "user", content: "用户点的那段" }],
    });

    const opened = await open({ sessionId: "chat_picked", resume: true });

    expect(opened.currentId).toBe("chat_picked");
    expect(opened.messages).toEqual([{ role: "user", content: "用户点的那段" }]);
  });
});

describe("RemoteChatSession：send 的语义与进程内一致", () => {
  it("一轮跑完才 resolve（界面靠它管 busy），收尾用服务端快照纠正本地", async () => {
    const opened = await open();
    let finished = false;

    // 一轮 = `send()`（受理即回）+ `waitForTurn()`（等它真的结束）—— 与界面手里那对同形
    const pending = opened
      .send("你好")
      .then(() => opened.waitForTurn())
      .then(() => {
        finished = true;
      });
    // 回执已到、但这一轮还在跑：此时不该 resolve
    await waitUntil(() => agent.sent.length === 1);
    expect(finished).toBe(false);

    // 服务端这一侧：追加用户消息 → 流式两片 → 收尾
    //
    // 注意两片拼起来与最终那条 assistant **逐字一致**（"答" + "完了" = "答完了"）：
    // 生产里服务端那条权威消息就是由这些增量拼出来的，两者不会“一个是另一个的前缀而
    // 又不相等”。假件在这里必须守同样的约束，否则测的是包里的兜底分支（它是为“真的对不上”
    // 准备的：宁可重复也不吞字），而不是正常收尾。
    agent.messages.push({ role: "user", content: "你好" });
    agent.fire("chunk", { choices: [{ delta: { content: "答" } }] });
    agent.fire("chunk", { choices: [{ delta: { content: "完了" } }] });
    // 生成中就能读到临时拼出来的正文（屏幕要能滚起来）
    await waitUntil(() => JSON.stringify(opened.messages).includes("答完了"));
    expect(opened.phase).not.toBeNull();
    expect(finished).toBe(false);

    agent.messages.push({
      role: "assistant",
      content: "答完了",
      reasoning_content: "想一想",
    } as never);
    agent.fire("finally");
    await pending;

    expect(finished).toBe(true);
    // 收尾后是服务端那份权威消息（连 reasoning_content 都在），不是本地拼的近似
    expect(opened.messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "答完了", reasoning_content: "想一想" },
    ]);
    expect(opened.phase).toBeNull();
  });

  it("带图提交：图片真的发出去了（内容块里有文本段 + 内联图片）", async () => {
    const opened = await open();
    const pending = opened.send("看看这张图", [{ base64: "AAA", mime: "image/png" }]);
    await waitUntil(() => agent.sent.length === 1);

    // 文本段排在最前（图在文前会把指令切断），图片是内联 data URL
    expect(agent.sent[0]).toEqual([
      { type: "text", text: "看看这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);

    agent.messages.push({ role: "user", content: "看看这张图" });
    agent.fire("finally");
    await pending;
  });

  it("图片装不进一帧：只发文字并明确告知（超限帧会让服务端直接断连接）", async () => {
    const opened = await open();
    // 两张各 ~5MB：单张都过得了 SDK 的内联上限（8MiB），合起来超过单帧上限
    const big = "A".repeat(5_000_000);
    const pending = opened.send("看这两张", [
      { base64: big, mime: "image/png" },
      { base64: big, mime: "image/png" },
    ]);
    await waitUntil(() => agent.sent.length === 1);

    expect(agent.sent[0]).toBe("看这两张"); // 退成纯文本，不整条不发
    expect(notices.map((notice) => notice.text).join("")).toContain("超过单帧上限");
    expect(notices.at(-1)?.tone).toBe("error");

    agent.fire("finally");
    await pending;
  });

  it("abort 转发给服务端（由服务端掐本轮与进行中的交接）", async () => {
    const opened = await open();
    const pending = opened.send("长任务");
    await waitUntil(() => agent.sent.length === 1);

    opened.abort();
    await waitUntil(() => agent.aborted === 1);

    agent.fire("finally");
    await pending;
  });
});

describe("RemoteChatSession：存档与换 id 的方法", () => {
  it("save / saveAs / exists / listSaved 全都问服务端", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "留档" }];

    expect(await opened.save()).toBe("chat_1");
    expect(await opened.exists("chat_1")).toBe(true);
    expect(await opened.exists("chat_404")).toBe(false);

    expect(await opened.saveAs("chat_debug_login")).toBe("chat_debug_login");
    expect(opened.currentId).toBe("chat_debug_login");
    expect((await opened.listSaved()).map((ref) => ref.id)).toEqual(["chat_debug_login"]);

    // 换 id 之后服务端那条链路也认新 id：再存一次不该报 unknown-session
    expect(await opened.save()).toBe("chat_debug_login");
  });

  it("rollbackTo：服务端删消息并落盘，返回被删的首条用户消息（工作目录备注由客户端剥）", async () => {
    agent.messages = [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "答" },
      {
        role: "user",
        content: "第二个问题\n\n[system-injected: cwd]\nCurrent working directory: /work/proj",
      },
    ];
    const opened = await open();

    const text = await opened.rollbackTo(2);

    expect(text).toBe("第二个问题");
    expect(opened.messages).toHaveLength(2);

    // 落盘也是服务端做的：重新要一次快照，撤回的消息不会「复活」
    await opened.reload();
    expect(opened.messages).toHaveLength(2);
  });

  it("migrate：跟着新 id 走，消息被剔成「模板 + 交接断点」", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "旧任务" }];

    const path = await opened.migrate();

    expect(path.endsWith(".md")).toBe(true);
    expect(opened.currentId).not.toBe("chat_1"); // 换 id 了
    expect(JSON.stringify(opened.messages)).toContain(".md"); // 断点里带着文档路径
    expect(JSON.stringify(opened.messages)).not.toContain("旧任务"); // 历史被剔除
    // 新 id 上还能继续存/取（事件过滤也跟着新 id）
    expect(await opened.save()).toBe(opened.currentId);
  });

  it("reset：先把当前对话归档（有内容才存），再开一段新会话", async () => {
    agent.messages = [{ role: "user", content: "要归档的" }];
    const opened = await open();

    expect(await opened.reset()).toBe("chat_1");
    expect(opened.currentId).toBe("chat_2");
    expect(opened.messages).toEqual([]);
  });

  it("/new 换会话不换工作区：复用的是**服务端给的那个答案**", async () => {
    // 请求里带 `./`：规范化发生在服务端，客户端手上那份只是「意图」。`/new` 用的是答案
    // （`channel.path`），所以新会话仍然落在同一个工作区、跑在同一个目录。
    writeFileSync(join(workspaceDir, "only-here.txt"), "hi\n", "utf-8");
    const opened = await open({ path: `${workspaceDir}/./` });
    const sessions = new RemoteSessions(await startServer());
    const before = (await sessions.snapshot(opened.currentId)).workspaceId;
    // 服务端认定的就是那个目录（不是客户端自己推的 id）
    expect(before).toBe(await workspaceIdOf(workspaceDir));

    await opened.reset();

    // 新会话的工作区身份还是同一个（不是「又算了一遍、恰好像」）
    expect((await sessions.snapshot(opened.currentId)).workspaceId).toBe(before);
    // 而且真的跑在那个目录：清单位于服务端磁盘
    expect(await opened.listWorkspaceFiles()).toContainEqual({
      path: "only-here.txt",
      dir: false,
    });
  });

  it("handoff：不换 id，进度以本地文案进通知栏（服务端不产句子）", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "任务" }];

    const path = await opened.handoff();

    expect(opened.currentId).toBe("chat_1");
    const text = notices.map((notice) => notice.text).join("\n");
    expect(text).toContain("正在编写任务交接文档"); // handoffWriting
    expect(text).toContain(path); // handoffPath
    // 枚举被翻译过：界面里不该出现裸的 self
    expect(text).not.toContain("（self）");
  });
});

/**
 * 会话级的模型动作（`/model` / `/think`）。
 *
 * 它们走会话自己的 channel，不在应用里现取一次 `RemoteSessions` 门面：这样「当前这一段是
 * 哪个 id」与「接哪条连接」不会变成应用里两个会漂的来源。顺带钉住两件事：换完**立刻**是
 * 屏幕上的事实，且只通知一次重画（再补一次 `reload()` 就是多一个往返、多一次通知，而屏幕上
 * 不会多一个字）。
 */
describe("RemoteChatSession：会话级模型动作（走 channel，不现取门面）", () => {
  it("setModel：这一段会话的模型当场换成新的，且只通知一次重画", async () => {
    const opened = await open();
    const id = opened.currentId;
    const redraws = changes;
    const sessions = new RemoteSessions(await startServer());

    await opened.setModel("alt-model");

    // 不换 id：改的是**这一段会话**存档里的 modelId（别的会话、Agent 定义都不动）
    expect(opened.currentId).toBe(id);
    // 屏幕上的事实立刻是新的（包里 `setModel` 拿到快照就 `applySnapshot`）
    expect(opened.modelId).toBe("alt-model");
    // 服务端那一侧确实写了（不是客户端自己记一笔）
    expect((await sessions.snapshot(id)).modelId).toBe("alt-model");
    // 一次「该重画了」：再补一次 `reload()` 会变成两次，而屏幕上的字一个都不会变
    expect(changes).toBe(redraws + 1);
  });

  it("setModelParams：`null` 是「清掉这一层覆盖」，不是「调用方没给」", async () => {
    const opened = await open();
    const id = opened.currentId;
    const sessions = new RemoteSessions(await startServer());

    await opened.setModelParams({ reasoning_effort: "high" } as ModelParams);
    expect((await sessions.snapshot(id)).modelParams).toEqual({ reasoning_effort: "high" });
    expect(opened.currentId).toBe(id);

    // 清除：服务端那条覆盖真的没了（回到模型出厂参数），而不是把 `null` 当成「没给」跳过
    await opened.setModelParams(null);
    expect((await sessions.snapshot(id)).modelParams).toBeUndefined();
    // 换参数不动模型
    expect(opened.modelId).toBe("test-model");
  });

  /**
   * 命令层那一层：`/model` 换完模型**不要**再补一次 `reload()`。
   *
   * 上面那条钉的是 `session.setModel` 自己不 reload；这条钉的是**调用方**也没补 ——
   * `commands/handlers.ts` 的 `/model` 不能在写完三档之后再无条件跟一句 `session.reload()`：
   * session 档由包自己 `applySnapshot`，那一句就成了「多一个往返 + 多一次通知，屏幕上不多一个字」；
   * 而 `-a` / `-g` 两档仍需要它（它们走 `agent.save` / `config.json`，没有那份快照）。
   *
   * 判据就两条：状态里的 `modelId` 当场是新的，且「该重画了」只多一次。
   */
  it("`/model`（命令层，会话级）：modelId 当场是新的，且只通知一次重画", async () => {
    const opened = await open();
    const id = opened.currentId;
    const redraws = changes;
    const sessions = new RemoteSessions(await startServer());

    await runCommand("model", "/model alt-model", commandHost(opened, commandConfig));

    expect(opened.modelId).toBe("alt-model");
    // 跟一句 `reload()` 就会变成两次，而屏幕上的字一个都不会变
    expect(changes).toBe(redraws + 1);
    // 服务端那一侧真的写了（不是客户端自己记一笔）
    expect((await sessions.snapshot(id)).modelId).toBe("alt-model");
  });

  /**
   * 同上，换到 `/think` 的**会话级**那条写路径（`session.modelParams.set`）。
   *
   * 先 `/model alt-model` 把档位换到会话级：`/think` 的参数跟着「模型来自哪一级」走，
   * 而 Agent 定义那个分支走 `agent.save`，**必须**保留 `reload()`（参数得靠重建 Agent 才进请求）。
   */
  it("`/think`（命令层，会话级）：参数当场写进这一段，且只通知一次重画", async () => {
    const opened = await open();
    const id = opened.currentId;
    const sessions = new RemoteSessions(await startServer());
    await runCommand("model", "/model alt-model", commandHost(opened, commandConfig));
    // 档位是服务端解析的结果：会话级覆盖生效之后它就是 `session`
    expect(opened.modelLevel).toBe("session");
    const redraws = changes;

    await runCommand("think", "/think high", commandHost(opened, commandConfig));

    // 跟一句 `reload()` 就会变成两次（与 /model 同一条理由：包里 setModelParams 自己对齐快照）
    expect(changes).toBe(redraws + 1);
    expect((await sessions.snapshot(id)).modelParams).toEqual({ reasoning_effort: "high" });
  });
});

describe("RemoteChatSession：服务端在一轮内部换 id（自动迁移）", () => {
  it("跟着换 id 并重取消息，send 才能等到新 id 上的 session-turn-end", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = opened.send("继续");
    await waitUntil(() => agent.sent.length === 1);

    // 服务端这一侧：自动迁移（存档 + prune + 换 id）后这一轮才收尾
    const migrated = await (manager as any).autoMigrate(opened.currentId);
    void migrated;
    agent.messages = [{ role: "user", content: "交接断点：/tmp/x.md" }];
    agent.fire("finally");
    await pending;

    // id 变了，消息是迁移之后那份（客户端不能还挂着旧历史）
    expect(opened.currentId).not.toBe("chat_1");
    expect(JSON.stringify(opened.messages)).not.toContain("旧任务");
    expect(opened.phase).toBeNull();
  });
});

// ==================== 自动迁移：交接方式由用户选 ====================
//
// 这一条往返横跨三方，缺一条用例都证明不了链路是通的：
//
//   服务端插件侧：`AutoMigratePlugin` 触发 → 注入的 `resolveMode`
//     → `QuestionBroker.askHandoffMode` → 发 `"session-question"`；
//   客户端：`RemoteChatSession.answerQuestion` 弹 `requestMode` 选择器
//     → 回 `"session.answer"`；
//   服务端：拿到 mode 才真正迁移。
//
// 三样东西都已落地：协议面（`@ai-zen/agents-protocol` 的 `"session-question"` /
// `"session.answer"`）、服务端（`SessionAgentFactory` 把 `resolveMode` 交给
// `AutoMigratePlugin`）、客户端（`answerQuestion`）。所以下面三条走**真 socket、真服务端**
// 跑，没有一条是占位的。
//
// 为什么不用 `vi.mock` 硬凑：要断言的是「服务端真的停在那里等答复，然后按用户选的方式
// 迁移」。凭空塞一条事件只能证明自己会写 handler，证明不了对面会等。

describe("RemoteChatSession：自动迁移的交接方式由用户选", () => {
  /**
   * 自动迁移的提问发生在**服务端注入给 Agent 的 `resolveMode`** 里（SDK 的
   * `AutoMigratePlugin` 在触发时调它），不在 `autoMigrate` 里 —— 所以用例从这一头驱动，
   * 与真链路同构：`resolveMode(info)` → 服务端发 `session-question` → 客户端答 →
   * 服务端拿到 mode 后才 `autoMigrate(mode)`。
   */
  const trigger = () => {
    const resolveMode = lastAgentInput?.resolveMode;
    if (!resolveMode) throw new Error("服务端没有给 Agent 注入 resolveMode");
    return resolveMode({ promptTokens: 999, handoffTokens: 100 });
  };

  it("有 requestMode：选择器拿到触发时的用量，用户选的方式被送回服务端", async () => {
    const seen: AutoMigrateTriggerInfo[] = [];
    await open({
      requestMode: async (info) => {
        seen.push(info);
        return "summary";
      },
    });

    // 客户端拿到了选择器给的两个数（文案要显示「已用 999 / 上限 100」）
    expect(await trigger()).toBe("summary");
    expect(seen).toEqual([{ promptTokens: 999, handoffTokens: 100 }]);
  });

  it("用户选「不交接」：回答 mode: null，服务端据此跳过本次迁移", async () => {
    await open({ requestMode: async () => null });

    // `null` 原样回到服务端 —— 跳过与否由服务端的迁移逻辑决定，客户端不替它判断
    expect(await trigger()).toBeNull();
  });

  it("没有 requestMode：立刻回服务端的兜底（本次不交接），不让服务端干等超时", async () => {
    await open();

    // 服务端超时是 5 分钟：这里 2 秒内落定，就证明客户端自己答了（不是等超时）
    const choice = await Promise.race([
      trigger(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);
    // 兜底是「什么都不做」：交接类问题的 fallback 就是 null（不替用户选 self 迁移）
    expect(choice).toBeNull();
  });
});

/**
 * 假子 Agent：带事件总线（服务端会订阅它并转成带 `subAgentId` 的 `chunk`）。
 *
 * 形状跟 `FakeAgent` 同一个思路 —— 测试就是服务端那侧的「SDK」，手动驱动时序。
 */
function makeSubAgent() {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    messages: [] as any[],
    events: {
      on: (event: string, handler: (...args: any[]) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      },
      off: (event: string, handler: (...args: any[]) => void) => {
        handlers.get(event)?.delete(handler);
      },
      fire: (event: string, ...args: unknown[]) => {
        for (const handler of handlers.get(event) ?? []) handler(...args);
      },
    },
  };
}

/**
 * 子 Agent 栏目的整条链路。
 *
 * 协议面与服务端那一半都已落地，所以下面几条是真跑的：
 *
 *   1. `"sub-agent-start"` / `subAgentEnd`（`sub-agent-start` / `sub-agent-end`）；
 *   2. `AgentChunkEvent.subAgentId?`（子 Agent 的原始片带它上线，客户端自己折）；
 *   3. `"session.subAgent.snapshot"`（`session.subAgent.snapshot`）；
 *   4. `"subAgentFailed"`；
 *   5. 服务端的 `EventBridge` 把 SDK 的 `sub-agent-start` / `sub-agent-end` / 子 Agent 的
 *      `chunk` 翻译成上面这些。
 *
 * 驱动方式是假子 Agent 直接 `fire()`，而不是桩掉事件：`SessionManager.createAgent` 是注入的，
 * 所以「假的只是 SDK 那一侧」，服务端到客户端这段走的是真链路。
 */
describe("RemoteChatSession：子 Agent 栏目", () => {
  it("started 给出 index / id：标签按服务端编号出现，快照把已有消息填上", async () => {
    const opened = await open();
    const subAgent = makeSubAgent();
    subAgent.messages.push({ role: "user", content: "子任务：数文件" });

    agent.fire("sub-agent-start", { subAgent });

    await waitUntil(() => opened.subAgents.length === 1);
    const view = opened.subAgents[0]!;
    expect(view.index).toBe(1);
    expect(view.status).toBe("running");
    // 已有内容由 `session.subAgent.snapshot` 补上（不从主会话搬）
    await waitUntil(() => JSON.stringify(opened.subAgents).includes("子任务：数文件"));
    // 与主会话互不干扰
    expect(opened.messages).toEqual([]);
  });

  it("生成中切过去能看到实时输出（带 subAgentId 的增量落在它自己的对话里）", async () => {
    const opened = await open();
    const subAgent = makeSubAgent();
    agent.fire("sub-agent-start", { subAgent });
    await waitUntil(() => opened.subAgents.length === 1);

    subAgent.events.fire("chunk", { choices: [{ delta: { content: "数到 3 个" } }] });

    // 栏目条目是**整份替换**语义（每次变更都是新对象）：所以断言必须现取，
    // 把 `subAgents[0]` 先存下来再等，等到的永远是那个已经被换掉的旧对象。
    await waitUntil(() => JSON.stringify(opened.subAgents).includes("数到 3 个"));
    // 子 Agent 的增量不进主会话
    expect(JSON.stringify(opened.messages)).not.toContain("数到 3 个");
  });

  it("子 Agent 的增量不推进主阶段（主 Agent 此刻在等工具返回）", async () => {
    const opened = await open();
    void opened.send("统计一下");
    await waitUntil(() => agent.sent.length === 1);
    agent.fire("parsed", { tool_calls: [{ function: { name: "sub_agent_default" } }] });
    await waitUntil(() => opened.phase?.kind === "tool-waiting");

    const subAgent = makeSubAgent();
    agent.fire("sub-agent-start", { subAgent });
    subAgent.events.fire("chunk", { choices: [{ delta: { content: "子任务输出" } }] });
    await waitUntil(() => JSON.stringify(opened.subAgents).includes("子任务输出"));

    // 阶段仍停在「等待 sub_agent_default 返回」
    expect(opened.phase).toMatchObject({ kind: "tool-waiting", tools: ["sub_agent_default"] });
    agent.fire("finally");
  });

  it("ended 把状态改成 done；failed 不会被随后的 done 覆盖", async () => {
    const opened = await open();
    const subAgent = makeSubAgent();
    agent.fire("sub-agent-start", { subAgent });
    await waitUntil(() => opened.subAgents.length === 1);

    agent.fire("sub-agent-end", { subAgent });
    await waitUntil(() => opened.subAgents[0]!.status === "done");

    // 第二个子 Agent 出错：core 在 `finally` 里照常分发 end，不能被擦成 done
    const failing = makeSubAgent();
    agent.fire("sub-agent-start", { subAgent: failing });
    await waitUntil(() => opened.subAgents.length === 2);
    failing.events.fire("error", new Error("boom"));
    agent.fire("sub-agent-end", { subAgent: failing });

    await waitUntil(() => opened.subAgents[1]!.status === "failed");
    expect(opened.subAgents[1]!.status).toBe("failed");
  });

  it("子 Agent 出错：标签 failed + 通知栏一条原文（无前缀，逐字等于今天）", async () => {
    const opened = await open();
    const subAgent = makeSubAgent();
    agent.fire("sub-agent-start", { subAgent });
    await waitUntil(() => opened.subAgents.length === 1);

    subAgent.events.fire("error", new Error("boom"));

    // `subAgentFailed`（通知）与 `subAgentEnd`（状态）是**两帧**：通知先到、状态随后到。
    // 只等通知就断言状态，会在两帧之间读到还在跑的 `running`（机器一忙就红）。
    await waitUntil(() => opened.subAgents[0]?.status === "failed");
    expect(notices[0]).toEqual({ text: "boom", tone: "error" });
    expect(opened.subAgents[0]!.status).toBe("failed");
  });

  it("只活当前一轮：session-turn-end 清空列表", async () => {
    const opened = await open();
    const pending = opened.send("统计一下").then(() => opened.waitForTurn());
    await waitUntil(() => agent.sent.length === 1);

    agent.fire("sub-agent-start", { subAgent: makeSubAgent() });
    await waitUntil(() => opened.subAgents.length === 1);

    agent.fire("finally");
    await pending;

    expect(opened.subAgents).toEqual([]);
  });

  it("reset / reload / migrate 换了会话也清空（不清就会残留上一段会话的子 Agent）", async () => {
    const opened = await open();

    for (const change of [() => opened.reset(), () => opened.reload(), () => opened.migrate()]) {
      // 每段会话都得有自己的内容：`reset` 之后是一段**新**会话（服务端现造一个空 Agent），
      // 而 `migrate` 对「一条用户消息都没有」的会话是拒绝的。
      agent.messages = [{ role: "user", content: "任务" }];
      agent.fire("sub-agent-start", { subAgent: makeSubAgent() });
      await waitUntil(() => opened.subAgents.length === 1);
      await change();
      expect(opened.subAgents).toEqual([]);
    }
  });
});

// ==================== 断线重连 ====================
//
// 这条路径的坑几乎都在「连接真的断掉之后」：旧订阅废了、事件丢了、会话在服务端还活着 ——
// 假客户端复现不了。所以每个用例都真起 Daemon、真断线（停一个、同目录再起一个），
// 会话只能从盘上装回来，「接回原会话」这件事才算真的被验证过。
//
// 等待一律「轮询到条件成立」：断线与重连都没有确定性时机（socket 的 close、新进程的
// 监听都依赖事件循环），固定 `sleep` 在机器一忙时就翻车。

describe("RemoteChatSession：断线重连", () => {
  it("空闲时断线：重连接回同一段会话，屏幕由新连接的快照对齐", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "断线前的对话" }];
    // 落盘：新服务端的内存里没有这段会话，只能从盘上把它装回来（`session.attach` 的那条路）
    expect(await opened.save()).toBe(opened.currentId);
    const id = opened.currentId;
    const workspaceId = await workspaceIdOf(workspaceDir);

    // 断线（服务端换了一个实例：新端口、新 SessionManager）
    const port = await restartServer();
    /**
     * 断线之后才落到盘上的那条：只有**真的走了新连接上的 `session.snapshot`** 才会出现在
     * 屏幕上 —— 本地那份是旧的内存，不可能凭空长出这句话。
     */
    await new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }).write({
      id,
      agentId: "default",
      messages: [
        { role: "user", content: "断线前的对话" },
        { role: "assistant", content: "断线期间跑完的那句" },
      ],
    });
    nextServer.settle(port);

    // 接上了：连接已经换成了活着的那一条（旧的那条 `closed` 永远是 true）
    await waitUntil(() => sessionConnection!.closed === false);
    /**
     * 但「连接活了」比「会话接回来了」早一步：`restore()` 还要 `attach` + 拉一次快照，
     * 而那之后屏幕才是新的。所以等到**快照真的到了**再断言 —— 否则机器一忙就会读到
     * 刚重连、消息还没对齐的那一瞬。
     */
    await waitUntil(() => opened.messages.length === 2);

    expect(opened.currentId).toBe(id); // 会话没变
    expect(opened.messages).toEqual([
      { role: "user", content: "断线前的对话" },
      { role: "assistant", content: "断线期间跑完的那句" },
    ]);
    expect(opened.phase).toBeNull();
    expect(reconnectCalls).toBe(1); // 单飞：断线只起一次重连
    // 透明恢复：不弹「已重连」这类通知（那会是交互变化）
    expect(notices).toEqual([]);
  });

  it("一轮进行中断线：服务端已空闲，等着的 send() 当场落定（不永远挂着、也不抛）", async () => {
    agent.messages = [{ role: "user", content: "上一轮" }];
    const opened = await open();
    await opened.save(); // 新服务端只能从盘上把这段会话装回来

    const sending = watch(opened.send("长任务").then(() => opened.waitForTurn()));
    // 回执到了、这一轮在跑：假 Agent **不** fire finally —— 那条 session-turn-end 就丢在断线里
    await waitUntil(() => agent.sent.length === 1);

    nextServer.settle(await restartServer());

    await waitUntil(() => sending.settled);
    // 既不永远挂着（界面靠它恢复输入），也不把它当错误
    expect(sending.error).toBeUndefined();
    expect(opened.phase).toBeNull();
    // 按快照落定：屏幕上是盘上那份权威消息，不是断线前本地拼的残片
    expect(opened.messages).toEqual([{ role: "user", content: "上一轮" }]);
    expect(notices).toEqual([]);
  });

  it("重连三次都失败：在飞的 send() 以连接错误失败，之后的调用也失败（不无限重试）", async () => {
    let attempts = 0;
    const opened = await open(
      {},
      {
        reconnect: async () => {
          attempts += 1;
          throw new Error("connect refused (test)");
        },
      },
    );

    const sending = watch(opened.send("长任务").then(() => opened.waitForTurn()));
    await waitUntil(() => agent.sent.length === 1);

    await daemon!.stop("test disconnect");

    await waitUntil(() => sending.settled);
    // 走既有的错误通道：这一轮以连接错误收场 —— 错误进通知栏、`send()` 正常返回
    // （进程内实现也是 catch 后 `onNotice`，界面表现一致；若让 promise reject，
    // `chat.tsx` 没有 catch，会变成未处理 rejection 把进程终止）
    expect(sending.error).toBeUndefined();
    expect(notices.at(-1)?.tone).toBe("error");
    expect(notices.at(-1)?.text).toMatch(/connection closed/);
    // 恰好三次：不无限重试
    expect(attempts).toBe(3);
    // 之后的调用同样失败（同样是通知栏，不再开新的一轮重连）
    await expect(opened.send("再来一条")).resolves.toBeUndefined();
    expect(notices.at(-1)?.text).toMatch(/closed/);
    expect(attempts).toBe(3);
  });

  it("dispose() 之后断线不再重连（主动退出不该在后台拉起连接）", async () => {
    let attempts = 0;
    const opened = await open(
      {},
      {
        reconnect: async () => {
          attempts += 1;
          return await connectTo(await nextServer.promise);
        },
      },
    );
    const connected = await currentClient();

    opened.dispose();
    // 断线通知是**同步**发的（`failAll` 里直接调监听器）：若 `dispose()` 没先摘掉那个订阅，
    // 这时 `attempts` 已经是 1 了 —— 所以这里当场断言，不需要再等什么。
    //
    // 连接**仍然开着**：它归持有方、不归会话（进程级），`dispose()` 只关「这一段会话」。
    expect(connected.closed).toBe(false);
    expect(attempts).toBe(0);

    // 服务端那侧也真看到断线了（不是「还没轮到」）—— 连接现在归**持有方**，
    // 所以这里由用例自己关掉它。
    connected.close();
    if (daemon) {
      await waitUntil(() => daemon!.connectionCount === 0);
    }
    // 已经 dispose 了：断线之后不会再拉起连接
    expect(attempts).toBe(0);
  });
});

describe("RemoteChatSession：send 的同步拒绝（不走事件通道的那一类）", () => {
  it("连接已断时 send：错误进通知栏，不抛出（否则是未处理的 rejection，进程会被终止）", async () => {
    const session = await open(
      {},
      {
        // 连不回来（生产里是服务端一直不在）：断线后的重连会走三次失败，但 send 本身
        // 不等重连 —— 它用的是此刻手上那条已经关掉的连接，当场就被拒。
        reconnect: async () => {
          throw new Error("connect refused (test)");
        },
        config: testConfigPort,
      },
    );
    // 把它手上那条连接关掉：此刻 `session.send` 会被客户端自己拒（`client is closed`）
    (await currentClient()).close();

    await expect(session.send("有人吗")).resolves.toBeUndefined();
    expect(notices.at(-1)?.tone).toBe("error");
    expect(notices.at(-1)?.text).toContain("closed");
  });
});

describe("RemoteChatSession：用量口径", () => {
  it("totalUsage 会把工具消息上的 subAgentUsage 一起累加（子 Agent 的消耗不漏算）", async () => {
    const opened = await open();
    // 服务端快照发的是**原始** messages：工具消息上带着 `subAgentUsage`（core 的
    // `AgentTool` 在委派结束时钉上去的）。求和用 core 的 `sumUsage`，它同时累加
    // `usage`（本条响应）与 `subAgentUsage`（内部委派）—— 这条用例把口径钉住，
    // 免得以后有人换成「只加 usage」的求和，把子 Agent 的消耗静默漏掉。
    agent.messages = [
      {
        role: AgentNS.Role.Assistant,
        content: "主 Agent 的一句话",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        role: AgentNS.Role.Tool,
        tool_call_id: "t1",
        content: "委派结果",
        subAgentUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
    ] as never;
    await opened.reload();

    expect(opened.totalUsage).toEqual({
      prompt_tokens: 110,
      completion_tokens: 25,
      total_tokens: 135,
    });
  });
});

describe("RemoteChatSession：换 Agent 与会话回收", () => {
  it("setAgent：换 Agent、消息一条不丢、会话的 agentId 跟着变", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "在聊" }] as never;
    await opened.reload(); // 把消息同步进客户端（快照是唯一真相源）
    const workspaceId = await workspaceIdOf(workspaceDir);

    await opened.setAgent("coder");

    expect(opened.agentId).toBe("coder");
    expect(opened.messages).toHaveLength(1);
    // 服务端那侧的会话身份也换了（`session.list` 里那条 `live` 记录上的 `agentId`）
    const live = await new RemoteSessions(await startServer()).list(workspaceId);
    expect(live.sessions.find((item) => item.sessionId === opened.currentId)!.agentId).toBe(
      "coder",
    );
  });

  it("/new（reset）之后旧会话被 session.close 当场回收，存档还在", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "第一段" }] as never;
    await opened.reload();
    const workspaceId = await workspaceIdOf(workspaceDir);
    const previous = opened.currentId;

    await opened.reset();

    expect(opened.currentId).not.toBe(previous);
    const listed = await new RemoteSessions(await startServer()).list(workspaceId);
    // 旧那段不再是活会话（它作为存档仍在列表里，那是它“装得回来”的依凭）
    expect(listed.sessions.filter((item) => item.live).map((item) => item.sessionId)).not.toContain(
      previous,
    );
    expect(listed.sessions.map((item) => item.sessionId)).toContain(previous);
    // 存档在：`reset()` 先归档再放手，所以「旧的那段」随时装得回来
    const store = new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) });
    expect(await store.read(previous)).not.toBeNull();
  });

  it("session.close + 空闲 → 当场回收；`attach` 能从存档把它装回来", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "聊过一句" }] as never;
    await opened.reload();
    const workspaceId = await workspaceIdOf(workspaceDir);
    const id = opened.currentId;
    await opened.save(); // 落盘（每轮收尾也会写，这里让用例自足）

    const sessions = new RemoteSessions(await startServer());
    // 会话寿命只剩这一条显式表达：「我不看这段了 → 当场回收」
    expect(await sessions.close(id)).toEqual({ closed: true });
    // 幂等：再关一次不是错误（这一段已经不在了）
    expect(await sessions.close(id)).toEqual({ closed: false });

    // 活会话没了（存档还在，所以只看活会话）……
    expect(
      (await sessions.list(workspaceId)).sessions
        .filter((item) => item.live)
        .map((item) => item.sessionId),
    ).not.toContain(id);
    // ……但点回来能接上（rehydrate 走存档：这就是「回收不丢内容」的依据）
    const again = await sessions.attach({ workspaceId, sessionId: id, path: workspaceDir });
    expect(again.sessionId).toBe(id);
    expect((await sessions.snapshot(id)).messages).toHaveLength(1);
  });

  /**
   * 「会话寿命只剩 `session.close` 一条」的**第二个**出口：退出 / 切屏（`dispose()`）。
   *
   * 它是 `/load` 那条路（重挂载 → 旧屏幕卸载 → `dispose()`）与 Ctrl+C 的共同出口。连接归
   * 持有方、不随卸载消失，于是「卸载」对服务端彻底不可见 —— 这一帧不发，每切一次会话就多
   * 一段活会话待到宽限期。
   *
   * 与 `/new` 那条的区别：`reset()` 是 `await` 的（要等旧的关掉），`dispose()` **不等**回执
   * （退出路径卡在网络往返上不可接受），所以这里必须轮询等它落地。
   */
  it("退出（dispose）会尝试关掉这一段 —— 不等回执，但那一帧真的发出去了", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "退出前的一段" }] as never;
    await opened.reload();
    const workspaceId = await workspaceIdOf(workspaceDir);
    const id = opened.currentId;
    const sessions = new RemoteSessions(await startServer());
    const live = async (): Promise<boolean> =>
      (await sessions.list(workspaceId)).sessions.some(
        (item) => item.sessionId === id && item.live,
      );
    // 先确认它在服务端活着（否则下面的"不活了"什么都没证明）
    await waitUntilAsync(live);

    opened.dispose();

    await waitUntilAsync(async () => !(await live()));
    // 幂等：再 dispose 一次不会抛、也不会重发
    expect(() => opened.dispose()).not.toThrow();
  });
});

describe("RemoteChatSession：只带用量的增量", () => {
  it("流末只带 usage 的 chunk 不会在转录里留下空 assistant", async () => {
    const opened = await open();
    const done = watch(opened.send("问一句").then(() => opened.waitForTurn()));
    await waitUntil(() => agent.sent.length === 1);

    agent.fire("open");
    agent.fire("chunk", { choices: [{ delta: { content: "答案" } }] });
    // 增量上屏那一刻就能看出有没有多造消息（这一条与下面的收尾快照无关）
    await waitUntil(() =>
      opened.messages.some((message) => message.role === AgentNS.Role.Assistant),
    );
    expect(
      opened.messages.filter((message) => message.role === AgentNS.Role.Assistant),
    ).toHaveLength(1);

    // 流末 chunk：正文为空、只带用量（客户端按 `sumUsage()` 校准速率，不读这一片的内容）
    agent.fire("chunk", {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 40 },
    });
    // 服务端那份消息就是真相（真实的 SDK 在跑完时已经有这条 assistant）
    agent.messages = [
      { role: "user", content: "问一句" },
      { role: "assistant", content: "答案" },
    ] as never;
    agent.fire("finally");
    await waitUntil(() => done.settled);

    // 收尾后转录换成服务端那份：一条 assistant（「答案」），没有多出来的空消息
    const assistants = opened.messages.filter((message) => message.role === AgentNS.Role.Assistant);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toBe("答案");
  });
});
