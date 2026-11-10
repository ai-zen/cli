/**
 * 客户端身份 —— 握手首帧的 `client` 字段。
 *
 * 只进服务端日志与握手回执，**不参与鉴权**（v1 没有鉴权，见 `Daemon` 的注释）。
 *
 * ## 为什么收成一份
 *
 * 这个字面量曾经抄了三处：`tui/remote-chat-session.ts` 的 `REMOTE_CLIENT_INFO`、
 * 当时的 `server-client/config-port.ts` 的 `CONFIG_PORT_CLIENT_INFO`、`index.ts` 里给
 * `--server-status` 用的内联对象。第二处当年还专门写了一段「不能 import TUI 那份，
 * 否则绕成环」—— 那句话本身就说明它该住在**传输层**，而不是上层。
 *
 * 传输层现在是 `@ai-zen/agents-client` 这个包，但**身份仍留在 CLI 这边**：它答的是
 * 「我是谁、哪个版本」，只有应用自己能答（桌面端有它自己的一份，`app.getVersion()`）。
 * 包里只有 `ClientInfo` 这个形状。
 *
 * 版本号仍以 `version.ts` 的 `CLI_VERSION` 为唯一来源。
 */

import { CLI_VERSION } from "../version.js";
import type { ClientInfo } from "@ai-zen/agents-client";

/** 本进程对外自称的身份（握手用） */
export const CLIENT_INFO: ClientInfo = { name: "@ai-zen/cli", version: CLI_VERSION };
