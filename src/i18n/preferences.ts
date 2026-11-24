/**
 * CLI 本地偏好 —— 语言等「只属于本机 CLI」的设置。
 *
 * ## 为什么不塞进 `config.json`
 *
 * `config.json` 的类型是 SDK 的 `AppConfig`，CLI 与 Desktop 共享同一份契约；
 * 往里加 `ui.language` 等于把 CLI 的偏好写进跨端配置，桌面端读到时既无法理解、
 * 又可能在回写时丢掉。因此单独放 `~/.ai-zen/cli/preferences.json`：
 * 落点与 `cli/` 下其它运行时数据同级，都是「CLI 运行时数据」。
 *
 * ## 日志口是从参数上收的
 *
 * 读不出来 / 写不进去都要报一句（见下面的 `broken` 与 `writePreferences`），出口是调用方递进来
 * 的 `LogSink`（根造、入口传）。本模块**没有**全局日志口可读 —— 一句话写到哪，签名里写着。
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LogSink } from "@ai-zen/agents-logger";
import { cliEnv } from "../env.js";
import { readMemoryFile, type MemoryRead } from "../local-memory.js";
import { detectLocale, setLocale, getLocale, normalizeLocale, type Locale } from "./index.js";

/**
 * 偏好文件路径；`AIZ_PREFERENCES_FILE` 可覆盖（调试与特殊部署用）。
 *
 * 根从 `cliEnv()` 取，**不**在这里再拼一遍 `AI_ZEN_DIR` / `HOME`：那份拼法以前在本文件与
 * `config.ts` 各有一份，两份的**时机**还不一样（一个每次调用重算、一个模块求值时算一次），
 * 症状是「设了 `AI_ZEN_DIR` 有个文件跟着走、另一个不跟」。现在解析只有 `env.ts` 一处。
 */
function preferencesFile(): string {
  return process.env.AIZ_PREFERENCES_FILE || join(cliEnv().aiZenDir, "cli", "preferences.json");
}

/** CLI 本地偏好 */
export interface CliPreferences {
  /** 界面语言；缺失表示「还没选过」，由系统语言识别决定 */
  language?: Locale;
}

/**
 * 读取偏好。
 *
 * 判据与 `local-memory.ts` 同一套：文件不存在 = 还没选过（第一次启动，正常路径）；
 * 读不出来 / 不是 JSON → 报一句后按「没设置」继续，但**不写回**（`initLocale` 见 `broken`
 * 就不落盘：那份坏文件里的东西我们没读到，写下去等于把它抹掉）。
 */
export async function readPreferences(
  logger: LogSink,
  file: string = preferencesFile(),
): Promise<CliPreferences> {
  return preferencesOf(await readMemoryFile(file, logger));
}

/** 一份记忆文件 → 偏好；`absent` / `broken` 都按「没设置」算（后者已经报过一句） */
function preferencesOf(read: MemoryRead): CliPreferences {
  if (read.kind !== "value") return {};
  const language = read.entries.language;
  const normalized = typeof language === "string" ? normalizeLocale(language) : null;
  return normalized ? { language: normalized } : {};
}

/**
 * 写入偏好（先写临时文件再 rename，避免半个 JSON 留在磁盘上）。
 *
 * 写不进去不阻塞（这一屏的语言已经换了），但**不许静默丢**：写不进去 = 下次启动语言变回去，
 * 而用户只会以为是自己记错了。报一句。
 */
export async function writePreferences(
  next: CliPreferences,
  logger: LogSink,
  file: string = preferencesFile(),
): Promise<void> {
  const payload: CliPreferences = {};
  if (next.language) payload.language = next.language;
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await rename(tmp, file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`记不住界面偏好 ${file}：${reason}（下次启动会重新识别语言）`);
  }
}

/**
 * 启动时初始化语言：有偏好用偏好，没有则按系统语言识别并**落盘**。
 *
 * 落盘这一步是有意的：识别结果只算一次，用户之后改了系统语言也不会让界面语言
 * 悄悄漂移——想换就 `/lang`。
 *
 * 例外：偏好文件**读不出来**（不是「不存在」）时不落盘 —— 那份文件里的东西我们没读到，
 * 写下去等于把它抹掉。这一次按识别结果用，报的那一句在 `readMemoryFile` 里。
 */
export async function initLocale(
  logger: LogSink,
  file: string = preferencesFile(),
): Promise<Locale> {
  const read = await readMemoryFile(file, logger);
  const prefs = preferencesOf(read);
  const locale = prefs.language ?? detectLocale();
  setLocale(locale);
  if (!prefs.language && read.kind !== "broken") {
    await writePreferences({ language: locale }, logger, file);
  }
  return locale;
}

/** 切换语言并落盘（`/lang` 用） */
export async function persistLocale(
  locale: Locale,
  logger: LogSink,
  file: string = preferencesFile(),
): Promise<void> {
  setLocale(locale);
  await writePreferences({ language: locale }, logger, file);
}

/**
 * 宿主那份语言的读写口。
 *
 * 形状给得这么窄，是为了让本模块只认「读一格 / 写一格」：拼 `config.get` / `config.update`
 * 是调用方的事，这一层不 import 连接层。
 */
export interface HostLocaleSource {
  /** 宿主配置里的 `language`（没有这一格就是 `undefined`） */
  read(): Promise<string | undefined>;
  /** 写宿主配置里的 `language` */
  write(locale: Locale): Promise<void>;
}

/**
 * 出场对齐：让「界面语言」与「宿主渲染的句子」是同一门语言。
 *
 * 语言存在两处：本机偏好（`preferences.json`）管界面文案，宿主配置的 `language` 管宿主自己渲染的
 * 句子（题、通知、错误）。`/lang` 会两边一起写，缺的只是**第一次** —— `initLocale` 只按系统语言写
 * 本机那份，从没告诉过宿主，于是界面是中文、交接那道题与宿主通知却是英文（宿主缺省 `en`）。
 *
 * 方向由现有设计定死：`/lang` 写的是宿主配置，所以**宿主有值就以它为准**（顺手把本机偏好也改回
 * 同一份，下次启动不再对不上）；宿主没有这一格，就把本机偏好推上去补齐。之后两边由 `/lang` 一起
 * 改，不会再漂。
 *
 * 问不到 / 写不进去都只报一句、保持现状：界面已经能用，语言不是拦路的事。
 */
export async function alignLocaleWithHost(
  host: HostLocaleSource,
  logger: LogSink,
  file: string = preferencesFile(),
): Promise<void> {
  let hostLanguage: Locale | null;
  try {
    hostLanguage = normalizeLocale(await host.read());
  } catch (error) {
    logger.warn(`读不到宿主的语言设置：${reasonOf(error)}（界面语言保持本机偏好）`);
    return;
  }

  // 宿主有这一格：它就是真相（`/lang` 写的就是它）
  if (hostLanguage !== null) {
    if (hostLanguage === getLocale()) return;
    setLocale(hostLanguage);
    await writePreferences({ language: hostLanguage }, logger, file);
    return;
  }

  // 宿主没这一格（首次启动）：把本机偏好推上去，两处从今天起是同一份
  try {
    await host.write(getLocale());
  } catch (error) {
    logger.warn(`写不进宿主的语言设置：${reasonOf(error)}（宿主那侧仍是它自己的缺省）`);
  }
}

/** 错误对象 → 一句能放进日志的话 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
