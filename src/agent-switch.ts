/**
 * 主 Agent 切换 —— `/agent` 的校验与文案（纯逻辑，可单测）
 *
 * ## 「主 Agent」是哪一个
 *
 * 配置里只有一个主 Agent 概念：**`AppConfig.defaultAgent`**（缺省时 SDK 取
 * `~/.ai-zen/agents/` 下的第一个）。`/agent` 就是把用户选中的那个写回这里，
 * 与 `/config` →「默认 Agent」写的是同一个字段，不存在第二套状态。
 *
 * ## 切换前必须能跑起来
 *
 * 模型按**三级解析**（`会话级覆盖 > AgentDefinition.modelId > config.defaultModel`），
 * 而「切换 Agent」这一刻还没有会话级覆盖，所以预检只看后两级 —— 直接复用 SDK 的
 * `resolveModel`，不在这里再写一遍 `??` 链（那样两处迟早会漂：界面说「不可用」、
 * 服务端其实能跑，或者反过来）。链路校验：Agent 存在 → 解析得出模型 → 模型还在配置里
 * → 端点在 → 端点有 Key。
 * 少任何一环都直接抛错并把原因说清楚，绝不「先切过去再看它崩不崩」——
 * 切错 Agent 的代价是下一轮由一个未配置好的 Agent 来跑，而用户手上已经没有可用的 `/model`。
 *
 * ## 不动 Agent 定义本身
 *
 * 切 Agent 只改「用哪个」，不改「那个 Agent 长什么样」：不写 `modelParams`、
 * 不碰提示词、不碰权限。要改这些走 `/model`、`/think`、`/config`。
 *
 * ## 也不写配置
 *
 * 本模块只回答「能不能切」与「切了该说哪句话」；写 `defaultAgent` 走配置面的窄方法
 * `ConfigPort.setDefaultAgent()`（整份写回会把并发修改抹掉）。
 */

import { resolveModel, type AgentDefinition, type AppConfig } from "@ai-zen/agents-sdk";
import { resolveCredential } from "./config-editor.js";
import { t } from "./i18n/index.js";

/**
 * 这个 Agent 会实际用哪个模型（三级解析的**前两级**）。
 *
 * 不含会话级覆盖：预检发生在「要不要切过去」的时候，那一段会话还不存在。解析本身走 SDK
 * 的 `resolveModel`（唯一实现），这里只是把「Agent 定义 + 全局兜底」两个输入喂进去。
 */
function modelIdOfAgent(config: AppConfig, agent: AgentDefinition): string | undefined {
  return resolveModel({ agentModelId: agent.modelId, defaultModel: config.defaultModel })?.modelId;
}

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
    const modelId = modelIdOfAgent(config, agent);
    if (!modelId) {
      return { id: agent.id, name, selectable: false, reason: t("agentSwitch.err.noModel") };
    }
    const credential = resolveCredential(config, modelId);
    if (!credential) {
      return {
        id: agent.id,
        name,
        selectable: false,
        reason: t("agentSwitch.err.modelMissing", { id: modelId }),
      };
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

export interface CheckAgentSwitchOptions {
  config: AppConfig;
  /** 可选的主 Agent 列表（`~/.ai-zen/agents/*.json` 快照） */
  agents: readonly AgentDefinition[];
  /** 目标 Agent id */
  targetAgentId: string;
}

export interface CheckAgentSwitchResult {
  /** 面向用户的一句话结果 */
  summary: string;
}

/**
 * 校验目标 Agent 能否切换，并返回「跟用户说一句」的内容。
 *
 * **不改配置**：写 `defaultAgent` 是配置面上的一条窄方法（`ConfigPort.setDefaultAgent()`）。
 *
 * 抛错场景：Agent 不存在、未绑定模型、模型不在配置里、端点不存在、端点缺 Key。
 */
export function checkAgentSwitch(options: CheckAgentSwitchOptions): CheckAgentSwitchResult {
  const { config, agents, targetAgentId } = options;

  const agent = agents.find((item) => item.id === targetAgentId);
  if (!agent) throw new Error(t("agentSwitch.err.agentMissing", { id: targetAgentId }));

  const name = agent.name || agent.id;
  // 定义没绑模型但配了全局兜底时，切过去照样能跑（三级解析的最后一级）
  const modelId = modelIdOfAgent(config, agent);
  if (!modelId) {
    throw new Error(t("agentSwitch.err.agentNoModel", { name }));
  }

  const credential = resolveCredential(config, modelId);
  if (!credential) {
    throw new Error(t("agentSwitch.err.modelGone", { name, id: modelId }));
  }
  if (!credential.configured) {
    throw new Error(t("agentSwitch.err.noKey", { endpoint: credential.endpointName }));
  }

  return {
    summary: t("agentSwitch.summary", {
      name,
      id: agent.id,
      model: credential.modelName,
      modelId: credential.modelId,
    }),
  };
}
