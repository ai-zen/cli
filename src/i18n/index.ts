/**
 * CLI 国际化（i18n）骨架。
 *
 * 词典直接编译进产物，不做运行时语言包加载：CLI 只有中 / 英两种语言，`setLocale()` 只是换一个
 * 引用，切语言不需要重读磁盘、也不需要重启。词条 key 扁平（`status.lastTokens` 这种点号命名），
 * 找词条靠 `dict[key]` 一次哈希，没有嵌套遍历；` 域.语义 ` 前缀让同一域的词条在词典里聚在一起。
 *
 * 缺词条时返回 key 本身，不静默回退到另一种语言：那样英文界面里会突然冒出中文，比直接显示
 * `notice.draftSaved` 更难定位。
 *
 * 语言的优先级是 `LC_ALL` → `LC_MESSAGES` → `LANG` → `Intl` 系统 locale → `en`。环境变量放在
 * 前面，是因为它进程直接可见、用户可控；`Intl` 用来兜住「系统语言是中文但 LANG 没设」这类平台
 * 差异（如 macOS 的 AppleLocale）。
 */

import { en } from "./en.js";
import { zh } from "./zh.js";
import { en as enWizard } from "./en-wizard.js";
import { zh as zhWizard } from "./zh-wizard.js";

export type Locale = "zh" | "en";

export type InterpolateParams = Record<string, string | number>;

/** `/lang` 的候选集 */
export const SUPPORTED_LOCALES: readonly Locale[] = ["zh", "en"];

export const DEFAULT_LOCALE: Locale = "en";

// 主词典与配置中心专区合并成一张表：对 `t()` 没有区别，拆文件只为便于维护
const DICTS: Record<Locale, Record<string, string>> = {
  zh: { ...zh, ...zhWizard },
  en: { ...en, ...enWizard },
};

let currentLocale: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return currentLocale;
}

/** 只改内存，落盘由 `preferences.ts` 负责 */
export function setLocale(locale: Locale): void {
  currentLocale = normalizeLocale(locale) ?? DEFAULT_LOCALE;
}

/**
 * 把任意语言标识归一为支持的 locale。
 *
 * 接受 `zh` / `zh-CN` / `zh_CN.UTF-8` / `en-US` 等写法；`C` / `POSIX` 这类没有语言信息的值返回
 * `null`，交给下一个候选。
 */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("zh")) return "zh";
  if (v.startsWith("en")) return "en";
  return null;
}

function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** 参数可注入，单测因此不依赖宿主环境 */
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
 * `{name}` 占位符用 params 替换，缺参数时保留原样，便于一眼看出漏传。
 *
 * 刻意不做复数变体：本项目的数量词都写成「{n} 个 / (s)」，一套没人用的复数机制只会让词条表
 * 看起来支持它。
 */
export function t(key: string, params?: InterpolateParams): string {
  const template = DICTS[currentLocale][key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

function interpolate(template: string, params?: InterpolateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
