/**
 * 旧方法名 → 今天那一格：**`call` 这一条旧路的对照表**（口径②③）。
 *
 * ## 这张表答什么
 *
 * 宿主把整包 wire 方法换成 tRPC procedure 之后，CLI 里还留着一批按**旧方法名**说话的调用点
 * （`call("config.get")` 这种）。它们不能一次全搬完，所以这一刀的形式是**两路并存**（口径④）：
 *
 *   · **`api` 直连** —— 会话域走它（`session.open` / `agent.send` / 三道闸 / …），不经过本文件；
 *   · **`call` 旧路** —— 还没搬的域走它，**一律抛** `ClientError("unsupported", …)`。
 *
 * 于是「哪些已经通了、哪些还抛」有了唯一一处可查的地方：{@link LEGACY_METHODS}。
 *
 * ## 实测数字（表头要给的那两格）
 *
 *   · 旧 wire 的方法表共 **68 条** procedure（`host.*` 6 + `workspace.*` 5 + `session.*` 19 +
 *     `message.*` 1 + `question.*` 2 + `notice.*` 3 + `config.*` 8 + `agent.*` 8 + `model.*` 8 +
 *     `asset.*` 3 + `completion.*` 1 + `handoff.*` 2 + `search.*` 2）；
 *   · 搬走的部分：`completion.files` 一条（`@` 补全那一刀）、配置域这一刀退场 25 条
 *     （`config.*` 8 + `agent.*` 8 + `model.*` 8 + `host.reload`），于是表里还剩 **42 条**
 *     `MethodName`；`LEGACY_METHODS` 仍是**完整的那张 68 行**（退场的那几条记在
 *     {@link RetiredMethodName} 里，理由与方法名一起留着）。
 *
 * 两条口径写在这里，免得下一刀再猜：
 *
 *   · **「已接」只有一个判据**：`call(名字, 参数)` 能真的转成 `api.*` 的一次调用。转不了的
 *     一律「未搬」，实现抛 `ClientError("unsupported", …)`，文案里带方法名；
 *   · `agent.send` **不是**旧方法名。旧的 `session.create` / `session.send` 是「已接」：前者转成
 *     `api.session.create`（只建一行），后者转成 `api.agent.send`（只投递）。
 *
 * ## 「已接」这一列今天指什么
 *
 * 它是**这场迁移的施工记录**，不是一条还在跑的路：配置域这 25 条旧路已经没有调用点（`call` 的
 * `switch` 里也没有它们的分支），它们的「已接」说的是「这个旧方法名服务的那件事，今天走哪条
 * procedure」。真正还在跑的两条「已接」只有 `session.create` / `session.send`。
 */

import type { HostClient } from "./index.js";
import { ClientError } from "./index.js";
import type { MethodName, MethodParams, MethodResult } from "../legacy-contract.js";

/** 本轮的状态：已接 = 真能转成 `api.*` 的一次调用；未搬 = 抛 `unsupported` */
export type LegacyStatus = "已接" | "未搬";

/** 表的一行 */
export interface LegacyMethodRow {
  /** 旧方法名（`MethodName` 认得它，或者是一个只剩名字的 `RetiredMethodName`） */
  readonly legacy: LegacyName;
  /** 今天的对应：哪条 procedure，或者「没有」（并说清为什么没有） */
  readonly today: string;
  /** 本轮状态 */
  readonly status: LegacyStatus;
}

/**
 * 已经从旧契约里整组删掉、只剩名字的旧方法。
 *
 * 名字留着、形状（`legacy-contract.ts` 里那一组）删掉，`MethodName` 也不再认它们 —— 于是
 * 「这条旧路今天走哪条 procedure」这件事只有这张表说得出来。
 *
 *   · `completion.files`：`@` 补全那一刀（走 `api.workspace.files`）；
 *   · `config.*` 8 条 + `agent.*` 8 条 + `model.*` 8 条：配置域这一刀，旧那三组形状
 *     （`ConfigView` / `AgentView` / `ModelView` …）一个消费者都不剩了；
 *   · `host.reload`：它的出参就是 `{ config: ConfigView, applied: ConfigApplyReport }`，
 *     两个形状随上面那一组一起删掉，而它本来就没有调用点。
 */
