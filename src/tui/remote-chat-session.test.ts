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
import { join, resolve } from "node:path";
import {
  Daemon,
  createSessionHandlers,
  FileSessionStore,
  SessionManager,
  type AgentLike,
  type CreateAgentInput,
} from "@ai-zen/agents-server";
import { AgentNS } from "@ai-zen/agents-core";
import { RemoteSessions } from "../server-client/sessions.js";
import { SocketServerClient } from "../server-client/socket-server-client.js";
import type { ServerClient } from "../server-client/types.js";
import type { AutoMigrateTriggerInfo, HandoffMode } from "@ai-zen/agents-sdk";
import { setLocale } from "../i18n/index.js";
import { useTempAiZenDir } from "../test-support/temp-dir.js";
import {
  RemoteChatSession,
  mergeSubAgentSnapshot,
  type RemoteChatSessionDeps,
  type SubAgentStream,
} from "./remote-chat-session.js";
import { clientWorkspacePath } from "../server-client/local-host.js";
import type { ConfigPort } from "../server-client/config-port.js";
import type { ChatSessionNotifier } from "./chat-session.js";

class FakeAgent implements AgentLike {
  messages: any[] = [];
  lastUsage: unknown = undefined;
  /** 交接要用的那几面（真件是 SDK 的 `SdkAgent`）；无 write 工具 → 走摘要模式 */
  definition = { messages: [] as any[], modelId: "test-model" };
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
  saveConfig: async () => {},
  readReasoningPresets: async () => ({}) as never,
  readMcpConfig: async () => ({ ok: true, config: { mcpServers: {} } }) as never,
  writeMcpConfig: async () => {},
  readAgentStore: async () =>
    ({ agents: [], subAgents: [], save: async () => {}, remove: async () => {} }) as never,
  setModel: async () => {},
  setDefaultAgent: async () => {},
};

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
});

