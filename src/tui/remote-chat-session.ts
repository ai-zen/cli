/**
 * 远程对话会话 —— TUI 的「纯客户端」实现。
 *
 * 屏幕上的一切都从服务端来：消息走 `session.snapshot` 与事件，存档/交接/迁移走方法调用。
 * 本进程**不跑 Agent、不碰会话文件、不读 Skill** —— 它只需要一条到服务端的连接。
 *
 * ## 三处与服务端分工有关的细节
 *
 * 1. **`send()` 等到本轮结束才 resolve**。服务端的 `session.send` 是「立刻回 `turnId`、
 *    过程走事件」，而界面用 `await send()` 包着 busy 状态与输入禁用。所以这里把它等成
 *    语义上的一轮：拿到回执后挂起，直到同一 `turnId` 的 `turn.end` 到达。
 * 2. **正文靠事件拼、结束后用快照纠正**。增量（`message.delta`）拼出一个临时 assistant
 *    消息让屏幕能滚起来；`turn.end` 一到就重新要一份 `snapshot`，用服务端那份替换本地
 *    —— 客户端只做「暂时的不准确」，不做第二份真相。
 * 3. **换 id 的方法（`migrate` / `saveAs`）以返回值里的 `sessionId` 为准**。服务端在旧
 *    id 上收尾、再把活会话挪到新键；客户端拿到响应后立刻跟着换，之后的事件才过滤得上。
 *
 * ## 现在还没有的三样（协议里就没有，不是 bug）
 *
 * 图片粘贴、子 Agent 栏目、按阈值自动迁移。前者在界面上是「说清楚」而不是静默丢弃：
 * 带图提交会明确提示本次只发了文字；子 Agent 列表恒为空，栏目因此不出现。
 */

import { AgentNS, sumUsage } from "@ai-zen/agents-core";
import type { HandoffMode } from "@ai-zen/agents-sdk";
import {
  SESSION_EVENTS,
  type PhaseInfo,
  type ServerEvent,
  type SessionSnapshotResult,
} from "@ai-zen/agents-server";
import type { ClipboardImage } from "../clipboard.js";
import { AI_ZEN_DIR } from "../config.js";
import { t } from "../i18n/index.js";
import { ensureServer } from "../server-client/ensure-server.js";
import { RemoteSessions } from "../server-client/sessions.js";
import type { ServerClient } from "../server-client/types.js";
import { CLI_VERSION } from "../version.js";
import type {
  ChatSessionLike,
  ChatSessionNotifier,
  ChatSessionOptions,
  SubAgentView,
} from "./chat-session.js";
import { noticeText } from "./notice-text.js";
import { stripCwdNote } from "./text.js";
import { TokenRateMeter, type RateSample } from "./token-rate.js";

/** 客户端的身份：只进握手首帧与服务端日志，不参与鉴权 */
export const REMOTE_CLIENT_INFO = { name: "@ai-zen/cli", version: CLI_VERSION };

/** 开一段远程会话需要的最小输入 */
export interface OpenRemoteSessionInput {
  /** 工作区绝对路径（客户端的当前目录；`/load` 时仍然是它） */
  path: string;
  agentId?: string;
  /** 续接已有存档：只给 id，消息由服务端从存档装 */
  sessionId?: string;
}

export class RemoteChatSession implements ChatSessionLike {
  readonly agentId: string;
  /** 工作区路径：`/new` 要在同一个工作区里开新会话 */
  private readonly path: string;
  private readonly client: ServerClient;
  private readonly sessions: RemoteSessions;
  private readonly notifier: ChatSessionNotifier;
  private readonly rate = new TokenRateMeter();
  private readonly offs: Array<() => void> = [];

