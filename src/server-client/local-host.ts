/**
 * 「服务端是不是也在这台机器上」—— 工作区归属的唯一判据。
 *
 * ## 为什么需要它
 *
 * 工作目录该由谁决定，取决于服务端在哪台机器上：
 *
 *   · **本地**（连的是 loopback）—— 用**客户端**的 `process.cwd()`。这是使用者的实际意图：
 *     「我在这个项目里敲 `ai`，会话就该跑在这个项目里」，也才能「复用或新建这个目录的
 *     工作区 → 接着它最后一段对话」「项目作用域的 mcp.json 读的是这个项目的」；
 *   · **远端**（非 loopback）—— 不说。客户端把自己进程的目录送上去，等于替服务端决定
 *     会话跑在哪：那个目录在服务端很可能根本不存在（要么开出一个空目录、要么直接失败）。
 *
 * 所以判据只能有一个，而且必须两处共用（开会话的工作区、项目作用域 mcp 的工作区）——
 * 分成两套判断，迟早出现「会话在 A 项目、mcp 配置读的却是别处」。本模块就是那一处。
 *
 * ## 为什么只认 loopback
 *
 * `localhost` / `::1` / `127.0.0.0/8` 是唯一能确定「同一个内核、同一块磁盘」的地址。
 * `0.0.0.0` **不算**：那是监听地址，不是连接目标。
 */

/** 这条连接的另一头是不是这台机器（见文件头） */
export function isLocalHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || /^127\./.test(value);
}

/**
 * 「我期望在这个目录」—— 只在服务端也在这台机器上时才说。
 *
 * 返回 `undefined` 就是「不说」，服务端会用自己的默认工作区。
 */
export function clientWorkspacePath(host: string, cwd: string = process.cwd()): string | undefined {
  return isLocalHost(host) ? cwd : undefined;
}
