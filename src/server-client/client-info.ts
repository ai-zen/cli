/**
 * 客户端身份 —— 握手首帧的 `client` 字段。
 *
 * 只进服务端日志与握手回执，**不参与鉴权**（v1 没有鉴权，见 `Daemon` 的注释）。
 *
 * ## 为什么收成一份
 *
 * 这个字面量只该有一个来源：每抄一处就会出现「握手自称的版本」与「实际版本」不一致。
 *
 * 它住在 CLI 而不在 `@ai-zen/agents-client`：**身份仍归应用** —— 「我是谁、哪个版本」
 * 只有应用自己能答（桌面端有它自己的一份，`app.getVersion()`），包里只提供 `ClientInfo`
 * 这个形状。
 *
 * 版本号仍以 `version.ts` 的 `CLI_VERSION` 为唯一来源。
 */

import { CLI_VERSION } from "../version.js";
import type { ClientInfo } from "@ai-zen/agents-client";

/** 本进程对外自称的身份（握手用） */
export const CLIENT_INFO: ClientInfo = { name: "@ai-zen/cli", version: CLI_VERSION };