afterEach(async () => {
  session?.dispose();
  session = null;
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

/**
 * 一个**新的** SessionManager（同一个 `dir`、同一份存档根）。
 *
 * 重连用例要“换一台服务端”：新实例的内存里没有那段会话，只能从盘上把它装回来 ——
 * 这正是 `session.attach` 的「盘上有就装回来」那条路。
 */
/** `createAgent` 最近一次收到的入参：用例要靠它拿服务端注入的 `resolveMode` */
let lastAgentInput: CreateAgentInput | undefined;

function newManager(): SessionManager {
  let counter = 0;
  return new SessionManager({
    createAgent: async (input) => {
      lastAgentInput = input;
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
 * 默认注入的重连：等用例交出端口，再连过去（生产里这里是 `ensureServer` + `connect`）。
 *
 * 用例一律走注入而不是 `vi.mock`：模块级 mock 在 `isolate: false` 下会串到别的文件，
 * 而且「重连到哪个端口」本来就该由用例说了算。
 */
const reconnectToNextServer = async (): Promise<ServerClient> => {
  reconnectCalls += 1;
  return await connectTo(await nextServer.promise);
};

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
  deps: RemoteChatSessionDeps = { reconnect: reconnectToNextServer, config: testConfigPort },
): Promise<RemoteChatSession> {
  const connected = await startServer();
  session = await RemoteChatSession.openWith(
    connected,
    { path: workspaceDir, ...input },
    notifier,
    deps,
  );
  return session;
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
 * 读一个**私有**字段。
 *
 * `path` / `workspaceId` 不在 `ChatSessionLike` 里（界面不需要它们），但「会话落在哪个目录」
 * 只能从实例上看。只在这里做窄口读取，不把它们提升成对外契约（同 `(manager as any)` 的用法）。
 */
function observed<T>(session: RemoteChatSession, key: string): T {
  return (session as unknown as Record<string, T>)[key]!;
}

describe("RemoteChatSession：开一段会话", () => {
  it("快照就是屏幕的全部事实：消息 / 阶段 / 模型 / id 都从服务端来", async () => {
    agent.messages = [{ role: "user", content: "上次聊到这儿" }];
    const opened = await open();

    expect(opened.currentId).toBe("chat_1");
    expect(opened.modelId).toBe("test-model");
    expect(opened.phase).toBeNull();
    expect(opened.messages).toEqual([{ role: "user", content: "上次聊到这儿" }]);
    // 还没人委派：栏目不出现（有子 Agent 才有这一栏）
    expect(opened.subAgents).toEqual([]);
  });
});

describe("RemoteChatSession：工作区归谁决定", () => {
  it("本地服务端（loopback）：不传 path 就用客户端 cwd —— 会话落在你敲 `ai` 的那个目录", async () => {
    const opened = await open({ path: undefined });

    // 服务端规范化后的路径就是客户端递上去的那个目录（本仓根）：
    // 这是「在项目里敲 `ai` 就接着这个项目」的全部依据
    expect(observed<string>(opened, "path")).toBe(resolve(process.cwd()));
    expect(observed<string>(opened, "path")).not.toBe(resolve(workspaceDir));
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
    const opened = await open({ path: workspaceDir });

    expect(observed<string>(opened, "path")).toBe(resolve(workspaceDir));
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

    const pending = opened.send("你好").then(() => {
      finished = true;
    });
    // 回执已到、但这一轮还在跑：此时不该 resolve
    await waitUntil(() => agent.sent.length === 1);
    expect(finished).toBe(false);

    // 服务端这一侧：追加用户消息 → 流式两片 → 收尾
    agent.messages.push({ role: "user", content: "你好" });
    agent.fire("chunk-parsed", {}, { choices: [{ delta: { content: "答" } }] });
    // 生成中就能读到临时拼出来的正文（屏幕要能滚起来）
    await waitUntil(() => JSON.stringify(opened.messages).includes("答"));
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

describe("RemoteChatSession：服务端在一轮内部换 id（自动迁移）", () => {
  it("跟着换 id 并重取消息，send 才能等到新 id 上的 turn.end", async () => {
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
// 这条往返（`session.question` → 选择器 → `session.answer`）的**客户端一半已经接好**：
// `RemoteChatSession.answerQuestion` 收到问题后会弹 `requestMode` 并把结果送回去，没有
// `requestMode` 则立刻回 `self`（见那里的注释）。
//
// 但**服务端那一半还没就绪**：`SessionAgentFactory` 现在不给 `AutoMigratePlugin` 传
// `resolveMode`（那里的注释写的就是「远程模式暂时不问‘用哪种方式’：协议里还没有
// ‘向客户端提问’的往返」），所以服务端永远走默认执行者、一条 `session.question` 都不发；
// `SESSION_EVENTS.question` / `SESSION_METHODS.answer` 也还没从 `@ai-zen/agents-server`
// 导出。**没有问题可答，用例无法真跑**，所以三条都是 `it.skip`。
//
// 为什么不用 `vi.mock` 硬凑：要断言的是「真 socket 上的一问一答，然后迁移照用户选的方式
// 执行」。凭空塞一条事件只能证明自己会写 handler，证明不了服务端真的停在那里等答复。
//
// 等服务端补上 `resolveMode` + `session.question` / `session.answer` 后，把三个 `it.skip`
// 改回 `it` 即可 —— 驱动方式用的是服务端**已有**的那个入口（`SessionManager.autoMigrate`，
// 上一个 describe 已经在用）；若服务端改成别的注入点，这里跟着换。

describe("RemoteChatSession：自动迁移的交接方式由用户选", () => {
  /**
   * 自动迁移的提问发生在**服务端注入给 Agent 的 `resolveMode`** 里（SDK 的
   * `AutoMigratePlugin` 在触发时调它），不在 `autoMigrate` 里 —— 所以用例从这一头驱动，
   * 与真链路同构：`resolveMode(info)` → 服务端发 `session.question` → 客户端答 →
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

describe("子 Agent：快照与增量的合并（竞态）", () => {
  const assistant = (content: string) =>
    ({ role: AgentNS.Role.Assistant, content }) as unknown as AgentNS.Message;
  const user = (content: string) =>
    ({ role: AgentNS.Role.User, content }) as unknown as AgentNS.Message;
  const tool = (content: string) =>
    ({ role: AgentNS.Role.Tool, tool_call_id: "t1", content }) as unknown as AgentNS.Message;
  /** 本地已经拼出来的那条临时消息（就是 `applySubAgentDelta` 累积的那个状态） */
  const streamOf = (text: string, reasoning = ""): SubAgentStream => {
    const message = assistant(text);
    if (reasoning) message.reasoning_content = reasoning;
    return { message, text, reasoning };
  };

  it("本地还没有增量：结果就是快照（started 时最常见）", () => {
    const snapshot = [user("任务")];
    const merged = mergeSubAgentSnapshot(snapshot, null);

    expect(merged.messages).toEqual(snapshot);
    expect(merged.stream).toBeNull();
  });

  it("快照晚于第一批增量：已经拼出来的正文不丢，也不多出一条", () => {
    // 服务端那份里是**空占位**（core 在开始流式前就把 assistant 消息 append 进了 messages），
    // 本地已经拼出半句「答」—— 无脑覆盖就会把这半句摸掉
    const snapshot = [user("任务"), assistant("")];
    const merged = mergeSubAgentSnapshot(snapshot, streamOf("答", "想"));

    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]!.content).toBe("答");
    expect(merged.messages[1]!.reasoning_content).toBe("想");
    // 之后的增量继续拼在**同一条**上（否则屏幕上会凭空多出一条消息）
    expect(merged.stream!.message).toBe(merged.messages[1]);
  });

  it("快照那份比本地旧：取信息多的那份（本地只多不少）", () => {
    const snapshot = [user("任务"), assistant("答")];
    const merged = mergeSubAgentSnapshot(snapshot, streamOf("答完了"));

    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]!.content).toBe("答完了");
  });

  it("服务端已经收下这段（当前没有在流的 assistant）：不重复追加", () => {
    // 本地累计的「先想」已经在快照里了，而快照末尾是工具结果（下一段还没开始）
    const merged = mergeSubAgentSnapshot(
      [user("任务"), assistant("先想"), tool("结果")],
      streamOf("先想"),
    );

    expect(merged.messages).toHaveLength(3);
    // 临时消息丢掉：之后的增量重新起一条（否则会接在已收尾的旧消息后面）
    expect(merged.stream).toBeNull();
  });

  it("快照之后才开的新一段：只接上多出来的尾巴", () => {
    const merged = mergeSubAgentSnapshot(
      [user("任务"), assistant("先想"), tool("结果")],
      streamOf("先想结论"),
    );

    expect(merged.messages).toHaveLength(4);
    expect(merged.messages[3]!.content).toBe("结论");
    expect(merged.stream!.message).toBe(merged.messages[3]);
  });

  it("对不上任何一段时宁重不丢：整段追加，不静默吞字", () => {
    const merged = mergeSubAgentSnapshot(
      [user("任务"), assistant("旧内容"), tool("结果")],
      streamOf("新内容"),
    );

    expect(merged.messages).toHaveLength(4);
    expect(merged.messages[3]!.content).toBe("新内容");
  });
});

/**
 * 假子 Agent：带事件总线（服务端会订阅它并转成带 `subAgentId` 的 `message.delta`）。
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
 * 整条链路的用例 —— **等**服务端把子 Agent 协议落地（当前 `@ai-zen/agents-server` 里还没有）：
 *
 *   1. `SESSION_EVENTS.subAgentStarted` / `subAgentEnded`（`session.subAgent.started/ended`）；
 *   2. `MessageDeltaEvent.subAgentId?`；
 *   3. `SESSION_METHODS.subAgentSnapshot`（`session.subAgent.snapshot`）；
 *   4. `SESSION_NOTICE_CODES.subAgentFailed`；
 *   5. `SessionManager` 把 SDK 的 `sub-agent-start` / `sub-agent-end` / 子 Agent 的
 *      `chunk-parsed` 翻译成上面这些（假 Agent 已经能 `fire()`，`SessionManager.createAgent`
 *      是注入的，所以服务端一接上这些用例就能真跑）。
 */
describe("RemoteChatSession：子 Agent 栏目（等服务端协议）", () => {
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
    await waitUntil(() => JSON.stringify(view.messages).includes("子任务：数文件"));
    // 与主会话互不干扰
    expect(opened.messages).toEqual([]);
  });

  it("生成中切过去能看到实时输出（带 subAgentId 的增量落在它自己的对话里）", async () => {
    const opened = await open();
    const subAgent = makeSubAgent();
    agent.fire("sub-agent-start", { subAgent });
    await waitUntil(() => opened.subAgents.length === 1);

    subAgent.events.fire("chunk-parsed", {}, { choices: [{ delta: { content: "数到 3 个" } }] });

    const view = opened.subAgents[0]!;
    await waitUntil(() => JSON.stringify(view.messages).includes("数到 3 个"));
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
    subAgent.events.fire("chunk-parsed", {}, { choices: [{ delta: { content: "子任务输出" } }] });
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

    // `subAgentFailed`（通知）与 `subAgentEnded`（状态）是**两帧**：通知先到、状态随后到。
    // 只等通知就断言状态，会在两帧之间读到还在跑的 `running`（机器一忙就红）。
    await waitUntil(() => opened.subAgents[0]?.status === "failed");
    expect(notices[0]).toEqual({ text: "boom", tone: "error" });
    expect(opened.subAgents[0]!.status).toBe("failed");
  });

  it("只活当前一轮：turn.end 清空列表", async () => {
    const opened = await open();
    const pending = opened.send("统计一下");
    await waitUntil(() => agent.sent.length === 1);

    agent.fire("sub-agent-start", { subAgent: makeSubAgent() });
    await waitUntil(() => opened.subAgents.length === 1);

    agent.fire("finally");
    await pending;

    expect(opened.subAgents).toEqual([]);
  });

  it("reset / reload / migrate 换了会话也清空（不清就会残留上一段会话的子 Agent）", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "任务" }];

    for (const change of [() => opened.reset(), () => opened.reload(), () => opened.migrate()]) {
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
    const workspaceId = observed<string>(opened, "workspaceId");

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

    // 接上了：手上换成了新连接（旧的那条 `closed` 一直是 true）
    await waitUntil(() => observed<ServerClient>(opened, "client").closed === false);

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

    const sending = watch(opened.send("长任务"));
    // 回执到了、这一轮在跑：假 Agent **不** fire finally —— 那个 turn.end 就丢在断线里
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

    const sending = watch(opened.send("长任务"));
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
    const connected = observed<ServerClient>(opened, "client");

    opened.dispose();
    // 断线通知是**同步**发的（`failAll` 里直接调监听器）：若 `dispose()` 没先摘掉那个订阅，
    // 这时 `attempts` 已经是 1 了 —— 所以这里当场断言，不需要再等什么。
    expect(connected.closed).toBe(true);
    expect(attempts).toBe(0);

    // 服务端那侧也真把这个连接收掉了：断线确实发生过，不是「还没轮到」
    if (daemon) {
      await daemon.stop("test disconnect");
      await waitUntil(() => daemon!.connectionCount === 0);
    }
    expect(attempts).toBe(0);
    // 手上仍是那条关掉的连接：没有被换成新连接
    expect(observed<ServerClient>(opened, "client")).toBe(connected);
  });
});

describe("RemoteChatSession：send 的同步拒绝（不走事件通道的那一类）", () => {
  it("连接已断时 send：错误进通知栏，不抛出（否则是未处理的 rejection，进程会被终止）", async () => {
    const session = await open();
    // 把连接直接关掉：此刻 `session.send` 会被客户端自己拒（`client is closed`）
    session.dispose();

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

describe("RemoteChatSession：换 Agent 与保活区", () => {
  it("setAgent：换 Agent、消息一条不丢、会话的 agentId 跟着变", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "在聊" }] as never;
    await opened.reload(); // 把消息同步进客户端（快照是唯一真相源）
    const workspaceId = observed<string>(opened, "workspaceId");

    await opened.setAgent("coder");

    expect(opened.agentId).toBe("coder");
    expect(opened.messages).toHaveLength(1);
    // 服务端那侧的会话身份也换了（`session.list` 的 keepAlive 之外就看这个）
    const live = await new RemoteSessions(await startServer()).list(workspaceId);
    expect(live.sessions.find((item) => item.sessionId === opened.currentId)!.agentId).toBe(
      "coder",
    );
  });

  it("/new（reset）之后旧会话移出保活区：服务端当场回收，存档还在", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "第一段" }] as never;
    await opened.reload();
    const workspaceId = observed<string>(opened, "workspaceId");
    const previous = opened.currentId;

    await opened.reset();

    expect(opened.currentId).not.toBe(previous);
    const live = await new RemoteSessions(await startServer()).list(workspaceId);
    expect(live.sessions.map((item) => item.sessionId)).not.toContain(previous);
    // 存档在：`reset()` 先归档再放手，所以「旧的那段」随时装得回来
    const store = new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) });
    expect(await store.read(previous)).not.toBeNull();
  });

  it("keepAlive.set off + 空闲 → 当场回收；`attach` 能从存档把它装回来", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "聊过一句" }] as never;
    await opened.reload();
    const workspaceId = observed<string>(opened, "workspaceId");
    const id = opened.currentId;
    await opened.save(); // 落盘（每轮收尾也会写，这里让用例自足）

    const sessions = new RemoteSessions(await startServer());
    expect(await sessions.keepAliveSet(id, false)).toEqual({ sessionId: id, keepAlive: false });

    // 活会话没了……
    expect((await sessions.list(workspaceId)).sessions.map((item) => item.sessionId)).not.toContain(
      id,
    );
    // ……但点回来能接上（rehydrate 走存档：这就是「回收不丢内容」的依据）
    const again = await sessions.attach({ workspaceId, sessionId: id, path: workspaceDir });
    expect(again.sessionId).toBe(id);
    expect((await sessions.snapshot(id)).messages).toHaveLength(1);
  });
});

describe("RemoteChatSession：只带用量的增量", () => {
  it("流末只带 usage 的 chunk 不会在转录里留下空 assistant", async () => {
    const opened = await open();
    const done = watch(opened.send("问一句"));
    await waitUntil(() => agent.sent.length === 1);

    agent.fire("open");
    agent.fire("chunk-parsed", {}, { choices: [{ delta: { content: "答案" } }] });
    // 增量上屏那一刻就能看出有没有多造消息（这一条与下面的收尾快照无关）
    await waitUntil(() =>
      opened.messages.some((message) => message.role === AgentNS.Role.Assistant),
    );
    expect(
      opened.messages.filter((message) => message.role === AgentNS.Role.Assistant),
    ).toHaveLength(1);

    // 流末 chunk：正文为空、只带用量（客户端拿它校准速率，见 `addExact`）
    agent.fire(
      "chunk-parsed",
      {},
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { completion_tokens: 40 },
      },
    );
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
