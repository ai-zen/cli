/**
 * 一段会话的客户端镜像：`session.open` 一次取全，之后按 `HostEvent` 增量。
 *
 * 镜像放在 CLI 这一侧，因为新契约里没有增量事件：流式期间宿主每片都推一条 `message.changed`，
 * 载荷是整条消息，于是「攒」不需要任何规则 —— 一条消息一个 `id`，来了就整条替换。旧连接层自己
 * 维护镜像，是因为它认得 `message.delta` 怎么折进消息，那套规则已经不存在。剩下的判断只有一条：
 * 这条事件是不是这一段会话的。
 *
 * `HostConnection.open(sessionId)` 打一次 `session.open`，把 `session` / `live` / `messages` /
 * `inbox` 四格一次铺好；之后每来一条 `HostEvent` 就按它改一格。
 *
 * 三处容易读错的地方：
 *
 * 1. 死活不等事件：`live !== null` 就是 `alive: true`，它等于 `false` 就是死的 —— 这是打开那一刻
 *    的事实，不必等 `agent.alive`；
 * 2. subagent 的话单独一栏：`subagent.message` 带 `toolCallId`，它不进主转录；
 * 3. inbox 只是宿主报出来的读数副本：打开时取一次，之后按事件换。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { HostEvent } from "./index.js";
import type { InboxItem, SessionActivity, SubAgentFact } from "../session/types.js";

/**
 * 一条事件属于哪一段会话，不属于任何一段时是 `null`。
 *
 * 写成函数是因为 `"sessionId" in event` 这种写法在联合上会窄化成 `string | undefined`。
 */
export function sessionIdOf(event: HostEvent): string | null {
  if (event.type === "session.changed") return event.session.id;
  if (event.type === "notice") return event.notice.sessionId;
  if (event.type === "notice.cleared") return event.sessionId ?? null;
  return event.sessionId;
}

/**
 * `session.open` 回来的那一份，出参原样，只改名字。
 *
 * 消息与排队区的类型写 `unknown[]` 是故意的：它们过了一条 JSON 通道，字段一个不少，但类实例上的
 * 方法（`AgentError.toJSON` 之类）不在了，而 `AgentNS.Message` 是类实例的形状。进镜像时用
 * {@link toCoreMessages} 收成 core 的类型。
 */
export interface SessionOpenView {
  session: MirrorSessionRow;
  live: {
    state: SessionActivity;
    inputPaused: boolean;
    outputPaused: boolean;
    handingOff: boolean;
  } | null;
  messages: readonly unknown[];
  inbox: readonly unknown[];
}

/**
 * wire 上的消息 → core 的 `Message`。
 *
 * 转换只是把「过了 JSON 通道之后只剩字段」这件事说一次：调用方读的全是字段（`role` / `content` /
 * `status` / `usage`），一个方法都不调。
 */
export function toCoreMessages(messages: readonly unknown[]): AgentNS.Message[] {
  return messages as AgentNS.Message[];
}

/** 排队 InboxEntry → core 的 `InboxEntry`，同一个理由 */
function toInboxEntries(entries: readonly unknown[]): AgentNS.InboxEntry[] {
  return entries as AgentNS.InboxEntry[];
}

/** 宿主 `session.open` 出参里的 `session`，字段一个不改 */
export interface MirrorSessionRow {
  id: string;
  workspaceId: string;
  name: string;
  /** 名字从哪儿来：`default` 是建行时的占位名（显示成「新会话 · 时刻」），`handoff` 是存档 */
  nameSource: "default" | "auto" | "user" | "handoff" | "legacy";
  pinned: boolean;
  agentId: string;
  modelId: string | null;
  thinkingLevel: string | null;
  autoHandoff: boolean;
  lineage: string | null;
  handoffThreshold: number | null;
  guardThreshold: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 一路 subagent 说过的话，按它挂在的那次工具调用分组 */
export interface SubAgentColumn {
  toolCallId: string;
  messages: AgentNS.Message[];
}

/** 每次读都现拼，不是第二份状态 */
export interface MirrorSnapshot {
  sessionId: string;
  session: MirrorSessionRow;
  messages: AgentNS.Message[];
  subAgents: SubAgentColumn[];
  status: SessionActivity | null;
  inputPaused: boolean | null;
  outputPaused: boolean | null;
  alive: boolean | null;
  handingOff: boolean;
  inbox: InboxItem[];
}

export class SessionMirror {
  readonly sessionId: string;
  session: MirrorSessionRow;