  private sessionId: string;
  private workspaceId: string;
  private modelIdValue = "";
  /** 服务端给的权威消息（事件期间的增量也追加在这里，收尾时整体换成快照） */
  private currentMessages: AgentNS.Message[] = [];
  /** 正在流式累积的那条 assistant 消息；不在生成中时 `null` */
  private streaming: { message: AgentNS.Message; text: string; reasoning: string } | null = null;
  private currentPhase: PhaseInfo | null = null;
  private lastUsageValue: AgentNS.Usage | undefined;
  /** 本轮等待中的 `turn.end`（`send()` 的 promise 靠它落地） */
  private pendingTurn: { turnId: number; resolve: () => void } | null = null;
  /** 最近一次收到的 `turn.end` 的轮次：挡住「事件比回执先到」那种竞态 */
  private lastEndedTurn = 0;

  private constructor(
    client: ServerClient,
    sessions: RemoteSessions,
    input: { path: string; agentId: string; sessionId: string; workspaceId: string },
    notifier: ChatSessionNotifier,
  ) {
    this.client = client;
    this.sessions = sessions;
    this.notifier = notifier;
    this.path = input.path;
    this.agentId = input.agentId;
    this.sessionId = input.sessionId;
    this.workspaceId = input.workspaceId;
    this.wire();
  }

  /**
   * 连接服务端并打开（或续接）一段会话。
   *
   * `watch()` 必须在 `open()` 之前：`open` 之后服务端可能立刻推 `session.phase`，
   * 订阅晚一步就会漏掉开头的阶段（屏幕停在上一个状态不动）。
   */
  static async create(
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
  ): Promise<RemoteChatSession> {
    const { client } = await ensureServer({ aiZenDir: AI_ZEN_DIR, clientInfo: REMOTE_CLIENT_INFO });
    return await RemoteChatSession.openWith(client, input, notifier);
  }

