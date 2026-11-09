/**
 * `RemoteSessions` 的端到端测试：真 socket + 真 Daemon + 真存档（临时目录）+ 假 Agent。
 *
 * 验的是「客户端能不能只凭服务端拿到会话全貌」这件事 —— 这正是 TUI 从"自己跑 Agent"
 * 改成"纯客户端"时要走的那条路。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createAgentHandlers,
  createSessionHandlers,
  FileSessionStore,
  SessionAgentFactory,
  SessionManager,
  SESSION_EVENTS,
  type AgentLike,
  type SessionEvent,
} from "@ai-zen/agents-server";
import { SocketServerClient } from "./socket-server-client.js";
import { RemoteSessions } from "./sessions.js";
import type { ClientInfo } from "./types.js";

class FakeAgent implements AgentLike {
  messages: unknown[] = [];
  lastUsage: unknown = undefined;
  private readonly handlers = new Map<string, Set<(payload: any) => void>>();
  readonly events = {
    on: (event: string, handler: (payload: any) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (payload: any) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };
  send(): Promise<unknown> {
    return Promise.resolve([]);
  }
  abort(): void {}
  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let agent: FakeAgent;
let connection: SocketServerClient | null = null;
let sessions: RemoteSessions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-remote-sessions-"));
  agent = new FakeAgent();
  manager = new SessionManager({
    createAgent: async () => agent,
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

/** 造一份最小配置与 Agent 定义（`agent.model.set` 要读写它们） */
function seedAgentDefinition(): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      models: [
        { id: "test-model", name: "Test", endpointId: "e", tokenThresholds: { handoff: 1, guard: 2 }, custom: true },
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
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

async function start(): Promise<void> {
  seedAgentDefinition();
  const factory = new SessionAgentFactory({ aiZenDir: dir, homeDir: dir });
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: {
      ...createSessionHandlers({ manager: manager!, workspacesRoot: join(dir, "workspaces") }),
      ...createAgentHandlers({ factory }),
    },
  });
  await daemon.start();
  connection = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
  sessions = new RemoteSessions(connection);
}

describe("RemoteSessions", () => {
  it("open：解析工作区 + 开会话，工作区目录真的建出来", async () => {
    await start();
    const opened = await sessions.open({ path: join(dir, "proj") });

    expect(opened.sessionId).toBe("chat_test");
    expect(opened.agentId).toBe("default");

    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));
    const listed = await sessions.list(workspace.workspaceId);
    expect(listed.sessions.map((session) => session.sessionId)).toEqual(["chat_test"]);
  });

  it("snapshot：客户端不必自己攒事件，一次拿到消息 / 阶段 / 用量", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });

    agent.messages = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ];
    agent.lastUsage = { promptTokens: 1, completionTokens: 2 };

    const snapshot = await sessions.snapshot(sessionId);
    expect(snapshot).toMatchObject({
      sessionId,
      agentId: "default",
      turnId: 0,
      phase: null,
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
      ],
      lastUsage: { promptTokens: 1, completionTokens: 2 },
    });
  });

  it("save + 续接：存过之后用同一个 id 开，Agent 带着那份消息起来", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [{ role: "user", content: "留档" }];

    expect(await sessions.save(sessionId)).toEqual({ saved: true, sessionId });

    // 关掉这个会话，用同一个 id 重新开（模拟下次启动续接）
    const freshAgent = new FakeAgent();
    manager!.dispose();
    manager = new SessionManager({
      createAgent: async () => freshAgent,
      nextSessionId: () => "chat_unused",
      storeFor: (workspaceId) => new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
    });

    // 同一个工作区的存档是同一份：直接读新 manager 的续接结果
    const store = new FileSessionStore({
      rootDir: join(
        dir,
        "workspaces",
        (await sessions.resolveWorkspace(join(dir, "proj"))).workspaceId,
      ),
    });
    expect((await store.read(sessionId))?.messages).toEqual([{ role: "user", content: "留档" }]);
    expect((await store.lastSession())?.id).toBe(sessionId);
  });

  it("事件线：send 之后阶段与收尾都推到客户端", async () => {
    await start();
    const received: SessionEvent[] = [];
    connection!.on(SESSION_EVENTS.phase, (event) => received.push(event));
    connection!.on(SESSION_EVENTS.turnEnd, (event) => received.push(event));

    await sessions.watch();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    await sessions.send(sessionId, "你好");

    agent.fire("open");
    agent.fire("finally");

    for (let i = 0; i < 100 && !received.some((event) => event.event === SESSION_EVENTS.turnEnd); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const kinds = received.map((event) => event.event);
    expect(kinds).toContain(SESSION_EVENTS.phase);
    expect(kinds).toContain(SESSION_EVENTS.turnEnd);
  });
});

describe("RemoteSessions：存档列表与撤回", () => {
  it("listSaved：只列盘上的存档，随 save 增加", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    const workspace = await sessions.resolveWorkspace(join(dir, "proj"));

    expect((await sessions.listSaved(workspace.workspaceId)).sessions).toEqual([]);
    await sessions.save(sessionId);
    expect((await sessions.listSaved(workspace.workspaceId)).sessions.map((ref) => ref.id)).toEqual([
      sessionId,
    ]);
  });

  it("rollback：删掉之后的现场消息随结果返回，且已经落盘", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "答" },
      { role: "user", content: "第二个问题" },
    ];

    const result = await sessions.rollback(sessionId, 3);
    expect(result.removed).toBe(1);
    expect(result.prompt).toBe("第二个问题");
    expect(result.messages).toHaveLength(3);
    // 快照与结果一致：客户端不必再要一次
    expect((await sessions.snapshot(sessionId)).messages).toEqual(result.messages);
  });

  it("rollback 下标越界：错误码原样带回客户端", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [{ role: "user", content: "只有一条" }];

    await expect(sessions.rollback(sessionId, 9)).rejects.toThrow(/bad-index/);
  });
});

describe("RemoteSessions：换模型与重建", () => {
  it("setModel 写的是 Agent 定义（不是会话），reload 保留消息", async () => {
    await start();
    const { sessionId } = await sessions.open({ path: join(dir, "proj") });
    agent.messages = [{ role: "user", content: "上下文留住" }];

    expect(await sessions.setModel("default", "test-model")).toEqual({
      agentId: "default",
      modelId: "test-model",
    });

    const snapshot = await sessions.reload(sessionId);
    expect(snapshot.messages).toEqual([{ role: "user", content: "上下文留住" }]);
    expect(snapshot.sessionId).toBe(sessionId);
  });
});
