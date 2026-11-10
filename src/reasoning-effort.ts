/**
 * 思考档位（reasoning level）—— CLI 侧读写
 *
 * ## 三个层次，边界很硬
 *
 *   - **协议差异在策略表**（`~/.ai-zen/reasoning-presets.json`）：档位名 → 请求参数补丁，
 *     由这张 CLI 自有的表声明，模型用 `reasoningPreset` 引用它。
 *   - **档位值存在「参数该待的那一层」**：参数跟着**模型来自哪一级**走（规则只在
 *     SDK 的 `resolveModelParams` 一处）——
 *       · 模型是 Agent 定义绑的（`level: "agent"`）→ 写 `AgentDefinition.modelParams`
 *         （一直是这个行为）；
 *       · 模型是本段会话换的（`level: "session"`）→ 写会话存档的 `modelParams`
 *         （服务端 `session.modelParams.set`），**不碰定义**；
 *       · 模型来自全局兜底（`level: "global"`）→ **没有可写的一层**，调用方拒绝。
 *     **存的是展开后的参数**，不是档位名。于是「配置即事实」——运行期 SDK 只做一次浅合并，
 *     不查表、不推导。
 *   - **本模块只管 UI 语义**：列可选档位、把参数反查成档位名、算出该写进某一层的参数。
 *
 * 代价（刻意接受）：改了策略表**不会追溯**已配置的 Agent —— 存的是写配置那一刻展开后的参数。
 * 这正是「配置即事实」的含义：表只是写配置那一刻的模板。
 */

import type { AgentDefinition, AppConfig, Model } from "@ai-zen/agents-sdk";
import { t } from "./i18n/index.js";
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
 * 已知档位名清单。
 *
 * 不设成穷举映射：档位名由策略表定义（用户可自建策略、自定档位名），
 * 未收录的名字直接显示原文，比显示「?」有用得多。
 * 文案本身在 i18n 词典的 `effort.<档位名>` 里（中 / 英各一份）。
 */
export const KNOWN_EFFORT_LEVELS: readonly string[] = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 档位 → 显示文案（未收录的档位名原样显示） */
export function effortLabel(level: string): string {
  return KNOWN_EFFORT_LEVELS.includes(level) ? t(`effort.${level}`) : level;
}

/** 模型关联的策略 */
function presetOf(
  model: Model | null | undefined,
  presets: ReasoningPresets,
): ReasoningPreset | undefined {
  return presetFor(model?.id, model?.reasoningPreset, presets);
}

/** 模型可选档位（空数组 = 不可调档） */
export function effortChoices(model?: Model | null, presets?: ReasoningPresets | null): string[] {
  if (!presets) return [];
  return levelsOf(presetOf(model, presets));
}

/** 一档都用不了的模型 */
export function isAdjustable(model?: Model | null, presets?: ReasoningPresets | null): boolean {
  return effortChoices(model, presets).length > 0;
}

/**
 * 生效中的模型参数 = 模型默认参数 + **目标那一层**的覆盖（与 SDK 的合并语义一致，浅合并）。
 *
 * 注意这里复刻的是**同一份事实**，不是另一套推导：状态栏显示的就是真正会发给 API 的
 * 那几个参数里匹配到的那一档。所以调用方必须把「模型来自哪一级」的那一份传进来 ——
 * 会话级的参数在服务端存档里，客户端读不到，那种情况传 `null`，别拿定义那份顶替
 * （混层的参数本来就不会发出去，显示了就是在撒谎）。
 */
function effectiveParams(
  model?: Model | null,
  definition?: Pick<AgentDefinition, "modelParams"> | null,
): Record<string, unknown> {
  return { ...(model?.defaultParams ?? {}), ...(definition?.modelParams ?? {}) };
}

/**
 * 状态栏文案。
 *
 * - 模型不可调档 → `—`
 * - 生效参数命中某档 → 「低」「中」「高」…（按 `effortLabel()`）
 * - 有 Agent 级覆盖但不匹配任何档位 → 「自定义」（用户手改过参数）
 * - 没有任何声明 → 「默认」（跟随模型 `defaultParams`，如 DeepSeek 出厂只开思考不指定档位）
 */
