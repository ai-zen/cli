/**
 * 思考档位（reasoning level）—— CLI 侧读写
 *
 * 分三层，边界很硬：
 *   - **协议差异在策略表**（`.ai-zen/reasoning-presets.json`）：档位名与请求参数的对应关系，
 *     由表声明，`Model.reasoningPreset` 引用。SDK 不猜、CLI 更不该猜。
 *   - **档位值存在 Agent**（`AgentDefinition.reasoningEffort`）：同一个模型可以给编程 / 小说 /
 *     闲聊三个 Agent 配不同强度，而模型自身的 `defaultParams` 不动。
 *   - **本模块只管 UI 语义**：列出可选档位、把档位名翻成中文、写回 Agent 定义。
 *
 * 参数怎么落到 `thinking` / `reasoning_effort` 由 SDK 的 `resolveModelParams()` 在
 * `createModel` 阶段决定 —— CLI 一个厂商键名都不该知道。
 */

import { AgentRepository } from "@ai-zen/agents-sdk";
import type {
  AgentDefinition,
  AppConfig,
  Model,
  ReasoningPresets,
} from "@ai-zen/agents-sdk";
import { modelLevels, resolveReasoningEffort } from "@ai-zen/agents-sdk";
import { AGENTS_DIR } from "./config.js";

/**
 * 已知档位的中文标签。
 *
 * 不设成穷举映射：档位名由策略表定义（用户可以自建策略、甚至自定档位名），
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

/** 一档都用不了的模型（未关联策略，或策略里一个档位都没有） */
export function isAdjustable(model?: Model | null, presets?: ReasoningPresets | null): boolean {
  return modelLevels(model, presets).length > 0;
}

/** 可选档位（顺序 = 策略表声明顺序，含 `off` —— 它只是表里的一行） */
export function effortChoices(model?: Model | null, presets?: ReasoningPresets | null): string[] {
  return modelLevels(model, presets);
}

/**
 * 状态栏文案。
 *
 * - 模型不可调档 → `—`
 * - Agent 显式声明了档位 → 「低」「中」「高」…（按 `EFFORT_LABELS`）
 * - 可调但没声明 → 「默认」（跟随模型 `defaultParams`，如 DeepSeek 出厂就是「开思考但未指定档位」）
 */
export function describeEffort(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  definition?: Pick<AgentDefinition, "reasoningEffort"> | null,
): string {
  if (!isAdjustable(model, presets)) return "—";
  const effective = resolveReasoningEffort(model, presets, definition);
  return effective ? effortLabel(effective) : "默认";
}

export interface SetAgentEffortOptions {
  config: AppConfig;
  /** 思考策略表（`readReasoningPresets()` 的结果） */
  presets: ReasoningPresets;
  /** 目标 Agent（缺省 default） */
  agentId?: string;
  /** 目标档位；`null` 表示清除声明、恢复跟随模型默认 */
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
 * 设置某 Agent 的思考档位并写入其定义文件。
 *
 * 抛错场景：Agent 不存在、Agent 未绑定可用模型、模型未关联策略、档位不在策略表里。
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

  const modelId = definition.modelId ?? config.defaultModel;
  const model = (config.models ?? []).find((item) => item.id === modelId);
  if (!model) throw new Error(`模型 "${modelId}" 不存在，请先用 /model 或 /config 检查`);

  const allowed = effortChoices(model, presets);
  if (allowed.length === 0) {
    throw new Error(
      `模型 "${model.id}" 未关联可用的思考策略（reasoningPreset），无法设置思考强度`,
    );
  }
  if (effort !== null && !allowed.includes(effort)) {
    throw new Error(
      `策略 "${model.reasoningPreset}" 没有档位 "${effort}"（可选：${allowed.join(" / ")}）`,
    );
  }

  const next: AgentDefinition = { ...definition, updatedAt: now.toISOString() };
  if (effort === null) delete next.reasoningEffort;
  else next.reasoningEffort = effort;

  await writeAgent(next);

  const label = effort === null ? "跟随模型默认" : `「${effortLabel(effort)}」`;
  return {
    definition: next,
    model,
    summary: `思考强度已设为 ${label} · 写入 Agent「${agentId}」（模型 ${model.id}）`,
  };
}
