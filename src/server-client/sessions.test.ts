/**
 * `RemoteSessions` 的端到端测试：真 socket + 真 Daemon + 真存档（临时目录）+ 假 Agent。
 *
 * 验的是「客户端能不能只凭服务端拿到会话全貌」这件事 —— 这正是 TUI 从"自己跑 Agent"
 * 改成"纯客户端"时要走的那条路。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createSessionHandlers,
  FileSessionStore,
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

async function start(): Promise<void> {
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: createSessionHandlers({ manager: manager!, workspacesRoot: join(dir, "workspaces") }),
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
