/**
 * Agent / Sub-agent 定义仓储 —— CLI 层
 *
 * 管理两处定义目录（均为「每实体一个 JSON，文件名 = `<id>.json`」）：
 *   - 顶层 Agent：`~/.ai-zen/agents/*.json`（`/config`「默认 Agent」可选的那些）
 *   - 子 Agent：  `~/.ai-zen/sub-agents/*.json`（可被委派，额外带 `function` 定义）
 *
 * 单文件读写委托 SDK 的 `AgentRepository`（`EntityRepository`），本模块只做「按 kind 分派」
 * 与「快照 + 写操作」的组装，便于 TUI 与单测共用。
 */

import { AgentRepository } from "@ai-zen/agents-sdk";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { AGENTS_DIR, SUB_AGENTS_DIR } from "./config.js";

/** Agent 定义的类型：顶层 Agent / 子 Agent */
export type AgentKind = "agent" | "subagent";

/** 某个 kind 对应的定义目录 */
export function agentDir(kind: AgentKind): string {
  return kind === "agent" ? AGENTS_DIR : SUB_AGENTS_DIR;
}

/** kind 的中文名 */
export function agentKindLabel(kind: AgentKind): string {
  return kind === "agent" ? "Agent" : "Sub-agent";
}

/** 「Agent 定义」管理用的仓储：快照 + 写 / 删操作 */
export interface AgentStore {
  agents: AgentDefinition[];
  subAgents: AgentDefinition[];
  save: (kind: AgentKind, def: AgentDefinition) => Promise<void>;
  remove: (kind: AgentKind, id: string) => Promise<void>;
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

/** 用给定快照 + 真实文件读写构造仓储 */
export function createAgentStore(agents: AgentDefinition[], subAgents: AgentDefinition[]): AgentStore {
  return {
    agents,
    subAgents,
    save: async (kind, def) => {
      await new AgentRepository(agentDir(kind)).write(def);
    },
    remove: async (kind, id) => {
      await new AgentRepository(agentDir(kind)).delete(id);
    },
  };
}

/** 从磁盘读取 Agent / Sub-agent 快照，并附带真实读写能力 */
export async function readAgentStore(): Promise<AgentStore> {
  const agents = await new AgentRepository(AGENTS_DIR).list();
  const subAgents = await new AgentRepository(SUB_AGENTS_DIR).list();
  return createAgentStore(agents, subAgents);
}
