/**
 * 会话层的方法门面 —— 把 `ServerClient.call("session.xxx", …)` 收成带类型的方法。
 *
 * 为什么要这一层：`ServerClient.call` 的 `params` 是 `unknown`，逐处手写方法名与
 * 参数形状等于把线上契约抄一遍。这里每个方法都对着 `@ai-zen/agents-server` 的类型，
 * 协议改了这边编译不过，而不是运行期才 500。
 *
 * 它是**无状态**的薄封装（只持有连接）：TUI 拿到一个实例就能开/发/存/取快照。
 */

import {
  AGENT_METHODS,
  EVENT_METHODS,
  SESSION_METHODS,
  WORKSPACE_METHODS,
  type AgentSetModelResult,
  type HandoffMode,
  type MessageContent,
  type SessionAttachResult,
  type SessionCancelResult,
  type SessionCreateResult,
  type SessionHandoffResult,
  type SessionListResult,
  type SessionListSavedResult,
  type SessionLastResult,
  type SessionMigrateResult,
  type SessionRollbackResult,
  type SessionSaveAsResult,
  type SessionSaveResult,
  type SessionSendResult,
  type SessionSnapshotResult,
  type WorkspaceResolveResult,
  type WorkspaceFilesResult,
} from "@ai-zen/agents-server";
import type { ServerClient } from "./types.js";

/** 开一个会话要多说几句，单独成类型，避免调用点各拼一份 */
export interface OpenSessionInput {
  /**
   * 工作目录绝对路径。**建议不给**：不给就用服务端自己的目录（那才是会话真正跑的地方）。
   * 给了也只是“我希望是这里”，路径仍由服务端规范化。
   */
  path?: string;
  agentId?: string;
  /** 续接已有存档时给出它的 id；不给则由服务端分配新 id */
  sessionId?: string;
}

export class RemoteSessions {
  constructor(private readonly client: ServerClient) {}

  /** 让这条连接开始收事件（服务端主动推的阶段 / 增量 / 收尾） */
  async watch(): Promise<void> {
    await this.client.call(EVENT_METHODS.watch);
  }

  /**
   * 路径 → 工作区身份。
   *
   * 不给 `path` 就是在问「服务端自己的工作区在哪」—— 远程部署时这才是唯一有意义的问法：
   * 客户端把自己进程的当前工作目录送上去，等于让客户端替服务端决定会话跑在哪个目录。
   */
  async resolveWorkspace(path?: string): Promise<WorkspaceResolveResult> {
    return await this.client.call<WorkspaceResolveResult>(
      WORKSPACE_METHODS.resolve,
      path ? { path } : {},
    );
  }

  /** 工作区的文件清单（`@` 补全用；扫的是**服务端**磁盘） */
  async files(workspaceId: string): Promise<WorkspaceFilesResult> {
    return await this.client.call<WorkspaceFilesResult>(WORKSPACE_METHODS.files, { workspaceId });
  }

  /** 某个工作区「上一轮会话」的指针（续接用；没有则 null） */
  async last(workspaceId: string): Promise<SessionLastResult> {
    return await this.client.call<SessionLastResult>(SESSION_METHODS.last, { workspaceId });
  }

