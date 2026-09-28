/**
 * 子 Agent 护栏安装器（CLI 层）— SubAgentGuardInstallerPlugin
 *
 * 背景：SDK 的子 Agent 由 `AgentTool` / `AgentToolLazy` 在委派时 `new Agent({...})` 构建，
 * 新建实例不携带任何插件（`Agent._plugins` 每实例私有，不向子 Agent 传播），且子 Agent 走
 * `run()` 而非 `send()`（`onBeforeSend` / `onAfterSend` 不会触发）。因此主 Agent 上的
 * `ContextGuardPlugin` 对子 Agent 完全无效：子 Agent 的内循环没有上下文 token 护栏。
 *
 * 介入点：core 4.2.0 的 `onSubAgentStart` 钩子在「子 Agent 已构建、尚未 run()」时由宿主 Agent
 * 分发，载荷携带子 Agent 实例。`use()` 只是把插件推入 `_plugins`，而钩子分发每次都实时遍历
 * 该列表，故在钩子内安插对**本次 run 立即生效**（无需 init；AgentTool 也不会调用子 Agent 的
 * init）。
 *
 * 约束口径（与主 Agent 一致，仅此一项）：把主 Agent 同款的 `ContextGuardPlugin` 装到子 Agent 上
 * —— 同一 `maxTokens`（当前模型 `maxContextTokens`）、同样不传 ratio（沿用 SDK 默认 1.5），
 * 使「上下文 token 超过 maxTokens × 1.5 即中断」对子 Agent 同样成立。
 * **不设**轮次上限，**不设**工具调用次数上限。
 *
 * 中断语义：抛错即结束子 Agent 的 run；异常经 `AgentTool` 的 finally（分发 onSubAgentEnd）
 * 上抛至父 Agent，因父 Agent 默认 `allowJsonParseError = true` 而降级为一条工具结果文本
 * （`执行工具 X 时出错: …`），父 Agent 继续下一轮——即「软中断」：停掉越界的子 Agent，但不
 * 终止用户对话（如需硬停，父 Agent 须设 allowJsonParseError=false）。
 *
 * 覆盖范围：仅覆盖 core 的 `AgentTool` / `AgentToolLazy` 两条委派路径（均分发 onSubAgentStart）。
 * SDK 的 `call_skill_sub_agent`（技能子 Agent）不分发该钩子，暂不覆盖。
 */

import { ContextGuardPlugin } from "@ai-zen/agents-sdk";
import type { AgentPlugin } from "@ai-zen/agents-sdk";
import type { SubAgentContext } from "@ai-zen/agents-core";

export interface SubAgentGuardOptions {
  /** 子 Agent 的上下文 token 阈值；与主 Agent 同源（当前模型的 `maxContextTokens`） */
  maxTokens: number;
}

/**
 * 子 Agent 护栏安装器（装在**宿主 Agent** 上）。
 *
 * 每次委派边界把 `ContextGuardPlugin` 装到子 Agent 身上（阈值与主 Agent 相同），并递归安插
 * 自身，使子 Agent 再委派（孙级）时同样受约束。始终返回 undefined，永不拒绝委派——是否中断
 * 由 `ContextGuardPlugin` 按阈值决定。
 */
export class SubAgentGuardInstallerPlugin implements AgentPlugin {
  private readonly maxTokens: number;

  constructor(options: SubAgentGuardOptions) {
    this.maxTokens = options.maxTokens;
  }

  onSubAgentStart({ subAgent }: SubAgentContext): void {
    // 与主 Agent 完全同款：同一 maxTokens，不传 ratio（沿用 ContextGuardPlugin 默认 1.5）
    subAgent.use(new ContextGuardPlugin({ maxTokens: this.maxTokens }));

    // 传染到孙级：子 Agent 若再委派，其子 Agent 同样被安插
    subAgent.use(
      new SubAgentGuardInstallerPlugin({ maxTokens: this.maxTokens }),
    );
  }
}
