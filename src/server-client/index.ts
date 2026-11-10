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
 */

import {
  createRemoteConfigPort,
  ensureServer,
  type ConfigPort,
  type ServerClient,
} from "@ai-zen/agents-client";
import { AI_ZEN_DIR } from "../config.js";
import { CLIENT_INFO } from "./client-info.js";

export * from "@ai-zen/agents-client";
export { CLIENT_INFO };

/**
 * 拉起（或连上）服务端 —— CLI 里「怎么建一条连接」的唯一答案。
 *
 * 生产只有这一种：没有服务端就 detached 拉一个，有就用它（判据见包里的 `ensure-server.ts`）。
 * 用例需要指向自己起的那个 Daemon，会直接用 `SocketServerClient.connect`。
 */
export async function connectToServer(): Promise<ServerClient> {
  const { client } = await ensureServer({ aiZenDir: AI_ZEN_DIR, clientInfo: CLIENT_INFO });
  return client;
}

/**
 * 配置面（`ConfigPort`）—— 已绑好配置根与身份。
 *
 * 不走 `createRemoteConfigPort()` 的缺省形态：那个缺省要求调用方显式给出 `aiZenDir` +
 * `clientInfo`（包不读 env）。CLI 里这两样是确定的，收在这里一次，调用点不再各拼一遍。
 */
export function createConfigPort(): ConfigPort {
  return createRemoteConfigPort({ aiZenDir: AI_ZEN_DIR, clientInfo: CLIENT_INFO });
}
