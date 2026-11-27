/**
 * AgentDefinition 清单的三个投影，也是 CLI 层唯一的「数据整形」。
 *
 * 这里不读写也不碰目录：AgentDefinition 的真相在宿主，一份清单就是
 * `api.config.agents.list.query()` 的返回（`AgentDefinition[]`），增删改各走 `agentDefinition.create` /
 * `update` / `remove` / `reset`。本文件只做「从清单里挑」：主 AgentDefinition、子 Agent、按 id 找一条。
 *
 * 旧的 `AgentView` 有 `isSubAgent` / `isDefault` / `available` 三格，今天的 `AgentDefinition` 只有定义
 * 本身。前两格能由定义与配置算出（有 `function` 就是子 Agent，`AppConfig.defaultAgent` 指着它就是
 * 默认），所以在这里现算。第三格没有对应：能不能跑起来要解析模型、查端点密钥，那是宿主的判断，
 * 客户端算一遍就是第二份会漂的规则；它随契约一起退场，界面也不再印「不可用」。
 */

import type { AgentDefinition, AppConfig } from "./config.js";

/** 全部定义 + 默认 AgentDefinition 的 id（`AppConfig.defaultAgent`，没有就是 `null`） */
export interface AgentList {
  agents: AgentDefinition[];
  defaultAgentId: string | null;
}

/**
 * wire 上的定义 → 本仓认的 `AgentDefinition`。
 *
 * 与 `server-client/mirror.ts` 的 `toCoreMessages` 同一个理由：过了 JSON 通道之后只剩字段，而这里读
 * 的全是字段（`modelId` / `messages` / `function` / `permissions`），一个方法都不调。转换写在这一处，
 * 屏与命令层就拿不到两种定义。
 */
export function toDefinition(value: unknown): AgentDefinition {
  return value as AgentDefinition;
}

export function agentListOf(
  definitions: readonly unknown[],
  config: Pick<AppConfig, "defaultAgent">,
): AgentList {
  return {
    agents: definitions.map(toDefinition),
    defaultAgentId: config.defaultAgent ?? null,
  };
}

export function isSubAgent(agent: AgentDefinition): boolean {
  return agent.function !== undefined;
}

/**
 * kind 的显示名（`Agent` / `Sub-agent`）。
 *
 * 刻意不本地化：这两个词在配置中心的英文界面与中文界面里是同一个行业惯用写法，翻译成「代理 /
 * 子代理」反而难认。真要本地化，应该走 `t()` 而不是在这里硬编码。
 */
export function agentKindLabel(agent: AgentDefinition): string {
  return isSubAgent(agent) ? "Sub-agent" : "Agent";
}

/** 子 Agent 不是入口：SDK 用 `function` 明说了这件事 */
export function topLevelAgents(list: AgentList): AgentDefinition[] {
  return list.agents.filter((agent) => !isSubAgent(agent));
}

export function subAgentList(list: AgentList): AgentDefinition[] {
  return list.agents.filter(isSubAgent);
}

export function findAgent(list: AgentList, id: string | undefined): AgentDefinition | undefined {
  if (!id) return undefined;
  return list.agents.find((agent) => agent.id === id);
}
