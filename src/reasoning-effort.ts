/**
 * 思考档位在 CLI 侧的文案，外加一处「读表」：AgentDefinition 上现在算哪一档。
 *
 * 会话级的档位现状由会话行给（`session.open` 的 `thinkingLevel`）：`session.setThinking` 写它、宿主
 * 展开成参数，`session.ts` 的派生视图拼成 `ThinkingState`。AgentDefinition 级存的是展开后的参数
 * （`AgentDefinition.modelParams`，配置即事实），所以「它现在算哪一档」只能由客户端拿档位表反查，
 * 那就是 {@link agentThinkingOf}，与旧版 `reasoning-effort.ts` 的 `matchLevel` 是同一套算法。文案
 * （` 低 ` / ` 跟随模型默认 ` / `—`）与状态栏那一格在 {@link thinkingView}。
 *
 * 档位表的定义、出厂内容与读写都在宿主（`config.get` 的 `presets`）。这里只利用它：列出可选档位、
 * 把现有参数反查成档位名、把选中的档位展开成参数交给 `agentDefinition.update`。不碰文件，也不认识
 * 哪家厂商。
 */

import type { AgentDefinition, AppConfig, ReasoningPreset, ReasoningPresets } from "./config.js";
import { findModel } from "./config-editor.js";
import type { ThinkingState } from "./session/types.js";
import { t } from "./i18n/index.js";

/**
 * 已知档位名清单。
 *
 * 不做穷举映射：档位名由宿主那侧的策略表定义（用户可以自建策略、自定档位名），未收录的名字直接显示
 * 原文，比显示「?」有用。文案本身在 i18n 词典的 `effort.<档位名>` 里。
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

export function effortLabel(level: string): string {
  return KNOWN_EFFORT_LEVELS.includes(level) ? t(`effort.${level}`) : level;
}

/**
 * 档位的显示名（如「高」/「跟随模型默认」）。
 *
 * 汇总文案与选择器都得说同一个词，所以收在这里：命令层的 summary 各拼一句不同的句子，但里面那个档位
 * 名必须是同一个函数算出来的。
 */
export function effortLabelText(effort: string | null): string {
  return effort === null
    ? t("effort.followDefault")
    : t("effort.quoted", { label: effortLabel(effort) });
}

export function isAdjustable(thinking: ThinkingState): boolean {
  return thinking.source !== "not_adjustable" && thinking.levels.length > 0;
}

/** 关掉的档位：状态栏里该置灰（判断依据是档位值，不是文案） */
function isOffLevel(level: string): boolean {
  return level === "off" || level === "none";
}

/**
 * 状态栏用的思考强度视图：文案 + 是否置灰。
 *
 * 三句话，全部来自宿主给的 `source` / `selected`：
 *   - `not_adjustable`：这个模型没有档位 → `—`，置灰；
 *   - `manual`：现在就是某一档 → 档位名；`off` / `none` 置灰；
 *   - `following_default`：没设过档位，跟着模型默认走 → 「默认」，不置灰。
 *
 * 合成一个对象返回，是为了让调用方一次取全 —— 分成两个函数容易出现「文案更新了、
 * 置灰没跟上」这种漂移。
 */
export function thinkingView(thinking: ThinkingState): { text: string; dimmed: boolean } {
  if (!isAdjustable(thinking)) return { text: t("effort.unsupported"), dimmed: true };
  if (thinking.source === "manual" && thinking.selected !== null) {
    return { text: effortLabel(thinking.selected), dimmed: isOffLevel(thinking.selected) };
  }
  // 定义上带着属于这个策略的键、却凑不成任何一档 = 有人手写过参数。
  // 它不是默认：说成默认会让用户以为那份没生效，或者再设一次把手写值覆盖掉。
  if (thinking.source === "custom") return { text: t("effort.custom"), dimmed: false };
  return { text: t("effort.default"), dimmed: false };
}

/** 安全取自有属性（策略名来自用户配置，可能是 `constructor` / `__proto__`） */
function own<T>(bag: Record<string, T> | undefined, key: string): T | undefined {
  if (!bag || !Object.prototype.hasOwnProperty.call(bag, key)) return undefined;
  return bag[key];
}

export function presetOf(
  presets: ReasoningPresets,
  name: string | null | undefined,
): ReasoningPreset | undefined {
  if (!name) return undefined;
  return own(presets, name);
}

