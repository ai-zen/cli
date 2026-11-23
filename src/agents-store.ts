/**
 * AgentDefinition 清单的三个投影 —— CLI 层唯一的「数据整形」。
 *
 * ## 这里没有读写，也没有目录
 *
 * AgentDefinition 的真相在**宿主**：一份清单就是 `api.config.agents.list.query()` 的返回
 * （`AgentDefinition[]`），增删改各走 `agentDefinition.create` / `update` / `remove` /
 * `reset`。所以本文件只做「从清单里挑」：主 AgentDefinition、子 Agent、按 id 找一条。没有仓储形状，
 * 也没有第二个 `AgentDefinition` 类型。
 *
 * ## 两个「宿主不再给」的格子，在这里各有一行推导
 *
 * 旧契约的 `AgentView` 有 `isSubAgent` / `isDefault` / `available` 三格；今天的
 * `AgentDefinition` 只有定义本身。前两格是**定义里的字段**能算出来的事实（有 `function` 就是
 * 子 Agent；`AppConfig.defaultAgent` 指着它就是默认），所以在这里现算：
 *
 *   · {@link isSubAgent} —— `function` 在不在；
 *   · {@link agentListOf} —— 顺手把「默认 AgentDefinition 是谁」也放进清单（它来自配置，不来自定义）。
 *
 * 第三格 `available` **没有**对应：能不能跑起来要解析模型、查端点密钥，那是宿主的判断，客户端
 * 算一遍就是第二份会漂的规则。所以这一格随契约一起退场，界面也不再印「不可用」。
 */

import type { AgentDefinition, AppConfig } from "./config.js";

/** AgentDefinition 清单：全部定义 + 默认 AgentDefinition 的 id（`AppConfig.defaultAgent`，没有就是 `null`） */
export interface AgentList {
  agents: AgentDefinition[];
  defaultAgentId: string | null;
}

/**
 * wire 上的定义 → 本仓认的 `AgentDefinition`。
 *
 * 与 `server-client/mirror.ts` 的 `toCoreMessages` 同一个理由：过了 JSON 通道之后只剩**字段**
 * （tRPC 从宿主推出来的那一份里，`AgentNS.Message` 的带方法的成员被摊成了纯对象），而这里读的
 * 全是字段（`modelId` / `messages` / `function` / `permissions`），一个方法都不调。转换写在这一处，
 * 屏与命令层就拿不到「两种定义」。
 */
export function toDefinition(value: unknown): AgentDefinition {
  return value as AgentDefinition;
}

/** 把 `agentDefinition.list` 的定义数组与 `config.defaultAgent` 折成清单 */
export function agentListOf(
  definitions: readonly unknown[],
  config: Pick<AppConfig, "defaultAgent">,
): AgentList {
  return {
    agents: definitions.map(toDefinition),
    defaultAgentId: config.defaultAgent ?? null,
  };
}

/** 是不是子 Agent：定义里有 `function` 就是（SDK 与宿主用的是同一个判据） */
export function isSubAgent(agent: AgentDefinition): boolean {
  return agent.function !== undefined;
}

/**
 * kind 的显示名（`Agent` / `Sub-agent`）。
 *
 * 刻意**不本地化**：这两个词在配置中心的英文界面与中文界面里是同一个行业惯用写法，
 * 翻译成「代理 / 子代理」反而难认。真要本地化，应该走 `t()` 而不是在这里硬编码。
 */
export function agentKindLabel(agent: AgentDefinition): string {
  return isSubAgent(agent) ? "Sub-agent" : "Agent";
}

/** 能开一段会话的主 AgentDefinition（子 Agent 不是入口，SDK 用 `function` 明说了这件事） */
export function topLevelAgents(list: AgentList): AgentDefinition[] {
  return list.agents.filter((agent) => !isSubAgent(agent));
}

/** 子 Agent（能被主 AgentDefinition 当函数调用的那些） */
export function subAgentList(list: AgentList): AgentDefinition[] {
  return list.agents.filter(isSubAgent);
}

/** 按 id 查一条（主 AgentDefinition 与子 Agent 一起找；`id` 为空时返回 undefined） */
export function findAgent(list: AgentList, id: string | undefined): AgentDefinition | undefined {
  if (!id) return undefined;
  return list.agents.find((agent) => agent.id === id);
}
