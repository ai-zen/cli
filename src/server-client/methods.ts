/**
 * 旧方法名到今天的 procedure 的对照表，服务于 `call` 这一条旧路。
 *
 * 宿主把整包 wire 方法换成 tRPC procedure 之后，CLI 里还留着一批按旧方法名说话的调用点
 * （`call("config.get")` 这种），不能一次搬完，所以两种调用方式并存：会话域走 `api` 直连
 * （`session.open` / `agent.send` / 三道开关），其余域仍走 `call`，而 `call` 对没有接上的名字一律抛
 * `ClientError("unsupported", …)`。「哪些通了、哪些还抛」只有 {@link LEGACY_METHODS} 一处说得出来。
 *
 * 「已接」只有一个判据：`call(名字, 参数)` 能真的转成 `api.*` 的一次调用。转不了的一律算「未搬」。
 * `agent.send` 不是旧方法名；旧的 `session.create` / `session.send` 是「已接」，前者转成
 * `api.session.create`（只建一行），后者转成 `api.runtime.agent.send`（只投递）。
 *
 * 「已接」这一列是这场迁移的施工记录，不是一条还在跑的路：配置域那 25 条旧路已经没有调用点
 * （`call` 的 `switch` 里也没有它们的分支），它们的「已接」说的是这个旧方法名服务的那件事今天走
 * 哪条 procedure。真正还在跑的「已接」只有 `session.create` / `session.send`。
 */

import type { HostClient } from "./index.js";
import { ClientError } from "./index.js";
import type { MethodName, MethodParams, MethodResult } from "../legacy-contract.js";

/** 已接 = 能转成 `api.*` 的一次调用；未搬 = 抛 `unsupported` */
export type LegacyStatus = "已接" | "未搬";

export interface LegacyMethodRow {
  readonly legacy: LegacyName;
  /** 今天的 procedure；没有对应的写「没有」并给出原因，「没有」本身不构成理由 */
  readonly today: string;
  readonly status: LegacyStatus;
}

/**
 * 已经从旧契约里整组删掉、只剩名字的旧方法。
 *
 * 名字留着、形状（`legacy-contract.ts` 里那一组）删掉，`MethodName` 也不再认它们，于是「这条旧路
 * 今天走哪条 procedure」只有这张表说得出来。`config.*` / `agent.*` / `model.*` 那三组形状
 * （`ConfigView` / `AgentView` / `ModelView` …）一个消费者都不剩；`host.reload` 的出参就是
 * `{ config: ConfigView, applied: ConfigApplyReport }`，两个形状随上面那一组一起删，而它本来就没有
 * 调用点。
 */
export type RetiredMethodName =
  | "completion.files"
  | "host.reload"
  | "config.get"
  | "config.patch"
  | "config.defaults.update"
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

export type LegacyName = MethodName | RetiredMethodName;

/**
 * 表本体（68 行，顺序照旧 wire 的方法表）。
 *
 * 第二列写的是今天的 procedure（宿主 `modules/api/*.ts` 里的名字），不是曾经的对应：读它的人要能
 * 照着去打一条 tRPC 调用。
 */
