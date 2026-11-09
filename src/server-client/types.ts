/**
 * 客户端侧对「服务端」的全部认知。
 *
 * 这里只有**端口**（能力接口），没有实现：TUI / 命令层只认 {@link SessionClient}，
 * 不认 TCP、不认 HTTP，也不知道服务端跑在同机还是别处。将来换传输（WebSocket / stdio /
 * ssh 隧道）只换实现类，调用点一行不改 —— 这是「传输自由」在类型上的落点。
 */

/**
 * 服务端在哪。
 *
 * 单独起个名字（而不是到处写 `{ host: string; port: number }`）：将来换 unix socket
 * 或 URL 时，改的是这一个类型，不是二十九处字面量。
 */
export interface ServerAddress {
  host: string;
  port: number;
}

/** 客户端身份：握手首帧的 `client` 字段，只进日志与服务端回执，**不参与鉴权** */
export interface ClientInfo {
  name: string;
  version: string;
}

export interface CallOptions {
  /** 本次调用的时限；不传就用客户端默认值 */
  timeoutMs?: number;
}

/**
 * 会话能力端口。
 *
 * v1 只有 `call` / `close`：事件推送（阶段进度、工具输出）等**第一个真实事件**出现时
 * 再加 `on()`，不提前预留一个没人调用的订阅口。
 */
export interface SessionClient {
  readonly address: ServerAddress;
  call<T = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<T>;
  close(): void;
}
