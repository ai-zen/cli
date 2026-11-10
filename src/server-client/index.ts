/**
 * CLI 对 `@ai-zen/agents-client` 的**绑定层**（组装根）。
 *
 * ## 为什么 CLI 还需要这一层
 *
 * 连接层已经下沉成 `@ai-zen/agents-client` 了，但它刻意不读进程级全局：配置根
 * （`AI_ZEN_DIR`）与自己这个进程的身份（`CLIENT_INFO` / `CLI_VERSION`）都是**应用级**事实
 * —— 库拍不了这个板，否则桌面端拉起服务端时会自称是 CLI。于是剩下这两件小事归 CLI：
 * 把那两个值读一次，绑进两个函数里。
 *
 * 除此之外这里只有透传（`export * from "@ai-zen/agents-client"`）：**不是**第二份实现，
 * 定义仍然只有包里那一处。加东西时先想清楚它属于「CLI 的组装根」还是「连接层」，
 * 后者应该改包。
 *
 * ## 为什么 `CLIENT_INFO` 在 CLI 这边而不在包里
 *
 * 它答的是「我是谁、哪个版本」，只有应用自己能答（`version.ts` 的 `CLI_VERSION`）。
 * 桌面端有它自己的一份（`app.getVersion()`）。包里只放 `ClientInfo` 这个**形状**。
 *
 * ## 为什么连接是「一个实例」而不是「一个函数」
 *
 * 在一个进程里，到服务端的连接**只能有一条**（D8）。以前这件事靠两个土办法维持：TUI 在
 * `tui/index.tsx` 里建一个 `configPort` 往下传（注释写着「不传就变成两条连接」），stdio 的
 * 一次性调用自己再建一条。两处都是「谁记得谁对」的纪律，而纪律会在第三次组装时失效。
 * 现在答案只有一个对象：{@link createServerConnection} 造它，谁要说话就借它
 * （`connection.client()` 每次判活、断了自建，见包里的 `transport/connection.ts`）。
 */

import {
  createRemoteConfigPort,
  ensureServer,
  ServerConnection,
  type ConfigPort,
  type ServerClient,
} from "@ai-zen/agents-client";
import { AI_ZEN_DIR } from "../config.js";
import { CLIENT_INFO } from "./client-info.js";

export * from "@ai-zen/agents-client";
export { CLIENT_INFO };

/**
 * 拉起（或连上）服务端的一条裸连接。
 *
 * 生产几乎不用它了（要用就用 {@link createServerConnection}：它还带「断了自建 + 重新订阅
 * 事件」）。保留是因为「只要一条连接、不要那层壳」的场景仍然存在：
 * e2e 用例直接 `SocketServerClient.connect` 到自己的 Daemon，`ensure-server` 的探活也是。
 */
export async function connectToServer(): Promise<ServerClient> {
  const { client } = await ensureServer({ aiZenDir: AI_ZEN_DIR, clientInfo: CLIENT_INFO });
  return client;
}

/**
 * 造**本进程那一条**连接（D8）。
 *
 * 调用点只有两个，而且都必须活得比「谁在用」久：
 *   · `tui/index.tsx` —— 模块级一个，**在 `runChat` 的重挂载循环之外**（`/load`、`/clear`、
 *     `/back` 靠重新 `mount(<Chat/>)` 实现；连接若建在循环里，切一次会话就重连一次）；
 *   · `stdio.ts` —— 一次性调用的入口自己造、自己关（它没有第二个使用方）。
 *
 * 它不建连（懒）：第一次 `client()` 才去 `ensureServer`。所以「启动时还没有服务端」这件事
 * 不需要在这里处理。
 */
export function createServerConnection(): ServerConnection {
  return new ServerConnection({ aiZenDir: AI_ZEN_DIR, clientInfo: CLIENT_INFO });
}

/**
 * 配置面（`ConfigPort`）—— 绑在**传进来的那条**连接上，并已绑好配置根与身份。
 *
 * 为什么必须接收连接而不是自己造：配置面是懒连接的，自己造就是「第二条连接」（D8 之前
 * 桌面端与 CLI 各踩过一次）。同一条连接上多挂一个端口是免费的 —— 它只是一堆方法。
 */
export function createConfigPort(connection: ServerConnection): ConfigPort {
  return createRemoteConfigPort({ connection });
}