  /** 用一条已有连接开会话（测试注入连接用；`create` 是它的「自备连接」版本） */
  static async openWith(
    client: ServerClient,
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
  ): Promise<RemoteChatSession> {
    const sessions = new RemoteSessions(client);
    await sessions.watch();

    const opened = await sessions.open({
      path: input.path,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    const workspace = await sessions.resolveWorkspace(input.path);

    const session = new RemoteChatSession(
      client,
      sessions,
      {
        path: workspace.path,
        agentId: opened.agentId,
        sessionId: opened.sessionId,
        workspaceId: workspace.workspaceId,
      },
      notifier,
    );
    session.applySnapshot(await sessions.snapshot(opened.sessionId));
    return session;
  }

  // ==================== 对外面（ChatSessionLike） ====================

  get modelId(): string {
    return this.modelIdValue;
  }

  get currentId(): string {
    return this.sessionId;
  }

  get currentName(): string {
    return this.sessionId;
  }

  get messages(): AgentNS.Message[] {
    return this.currentMessages;
  }

  /**
   * 子 Agent 视图：**恒为空**。
   *
   * 协议里还没有子 Agent 事件（那是下一批的事），所以远程模式下 Agent 栏目不出现。
   * 返回空数组而不是报错：界面把「没有子 Agent」与「暂不支持子 Agent」渲染成同一件事，
   * 等协议补上事件，这里换个数据源就行。
   */
  get subAgents(): readonly SubAgentView[] {
    return [];
  }

  get lastUsage(): AgentNS.Usage | undefined {
    return this.lastUsageValue;
  }

  get totalUsage(): AgentNS.Usage {
    return sumUsage(this.currentMessages);
  }

  get phase(): PhaseInfo | null {
    return this.currentPhase;
  }

  get rateSample(): RateSample {
    return this.rate.snapshot();
  }

  async send(input: string, images: readonly ClipboardImage[] = []): Promise<void> {
    this.rate.begin();
    try {
      // 图片还没有协议承载（`session.send` 只收文本）：说清楚「本次只发了文字」。
      // 不静默丢弃（用户以为图送到了），也不整条不发（文字部分是有效的）。
      if (images.length > 0) {
        this.notifier.onNotice(t("notice.remoteImagesDropped", { n: images.length }), "error");
      }
      const { turnId } = await this.sessions.send(this.sessionId, input);
      await this.waitForTurn(turnId);
    } finally {
      this.rate.finish();
    }
  }

  abort(): void {
    // 取消是「请求服务端停」：`session.cancel` 会掐本轮请求与进行中的交接，随后 `turn.end` 到达
    void this.sessions.cancel(this.sessionId).catch(() => {});
  }

  async reset(): Promise<string | null> {
    const hasContent = this.currentMessages.some((message) => message.role === AgentNS.Role.User);
    const archivedId = hasContent ? await this.save() : null;

    const opened = await this.sessions.open({ path: this.path, agentId: this.agentId });
    this.sessionId = opened.sessionId;
    this.currentMessages = [];
    this.streaming = null;
    this.currentPhase = null;
    this.lastUsageValue = undefined;
    this.notifier.onChange(true);
    return archivedId;
  }

  async reload(): Promise<void> {
    this.applySnapshot(await this.sessions.reload(this.sessionId));
    this.notifier.onChange(true);
  }

  async handoff(mode?: HandoffMode): Promise<string> {
    const result = await this.sessions.handoff(this.sessionId, mode);
    this.applyMessages(result.messages);
    this.notifier.onChange(true);
    return result.handoffPath;
  }

  async migrate(mode?: HandoffMode): Promise<string> {
    const result = await this.sessions.migrate(this.sessionId, mode);
    // 先换 id：换完之后旧 id 的事件一律过滤掉，新会话的事件才接得上
    this.sessionId = result.sessionId;
    this.currentPhase = null;
    this.applyMessages(result.messages);
    this.notifier.onChange(true);
    return result.handoffPath;
  }

  async rollbackTo(index: number): Promise<string> {
    const result = await this.sessions.rollback(this.sessionId, index);
    this.applyMessages(result.messages);
    this.notifier.onChange(true);
    // 服务端给原文，工作目录备注由客户端剥（那是客户端自己拼进去的）
    return stripCwdNote(result.prompt);
  }

  async save(): Promise<string> {
    return (await this.sessions.save(this.sessionId)).sessionId;
  }

  async saveAs(id: string): Promise<string> {
    this.sessionId = (await this.sessions.saveAs(this.sessionId, id)).sessionId;
    return this.sessionId;
  }

  async listSaved(): Promise<Array<{ id: string }>> {
    return (await this.sessions.listSaved(this.workspaceId)).sessions;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.listSaved()).some((ref) => ref.id === id);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    // 挂着的 `send()` 不能永远悬着：连接没了，本轮只能算结束
    this.resolveTurn();
    this.client.close();
  }

  // ==================== 内部 ====================

  /**
   * 订阅事件并按 `sessionId` 过滤。
   *
   * 过滤不是可选优化：同一条连接可以先后服务好几段会话（`/load`、`/migrate` 换了 id），
   * 不过滤就会把上一段会话的事件拼进当前这段。
   */
  private wire(): void {
    const mine = <E extends ServerEvent["event"]>(
      event: E,
      handler: (payload: Extract<ServerEvent, { event: E }>) => void,
    ) => {
      this.offs.push(
        this.client.on(event, (payload) => {
          if ((payload as { sessionId?: string }).sessionId !== this.sessionId) return;
          handler(payload);
        }),
      );
    };

    mine(SESSION_EVENTS.phase, (event) => {
      this.currentPhase = event.phase;
      // 每个 chunk 都会带一条 phase：走合帧，别把渲染压到每片一次；回到空闲才立即上屏
      this.notifier.onChange(event.phase === null);
    });

    mine(SESSION_EVENTS.delta, (event) => {
      this.applyDelta(event.text, event.reasoning);
      this.rate.addDelta(event.text + event.reasoning);
      this.notifier.onChange(false);
    });

    mine(SESSION_EVENTS.turnEnd, (event) => {
      void this.finishTurn(event.turnId, event.error?.message);
    });

    mine(SESSION_EVENTS.notice, (event) => {
      this.notifier.onNotice(noticeText(event.code, event.params), toneOf(event.level));
    });

    // 全局通知不属于任何会话：切会话也不该消失，所以不过滤 sessionId
    this.offs.push(
      this.client.on(SESSION_EVENTS.globalNotice, (event) => {
        this.notifier.onNotice(noticeText(event.code, event.params), toneOf(event.level));
      }),
    );
  }

  /** 增量落到一条**暂时的** assistant 消息上（`turn.end` 之后会被快照替换掉） */
  private applyDelta(text: string, reasoning: string): void {
    if (!this.streaming) {
      const message = { role: AgentNS.Role.Assistant, content: "" } as AgentNS.Message;
      this.streaming = { message, text: "", reasoning: "" };
      this.currentMessages.push(message);
    }
    const streaming = this.streaming;
    streaming.text += text;
    streaming.reasoning += reasoning;
    // 就地改这两个字段：屏幕读的是同一个对象，不必每次新建一条消息
    streaming.message.content = streaming.text;
    if (streaming.reasoning) {
      (streaming.message as unknown as { reasoning_content?: string }).reasoning_content =
        streaming.reasoning;
    }
  }

  /**
   * 一轮收尾：用快照换成服务端那份权威结果。
   *
   * 为什么不自己把流拼完整：工具调用、思考内容、`omit` 标记、用量都只有服务端有；
   * 客户端拼出来的只是一个「能滚动的近似」，回合结束后必须被真件替换掉。
   */
  private async finishTurn(turnId: number, failure?: string): Promise<void> {
    this.lastEndedTurn = Math.max(this.lastEndedTurn, turnId);
    this.streaming = null;
    this.currentPhase = null;
    this.rate.finish();
    try {
      this.applySnapshot(await this.sessions.snapshot(this.sessionId));
    } catch {
      // 拿不到快照（服务端刚重启 / 连接断了）：本地那份仍然可读，下一轮还会再同步
    }
    if (failure) this.notifier.onNotice(failure, "error");
    this.resolveTurn(turnId);
    this.notifier.onChange(true);
  }

  /**
   * 等这一轮结束。
   *
   * 事件可能**比回执先到**（`session.send` 先推 `connecting` 再回 `turnId`，一轮太快时
   * 连 `turn.end` 都可能在回执之前落地），所以先看 `lastEndedTurn` 再挂 promise。
   *
   * 这里**不**去要快照“补一下”：快照是回合开始前的状态，它的回执若晚于第一批增量
   * 到达，就会把已经拼出来的正文抹掉（本地列表被整个换掉，而流式那条已经不在里面）。
   * 快照只在一个地方用：真正的 `turn.end`（见 `finishTurn`）。
   */
  private async waitForTurn(turnId: number): Promise<void> {
    if (this.lastEndedTurn >= turnId) return;
    // 从判断到挂 promise 之间没有 await：中间不会被事件插进来
    await new Promise<void>((resolve) => {
      this.pendingTurn = { turnId, resolve };
    });
  }

  /** 唤醒等待中的 `send()`；带 turnId 时只唤醒它自己等的那一轮 */
  private resolveTurn(turnId?: number): void {
    if (turnId !== undefined && this.pendingTurn && this.pendingTurn.turnId !== turnId) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    pending?.resolve();
  }

  private applySnapshot(snapshot: SessionSnapshotResult): void {
    this.applyMessages(snapshot.messages);
    this.currentPhase = snapshot.phase;
    this.modelIdValue = snapshot.modelId;
    this.lastUsageValue = snapshot.lastUsage as AgentNS.Usage | undefined;
  }

  private applyMessages(messages: unknown[]): void {
    this.currentMessages = [...(messages as AgentNS.Message[])];
  }
}

/** 通知语气：界面只分两档（普通 / 红），`warn` 归到红那一档 */
function toneOf(level: "info" | "warn" | "error"): "info" | "error" {
  return level === "info" ? "info" : "error";
}

/**
 * `ChatDeps.createSession` 的默认实现：连服务端（没有就拉起）并开一段会话。
 *
 * 工作区取客户端当前目录：TUI 就是在项目里跑的，`path` 由服务端规范化与建目录。
 */
export async function createRemoteChatSession(
  options: ChatSessionOptions,
  notifier: ChatSessionNotifier,
): Promise<ChatSessionLike> {
  return await RemoteChatSession.create(
    { path: process.cwd(), agentId: options.agentId, sessionId: options.sessionId },
    notifier,
  );
}
