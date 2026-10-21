/**
 * 思考档位（reasoning level）—— CLI 侧读写
 *
 * ## 三层，边界很硬
 *
 *   - **协议差异在策略表**（`~/.ai-zen/reasoning-presets.json`）：档位名 → 请求参数补丁，
 *     由这张 CLI 自有的表声明，模型用 `reasoningPreset` 引用它。
 *   - **档位值存在 Agent 定义**（`AgentDefinition.modelParams`）：**存的是展开后的参数**，
 *     不是档位名。于是「配置即事实」——运行期 SDK 只做一次浅合并，不查表、不推导。
 *   - **本模块只管 UI 语义**：列可选档位、把参数反查成档位名、写回 Agent 定义。
 *
 * 代价（刻意接受）：改了策略表**不会追溯**已配置的 Agent —— 它们存的是当时的参数。
 * 这正是「配置即事实」的含义：表只是写配置那一刻的模板。
 */

import { AgentRepository } from "@ai-zen/agents-sdk";
import type { AgentDefinition, AppConfig, Model } from "@ai-zen/agents-sdk";
import { AGENTS_DIR } from "./config.js";
import {
  levelsOf,
  matchLevel,
  ownedKeys,
  patchOf,
  presetFor,
  type ReasoningPreset,
  type ReasoningPresets,
} from "./reasoning-presets.js";

/**
 * 已知档位的中文标签。
 *
 * 不设成穷举映射：档位名由策略表定义（用户可自建策略、自定档位名），
 * 未知名字直接显示原文，比显示「?」有用得多。
 */
export const EFFORT_LABELS: Record<string, string> = {
  off: "关",
  none: "关",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** 档位 → 显示文案（未知档位名原样显示） */
export function effortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level;
}

/** 模型关联的策略 */
export function presetOf(
  model: Model | null | undefined,
  presets: ReasoningPresets,
): ReasoningPreset | undefined {
  return presetFor(model?.id, model?.reasoningPreset, presets);
}

/** 模型可选档位（空数组 = 不可调档） */
export function effortChoices(
  model?: Model | null,
  presets?: ReasoningPresets | null,
): string[] {
  if (!presets) return [];
  return levelsOf(presetOf(model, presets));
}

/** 一档都用不了的模型 */
export function isAdjustable(model?: Model | null, presets?: ReasoningPresets | null): boolean {
  return effortChoices(model, presets).length > 0;
}

/**
 * 生效中的模型参数 = 模型默认参数 + Agent 级覆盖（与 SDK 的合并语义一致，浅合并）。
 *
 * 注意这里复刻的是**同一份事实**，不是另一套推导：状态栏显示的就是真正会发给 API 的
 * 那几个参数里匹配到的那一档。
 */
export function effectiveParams(
  model?: Model | null,
  definition?: Pick<AgentDefinition, "modelParams"> | null,
): Record<string, unknown> {
  return { ...(model?.defaultParams ?? {}), ...(definition?.modelParams ?? {}) };
}

/**
 * 状态栏文案。
 *
 * - 模型不可调档 → `—`
 * - 生效参数命中某档 → 「低」「中」「高」…（按 `EFFORT_LABELS`）
 * - 有 Agent 级覆盖但不匹配任何档位 → 「自定义」（用户手改过参数）
 * - 没有任何声明 → 「默认」（跟随模型 `defaultParams`，如 DeepSeek 出厂只开思考不指定档位）
 */
export function describeEffort(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  definition?: Pick<AgentDefinition, "modelParams"> | null,
): string {
  if (!presets || !isAdjustable(model, presets)) return "—";
  const params = effectiveParams(model, definition);
  const matched = matchLevel(presetOf(model, presets), params);
  if (matched) return effortLabel(matched);
  return definition?.modelParams && Object.keys(definition.modelParams).length > 0
    ? "自定义"
    : "默认";
}

export interface SetAgentEffortOptions {
  config: AppConfig;
  /** 思考策略表（`readReasoningPresets()` 的结果） */
  presets: ReasoningPresets;
  /** 目标 Agent（缺省 default） */
  agentId?: string;
  /** 目标档位；`null` 表示清除思考参数、恢复跟随模型默认 */
  effort: string | null;
  /** 注入用（测试） */
  readAgent?: (agentId: string) => Promise<AgentDefinition | null>;
  writeAgent?: (definition: AgentDefinition) => Promise<void>;
  now?: Date;
}

export interface SetAgentEffortResult {
  definition: AgentDefinition;
  /** 生效模型 */
  model: Model;
  summary: string;
}

/**
 * 设置某 Agent 的思考档位：查表拿补丁 → 写进 `definition.modelParams`。
 *
 * 写入前先剔除「整张表出现过的键」，所以 `max` → `off` 不会残留上一档的
 * `reasoning_effort`；`effort: null` 就是剔除后若为空则删掉整个 `modelParams`。
 *
 * 抛错场景：Agent 不存在、未绑定可用模型、模型未关联策略、策略里没有该档位。
 * 这些都属于「用户明确要求了一件做不到的事」，宁可报错也不要静默降级。
 */
export async function setAgentEffort(
  options: SetAgentEffortOptions,
): Promise<SetAgentEffortResult> {
  const { config, presets, effort } = options;
  const agentId = options.agentId || "default";
  const now = options.now ?? new Date();

  const readAgent =
    options.readAgent ?? ((id: string) => new AgentRepository(AGENTS_DIR).read(id));
  const writeAgent =
    options.writeAgent ??
    ((definition: AgentDefinition) => new AgentRepository(AGENTS_DIR).write(definition));

  const definition = await readAgent(agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId;
  if (!modelId) {
    throw new Error(`Agent "${agentId}" 未绑定模型，请先为它选择模型`);
  }
  const model = (config.models ?? []).find((item) => item.id === modelId);
  if (!model) throw new Error(`模型 "${modelId}" 不存在，请先用 /model 或 /config 检查`);

  const preset = presetOf(model, presets);
  const allowed = levelsOf(preset);
  if (allowed.length === 0) {
    throw new Error(
      `模型 "${model.id}" 未关联可用的思考策略（reasoningPreset），无法设置思考强度`,
    );
  }

  const patch = effort === null ? undefined : patchOf(preset, effort);
  if (effort !== null && !patch) {
    throw new Error(
      `策略 "${model.reasoningPreset}" 没有档位 "${effort}"（可选：${allowed.join(" / ")}）`,
    );
  }

  // 先剔除思考相关键，再合并新补丁（`null` 即只剔除）
  const owned = ownedKeys(presets);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition.modelParams ?? {})) {
    if (!owned.has(key)) params[key] = value;
  }
  if (patch) Object.assign(params, patch);

  const next: AgentDefinition = { ...definition, updatedAt: now.toISOString() };
  if (Object.keys(params).length > 0) next.modelParams = params;
  else delete next.modelParams;

  await writeAgent(next);

  const label = effort === null ? "跟随模型默认" : `「${effortLabel(effort)}」`;
  return {
    definition: next,
    model,
    summary: `思考强度已设为 ${label} · 写入 Agent「${agentId}」（模型 ${model.id}）`,
  };
}