export function describeEffort(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  definition?: Pick<AgentDefinition, "modelParams"> | null,
): string {
  if (!presets || !isAdjustable(model, presets)) return t("effort.unsupported");
  const params = effectiveParams(model, definition);
  const matched = matchLevel(presetOf(model, presets), params);
  if (matched) return effortLabel(matched);
  return definition?.modelParams && Object.keys(definition.modelParams).length > 0
    ? t("effort.custom")
    : t("effort.default");
}

/**
 * 状态栏用的思考强度视图：文案 + 是否置灰。
 *
 * 合成一个对象返回，是为了让调用方**一次取全**——分成两个函数调用容易出现
 * 「文案更新了、置灰没跟上」这种漂移。
 */
export function describeEffortView(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  definition?: Pick<AgentDefinition, "modelParams"> | null,
): { text: string; dimmed: boolean } {
  return {
    text: describeEffort(model, presets, definition),
    dimmed: effortDimmed(model, presets, definition),
  };
}

/**
 * 状态栏里思考强度是否该置灰 —— **不靠文案判断**。
 *
 * 文案是随语言变的：拿它比较（如 `effort === "关"`）在英文界面下永远不成立。
 * 所以判据只能是档位值本身：不可调档，或档位是 off / none。
 */
export function effortDimmed(
  model?: Model | null,
  presets?: ReasoningPresets | null,
  definition?: Pick<AgentDefinition, "modelParams"> | null,
): boolean {
  if (!presets || !isAdjustable(model, presets)) return true;
  const level = matchLevel(presetOf(model, presets), effectiveParams(model, definition));
  return level === "off" || level === "none";
}

export interface SetAgentEffortOptions {
  config: AppConfig;
  /** 思考策略表（`readReasoningPresets()` 的结果） */
  presets: ReasoningPresets;
  /** 目标 Agent（缺省 default） */
  agentId?: string;
  /**
   * **生效**模型 id（三级解析之后的那个；会话级覆盖 / 全局兜底都算）。
   *
   * 不传则用定义上的 `modelId`（写定义那条路的老口径）。为什么要能传：参数写在哪一层
   * 跟着模型来自哪一级走，而**能选哪些档位、档位写成什么参数**只能按生效模型算 —— 拿定义
   * 上的模型算，会话级换了模型之后列出来的档位全是错的（把 A 的档位写成 B 的参数）。
   */
  modelId?: string;
  /** 目标档位；`null` 表示清除思考参数、恢复跟随模型默认 */
  effort: string | null;
  /**
   * 读 Agent 定义。**必填**。
   *
   * 不给缺省值：一个「读本机磁盘」的缺省就是一条**写进客户端本机**的路径 —— 会话跑在
   * 服务端时，读到的既不是 Agent 实际用的定义，写回去也到不了服务端 —— 界面说「改好了」，
   * 请求里还是旧档位（错得很安静）。所以这里只保留一个**注入点**，由调用方决定「定义从哪来」
   * （命令层递的是 `config.readAgentStore()` / `store.save`）。
   */
  readAgent: (agentId: string) => Promise<AgentDefinition | null>;
  /** 写 Agent 定义。**必填**，理由同上（写入比读取更危险：它会在不经意间写脏本机文件） */
  writeAgent: (definition: AgentDefinition) => Promise<void>;
  now?: Date;
}

export interface SetAgentEffortResult {
  definition: AgentDefinition;
  /** 生效模型 */
  model: Model;
  summary: string;
}

export interface EffortParamsOptions {
  /** 思考策略表 */
  presets: ReasoningPresets;
  /** **生效**模型：决定能选哪些档、以及档位对应什么参数 */
  model: Model;
  /** 目标档位；`null` = 只剔除思考键（清掉覆盖） */
  effort: string | null;
  /**
   * 目标层**已有**的参数。
   *
   * 剔除 + 合并都基于它：只认 `base` 里的非思考键，再叠上新档位的补丁。于是
   * `max` → `off` 不会残留上一档的 `reasoning_effort`（那些键整张表都出现过）。
   */
  base?: Record<string, unknown> | null;
}