/** 某策略的全部档位（`levels` 的键，顺序即声明顺序；空数组 = 不可调档） */
export function levelsOf(preset: ReasoningPreset | undefined): string[] {
  return preset ? Object.keys(preset.levels ?? {}) : [];
}

export function patchOf(
  preset: ReasoningPreset | undefined,
  level: string,
): Record<string, unknown> | undefined {
  return own(preset?.levels, level);
}

/**
 * 整张表出现过的参数键：「哪些键属于思考」由表自己声明，代码零硬编码。
 *
 * 换档时按此剔除旧值：`max` → `off` 不会残留上一档的 `reasoning_effort`，而表里没有的键
 * （`temperature` 之类）一律当普通参数原样留着。
 */
export function ownedKeys(presets: ReasoningPresets): Set<string> {
  const keys = new Set<string>();
  for (const preset of Object.values(presets ?? {})) {
    for (const patch of Object.values(preset?.levels ?? {})) {
      for (const key of Object.keys(patch ?? {})) keys.add(key);
    }
  }
  return keys;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(right, k) && sameValue(left[k], right[k]),
  );
}

/**
 * 反查：现有参数命中哪个档位（多张补丁同时命中取最具体的）。纯展示用途，命中不了返回 `undefined`。
 */
export function matchLevel(
  preset: ReasoningPreset | undefined,
  params: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!preset || !params) return undefined;
  let best: string | undefined;
  let bestSize = 0;
  for (const [level, patch] of Object.entries(preset.levels ?? {})) {
    const keys = Object.keys(patch ?? {});
    if (keys.length === 0 || keys.length <= bestSize) continue;
    if (!keys.every((k) => sameValue(params[k], (patch as Record<string, unknown>)[k]))) continue;
    best = level;
    bestSize = keys.length;
  }
  return best;
}

/**
 * 一条 AgentDefinition 现在的思考档位现状（派生视图，与 `session/types.ts` 的 `ThinkingState` 同形）。
 *
 * 生效模型按三级解析的第二、三级算（`definition.modelId` → `config.defaultModel`）：定义上那一层写的
 * 是什么，决定用这个 AgentDefinition 新开的会话会拿到哪一档，而会话级覆盖另有一格。
 *
 * 四个 `source` 的含义：`not_adjustable` = 模型没有策略，或策略里一档都没有；`following_default` =
 * 定义上没有任何思考参数（跟随模型 `defaultParams`）；`manual` = 定义上的参数正好凑成某一档；
 * `custom` = 定义了思考参数但凑不成任何一档（有人手写过）。
 */
export function agentThinkingOf(
  definition: AgentDefinition,
  config: Pick<AppConfig, "models" | "defaultModel">,
  presets: ReasoningPresets,
): ThinkingState {
  const model = findModel(config, definition.modelId ?? config.defaultModel);
  const presetName = model?.reasoningPreset ?? null;
  const preset = presetOf(presets, presetName);
  const levels = levelsOf(preset);
  const params = definition.modelParams ?? {};
  if (levels.length === 0) {
    return { preset: presetName, levels, selected: null, source: "not_adjustable", params: {} };
  }
  const thinking = ownedKeys(presets);
  const hasOwn = Object.keys(params).some((key) => thinking.has(key));
  const selected = hasOwn ? (matchLevel(preset, params) ?? null) : null;
  const source = !hasOwn ? "following_default" : selected === null ? "custom" : "manual";
  return { preset: presetName, levels, selected, source, params: {} };
}

/**
 * 定义上的 `modelParams` 换成某一档（或清掉）之后应该长成什么。
 *
 * 先剔除整张表出现过的键（新旧档位不混），再合并新档的补丁；`level === null` 就是只剔除。不思考的
 * 参数（`temperature` 之类）原样留着，那一格不归这一层管。
 *
 * 空的结果保持 `{}` 而不是删掉这一格：`agentDefinition.update` 是合并语义（`undefined` = 不改这一
 * 项），所以「清掉思考参数」在 wire 上就是一份剔干净的参数表。
 */
export function modelParamsWithLevel(
  current: Record<string, unknown> | undefined,
  presets: ReasoningPresets,
  preset: ReasoningPreset | undefined,
  level: string | null,
): Record<string, unknown> {
  const thinking = ownedKeys(presets);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    if (!thinking.has(key)) next[key] = value;
  }
  if (level !== null) Object.assign(next, patchOf(preset, level) ?? {});
  return next;
}
