/**
 * 客户端身份 —— 握手首帧的 `client` 字段。
 *
 * 只进服务端日志与握手回执，**不参与鉴权**（v1 没有鉴权，见 `Daemon` 的注释）。
 *
 * ## 为什么收成一份
 *
 * 这个字面量曾经抄了三处：`tui/remote-chat-session.ts` 的 `REMOTE_CLIENT_INFO`、
 * `server-client/config-port.ts` 的 `CONFIG_PORT_CLIENT_INFO`、`index.ts` 里给
 * `--server-status` 用的内联对象。第二处当年还专门写了一段「不能 import TUI 那份，
 * 否则绕成环」—— 那句话本身就说明它该住在**传输层**，而不是上层。
 *
 * 版本号仍以 `version.ts` 的 `CLI_VERSION` 为唯一来源。
 */

import { CLI_VERSION } from "../version.js";
import type { ClientInfo } from "./types.js";

/** 本进程对外自称的身份（握手用） */
export const CLIENT_INFO: ClientInfo = { name: "@ai-zen/cli", version: CLI_VERSION };