  private messagesValue: AgentNS.Message[] = [];
  /** `toolCallId` → 它说过的话（顺序即到达顺序） */
  private readonly columns = new Map<string, AgentNS.Message[]>();
  private statusValue: SessionActivity | null = null;
  private inputPausedValue: boolean | null = null;
  private outputPausedValue: boolean | null = null;
  private aliveValue: boolean | null = null;
  private handingOffValue = false;
  private inboxValue: InboxItem[] = [];
  /** 事件比 `open` 的回执先到时要记住它们：铺完之后按序重放一次（否则那几条永远丢） */
  private readonly buffered: HostEvent[] = [];
  private opened = false;

  constructor(session: MirrorSessionRow) {
    this.sessionId = session.id;
    this.session = session;
  }

  get messages(): readonly AgentNS.Message[] {
    return this.messagesValue;
  }

  get roster(): SubAgentFact[] {
    return rosterOf(this.messagesValue, this.columns);
  }

  subAgent(toolCallId: string): readonly AgentNS.Message[] {
    return this.columns.get(toolCallId) ?? [];
  }

  /**
   * 第一次铺：`session.open` 的四格一次到位。
   *
   * 事件可能已经先到了（订阅比这一次往返早）：它们被记在 {@link buffered} 里，铺完之后按原序
   * 重放一次 —— 丢掉它们等于丢掉「打开这一瞬间正好在流的那一片」。
   */
  applyOpen(view: SessionOpenView): void {
    this.session = view.session;
    this.messagesValue = toCoreMessages(view.messages);
    this.inboxValue = toInboxEntries(view.inbox).flatMap(inboxItemOf);
    this.statusValue = view.live?.state ?? null;
    this.inputPausedValue = view.live?.inputPaused ?? null;
    this.outputPausedValue = view.live?.outputPaused ?? null;
    this.aliveValue = view.live !== null;
    this.handingOffValue = view.live?.handingOff ?? false;
    this.opened = true;
    for (const event of this.buffered.splice(0)) this.apply(event);
  }

  /**
   * 一条事件。不是这一段的一律丢掉（`subscribe` 拿到的是全进程一条流）。
   *
   * `open` 还没回来时先进缓冲：那时 `messages` 还是空的，直接折进去会被随后那次铺盖掉。
   */
  apply(event: HostEvent): void {
    if (sessionIdOf(event) !== this.sessionId) return;
    if (!this.opened) {
      this.buffered.push(event);
      return;
    }

    switch (event.type) {
      case "message.added":
      case "message.changed":
        this.putMessage(event.message);
        return;
      case "message.removed":
        this.messagesValue = this.messagesValue.filter((message) => message.id !== event.messageId);
        return;
      case "subagent.message":
        this.putSubAgentMessage(event.toolCallId, event.message);
        return;
      case "agent.status":
        this.statusValue = event.status;
        return;
      case "agent.paused":
        if (event.side === "input") this.inputPausedValue = event.paused;
        else this.outputPausedValue = event.paused;
        return;
      case "agent.alive":
        this.aliveValue = event.alive;
        return;
      case "agent.inbox":
        this.inboxValue = event.inbox.flatMap(inboxItemOf);
        return;
      case "session.changed":
        this.session = event.session;
        return;
      case "session.handoff":
        this.handingOffValue = event.handingOff;
        return;
      default:
        // 通知 / 问题 / 清空通知：不是镜像的事实（会话层自己订）
        return;
    }
  }

  snapshot(): MirrorSnapshot {
    return {
      sessionId: this.sessionId,
      session: this.session,
      messages: this.messagesValue,
      subAgents: [...this.columns].map(([toolCallId, messages]) => ({
        toolCallId,
        messages,
      })),
      status: this.statusValue,
      inputPaused: this.inputPausedValue,
      outputPaused: this.outputPausedValue,
      alive: this.aliveValue,
      handingOff: this.handingOffValue,
      inbox: this.inboxValue,
    };
  }

  /** 主转录里那条：同 id 就地替换，新的追加在后面 */
  private putMessage(message: AgentNS.Message): void {
    const index = this.messagesValue.findIndex((item) => item.id === message.id);
    if (index < 0) {
      this.messagesValue = [...this.messagesValue, message];
      return;
    }
    const next = [...this.messagesValue];
    next[index] = message;
    this.messagesValue = next;
  }