/**
 * 把档位展开成「某一层该写的参数」—— 写 Agent 定义与写会话存档**共用这一份**。
 *
 * 为什么必须共用：两层的写入只是「写哪儿」不同，「写什么」必须一模一样 —— 否则同一个
 * 档位在会话级和定义级会写成两套参数（一处留着上一档的键、一处不留）。
 *
 * 返回 `undefined` = 该层不该有参数（剔除完为空）：写定义时删掉 `modelParams`，写会话时
 * 存 `null`。两者是同一句话：「这一层没有覆盖，跟随模型出厂参数」。
 *
 * 抛错场景都属于「用户明确要求了一件做不到的事」：模型没关联策略、策略里没这一档。
 */
export function effortParams(options: EffortParamsOptions): Record<string, unknown> | undefined {
  const { presets, model, effort } = options;
  const preset = presetOf(model, presets);
  const allowed = levelsOf(preset);
  if (allowed.length === 0) {
    throw new Error(t("effort.err.noPreset", { id: model.id }));
  }

  const patch = effort === null ? undefined : patchOf(preset, effort);
  if (effort !== null && !patch) {
    throw new Error(
      t("effort.err.unknownLevel", {
        preset: model.reasoningPreset ?? "",
        level: effort,
        options: allowed.join(" / "),
      }),
    );
  }

  // 先剔除思考相关键，再合并新补丁（`null` 即只剔除）
  const owned = ownedKeys(presets);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options.base ?? {})) {
    if (!owned.has(key)) params[key] = value;
  }
  if (patch) Object.assign(params, patch);

  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * 档位的显示名（如「高」/ `high`）。
 *
 * 汇总文案与选择器都得说同一个词，所以收在这里：`setAgentEffort` 的 summary 与命令层
 * （会话级写入）各拼一句不同的句子，但里面那个档位名必须是同一个函数算出来的。
 */
export function effortLabelText(effort: string | null): string {
  return effort === null
    ? t("effort.followDefault")
    : t("effort.quoted", { label: effortLabel(effort) });
}

/**
 * 设置某 Agent 的思考档位：查表拿补丁 → 写进 `definition.modelParams`。
 *
 * 这是**定义那一层**的写入（`level: "agent"`）。模型是本段会话换的、或者来自全局兜底时
 * 不该走这里：参数跟着「模型来自哪一级」走，写错层等于写了一个不生效的地方（见文件头）。
 *
 * 抛错场景：Agent 不存在、未绑定可用模型、模型未关联策略、策略里没有该档位。
 * 这些都属于「用户明确要求了一件做不到的事」，宁可报错也不要静默降级。
 */
export async function setAgentEffort(
  options: SetAgentEffortOptions,
): Promise<SetAgentEffortResult> {
  const { config, presets, effort, readAgent, writeAgent } = options;
  const agentId = options.agentId || "default";
  const now = options.now ?? new Date();

  const definition = await readAgent(agentId);
  if (!definition) throw new Error(t("effort.err.agentMissing", { id: agentId }));

  // 生效模型优先：会话级覆盖 / 全局兜底时，定义上的 `modelId` 不是实际在跑的那个。
  const modelId = options.modelId ?? definition.modelId;
  if (!modelId) {
    throw new Error(t("effort.err.noModel", { id: agentId }));
  }
  const model = (config.models ?? []).find((item) => item.id === modelId);
  if (!model) throw new Error(t("effort.err.modelMissing", { id: modelId }));

  const params = effortParams({ presets, model, effort, base: definition.modelParams });

  const next: AgentDefinition = { ...definition, updatedAt: now.toISOString() };
  if (params) next.modelParams = params;
  else delete next.modelParams;

  await writeAgent(next);

  return {
    definition: next,
    model,
    summary: t("effort.summary", { label: effortLabelText(effort), id: agentId, model: model.id }),
  };
}