export const LEGACY_METHODS: readonly LegacyMethodRow[] = [
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

  { legacy: "workspace.list", today: "workspace.list", status: "未搬" },
  { legacy: "workspace.create", today: "workspace.create", status: "未搬" },
  { legacy: "workspace.get", today: "没有（用 workspace.list + find）", status: "未搬" },
  { legacy: "workspace.rename", today: "workspace.rename", status: "未搬" },
  { legacy: "workspace.delete", today: "workspace.delete", status: "未搬" },

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
  { legacy: "session.updateModel", today: "session.updateModel", status: "未搬" },
  { legacy: "session.setThinking", today: "session.updateThinkingLevel", status: "未搬" },
  { legacy: "session.updateThresholds", today: "session.updateThresholds", status: "未搬" },
  {
    legacy: "runtime.agent.runOnce",
    today: "runtime.agent.runOnce（入参换成 `{ cwd, agentId, content }`）",
    status: "未搬",
  },

  { legacy: "message.list", today: "session.open（`messages` 那一格）", status: "未搬" },

  { legacy: "question.list", today: "question.list", status: "未搬" },
  { legacy: "question.answer", today: "question.answer", status: "未搬" },

  { legacy: "notice.list", today: "notice.list", status: "未搬" },
  {
    legacy: "notice.dismiss",
    today: "没有（改用 notice.deleteAll({ sessionId })）",
    status: "未搬",
  },
  { legacy: "notice.deleteAll", today: "notice.deleteAll", status: "未搬" },

  {
    legacy: "config.get",
    today: "config.get（出参是 `AppConfig` + `presets`，不再是老 `ConfigView`）",
    status: "已接",
  },
  {
    legacy: "config.patch",
    today: "config.defaults.update / config.update（默认项五格 | 上限 + 中断策略两项）",
    status: "已接",
  },
  {
    legacy: "config.defaults.update",
    today: "config.defaults.update（`null` = 清空那一项）",
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
    today: "config.endpoints.create（新建） / config.endpoints.update（改一条）",
    status: "已接",
  },
  { legacy: "config.deleteEndpoint", today: "config.endpoints.delete", status: "已接" },

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

  { legacy: "model.list", today: "config.get（`config.models`）", status: "已接" },
  { legacy: "model.listImages", today: "config.get（`config.imageModels`）", status: "已接" },
  { legacy: "model.create", today: "config.models.create", status: "已接" },
  { legacy: "model.update", today: "config.models.update", status: "已接" },
  { legacy: "model.delete", today: "config.models.delete", status: "已接" },
  { legacy: "model.restoreFactory", today: "config.models.reset", status: "已接" },
  {
    legacy: "model.saveImage",
    today: "config.imageModels.create（新建） / config.imageModels.update（改一条）",
    status: "已接",
  },
  { legacy: "model.deleteImage", today: "config.imageModels.delete", status: "已接" },

  { legacy: "asset.begin", today: "asset.upload（一段式，不再分三段）", status: "未搬" },
  { legacy: "asset.end", today: "asset.upload（一段式）", status: "未搬" },
  { legacy: "asset.get", today: "asset.get", status: "未搬" },

  {
    legacy: "completion.files",
    today: "已由 `api.workspace.files` 取代",
    status: "未搬",
  },

  {
    legacy: "handoff.start",
    today: "handoff.start（入参 `{ sessionId, mode? }`：`then` 退场）",
    status: "未搬",
  },
  { legacy: "handoff.listDocuments", today: "没有（宿主这一版不列交接文档）", status: "未搬" },

  { legacy: "search.sessions", today: "search.sessions", status: "未搬" },
  { legacy: "search.messages", today: "search.messages", status: "未搬" },
];

/** 与旧 wire 逐字一致的签名 */
export interface LegacyCall {
  <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
}

/**
 * 造一条旧路。
 *
 * 已接的两条在这里转成 procedure 调用：`session.create` → `api.session.create`（只建行，不唤醒也不
 * 投递），`session.send` → `api.runtime.agent.send`（只投给活着的 Agent）；其余一律抛
 * `ClientError("unsupported", …)`。文案里带方法名，用户看到的是「`agent.get` 这条路这一版还没接」，
 * 而不是一句没有主语的「不支持」。
 */
export function createLegacyCall(api: HostClient["api"], language?: string): LegacyCall {
  return (async (method: MethodName, params: MethodParams<MethodName>) => {
    switch (method) {
      case "session.send": {
        const sent = params as MethodParams<"session.send">;
        const opened = await api.session.open.query({ sessionId: sent.sessionId });
        const messageId = newMessageId();
        await api.runtime.agent.send.mutate({
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
        // 建行只写库：这一条旧路要的是一行，不唤醒 Agent，也不投一条空正文
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

function unsupported(method: MethodName, language: string | undefined): ClientError {
  const text =
    language !== undefined && language.startsWith("zh")
      ? `这一版还没接 \`${method}\` 这条旧路（宿主已换成 tRPC procedure 面，这个域下一刀再搬）`
      : `\`${method}\` is not wired yet in this build (the host moved to tRPC procedures; this domain comes next)`;
  return new ClientError("unsupported", text, { detail: { method } });
}

/** 宿主只要求 id 由客户端给，形状由宿主自己认 */
function newMessageId(): string {
  return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function legacyRowOf(method: LegacyName): LegacyMethodRow | undefined {
  return LEGACY_METHODS.find((row) => row.legacy === method);
}