  private putSubAgentMessage(toolCallId: string, message: AgentNS.Message): void {
    const column = this.columns.get(toolCallId) ?? [];
    const index = column.findIndex((item) => item.id === message.id);
    const next = [...column];
    if (index < 0) next.push(message);
    else next[index] = message;
    this.columns.set(toolCallId, next);
  }
}

/**
 * 名册：主体里每一次 `subagent` 委派 → 一行。
 *
 * 宿主这一版不报名册（旧 `session.state.subAgents` 那一格没了），能读的只有事实：
 *
 *   · `toolCallId` —— 那些 `subagent.message` 事件带过来的；
 *   · 工具名 —— 主体里那次委派的 `tool_calls[].function.name`；
 *   · 状态 —— 那次委派的工具结果消息定型了没有：`role: "tool"` 且 `tool_call_id` 就是这个
 *     `toolCallId` 的那条，状态不再是 `pending` / `writing` 就是这一趟真的回来了，否则 `working`。
 *     一条话都没有时也按 `working`（它刚被派出去）。
 *
 * 为什么不看「那一栏最后一条消息定型了没有」：那是早先的判据，错在把「它说完了这一句」当成了
 * 「它干完了这趟活」。core 里 assistant 消息定型（`status = completed` + `responseFinished`）发生在
 * 工具开跑之前（`core/src/Agent.ts` 的 `runTurn`：定型 → `runTools`），而 ReActLoop 的常态正是
 * 「说一句带 tool_calls 的话，去跑一个可能几分钟的工具，再说一句」。按那个判据，subagent 吐出第一句
 * 话的那一刻它就被判成 `ended`，屏幕上的圆点变灰、`notice.subAgentDone` 直接弹「已完成」，而它其实
 * 正卡在工具里。
 *
 * 委派工具自己那条 tool 消息没有这个问题：`AgentToolLazy.exec` 是 `runOnce()` 返回之后才交回结果
 * 的，所以那条消息定型等价于这个 subagent 这一趟结束。它还有两个好处：是主转录里的事实而不是推的，
 * 并且随消息入库，重开一段会话也读得到。
 */
function rosterOf(
  messages: readonly AgentNS.Message[],
  columns: ReadonlyMap<string, AgentNS.Message[]>,
): SubAgentFact[] {
  const names = new Map<string, string>();
  /** 委派工具的结果消息已定型的那些调用 */
  const returned = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.id !== undefined && call.function?.name !== undefined) {
        names.set(call.id, call.function.name);
      }
    }
    if (message.role !== AgentNS.Role.Tool) continue;
    const toolCallId = message.tool_call_id;
    if (toolCallId === undefined || toolCallId === "") continue;
    // 没有状态的那条不算定型：`pending` 是「已经写进 messages、工具还在跑」
    if (message.status === undefined) continue;
    if (message.status === AgentNS.MessageStatus.Pending) continue;
    if (message.status === AgentNS.MessageStatus.Writing) continue;
    returned.add(toolCallId);
  }

  return [...columns].map(([toolCallId]) => ({
    toolCallId,
    name: names.get(toolCallId) ?? toolCallId,
    state: returned.has(toolCallId) ? "ended" : "working",
  }));
}

/**
 * 宿主的一条排队 InboxEntry → 界面那一行。
 *
 * 旧版这一行是宿主拼好的（`InboxItem.preview`）；新契约给的是 core 的 `InboxEntry` 原样，所以
 * 摘要由这里现拼：文本段按顺序拼接、空白折叠、超 120 字截断加 `…`，非文本段记 `[图片]` /
 * `[文件]`。没有正文的 InboxEntry 直接丢：它不是一句话，排队区说的是「还有几句没送
 * 出去」。
 */
function inboxItemOf(entry: AgentNS.InboxEntry): InboxItem[] {
  if (entry.content === undefined) return [];
  const id = entry.messageId ?? entry.createdAt;
  return [
    {
      messageId: id,
      source: entry.source ?? { kind: "system", label: "" },
      createdAt: entry.createdAt,
      // 优先级原样带出去：界面要说清它为什么还没被取走（`high` 在工具边界就取、`low` 等这一批跑完）
      priority: entry.priority,
      preview: previewOf(entry.content),
    },
  ];
}

function previewOf(content: AgentNS.MessageContent): string {
  const text =
    typeof content === "string"
      ? content
      : content
          .map((section) => {
            if (section.type === "text") return section.text;
            return section.type === "image_url" ? "[图片]" : "[文件]";
          })
          .join(" ");
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
}
