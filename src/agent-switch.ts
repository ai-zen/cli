/**
 * 主 AgentDefinition 的选择与预检，供 `/agent` 的选择器数据与一句话结果使用（纯逻辑，可单测）。
 *
 * 这里不算任何规则：「这个 AgentDefinition 现在能不能用、不能用是为什么」在新契约里没有这一格，
 * `agentDefinition.list` 回的是定义本身。要判「跑不跑得起来」得先解析模型（会话级 → 定义 → 全局兜
 * 底），再看端点有没有密钥，那是宿主的判断；客户端算一遍就是第二份会漂的规则，症状是界面说切不过去
 * 而宿主其实能跑。
 *
 * 于是本文件只剩两件事：把 AgentDefinition 与配置摊成选择器要的那几行，以及回答「选它行不行」并
 * 给出一句能直接上屏的话。
 *
 * 切换本身写的是默认 AgentDefinition，不是这一段会话：AgentDefinition 在会话创建时就定死了（没有
 * `session.setAgent` 这种东西），所以 `/agent` 写的只能是以后的会话用哪个 AgentDefinition，也就是
 * `config.defaults.update` 的 `defaultAgent`。
 */

import type { AgentList } from "./agents-store.js";
import { topLevelAgents } from "./agents-store.js";
import type { AppConfig } from "./config.js";
import { findModel } from "./config-editor.js";
import { t } from "./i18n/index.js";

/** 一个可选的主 AgentDefinition */
export interface AgentChoice {
  id: string;
  name: string;
  /** 定义没绑模型时取全局兜底那一级 */
  modelId?: string;
  modelName?: string;
}

export function listAgentChoices(config: AppConfig, list: AgentList): AgentChoice[] {
  return topLevelAgents(list).map((agent) => {
    // 落全局兜底那一级只为把「它其实会用哪个模型」显示出来，不参与任何判断：这一版没有
    // 「能不能用」那一格
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

/** 要么一句话结果，要么「哪个 AgentDefinition、为什么不行」 */
export type AgentSwitchCheck =
  { ok: true; summary: string } | { ok: false; name: string; reason?: string };

export interface CheckAgentSwitchOptions {
  config: AppConfig;
  list: AgentList;
  targetAgentId: string;
}

/**
 * 校验目标主 AgentDefinition 能否选用，并给出一句能直接上屏的话。
 *
 * 这里不写任何东西：`defaultAgent` 由调用方走 `config.defaults.update` 写。唯一会拒的是清单里没有
 * 这个 id（选错了，或者定义刚被删）。
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
      // 模型名与 id 只用于显示；两样都没有时留空，不编一个值
      model: choice.modelName ?? choice.modelId ?? "",
      modelId: choice.modelId ?? "",
    }),
  };
}