export type RetiredMethodName =
  | "completion.files"
  | "host.reload"
  | "config.get"
  | "config.patch"
  | "config.setDefaults"
  | "config.getDiscovery"
  | "config.saveMcp"
  | "config.deleteMcp"
  | "config.saveEndpoint"
  | "config.deleteEndpoint"
  | "agent.list"
  | "agent.get"
  | "agent.create"
  | "agent.update"
  | "agent.delete"
  | "agent.setModel"
  | "agent.setThinking"
  | "agent.restoreFactory"
  | "model.list"
  | "model.listImages"
  | "model.create"
  | "model.update"
  | "model.delete"
  | "model.restoreFactory"
  | "model.saveImage"
  | "model.deleteImage";

/** 表里那一行认的旧方法名 */
export type LegacyName = MethodName | RetiredMethodName;

/**
 * 表本体（68 行，顺序照旧 wire 的方法表）。
 *
 * 第二列写的是**今天的**那条 procedure（宿主 `modules/api/*.ts` 里的名字），不是「曾经的对
 * 应」—— 读它的人要能照着去打一条 tRPC 调用。没有对应的那些把原因写在括号里，因为「没有」
 * 本身不构成理由，而下一刀要照着这份清单决定「这条旧路还留不留」。
 */
export const LEGACY_METHODS: readonly LegacyMethodRow[] = [
  // ---- host.* ----
  { legacy: "host.hello", today: "没有（握手帧换成建连时的 connectionParams）", status: "未搬" },
  { legacy: "host.version", today: "host.version", status: "未搬" },
  { legacy: "host.upgrade", today: "host.upgrade", status: "未搬" },
  {
    legacy: "host.shutdown",
    today: "没有（宿主不再有收摊 procedure，收摊=杀进程）",
    status: "未搬",
  },
  {
    legacy: "host.reload",
    today: "没有（配置改完即生效，没有「现在就说一遍」这一条；出参那两个形状随配置域一起退场）",
    status: "未搬",
  },
  {
    legacy: "host.setLanguage",
    today: "没有（语言是宿主的全局设置，不挂在连接上）",
    status: "未搬",
  },

  // ---- workspace.* ----
  { legacy: "workspace.list", today: "workspace.list", status: "未搬" },
  { legacy: "workspace.create", today: "workspace.create", status: "未搬" },
  { legacy: "workspace.get", today: "没有（用 workspace.list + find）", status: "未搬" },
  { legacy: "workspace.rename", today: "workspace.rename", status: "未搬" },
  { legacy: "workspace.remove", today: "workspace.remove", status: "未搬" },

  // ---- session.* ----
  { legacy: "session.list", today: "session.list", status: "未搬" },
  {
    legacy: "session.create",
    today: "session.create（只建行：不唤醒执行体，也不投递）",
    status: "已接",
  },
  { legacy: "session.get", today: "session.open（`session` 那一格）", status: "未搬" },
  { legacy: "session.state", today: "session.open（`live` 那一格）", status: "未搬" },
  { legacy: "session.rename", today: "session.rename", status: "未搬" },
  { legacy: "session.pin", today: "session.pin", status: "未搬" },
  { legacy: "session.delete", today: "没有（宿主这一版没有删会话的 procedure）", status: "未搬" },
  {
    legacy: "session.send",
    today: "agent.send（带 sessionId：只投递）",
    status: "已接",
  },
  { legacy: "session.start", today: "agent.wake", status: "未搬" },
  { legacy: "session.abort", today: "agent.abort", status: "未搬" },
  { legacy: "session.pause", today: "agent.pause", status: "未搬" },
  { legacy: "session.resume", today: "agent.resume", status: "未搬" },
  { legacy: "session.kill", today: "agent.kill", status: "未搬" },
  {
    legacy: "session.clearInbox",
    today: "没有（宿主这一版没有清空排队区的 procedure）",
    status: "未搬",
  },
  { legacy: "session.revert", today: "session.rewind", status: "未搬" },
  { legacy: "session.setModel", today: "session.setModel", status: "未搬" },
  { legacy: "session.setThinking", today: "session.setThinkingLevel", status: "未搬" },
  { legacy: "session.setThresholds", today: "session.setThresholds", status: "未搬" },
  {
    legacy: "session.transient",
    today: "session.transient（入参换成 `{ cwd, agentId, content }`）",
    status: "未搬",
  },

  // ---- message.* ----
  { legacy: "message.list", today: "session.open（`messages` 那一格）", status: "未搬" },

  // ---- question.* ----
  { legacy: "question.list", today: "question.list", status: "未搬" },
  { legacy: "question.answer", today: "question.answer", status: "未搬" },

  // ---- notice.* ----
  { legacy: "notice.list", today: "notice.list", status: "未搬" },
  { legacy: "notice.dismiss", today: "没有（改用 notice.clear({ sessionId })）", status: "未搬" },
  { legacy: "notice.clear", today: "notice.clear", status: "未搬" },

  // ---- config.* ----（配置域这一刀搬完：见 `LEGACY_METHODS` 文件头「已接指什么」）
  {
    legacy: "config.get",
    today: "config.get（出参是 `AppConfig` + `presets`，不再是老 `ConfigView`）",
    status: "已接",
  },
  {
    legacy: "config.patch",
    today: "config.setDefaults / config.setGlobal（默认项五格 | 上限 + 中断策略两项）",
    status: "已接",
  },
  {
    legacy: "config.setDefaults",
    today: "config.setDefaults（`null` = 清空那一项）",
    status: "已接",
  },
  {
    legacy: "config.getDiscovery",
    today: "并入 mcp.list（每条带 `scope`，没有 skills / tools / subagents 的分层）",
    status: "已接",
  },
  {
    legacy: "config.saveMcp",
    today: "mcp.save（`{ workspaceId, scope, server }`）",
    status: "已接",
  },
  {
    legacy: "config.deleteMcp",
    today: "mcp.remove（`{ workspaceId, scope, name }`）",
    status: "已接",
  },
  {
    legacy: "config.saveEndpoint",
    today: "config.endpoint.add（新建） / config.endpoint.update（改一条）",
    status: "已接",
  },
  { legacy: "config.deleteEndpoint", today: "config.endpoint.remove", status: "已接" },

  // ---- agent.* ----（助手定义那一面：`agentDefinition.*`）
  { legacy: "agent.list", today: "agentDefinition.list", status: "已接" },
  { legacy: "agent.get", today: "agentDefinition.get", status: "已接" },
  { legacy: "agent.create", today: "agentDefinition.create", status: "已接" },
  { legacy: "agent.update", today: "agentDefinition.update", status: "已接" },
  { legacy: "agent.delete", today: "agentDefinition.remove", status: "已接" },
  { legacy: "agent.setModel", today: "agentDefinition.update（`change.modelId`）", status: "已接" },
  {
    legacy: "agent.setThinking",
    today: "agentDefinition.update（`change.modelParams`：档位展开成参数）",
    status: "已接",
  },
  { legacy: "agent.restoreFactory", today: "agentDefinition.reset", status: "已接" },

  // ---- model.* ----（模型与图片模型：`config.model.*` / `config.imageModel.*`）
  { legacy: "model.list", today: "config.get（`config.models`）", status: "已接" },
  { legacy: "model.listImages", today: "config.get（`config.imageModels`）", status: "已接" },
  { legacy: "model.create", today: "config.model.add", status: "已接" },
  { legacy: "model.update", today: "config.model.update", status: "已接" },
  { legacy: "model.delete", today: "config.model.remove", status: "已接" },
  { legacy: "model.restoreFactory", today: "config.model.reset", status: "已接" },
  {
    legacy: "model.saveImage",
    today: "config.imageModel.add（新建） / config.imageModel.update（改一条）",
    status: "已接",
  },
  { legacy: "model.deleteImage", today: "config.imageModel.remove", status: "已接" },

  // ---- asset.* ----
  { legacy: "asset.begin", today: "asset.upload（一段式，不再分三段）", status: "未搬" },
  { legacy: "asset.end", today: "asset.upload（一段式）", status: "未搬" },
  { legacy: "asset.get", today: "asset.get", status: "未搬" },

  // ---- completion.* ----
  {
    legacy: "completion.files",
    // 会话层直连 `api.workspace.files.query({ workspaceId, query })`，不走这条旧路
    today: "已由 `api.workspace.files` 取代",
    status: "未搬",
  },

  // ---- handoff.* ----
  {
    legacy: "handoff.start",
    today: "handoff.start（入参 `{ sessionId, mode? }`：`then` 退场）",
    status: "未搬",
  },
  { legacy: "handoff.listDocuments", today: "没有（宿主这一版不列交接文档）", status: "未搬" },

  // ---- search.* ----
  { legacy: "search.sessions", today: "search.sessions", status: "未搬" },
  { legacy: "search.messages", today: "search.messages", status: "未搬" },
];

