/**
 * 主 Agent 切换 —— `/agent` 的校验与写配置策略（纯逻辑，可单测）
 *
 * ## 「主 Agent」是哪一个
 *
 * 配置里只有一个主 Agent 概念：**`AppConfig.defaultAgent`**（缺省时 SDK 取
 * `~/.ai-zen/agents/` 下的第一个）。`/agent` 就是把用户选中的那个写回这里，
 * 与 `/config` →「默认 Agent」写的是同一个字段，不存在第二套状态。
 *
 * ## 切换前必须能跑起来
 *
 * Agent 定义里的 `modelId` 是运行期唯一真相源（`createAgent` 只认它）。所以切换
 * 前先做完整链路校验：Agent 存在 → 绑定了模型 → 模型还在配置里 → 端点在 → 端点有 Key。
 * 少任何一环都直接抛错并把原因说清楚，绝不「先切过去再看它崩不崩」——切完是要
 * 重挂载对话屏的，崩了用户连 `/model` 都敲不进去。
 *
 * ## 不动 Agent 定义本身
 *
 * 切 Agent 只改「用哪个」，不改「那个 Agent 长什么样」：不写 `modelParams`、
 * 不碰提示词、不碰权限。要改这些走 `/model`、`/think`、`/config`。
 */

import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { resolveCredential } from "./config-editor.js";
import { t } from "./i18n/index.js";

/** 选择器里的一行：一个可选的主 Agent */
export interface AgentChoice {
  id: string;
  /** 展示名（`name` 缺失时回落 id） */
  name: string;
  /** 绑定的模型名（未绑定 / 模型已删时为 undefined） */
  modelName?: string;
  /** 是否可切换（模型与端点凭据齐备） */
  selectable: boolean;
  /** 不可切换的原因（可切换时为 undefined） */
  reason?: string;
}

/**
 * 列出全部主 Agent 及其可用性，供 `/agent` 选择器渲染。
 *
 * 不可用的也列出来（而不是隐藏）：用户能看到「那个 Agent 为什么切不过去」，
 * 比列表里凭空少一个更容易排查。
 */
export function listAgentChoices(
  config: AppConfig,
  agents: readonly AgentDefinition[],
): AgentChoice[] {
  return agents.map((agent) => {
    const name = agent.name || agent.id;
    if (!agent.modelId) {
      return { id: agent.id, name, selectable: false, reason: t("agentSwitch.err.noModel") };
    }
    const credential = resolveCredential(config, agent.modelId);
    if (!credential) {
      return { id: agent.id, name, selectable: false, reason: t("agentSwitch.err.modelMissing", { id: agent.modelId }) };
    }
    if (!credential.configured) {
      return {
        id: agent.id,
        name,
        modelName: credential.modelName,
        selectable: false,
        reason: t("agentSwitch.err.missingKey", { endpoint: credential.endpointName }),
      };
    }
    return { id: agent.id, name, modelName: credential.modelName, selectable: true };
  });
}

export interface SwitchAgentOptions {
  config: AppConfig;
  /** 可选的主 Agent 列表（`~/.ai-zen/agents/*.json` 快照） */
  agents: readonly AgentDefinition[];
  /** 目标 Agent id */
  targetAgentId: string;
}

export interface SwitchAgentResult {
  /** 已写入 `defaultAgent` 的新配置（调用方负责落盘） */
  config: AppConfig;
  /** 面向用户的一句话结果 */
  summary: string;
}

/**
 * 校验目标 Agent 能否切换，并返回「写好 `defaultAgent` 的新配置」。
 *
 * 抛错场景：Agent 不存在、未绑定模型、模型不在配置里、端点不存在、端点缺 Key。
 */
export function switchAgent(options: SwitchAgentOptions): SwitchAgentResult {
  const { config, agents, targetAgentId } = options;

  const agent = agents.find((item) => item.id === targetAgentId);
  if (!agent) throw new Error(t("agentSwitch.err.agentMissing", { id: targetAgentId }));

  const name = agent.name || agent.id;
  if (!agent.modelId) {
    throw new Error(t("agentSwitch.err.agentNoModel", { name }));
  }

  const credential = resolveCredential(config, agent.modelId);
  if (!credential) {
    throw new Error(t("agentSwitch.err.modelGone", { name, id: agent.modelId }));
  }
  if (!credential.configured) {
    throw new Error(t("agentSwitch.err.noKey", { endpoint: credential.endpointName }));
  }

  return {
    config: { ...config, defaultAgent: agent.id },
    summary: t("agentSwitch.summary", {
      name,
      id: agent.id,
      model: credential.modelName,
      modelId: credential.modelId,
    }),
  };
}
