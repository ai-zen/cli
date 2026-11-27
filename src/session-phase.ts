/**
 * 阶段行的**那一句话** —— 从契约事实现推，不存状态。
 *
 * ## 为什么不是「六态」
 *
 * 新契约里**没有** `generation` 那样的阶段值：宿主只报忙闲那一格（`working` / `idle`），更细的
 * 「排队 / 在想 / 在拼工具 / 在等工具 / 在出字」由客户端按到达的事件自己推（`PRD 4.4`、`3.9`）。
 * 所以这一层既没有状态机、也没有可以存下来的 `phase` 字段：它是一次**纯函数调用**，入参是
 * 「忙闲 + 此刻那条消息长什么样」，出参是一句话。同一份事实读两次，得到的永远是同一句。
 *
 * ## 推的依据只有这几样（全在契约里）
 *
 *   1. 忙闲那一格（`SessionState.status`）：`idle` 就没在动，没什么可说的；
 *   2. 最后一条消息的 `role` 与 `status`：AgentDefinition 那条还在 `pending` / `writing`，
 *      就是还没有开始输出；
 *   3. 那条 AgentDefinition 消息的 `reasoning_content` / `content` / `tool_calls` / `finish_reason`：
 *      思考在前、正文在后、工具调用在中间（core 的一条消息内部顺序恒定）。
 *
 * 外加一个只有工具那一段才需要的事实：工具结果消息（`role: tool`）回来了几条 —— 还有几条没回来
 * 就说明还在等它们。
 *
 * ## 「排队」不在这条线上
 *
 * 宿主从来不报「在排队」：那是**用户的话还在 inbox 里、这一任还没取走**（`PRD 4.1`）。但这句话不该
 * 由阶段行来说 —— 屏上那块**排队区**（`tui/components.tsx` 的 `InboxArea`）已经把队里那几句**逐条
 * 回显**出来了（「排队中 <原话预览>」，最多三行 + 「还有 N 条」）。同一件事在两处各说一遍，只是在
 * 每一帧多占一行宽度。
 *
 * 于是阶段行只回答「这一任此刻在干什么」：手上没活就不说，有活就说连接 / 思考 / 工具 / 输出。
 * 队列里的话还没有被取走时，这一行说的是**上一轮**的状态（那一轮确实还在跑），排队区说的是
 * **仍在队列里的那几句** —— 两者并读没有歧义。
 *
 * 文案仍然是客户端的事（`i18n`）：事实来自宿主，句子来自这里，与命令表同一条规矩。
 */

import { AgentNS } from "@ai-zen/agents-core";
import { t } from "./i18n/index.js";
import type { SessionActivity } from "./session/types.js";

/** 推那句话要的输入：**全部是现读的事实**，没有一份是这里存下来的 */
export interface PhaseFacts {
  /** 忙闲那一格（`session.status`）；`null` = 还没读到 */
  status: SessionActivity | null;
  /** 这段会话的消息（`session.messages`，主线；subagent 的话不在里面） */
  messages: readonly AgentNS.Message[];
  /**
   * 正在交接（`session.handoffSince`）—— `true` 时这句话盖过下面所有阶段。
   *
   * 交接期间这一段**照旧有自己的忙闲与两道开关**（`handoff` 不在四件事里），所以不能把它塞进
   * `status` 那一格：那个字段只有一个值。它是另一件事，单独占一行话（PRD 4.5）。
   */
  handingOff: boolean;
}

/**
 * 阶段行的文案；`null` = 手上没活（不占行）。
 *
 * 与 PRD 3.9 的几句话一一对得上（连上了 / 在想 / 调工具 / 等工具回来 / 在输出），另加
 * 一句更细的「等待首字」（请求已发出、一条字都还没回来 —— 旧版把这两件事压在同一句里，屏上
 * 分不开「话还在队里」与「话已送到、服务端还没有输出」）。它们只是**这一帧的读数**，
 * 不是被记住的一格。
 */
export function phaseLine(facts: PhaseFacts): string | null {
  // 交接优先，而且**不看忙闲**：交接期间这一段可能在写文档（忙），也可能在等它们收口（闲），
  // 但界面该说的是同一句话 —— 「正在交接」（PRD 4.5）。
  if (facts.handingOff) return t("phase.handoff");
  if (facts.status !== "working") return null;
  const messages = facts.messages;
  const last = messages[messages.length - 1];

  // 状态是忙，但消息还没有到达：这一段仍在装配，或者还没有取到消息
  if (!last) return t("phase.connecting");

  if (last.role === AgentNS.Role.Tool) {
    // 一条工具结果已经回来：其余工具仍在运行（并行时把各自的名字都列出来）
    const names = outstandingToolNames(messages);
    return names.length === 0
      ? t("phase.toolWaiting")
      : t("phase.toolWaitingWith", { name: names.join(t("common.listSeparator")) });
  }

  // 用户那句刚落、AgentDefinition 那条还没出现
  if (last.role !== AgentNS.Role.Assistant) return t("phase.connecting");

  const calls = last.tool_calls ?? [];
  if (calls.length > 0) {
    // `finish_reason === tool_calls` 才是「参数拼完了、这些工具在跑」；
    // 之前是「还在拼参数」（名字通常已经到了）
    if (last.finish_reason === AgentNS.FinishReason.ToolCalls) {
      const names = toolNamesOf(calls);
      return names.length === 0
        ? t("phase.toolWaiting")
        : t("phase.toolWaitingWith", { name: names.join(t("common.listSeparator")) });
    }
    const names = toolNamesOf(calls);
    return names.length === 1
      ? t("phase.toolCallingWith", { name: names[0]! })
      : t("phase.toolCalling");
  }

  if (hasText(last.content)) return t("phase.streaming");
  if ((last.reasoning_content ?? "").length > 0) return t("phase.thinking");
  // 请求已发出、首字未到（服务端排队 / 冷启动都算这一段）
  return t("phase.waitingFirstToken");
}

/** 一条消息的内容段里有没有正文（字符串或段数组两种形状） */
function hasText(content: AgentNS.MessageContent | undefined): boolean {
  if (content === undefined) return false;
  if (typeof content === "string") return content.length > 0;
  return content.some((section) => section.type !== "text" || section.text.length > 0);
}

/** 一组工具调用里出现过的工具名（去重、保持顺序；没名字的忽略） */
function toolNamesOf(calls: readonly AgentNS.ToolCall[]): string[] {
  const names: string[] = [];
  for (const call of calls) {
    const name = call.function?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 最近一次工具调用里**还没有结果**的那几个的名字。
 *
 * 判据只有一处：最后一条带 `tool_calls` 的 AgentDefinition 消息之后，哪些 `role: tool` 消息已经把结果带回来了
 * （按 `tool_call_id` 对）。这是在读消息本身，不是另记一份「在跑的工具」—— 那份清单没有第二个
 * 事实来源，记下来就必然与消息分叉。
 */
function outstandingToolNames(messages: readonly AgentNS.Message[]): string[] {
  let index = messages.length - 1;
  while (index >= 0 && (messages[index]!.tool_calls ?? []).length === 0) index -= 1;
  if (index < 0) return [];
  const calls = messages[index]!.tool_calls ?? [];
  const done = new Set<string>();
  for (const message of messages.slice(index + 1)) {
    if (message.role !== AgentNS.Role.Tool) continue;
    if (message.tool_call_id) done.add(message.tool_call_id);
  }
  const remaining = calls.filter((call) => call.id === undefined || !done.has(call.id));
  return toolNamesOf(remaining);
}
