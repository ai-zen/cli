/**
 * 模型切换 —— `/model` 的写配置策略（纯逻辑，可单测）
 *
 * 会话用哪个模型，取决于**两处配置的优先级**（见 `tui/index.tsx` 的 `resolveTarget()`）：
 *   1. Agent 定义里的 `modelId`（显式绑定）
 *   2. `config.json` 的 `defaultModel`（未绑定时兜底）
 *
 * 所以切换时必须写到「真正生效的那一处」，否则会出现「提示已切换、实际没变」：
 *   - Agent 显式绑定过模型 → 改 `agents/<id>.json` 的 `modelId`
 *   - Agent 没绑（用默认模型）→ 改 `config.json` 的 `defaultModel`
 *
 * 注意 **Agent 定义的其它字段不可丢**：SDK 初始化时只同步出厂提示词，
 * 其余字段（权限、`custom` 等）以用户文件为准，因此写入是「读 → 改一个字段 → 写回」。
 */

import { AgentRepository } from "@ai-zen/agents-sdk";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { AGENTS_DIR, saveConfig } from "./config.js";

/** 写入目标：Agent 定义（显式绑定）/ 全局默认模型 */
export type ModelWriteTarget = "agent" | "default";

/**
 * 由 Agent 定义判定写入目标。
 *
 * 判据是 `modelId` 是否**已存在**，而不是它等不等于某个值：
 * 只有显式绑过模型的 Agent 才该被改定义；没绑的 Agent 走默认模型，
 * 此时改定义等于凭空给它加一条绑定，会掩盖「默认模型」这一层语义。
 */
export function resolveModelWriteTarget(
  definition?: Pick<AgentDefinition, "modelId"> | null,
): ModelWriteTarget {
  return definition?.modelId ? "agent" : "default";
}

export interface SwitchModelDeps {
  /** 读 Agent 定义（默认：`~/.ai-zen/agents/<id>.json`） */
  readAgent?: (agentId: string) => Promise<AgentDefinition | null>;
  /** 写 Agent 定义 */
  writeAgent?: (definition: AgentDefinition) => Promise<void>;
  /** 写全局配置 */
  saveConfig?: (config: AppConfig) => Promise<void>;
  /** 当前时间（测试可固定） */
  now?: Date;
}

export interface SwitchModelOptions extends SwitchModelDeps {
  config: AppConfig;
  /** 当前会话的 Agent（缺省视为 default） */
  agentId?: string;
  /** 目标模型 id */
  modelId: string;
}

export interface SwitchModelResult {
  /** 实际写入的位置 */
  target: ModelWriteTarget;
  /** 面向用户的一句话结果 */
  summary: string;
  /** 变更后的配置（`target === "default"` 时为新对象，否则原样返回） */
  config: AppConfig;
  /** 变更后的 Agent 定义（`target === "agent"` 时有值） */
  definition?: AgentDefinition;
}

/**
 * 切换模型并写入配置。
 *
 * 抛错场景：模型不存在、Agent 定义缺失（显式绑定的 Agent 却读不到文件）。
 */
export async function switchModel(options: SwitchModelOptions): Promise<SwitchModelResult> {
  const { config, modelId } = options;
  const agentId = options.agentId || "default";
  const now = options.now ?? new Date();

  const model = (config.models ?? []).find((item) => item.id === modelId);
  if (!model) throw new Error(`模型 "${modelId}" 不存在`);

  const readAgent =
    options.readAgent ?? ((id: string) => new AgentRepository(AGENTS_DIR).read(id));
  const writeAgent =
    options.writeAgent ?? ((definition: AgentDefinition) => new AgentRepository(AGENTS_DIR).write(definition));
  const save = options.saveConfig ?? saveConfig;

  const definition = await readAgent(agentId);
  const target = resolveModelWriteTarget(definition);

  if (target === "agent" && definition) {
    const next: AgentDefinition = { ...definition, modelId, updatedAt: now.toISOString() };
    await writeAgent(next);
    return {
      target,
      summary: `已切换模型：${model.name}（${model.id}）· 已写入 Agent「${agentId}」的绑定模型`,
      config,
      definition: next,
    };
  }

  const nextConfig: AppConfig = { ...config, defaultModel: modelId };
  await save(nextConfig);
  return {
    target,
    summary: `已切换模型：${model.name}（${model.id}）· 已写入默认模型配置`,
    config: nextConfig,
  };
}
