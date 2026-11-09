/**
 * 客户端 ↔ 服务端的**事件线**端到端：真 socket、真帧、假 Agent。
 *
 * 这里不测业务（服务端包里有 16 例管着），只证明一件事：`SocketSessionClient.on()` 收得到
 * 服务端推过来的事件，且 `SessionClient` 端口的事件名是编译期可查的。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createSessionHandlers,
  SessionManager,
  SESSION_EVENTS,
  SESSION_METHODS,
  type SessionAgent,
  type SessionEvent,
} from "@ai-zen/agents-server";
import { SocketSessionClient } from "./socket-session-client.js";
import type { ClientInfo } from "./types.js";

class FakeAgent implements SessionAgent {
  messages: unknown[] = [];
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
  send(): Promise<void> {
    return Promise.resolve();
  }
  abort(): void {}
  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const client: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let agent: FakeAgent;
let session: SocketSessionClient | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-cli-events-"));
  agent = new FakeAgent();
  manager = new SessionManager({ createAgent: async () => agent });
});

afterEach(async () => {
  session?.close();
  session = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<SocketSessionClient> {
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: createSessionHandlers({ manager: manager!, workspacesRoot: join(dir, "workspaces") }),
  });
  await daemon.start();
  session = await SocketSessionClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client,
  });
  return session;
}

/** 等到某个事件出现（事件是推的，没有"等这一帧"的 API） */
async function waitFor(received: SessionEvent[], name: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (received.filter((event) => event.event === name).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${count}× ${name}, got ${JSON.stringify(received)}`);
}

describe("SocketSessionClient.on（服务端推的事件）", () => {
  it("watch 之后收得到阶段 / 正文增量 / 轮次收尾", async () => {
    const client = await start();
    const received: SessionEvent[] = [];
    client.on(SESSION_EVENTS.phase, (event) => received.push(event));
    client.on(SESSION_EVENTS.delta, (event) => received.push(event));
    client.on(SESSION_EVENTS.turnEnd, (event) => received.push(event));

    await client.call(SESSION_METHODS.watch);
    const created = await client.call<{ sessionId: string }>(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    });
    await client.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "你好" });

    agent.fire("open");
    agent.fire("chunk-parsed", { choices: [{ delta: { content: "答" } }] });
    agent.fire("finally");
    await waitFor(received, SESSION_EVENTS.turnEnd);

    const kinds = received
      .filter((event) => event.event === SESSION_EVENTS.phase)
      .map((event) => (event as { phase: { kind?: string } | null }).phase?.kind ?? null);
    expect(kinds).toEqual(["connecting", "queued", "streaming", null]);

    const deltas = received.filter((event) => event.event === SESSION_EVENTS.delta);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ text: "答", reasoning: "", turnId: 1 });

    const ends = received.filter((event) => event.event === SESSION_EVENTS.turnEnd);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ ok: true, sessionId: created.sessionId, turnId: 1 });
  });

  it("取消订阅之后不再收到事件", async () => {
    const client = await start();
    const received: SessionEvent[] = [];
    const off = client.on(SESSION_EVENTS.phase, (event) => received.push(event));

    await client.call(SESSION_METHODS.watch);
    const created = await client.call<{ sessionId: string }>(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    });
    await client.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "x" });
    await waitFor(received, SESSION_EVENTS.phase);

    off();
    const before = received.length;
    agent.fire("open");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.length).toBe(before);
  });

  it("没订阅时事件不会把连接搞坏（后续调用照常）", async () => {
    const client = await start();
    const created = await client.call<{ sessionId: string }>(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    });
    await client.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "x" });
    agent.fire("open");
    agent.fire("finally");

    expect(await client.call("ping")).toEqual({ pong: true });
  });
});