/** 旧路：`call(名字, 参数)` —— 与旧 wire 逐字一致的签名（只是能通的没剩几条） */
export interface LegacyCall {
  <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
}

/**
 * 造一条旧路。
 *
 * **已接**的两条在这里转成 procedure 调用：`session.create` → `api.session.create`（只建行，
 * 不唤醒也不投递），`session.send` → `api.agent.send`（只投给活着的执行体）；其余一律抛
 * `ClientError("unsupported", …)`，文案里带方法名 —— 用户看到的是「`agent.get` 这条路这一版
 * 还没接」，而不是一句没有主语的「不支持」。
 */
export function createLegacyCall(api: HostClient["api"], language?: string): LegacyCall {
  return (async (method: MethodName, params: MethodParams<MethodName>) => {
    switch (method) {
      case "session.send": {
        const sent = params as MethodParams<"session.send">;
        const opened = await api.session.open.query({ sessionId: sent.sessionId });
        const messageId = newMessageId();
        await api.agent.send.mutate({
          workspaceId: opened.session.workspaceId,
          agentId: opened.session.agentId,
          content: sent.input.content,
          messageId,
          sessionId: sent.sessionId,
        });
        return { userMessageId: messageId, attachments: [] } as MethodResult<"session.send">;
      }
      case "session.create": {
        const created = params as MethodParams<"session.create">;
        // 建行只写库：这一条旧路要的是一行，不该顺手唤醒执行体，也不该投一条空正文过去
        const { session } = await api.session.create.mutate({
          workspaceId: created.workspaceId,
          agentId: created.agentId,
        });
        return { session } as unknown as MethodResult<"session.create">;
      }
      default:
        throw unsupported(method, language);
    }
  }) as LegacyCall;
}

/** 「这条路这一版还没接」——一句能照做的话，带方法名 */
function unsupported(method: MethodName, language: string | undefined): ClientError {
  const text =
    language !== undefined && language.startsWith("zh")
      ? `这一版还没接 \`${method}\` 这条旧路（宿主已换成 tRPC procedure 面，这个域下一刀再搬）`
      : `\`${method}\` is not wired yet in this build (the host moved to tRPC procedures; this domain comes next)`;
  return new ClientError("unsupported", text, { detail: { method } });
}

/** 一条新消息 id（宿主只要求「客户端给的那个 id」，形状由它自己认） */
function newMessageId(): string {
  return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 按名字查表里那一行（用例与自检用；查不到就是 `undefined`） */
export function legacyRowOf(method: LegacyName): LegacyMethodRow | undefined {
  return LEGACY_METHODS.find((row) => row.legacy === method);
}
