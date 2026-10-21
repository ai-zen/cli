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
import type { AgentDefinition, AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { AGENTS_DIR, SUB_AGENTS_DIR, readConfig, readReasoningPresets } from "./config.js";
import { patchOf, presetFor } from "./reasoning-presets.js";

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
  const repoAgents = new AgentRepository(AGENTS_DIR);
  const repoSubAgents = new AgentRepository(SUB_AGENTS_DIR);
  const [rawAgents, rawSubAgents] = await Promise.all([repoAgents.list(), repoSubAgents.list()]);

  // 旧版 `/think` 把档位名写在 `reasoningEffort` 上；现在档位在写入时就展开成参数。
  // 这里做一次性迁移：能查到策略就展开进 `modelParams`，查不到就只删旧字段。
  const isLegacy = (def: AgentDefinition) =>
    "reasoningEffort" in (def as unknown as Record<string, unknown>);
  const legacy = (defs: AgentDefinition[]) => defs.filter(isLegacy);
  const needsMigration = legacy(rawAgents).length + legacy(rawSubAgents).length > 0;

  if (!needsMigration) return createAgentStore(rawAgents, rawSubAgents);

  const [config, presets] = await Promise.all([readConfig(), readReasoningPresets()]);
  const migrate = async (
    repo: AgentRepository,
    defs: AgentDefinition[],
  ): Promise<AgentDefinition[]> => {
    const out: AgentDefinition[] = [];
    for (const def of defs) {
      if (!isLegacy(def)) {
        out.push(def);
        continue;
      }
      out.push(await migrateDefinition(repo, def, config, presets));
    }
    return out;
  };

  const agents = await migrate(repoAgents, rawAgents);
  const subAgents = await migrate(repoSubAgents, rawSubAgents);
  return createAgentStore(agents, subAgents);
}

/** 把旧 `reasoningEffort` 展开成 `modelParams` 并写回（只跑一次：写完旧字段就没了） */
async function migrateDefinition(
  repo: AgentRepository,
  def: AgentDefinition,
  config: AppConfig,
  presets: ReasoningPresets,
): Promise<AgentDefinition> {
  const { reasoningEffort, ...rest } = def as AgentDefinition & { reasoningEffort?: string };
  // 模型只认 Agent 定义自身的 modelId（配置层已无 defaultModel）
  const modelId = rest.modelId;
  const model = (config.models ?? []).find((item) => item.id === modelId);
  const preset = model ? presetFor(model.id, model.reasoningPreset, presets) : undefined;
  const patch = reasoningEffort ? patchOf(preset, reasoningEffort) : undefined;
  const next: AgentDefinition = patch
    ? { ...rest, modelParams: { ...(rest.modelParams ?? {}), ...patch } }
    : rest;
  await repo.write(next);
  return next;
}
