/**
 * 思考强度（reasoning effort）—— CLI 侧读写
 *
 * 分两层，边界很硬：
 *   - **能力上限在模型**（`Model.reasoning`，SDK 按厂商官方文档声明）：决定菜单里能出现哪几档。
 *     发一个端点不认的值会被直接 400（智谱 GLM-5.3 系原文「其余输入将报错」）。
 *   - **档位值存在 Agent**（`AgentDefinition.reasoningEffort`）：同一个模型可以给编程 / 小说 /
 *     闲聊三个 Agent 配不同强度，而模型自身的 `defaultParams` 不动。
 *
 * 本模块只做「读能力 → 校验 → 写 Agent 定义」，参数如何落到 `thinking` / `reasoning_effort`
 * 由 SDK 的 `resolveModelParams()` 在 `createModel` 阶段决定。
 */

import { AgentRepository } from "@ai-zen/agents-sdk";
import type { AgentDefinition, AppConfig, Model } from "@ai-zen/agents-sdk";
import { modelAllowedEfforts, resolveReasoningEffort } from "@ai-zen/agents-sdk";

/**
 * 档位类型由 `AgentDefinition` 派生。
 *
 * SDK 的 alpha.13 只导出了 `shared/reasoning.ts` 的函数，`ReasoningEffort` /
 * `TokenThresholds` 这两个别名还没进包入口；用类型查询拿到同一个类型，语义完全等价，
 * 等 SDK 下个版本补上导出后可无痛切换成直接 import。
 */
export type ReasoningEffort = NonNullable<AgentDefinition["reasoningEffort"]>;
/** 上下文阈值结构（派生自 `Model`） */
export type TokenThresholds = Model["tokenThresholds"];
import { AGENTS_DIR } from "./config.js";

/** 档位 → 中文标签（状态栏与提示共用） */
export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "关",
  none: "关",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** 一档都用不了的模型（未声明能力，或声明为空数组）*/
export function isAdjustable(model?: Model | null): boolean {
  return modelAllowedEfforts(model).length > 0;
}

/** 可选档位（含 `off`，顺序即展示顺序） */
export function effortChoices(model?: Model | null): ReasoningEffort[] {
  return modelAllowedEfforts(model);
}

/**
 * 状态栏文案。
 *
 * - 模型不可调档 → `—`
 * - Agent 显式声明了档位 → 「低」「中」「高」…（`off` 显示「关」）
 * - 可调但没声明 → 「默认」（跟随模型 `defaultParams`，如 DeepSeek 出厂就是「开思考但未指定档位」）
 */
export function describeEffort(
  model?: Model | null,
  definition?: Pick<AgentDefinition, "reasoningEffort"> | null,
): string {
  if (!isAdjustable(model)) return "—";
  const effective = resolveReasoningEffort(model, definition);
  return effective ? EFFORT_LABELS[effective] : "默认";
}

export interface SetAgentEffortOptions {
  config: AppConfig;
  /** 目标 Agent（缺省 default） */
  agentId?: string;
  /** 目标档位；`null` 表示清除声明、恢复跟随模型默认 */
  effort: ReasoningEffort | null;
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
 * 设置某 Agent 的思考档位并写入其定义文件。
 *
 * 抛错场景：Agent 不存在、Agent 未绑定可用模型、模型不可调档、档位不在模型能力范围内。
 * 这些都属于「用户明确要求了一件做不到的事」，宁可报错也不要静默降级。
 */
export async function setAgentEffort(
  options: SetAgentEffortOptions,
): Promise<SetAgentEffortResult> {
  const { config, effort } = options;
  const agentId = options.agentId || "default";
  const now = options.now ?? new Date();

  const readAgent =
    options.readAgent ?? ((id: string) => new AgentRepository(AGENTS_DIR).read(id));
  const writeAgent =
    options.writeAgent ??
    ((definition: AgentDefinition) => new AgentRepository(AGENTS_DIR).write(definition));

  const definition = await readAgent(agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId ?? config.defaultModel;
  const model = (config.models ?? []).find((item) => item.id === modelId);
  if (!model) throw new Error(`模型 "${modelId}" 不存在，请先用 /model 或 /config 检查`);

  const allowed = effortChoices(model);
  if (allowed.length === 0) {
    throw new Error(`模型 "${model.id}" 未声明可调档位，无法设置思考强度`);
  }
  if (effort !== null && !allowed.includes(effort)) {
    throw new Error(
      `模型 "${model.id}" 不支持档位 "${effort}"（可选：${allowed.join(" / ")}）`,
    );
  }

  const next: AgentDefinition = { ...definition, updatedAt: now.toISOString() };
  if (effort === null) delete next.reasoningEffort;
  else next.reasoningEffort = effort;

  await writeAgent(next);

  const label = effort === null ? "跟随模型默认" : `「${EFFORT_LABELS[effort]}」`;
  return {
    definition: next,
    model,
    summary: `思考强度已设为 ${label} · 写入 Agent「${agentId}」（模型 ${model.id}）`,
  };
}
