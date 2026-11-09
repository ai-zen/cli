/**
 * 走 TCP 的 {@link SessionClient} 实现 —— 客户端侧唯一的「线上」实现。
 *
 * ## 为什么叫 Socket 而不是 Remote
 *
 * 后缀写**传输**，不写**距离**。v1 连的就是 `127.0.0.1`，叫 `Remote` 等于把一个还没
 * 发生的事实提前写进类型；将来真要跨机时它照样叫这个名字（跨不跨机不是类名该管的事）。
 * WebSocket / stdio 各来一个 `WebSocketSessionClient` / `StdioSessionClient`，换的是后缀。
 *
 * ## 握手在 `connect()` 里做完
 *
 * `connect()` 返回时一定已经握过手，调用方拿到客户端就能 `call()`。把「先发 hello、
 * 等回执、再发请求」摊给每个调用点，等于将来加鉴权时每个调用点都要跟着改。
 */

import { createConnection, type Socket } from "node:net";
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type HelloResponse,
  type ResponseFrame,
  type SessionEvent,
} from "@ai-zen/agents-server";
import type { CallOptions, ClientInfo, ServerAddress, SessionClient } from "./types.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SocketSessionClientOptions {
  address: ServerAddress;
  client: ClientInfo;
  /** 建连 + 握手的总时限。握手是两趟往返，但都在本机，1s 都算宽裕 */
  connectTimeoutMs?: number;
  /** 单次 `call` 的默认时限（会话类方法会跑很久，调用点应显式传 `timeoutMs`） */
  callTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class SocketSessionClient implements SessionClient {
  readonly address: ServerAddress;

  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<(payload: SessionEvent) => void>>();
  private readonly callTimeoutMs: number;

  /** 握手期间的非空槽位：握手帧到时由它落定 `connect()` 的 promise */
  private pendingHandshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  /** 服务端在握手回执里自报的身份（版本 / pid / 协议号） */
  private serverInfo: HelloResponse["server"];
  private nextId = 1;
  private closed = false;

  private constructor(socket: Socket, address: ServerAddress, callTimeoutMs: number) {
    this.socket = socket;
    this.address = address;
    this.callTimeoutMs = callTimeoutMs;
  }

  /** 建连 + 握手；握手被拒或超时一律抛错（调用方据此决定"重拉一个"还是"报给人看"） */
  static async connect(options: SocketSessionClientOptions): Promise<SocketSessionClient> {
    const { address, client } = options;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    const socket = createConnection({ host: address.host, port: address.port });
    socket.setEncoding("utf-8");
    const session = new SocketSessionClient(
      socket,
      address,
      options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );

    const ready = new Promise<void>((resolve, reject) => {
      session.pendingHandshake = { resolve, reject };
    });
    session.attach();

    const timer = setTimeout(() => {
      session.settleHandshake(
        new Error(`handshake timeout after ${connectTimeoutMs}ms (${address.host}:${address.port})`),
      );
      socket.destroy();
    }, connectTimeoutMs);

    socket.once("connect", () => {
      socket.write(
        encodeFrame({
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          client,
        }),
      );
    });

    try {
      await ready;
      return session;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 握手回执里服务端自报的身份（只在 `connect()` 成功后可用） */
  get server(): HelloResponse["server"] {
    return this.serverInfo;
  }

  call<T = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`client is closed, cannot call ${method}`));
    }
    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs ?? this.callTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms calling ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      // `params` 为 undefined 时 JSON.stringify 会整键丢掉，帧里就只剩 `{ id, method }`
      this.socket.write(encodeFrame({ id, method, params }));
    });
  }

  on<E extends SessionEvent["event"]>(
    event: E,
    listener: (payload: Extract<SessionEvent, { event: E }>) => void,
  ): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    const set = this.listeners.get(event)!;
    const wrapped = listener as (payload: SessionEvent) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  close(): void {
    this.failAll(new Error("client closed"));
    this.socket.destroy();
  }

  // ==================================================================
  // 内部
  // ==================================================================

  private attach(): void {
    this.socket.on("data", (chunk: string) => this.handleChunk(chunk));
    this.socket.on("error", (error: Error) => this.failAll(error));
    this.socket.on("close", () =>
      this.failAll(new Error(`connection closed (${this.address.host}:${this.address.port})`)),
    );
  }

  private handleChunk(chunk: string): void {
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      // 畸形帧：这条连接已经不可能对齐了，整体作废（不猜下一帧从哪开始）
      this.failAll(error as Error);
      this.socket.destroy();
      return;
    }
    for (const frame of frames) this.handleFrame(frame);
  }

  private handleFrame(frame: unknown): void {
    const value = frame as Record<string, any> | null;

    if (value?.kind === "hello") {
      if (value.ok) {
        this.serverInfo = value.server;
        this.settleHandshake();
      } else {
        this.settleHandshake(
          new Error(
            `handshake rejected: ${value.error?.code}: ${value.error?.message ?? "no message"}`,
          ),
        );
      }
      return;
    }

    if (typeof value?.id === "number") {
      const call = this.pending.get(value.id);
      // 已经超时落定的调用：响应来晚了，直接丢（不重复 settle）
      if (!call) return;
      this.pending.delete(value.id);
      clearTimeout(call.timer);

      const response = value as ResponseFrame;
      if (response.ok) call.resolve(response.result);
      else call.reject(new Error(`${response.error.code}: ${response.error.message}`));
      return;
    }

    // 事件帧（服务端主动推）：无 id、有 event
    if (typeof value?.event === "string") {
      const set = this.listeners.get(value.event);
      if (!set) return;
      for (const listener of set) {
        try {
          listener(value as SessionEvent);
        } catch {
          // 一个监听器抛错不该连累同事件的其它监听器（更不该弄坏连接）
        }
      }
    }
  }

  private settleHandshake(error?: Error): void {
    const handshake = this.pendingHandshake;
    if (!handshake) return;
    this.pendingHandshake = null;
    if (error) handshake.reject(error);
    else handshake.resolve();
  }

  /** 连接不可用：让所有在飞的调用一起失败，且之后不再接受新调用 */
  private failAll(error: Error): void {
    this.closed = true;
    this.settleHandshake(error);
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
    this.listeners.clear();
  }
}
