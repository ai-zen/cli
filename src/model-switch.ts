/**
 * 模型切换 —— `/model` 的写配置策略（纯逻辑，可单测）
 *
 * ## 唯一真相源
 *
 * 模型只写在 **`AgentDefinition.modelId`** 上：
 *
 *   - 配置层没有 `defaultModel`（`AppConfig` 已无此字段）；
 *   - 会话存档不记模型（`Conversation` 已无 `modelId`）；
 *   - 运行期 `createAgent` 只读 `definition.modelId`，缺了直接报错。
 *
 * 于是「切换模型」只有一种写法和一种读法，不存在两层分歧导致的
 * 「状态栏显示 A、实际请求发 B」。
 *
 * ## 切换即重置思考强度
 *
 * `AgentDefinition.modelParams` 里的思考参数（`thinking` / `reasoning_effort` 等）是
 * **模型相关**的：DeepSeek 的 `off` 档是 `thinking: { type: "disabled" }`，而智谱 GLM-5.3
 * 根本不接受关闭思考。把旧模型的档位带到新模型上，轻则无意义，重则直接报错。
 *
 * 所以换模型时**直接清空 `modelParams`**（不保留、不迁移、不逐键剔除），让 Agent
 * 回到「不填思考强度」的状态，由目标模型自己的 `defaultParams` 决定。用户想调就
 * 再用 `/think` 选一次。
 *
 * ## 注意
 *
 * **Agent 定义的其它字段不可丢**：SDK 初始化时只同步出厂提示词，
 * 其余字段（权限、`custom` 等）以用户文件为准，因此写入是「读 → 改字段 → 写回」。
 */

import { AgentRepository } from "@ai-zen/agents-sdk";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { AGENTS_DIR } from "./config.js";
import { t } from "./i18n/index.js";

export interface SwitchModelDeps {
  /** 读 Agent 定义（默认：`~/.ai-zen/agents/<id>.json`） */
  readAgent?: (agentId: string) => Promise<AgentDefinition | null>;
  /** 写 Agent 定义 */
  writeAgent?: (definition: AgentDefinition) => Promise<void>;
  /** 当前时间（测试可固定） */
  now?: Date;
}

export interface SwitchModelOptions extends SwitchModelDeps {
  config: import("@ai-zen/agents-sdk").AppConfig;
  /** 当前会话的 Agent（缺省视为 default） */
  agentId?: string;
  /** 目标模型 id */
  modelId: string;
}

export interface SwitchModelResult {
  /** 面向用户的一句话结果 */
  summary: string;
  /** 变更后的 Agent 定义 */
  definition: AgentDefinition;
}

/**
 * 切换模型：把目标模型写进 Agent 定义的 `modelId`，并把思考强度重置为模型默认。
 *
 * 抛错场景：模型不存在、Agent 定义缺失。
 */
export async function switchModel(options: SwitchModelOptions): Promise<SwitchModelResult> {
  const { config, modelId } = options;
  const agentId = options.agentId || "default";
  const now = options.now ?? new Date();

  const model = (config.models ?? []).find((item) => item.id === modelId);
  if (!model) throw new Error(t("modelSwitch.err.modelMissing", { id: modelId }));

  const readAgent =
    options.readAgent ?? ((id: string) => new AgentRepository(AGENTS_DIR).read(id));
  const writeAgent =
    options.writeAgent ??
    ((definition: AgentDefinition) => new AgentRepository(AGENTS_DIR).write(definition));

  const definition = await readAgent(agentId);
  if (!definition) throw new Error(t("modelSwitch.err.agentMissing", { id: agentId }));

  const next: AgentDefinition = { ...definition, modelId, updatedAt: now.toISOString() };
  // 换模型 = 重置思考强度：旧模型的档位参数对新模型可能非法（如 GLM-5.3 不接受
  // `thinking.disabled`），所以直接清空，让目标模型走自己的 defaultParams。
  delete next.modelParams;
  await writeAgent(next);

  const resetHint = definition.modelParams ? t("modelSwitch.resetHint") : "";
  return {
    summary: t("modelSwitch.summary", { name: model.name, id: model.id, agent: agentId, hint: resetHint }),
    definition: next,
  };
}
