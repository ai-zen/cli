/**
 * subagent 那一格的**结局** —— 名册只说「还在动 / 还挂着 / 已经散场」，更细的那两格从它自己的
 * 消息上推。
 *
 * ## 名册给什么、不给什么
 *
 * `session.state.subAgents[].state` 只有三格：`working` / `idle` / `ended`（`wire/states.ts` 的
 * `SubAgentFact`）。「出错」与「被叫停」名册不报 —— 但那**不等于没法知道**：那个 subagent
 * 自己那条消息上带着 `status`（`error` / `aborted`）与 `error`，而它的话本来就在镜像里那一栏
 * （`SessionMirror.subAgent(toolCallId)`，由带 `toolCallId` 的事件攒出来）。
 *
 * 于是「失败必须显示失败」（`PRD 3.9`）这一条靠客户端自己算回来：
 *
 *   · 名册说还在动 → 就是「在跑」（它是现读的观测值，比消息更近）；
 *   · 名册说散场 / 还挂着 → 看它栏里**最后一条消息**：`error` → 失败，`aborted` → 被叫停，
 *     其余 → 完成（散场）。
 *
 * ## 算不出来的那一半
 *
 * 它栏里一条消息都没有（更早派出去、本客户端打开时就已经散场：`subagent` 不入库，重开之后只有
 * 名册、没有话）→ 保持名册那一格（`ended`）。**不猜**：没有事实的地方不编一个「失败」出来。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { SubAgentFact } from "./session/types.js";

/**
 * subagent 此刻那一个圆点说的是什么。
 *
 * 前三格是名册本来就有的（`AgentNS.AgentState` + `ended`）；后两格是从它自己的消息上推出来的
 * 结局 —— `aborted`（被叫停）与 `error`（出错）不是一回事（PRD D14），所以它们不是同一个别名。
 */
export type SubAgentStatus = AgentNS.AgentState | "ended" | "error" | "aborted";

/**
 * 名册那一行 + 它自己的消息 → 那一格状态。
 *
 * `messages` 传它那一栏（`session.subAgentMessages(toolCallId)`）；空数组是正常的（见文件头）。
 */
export function subAgentStatusOf(
  fact: SubAgentFact,
  messages: readonly AgentNS.Message[],
): SubAgentStatus {
  // 名册说它还在动：那是现读的观测值，不必再去翻消息
  if (fact.state === "working") return "working";
  const last = messages[messages.length - 1];
  // 一条话都没有：只知道它散场了（名册那一格），不编结局
  if (!last) return fact.state;
  if (last.status === AgentNS.MessageStatus.Error || last.error != null) return "error";
  if (last.status === AgentNS.MessageStatus.Aborted) return "aborted";
  // 有话说完了、既没报错也没被叫停：名册那一格说了算（`ended` / `idle`）
  return fact.state;
}

/**
 * 「这一条有结局了」的三种说法（`idle` / `working` 不是结局，没有话说）。
 *
 * `ended` 与 `aborted` 分开：被叫停不是坏掉，失败也不是被叫停（PRD D14）。
 */
export type SubAgentEnding = "ended" | "error" | "aborted";

/** 一条要说的结局：说哪一种、为什么（原话）、以及「说过了没有」按什么认 */
export interface SubAgentEndingFact {
  ending: SubAgentEnding;
  /**
   * 失败时**宿主给的原话**（那一条消息上的 `error.message`）：照传，不另编一句。
   *
   * 宿主没给就没有这一格 —— 那时只说「失败」，不猜原因（编一句「可能是网络问题」正是
   * PRD 3.9 要拦的那种假话）。
   */
  reason?: string;
  /**
   * 记账用的键：那一条结局消息的 id（一条委派一条收尾消息，见 `markSubAgentEndingSpoken`）。
   *
   * 一条话都没有时（更早派出去、打开时就已经散场）退到工具调用 id：那一格也说得出「散场了」。
   */
  key: string;
}

/**
 * 名册那一行 + 它自己的消息 → 要不要说一句「它结束了」。
 *
 * 返回 `null` = 还在跑 / 还挂着 —— 那时没有结局可说。这条与 {@link subAgentStatusOf} 同一个
 * 判据：两处说的必须是同一件事，否则圆点是红的、通知却说「完成」。
 */
export function subAgentEndingOf(
  fact: SubAgentFact,
  messages: readonly AgentNS.Message[],
): SubAgentEndingFact | null {
  const status = subAgentStatusOf(fact, messages);
  if (status !== "ended" && status !== "error" && status !== "aborted") return null;
  const last = messages[messages.length - 1];
  const reason = last?.error?.message;
  return {
    ending: status,
    ...(reason === undefined || reason === "" ? {} : { reason }),
    key: last?.id ?? fact.toolCallId,
  };
}

/**
 * 「这个结局已经说过了」的记账 —— 头一次返回 `true`（调用方该说一句），之后一律 `false`。
 *
 * ## 为什么记账在模块里，而不是屏幕的内存里
 *
 * 名册与它栏里的话活在**会话层**（`server-client/mirror.ts` 的镜像，切屏、重开都不丢），而屏幕
 * 会被重建（`/model`、`/lang` 这些重挂载）。只按屏幕记「说过没」的话，重建之后同一条失败会被
 * 再说一遍 —— 用户看到的是「同一个子 AgentDefinition 又失败了一次」。
 *
 * 键取**那一条结局消息的 id**：同一条结局只说一次；下一次委派是另一条消息、另一个 id，照说。
 * 只活在本进程（与 `user-content.ts` 的 Asset 事实同一档：重启即清空，不落盘）。
 */
const spokenEndings = new Set<string>();

export function markSubAgentEndingSpoken(key: string): boolean {
  if (spokenEndings.has(key)) return false;
  spokenEndings.add(key);
  return true;
}

/**
 * 清空记账。
 *
 * 只有用例用：本仓所有用例共享一个进程与一张模块图（`vitest.config.ts` 的 `isolate: false`），
 * 上一条用例说过的结局会串到下一条。生产代码没有需要清空的时候 —— 重启就是清空。
 */
export function forgetSubAgentEndings(): void {
  spokenEndings.clear();
}
