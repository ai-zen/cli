/**
 * 主 AgentDefinition 的选择与预检 —— `/agent` 的选择器数据与一句话结果（纯逻辑，可单测）。
 *
 * ## 这里一个规则都不算
 *
 * 「这个 AgentDefinition 现在能不能用、不能用是为什么」在新契约里**没有**这一格：`agentDefinition.list`
 * 回的是定义本身（`AgentDefinition`），旧契约的 `AgentView.available` / `unavailableReason`
 * 随那一组形状一起退场了。要判「跑不跑得起来」得先解析模型（会话级 → 定义 → 全局兜底）、
 * 再看端点有没有密钥 —— 那是宿主的判断，客户端算一遍就是第二份会漂的规则（症状是「界面说切
 * 不过去、宿主其实能跑」）。
 *
 * 于是本文件只剩两件事：
 *   - 把 AgentDefinition + 配置摊成选择器要的那几行（主 AgentDefinition、它指着哪个模型）；
 *   - 回答「选它行不行」并给出一句能直接上屏的话。
 *
 * ## 切换本身写的是**默认 AgentDefinition**，不是这一段会话
 *
 * AgentDefinition 在会话创建时就定死了（PRD L7：没有 `session.setAgent` 这种东西），所以 `/agent`
 * 写的只能是「以后的会话用哪个 AgentDefinition」= `config.defaults.update` 的 `defaultAgent`。
 */

import type { AgentList } from "./agents-store.js";
import { topLevelAgents } from "./agents-store.js";
import type { AppConfig } from "./config.js";
import { findModel } from "./config-editor.js";
import { t } from "./i18n/index.js";

/** 选择器里的一行：一个可选的主 AgentDefinition */
export interface AgentChoice {
  id: string;
  /** 展示名（`name` 缺失时回落 id） */
  name: string;
  /** 它实际会用的模型 id（定义没绑时取全局兜底那一级） */
  modelId?: string;
  /** 模型的显示名（模型已被删时回落 id） */
  modelName?: string;
}

/**
 * 列出全部主 AgentDefinition，供 `/agent` 选择器渲染。
 *
 * 只列主 AgentDefinition：子 Agent 不是入口（定义里有没有 `function` 明说了这件事）。
 */
export function listAgentChoices(config: AppConfig, list: AgentList): AgentChoice[] {
  return topLevelAgents(list).map((agent) => {
    // 定义没绑模型时落全局兜底那一级 —— 只为了把「它其实会用哪个模型」显示出来，
    // 不参与任何判断（这一版没有「能不能用」那一格）
    const modelId = agent.modelId ?? config.defaultModel ?? undefined;
    const model = findModel(config, modelId);
    return {
      id: agent.id,
      name: agent.name || agent.id,
      modelId,
      modelName: model ? model.name || model.id : modelId,
    };
  });
}

/** 预检结果：要么一句话结果，要么「哪个 AgentDefinition、为什么不行」 */
export type AgentSwitchCheck =
  { ok: true; summary: string } | { ok: false; name: string; reason?: string };

/** {@link checkAgentSwitch} 的入参 */
export interface CheckAgentSwitchOptions {
  config: AppConfig;
  /** AgentDefinition 清单（+ 默认 AgentDefinition id） */
  list: AgentList;
  targetAgentId: string;
}

/**
 * 校验目标主 AgentDefinition 能否选用，并给出「跟用户说一句」的内容。
 *
 * **不写任何东西**：`defaultAgent` 由调用方走 `config.defaults.update` 写。
 * 这里唯一会拒的是「清单里根本没有这个 id」（选错了 / 定义刚被删）。
 */
export function checkAgentSwitch(options: CheckAgentSwitchOptions): AgentSwitchCheck {
  const choice = listAgentChoices(options.config, options.list).find(
    (item) => item.id === options.targetAgentId,
  );
  if (!choice) {
    return {
      ok: false,
      name: options.targetAgentId,
      reason: t("agentSwitch.err.agentMissing", { id: options.targetAgentId }),
    };
  }

  return {
    ok: true,
    summary: t("agentSwitch.summary", {
      name: choice.name,
      id: choice.id,
      // 模型名与 id 只用于显示；两样都没有时留空比编一个值诚实
      model: choice.modelName ?? choice.modelId ?? "",
      modelId: choice.modelId ?? "",
    }),
  };
}
