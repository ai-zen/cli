/**
 * CLI 本地偏好 —— 语言等「只属于本机 CLI」的设置。
 *
 * ## 为什么不塞进 `config.json`
 *
 * `config.json` 的类型是 SDK 的 `AppConfig`，CLI 与 Desktop 共享同一份契约；
 * 往里加 `ui.language` 等于把 CLI 的偏好写进跨端配置，桌面端读到时既无法理解、
 * 又可能在回写时丢掉。因此单独放 `~/.ai-zen/cli/preferences.json`：
 * 落点与 `conversations/`、`last-session.json` 同级，都是「CLI 运行时数据」。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectLocale, setLocale, normalizeLocale, type Locale } from "./index.js";

/** 共享根目录（与 `config.ts` 的 `AI_ZEN_DIR` 同一约定） */
const AI_ZEN_DIR =
  process.env.AI_ZEN_DIR ||
  join(process.env.HOME || process.env.USERPROFILE || "", ".ai-zen");

/** CLI 运行时目录 */
export const CLI_DIR = join(AI_ZEN_DIR, "cli");

/** 偏好文件；`AIZ_PREFERENCES_FILE` 可覆盖（测试与特殊部署用） */
export const PREFERENCES_FILE =
  process.env.AIZ_PREFERENCES_FILE || join(CLI_DIR, "preferences.json");

/** CLI 本地偏好 */
export interface CliPreferences {
  /** 界面语言；缺失表示「还没选过」，由系统语言识别决定 */
  language?: Locale;
}

/** 读取偏好：文件缺失 / 损坏 / 字段非法都按「没设置」处理，绝不抛错 */
export async function readPreferences(
  file: string = PREFERENCES_FILE,
): Promise<CliPreferences> {
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const language = normalizeLocale(
      (parsed as Record<string, unknown>).language as string | undefined,
    );
    return language ? { language } : {};
  } catch {
    return {};
  }
}

/** 写入偏好（先写临时文件再 rename，避免半个 JSON 留在磁盘上） */
export async function writePreferences(
  next: CliPreferences,
  file: string = PREFERENCES_FILE,
): Promise<void> {
  const payload: CliPreferences = {};
  if (next.language) payload.language = next.language;
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await rename(tmp, file);
  } catch {
    /* 偏好写不进去不该阻塞启动：下一次启动会重新识别 */
  }
}

/**
 * 启动时初始化语言：有偏好用偏好，没有则按系统语言识别并**落盘**。
 *
 * 落盘这一步是有意的：识别结果只算一次，用户之后改了系统语言也不会让界面语言
 * 悄悄漂移——想换就 `/lang`。
 */
export async function initLocale(file: string = PREFERENCES_FILE): Promise<Locale> {
  const prefs = await readPreferences(file);
  const locale = prefs.language ?? detectLocale();
  setLocale(locale);
  if (!prefs.language) await writePreferences({ language: locale }, file);
  return locale;
}

/** 切换语言并落盘（`/lang` 用） */
export async function persistLocale(
  locale: Locale,
  file: string = PREFERENCES_FILE,
): Promise<void> {
  setLocale(locale);
  await writePreferences({ language: locale }, file);
}
