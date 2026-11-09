/**
 * Agent / Sub-agent 定义仓储 —— CLI 层
 *
 * 管理两处定义目录（均为「每实体一个 JSON，文件名 = `<id>.json`」）：
 *   - 顶层 Agent：`~/.ai-zen/agents/*.json`（`/config`「默认 Agent」可选的那些）
 *   - 子 Agent：  `~/.ai-zen/sub-agents/*.json`（可被委派，额外带 `function` 定义）
 *
 * ## 这里只剩「词汇表 + 数据整形」
 *
 * 读写**不在**客户端：Agent 定义的真相在服务端，客户端经 `ConfigPort.readAgentStore()`
 * 拿快照 + 两个写操作（`server-client/config-port.ts`）。本模块保留的是三样东西：
 * 两处目录常量（仅本进程布局用）、`kind` 词表与分派、以及给假件/测试用的
 * `createAgentStore()`。
 *
 * 曾经这里还有 `readAgentStore()`（直接读 `~/.ai-zen/agents`，附带一次性的
 * `reasoningEffort` → `modelParams` 迁移）。它随「配置面搬到服务端」失去调用方，
 * 而那份迁移现在归**持有定义的那一侧**（服务端 `SessionAgentFactory` / SDK）。
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

/**
 * kind 的显示名（`Agent` / `Sub-agent`）。
 *
 * 刻意**不本地化**：这两个词在配置中心的英文界面与中文界面里是同一个行业惯用写法，
 * 翻译成「代理 / 子代理」反而难认。真要本地化，应该走 `t()` 而不是在这里硬编码。
 */
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

/**
 * 用给定快照 + 真实文件读写构造仓储 —— **只给假件与测试用**。
 *
 * 生产路径不经过它：服务端的 `ConfigService` 读定义，写走 `agent.save` / `agent.remove`。
 * 这里保留是因为编辑屏要的是「快照 + 两个写操作」这个形状，测试拿它当假件最省事。
 */
export function createAgentStore(
  agents: AgentDefinition[],
  subAgents: AgentDefinition[],
): AgentStore {
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
