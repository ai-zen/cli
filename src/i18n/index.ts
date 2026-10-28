/**
 * CLI 国际化（i18n）骨架。
 *
 * ## 设计取舍
 *
 * 1. **不做运行时语言包加载**：CLI 只有中 / 英两种语言，词典直接编译进产物，
 *    `setLocale()` 只是换一个引用，切换语言不需要重读磁盘、也不需要重启。
 * 2. **key 扁平化**（`status.lastTokens` 这种点号命名）：找词条靠 `dict[key]` 一次哈希，
 *    没有嵌套遍历；同一 `域.语义` 前缀在词典里天然聚在一起，读起来就是分组。
 * 3. **复数走 `Intl.PluralRules`**：英文需要 `1 tool` / `2 tools`，中文没有复数。
 *    词条可写 `key_one` / `key_other` 变体，`t()` 在 `params.n` 是数字时自动选；
 *    没有变体就用基础 key（中文只写基础 key 即可）。
 * 4. **缺词条返回 key 本身**：不做静默回退到另一种语言 —— 那样英文界面里会突然冒出
 *    中文，比直接显示 `notice.draftSaved` 更难定位。
 *
 * ## 语言怎么定
 *
 * 优先级：`LC_ALL` → `LC_MESSAGES` → `LANG` → `Intl` 系统 locale → **兜底 en**。
 * 环境变量放在前面是因为它是进程直接可见、用户可控的；`Intl` 用来兜住
 * 「系统语言是中文但 LANG 没设」这类平台差异（如 macOS 的 AppleLocale）。
 */

import { en } from "./en.js";
import { zh } from "./zh.js";
import { en as enWizard } from "./en-wizard.js";
import { zh as zhWizard } from "./zh-wizard.js";

/** 支持的语言 */
export type Locale = "zh" | "en";

/** 插值参数（`{n}` / `{name}` 这类占位符） */
export type InterpolateParams = Record<string, string | number>;

/** 支持的语言清单（`/lang` 的候选集） */
export const SUPPORTED_LOCALES: readonly Locale[] = ["zh", "en"];

/** 无法识别系统语言时的兜底 */
export const DEFAULT_LOCALE: Locale = "en";

// 主词典 + 配置中心专区，合并成同一张表（对 `t()` 而言无区别，只是拆文件便于维护）
const DICTS: Record<Locale, Record<string, string>> = {
  zh: { ...zh, ...zhWizard },
  en: { ...en, ...enWizard },
};

let currentLocale: Locale = DEFAULT_LOCALE;

/** 当前语言 */
export function getLocale(): Locale {
  return currentLocale;
}

/** 设置当前语言（只改内存，落盘由 `preferences.ts` 负责） */
export function setLocale(locale: Locale): void {
  currentLocale = normalizeLocale(locale) ?? DEFAULT_LOCALE;
}

/**
 * 把任意语言标识归一为支持的 locale。
 *
 * 接受 `zh` / `zh-CN` / `zh_CN.UTF-8` / `en-US` 等写法；`C` / `POSIX` 这类
 * 「没有语言信息」的值返回 `null`，交给下一个候选。
 */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("zh")) return "zh";
  if (v.startsWith("en")) return "en";
  return null;
}

/** 系统 locale（Node 的 ICU 结果，失败时返回 undefined） */
function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * 识别系统语言：环境变量优先，`Intl` 兜底，最后回落英文。
 *
 * 参数可注入，便于单测不依赖宿主环境。
 */
export function detectLocale(
  env: NodeJS.ProcessEnv = process.env,
  sys: string | undefined = systemLocale(),
): Locale {
  const candidates = [env.LC_ALL, env.LC_MESSAGES, env.LANG, sys];
  for (const raw of candidates) {
    const hit = normalizeLocale(raw);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

/**
 * 取词条。
 *
 * - `{name}` 占位符用 params 替换，缺参数时保留原样（便于一眼看出漏传）；
 * - 词条不存在时返回 key 本身。
 *
 * 刻意不做复数变体（Intl.PluralRules）：本项目的数量词都写成「{n} 个 / (s)」，
 * 一套从未启用的复数机制只会让词条表看起来支持它、实际没有一条在用。
 */
export function t(key: string, params?: InterpolateParams): string {
  const template = DICTS[currentLocale][key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

/** 占位符替换：`{name}` → 对应值 */
function interpolate(template: string, params?: InterpolateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