  /** 开（或续接）一个会话 */
  async open(input: OpenSessionInput): Promise<SessionCreateResult> {
    const workspace = await this.resolveWorkspace(input.path);
    return await this.client.call<SessionCreateResult>(SESSION_METHODS.create, {
      workspaceId: workspace.workspaceId,
      // 服务端能自己反查路径：客户端只在**它确实知道**时才递上去
      ...(input.path ? { path: input.path } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  /**
   * 接上一段**已经存在**的会话。
   *
   * 与 `open()` 的区别就是「要不要开新的」：`open()` 对活着的 id 会被服务端拒掉
   * （`session-exists`，不静默顶掉正在跑的会话），而「接着上次」/「`/load` 选一段」
   * 要的恰恰是接上那段 —— 它可能还在服务端内存里活着（上次 TUI 只是断开了连接）。
   * 活着就接、盘上有就装回来，都没有则服务端回 `session-missing`。
   */
  async attach(input: {
    workspaceId: string;
    sessionId: string;
    /** 服务端已知这个工作区时可以不给 */
    path?: string;
    agentId?: string;
  }): Promise<SessionAttachResult> {
    return await this.client.call<SessionAttachResult>(SESSION_METHODS.attach, input);
  }

  /**
   * 开始一轮；返回 `turnId`，过程与结果都走事件。
   *
   * `content` 可以是纯文本，也可以是「文本 + 图片」的内容块数组 —— 服务端不解释它，
   * 原样交给 Agent（内容块怎么拼是客户端的事，见 `protocol/sessions.ts`）。
   */
  async send(sessionId: string, content: MessageContent): Promise<SessionSendResult> {
    return await this.client.call<SessionSendResult>(SESSION_METHODS.send, { sessionId, content });
  }

  async cancel(sessionId: string): Promise<SessionCancelResult> {
    return await this.client.call<SessionCancelResult>(SESSION_METHODS.cancel, { sessionId });
  }

  /** 某个工作区下活着的会话 */
  async list(workspaceId: string): Promise<SessionListResult> {
    return await this.client.call<SessionListResult>(SESSION_METHODS.list, { workspaceId });
  }

  /** 某个工作区下已存档的会话（`/load` 的选择器用，按写入时间倒序） */
  async listSaved(workspaceId: string): Promise<SessionListSavedResult> {
    return await this.client.call<SessionListSavedResult>(SESSION_METHODS.listSaved, { workspaceId });
  }

  /** 撤回：从 `index` 起删掉并落盘；返回剩下的消息与被删的首条用户消息 */
  async rollback(sessionId: string, index: number): Promise<SessionRollbackResult> {
    return await this.client.call<SessionRollbackResult>(SESSION_METHODS.rollback, { sessionId, index });
  }

  /** 整份快照：消息 / 阶段 / 轮次 / 用量 */
  async snapshot(sessionId: string): Promise<SessionSnapshotResult> {
    return await this.client.call<SessionSnapshotResult>(SESSION_METHODS.snapshot, { sessionId });
  }

  /**
   * 换模型：写的是 **Agent 定义**（`agent.model.set`），影响所有用这个 Agent 的会话。
   *
   * 所以它不在 `session.*` 里 —— 名字得让人一眼看出作用范围。换完要让会话
   * {@link reload}，Agent 才会按新模型重建。
   */
  async setModel(agentId: string, modelId: string): Promise<AgentSetModelResult> {
    return await this.client.call<AgentSetModelResult>(AGENT_METHODS.setModel, { agentId, modelId });
  }

  /** 按磁盘上的新配置/定义重建 Agent（保留消息），返回重建后的快照 */
  async reload(sessionId: string): Promise<SessionSnapshotResult> {
    return await this.client.call<SessionSnapshotResult>(SESSION_METHODS.reload, { sessionId });
  }

  /** 落盘当前会话（并把它设为「上一轮会话」） */
  async save(sessionId: string): Promise<SessionSaveResult> {
    return await this.client.call<SessionSaveResult>(SESSION_METHODS.save, { sessionId });
  }

  /**
   * 另存为指定 id（`/save <名字>`）：服务端写新档、删旧档，并**换掉活会话的键**。
   *
   * 返回值里的 `sessionId` 才是当前有效的那个 —— 与 `migrate` 同一个规矩。
   */
  async saveAs(sessionId: string, id: string): Promise<SessionSaveAsResult> {
    return await this.client.call<SessionSaveAsResult>(SESSION_METHODS.saveAs, { sessionId, id });
  }

  /**
   * 只产出交接文档（`/handoff`）：会话 id 不变、历史不动。
   *
   * 进度（`handoffWriting` / `handoffPath` / 降级）走 `session.notice`，流式正文走
   * `message.delta` —— 这个方法可能要跑一两分钟，等回执期间界面靠事件渲染。
   */
  async handoff(sessionId: string, mode?: HandoffMode): Promise<SessionHandoffResult> {
    return await this.client.call<SessionHandoffResult>(SESSION_METHODS.handoff, {
      sessionId,
      ...(mode ? { mode } : {}),
    });
  }

  /**
   * 交接 + 开新会话（`/migrate`）：**返回的 `sessionId` 是新的**。
   *
   * 调用方必须把之后所有请求都换到新 id 上，旧 id 在服务端已经退场（`unknown-session`）。
   */
  async migrate(sessionId: string, mode?: HandoffMode): Promise<SessionMigrateResult> {
    return await this.client.call<SessionMigrateResult>(SESSION_METHODS.migrate, {
      sessionId,
      ...(mode ? { mode } : {}),
    });
  }
}
