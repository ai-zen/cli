/**
 * 思考预设 —— CLI 侧的表操作（纯函数）
 *
 * 表的**定义、出厂内容、读写**都在 SDK（`@ai-zen/agents-sdk` 的 `ReasoningPresets` /
 * `FACTORY_REASONING_PRESETS` / `ConfigManager.readReasoningPresets()`），因为桌面端等
 * 其它客户端也要用同一套档位知识。
 *
 * 本模块只负责「**利用**这张表」：CLI 用它限制 `/think` 的可选档位、把选中的档位展开成
 * 请求参数写进 `AgentDefinition.modelParams`、以及把现有参数反查成档位名做展示。
 *
 * 全部是纯函数、不碰文件——SDK 不替我们决定这些，客户端自己掌握「怎么用表」。
 */

import type { ReasoningPreset, ReasoningPresets } from "@ai-zen/agents-sdk";

export type { ReasoningPatch, ReasoningPreset, ReasoningPresets } from "@ai-zen/agents-sdk";

/** 安全取自有属性（策略名来自用户配置，可能是 `constructor` / `__proto__`） */
function own<T>(bag: Record<string, T> | undefined, key: string): T | undefined {
  if (!bag || !Object.prototype.hasOwnProperty.call(bag, key)) return undefined;
  return bag[key];
}

/** 模型关联的策略（未声明 `reasoningPreset` 或名字不存在 → `undefined`） */
export function presetFor(
  modelId: string | undefined,
  presetName: string | undefined,
  presets: ReasoningPresets,
): ReasoningPreset | undefined {
  if (!modelId || !presetName) return undefined;
  return own(presets, presetName);
}

/** 某策略的全部档位（= `levels` 的键，顺序即声明顺序） */
export function levelsOf(preset: ReasoningPreset | undefined): string[] {
  return preset ? Object.keys(preset.levels ?? {}) : [];
}

/** 某策略某档的参数补丁 */
export function patchOf(
  preset: ReasoningPreset | undefined,
  level: string,
): Record<string, unknown> | undefined {
  return own(preset?.levels, level);
}

/**
 * 整张表出现过的参数键。
 *
 * 换档时按此剔除旧值 —— 这样 `max` → `off` 不会残留上一个档位的 `reasoning_effort`，
 * 而「哪些键属于思考」由表自己声明，代码零硬编码。「表里没有的键」一律当普通参数保留。
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

/** 结构化相等 —— 补丁是纯 JSON，逐层比对即可 */
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
 * 反查：现有参数命中哪个档位（多张补丁同时命中取最具体的）。
 *
 * 纯展示用途 —— 状态栏要显示「当前是第几档」。命中不了返回 `undefined`。
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
