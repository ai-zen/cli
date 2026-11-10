/**
 * Agent / Sub-agent 定义的**词汇表 + 数据整形** —— CLI 层。
 *
 * ## 这里没有读写，也没有目录
 *
 * 定义的真相在**服务端**：客户端经 `ConfigPort.readAgentStore()` 拿一份快照
 * （`AgentStore`：`agents` / `subAgents` + 两个写操作），写走 `agent.save` / `agent.remove`。
 *
 * 所以本文件只有三件纯函数：`kind` 词表分派、显示名、按 id 查定义。它们不需要 IO，
 * 也不需要「目录在哪」这个客户端根本答不对的问题 —— 两机部署时那个目录在服务端那台机器上。
 */

import type { AgentDefinition } from "@ai-zen/agents-sdk";

/**
 * 两个「词汇表」类型在 `@ai-zen/agents-client` 里：
 *
 *   - `AgentKind` 就是协议里的 `AgentKind`（`agent.*` 方法的 `kind` 参数）；
 *   - `AgentStore` 是 `ConfigPort.readAgentStore()` 的返回形状。
 *
 * 两个类型都不在本文件定义，只转出：定义只该有一份，否则「客户端从服务端拿回来的那份」
 * 与「本文件那份」会变成两个类型，只靠形状碰巧一致。转出之后，本文件只剩「词汇表 + 数据整形」。
 */
import type { AgentKind, AgentStore } from "@ai-zen/agents-client";
export type { AgentKind, AgentStore };

/**
 * kind 的显示名（`Agent` / `Sub-agent`）。
 *
 * 刻意**不本地化**：这两个词在配置中心的英文界面与中文界面里是同一个行业惯用写法，
 * 翻译成「代理 / 子代理」反而难认。真要本地化，应该走 `t()` 而不是在这里硬编码。
 */
export function agentKindLabel(kind: AgentKind): string {
  return kind === "agent" ? "Agent" : "Sub-agent";
}

/** 取某 kind 的定义列表 */
export function agentList(store: AgentStore, kind: AgentKind): AgentDefinition[] {
  return kind === "agent" ? store.agents : store.subAgents;
}

/** 按 id 查找某 kind 的定义 */
export function findAgentDefinition(
  store: AgentStore,
  kind: AgentKind,
  id: string | undefined,
): AgentDefinition | undefined {
  if (!id) return undefined;
  return agentList(store, kind).find((def) => def.id === id);
}
