/**
 * 按键诊断 —— 不同终端的按键编码差异极大（macOS 的 Option、PageUp/PageDown 尤其），
 * 「某个键在我机器上没反应」这类问题靠猜毫无意义：要么键被 OS/终端吞掉，
 * 要么终端发来的序列和我们认的不一样。两种情况的判定方法是同一个 —— 看日志里有几行。
 *
 * 用法：
 *   AIZ_DEBUG_KEYS=1 aiz                       → 追加写到 <数据根>/logs/cli/keys.log
 *   AIZ_DEBUG_KEYS=1 AIZ_KEYS_FILE=/path aiz   → 写到指定文件
 *
 * `AIZ_DEBUG_KEYS` 在**模块加载时**读一次就固定（见 `KEY_DEBUG_ENABLED`），所以必须在启动进程前
 * 给 —— 进程跑起来之后再设无效。日志路径相反，**用的时候才算**（见 `keyDebugFile()`）。
 *
 * 判读：
 *   - 按了键但日志里没有新增行 → 键根本没到应用（被 OS 快捷键或终端键位映射截走）
 *   - 有行但 `input`/`flags` 与预期不符 → 序列认识，是匹配逻辑的问题
 *   - 有行且 `raw=false` → 终端没处于 raw mode，键被终端自己解释了（如滚动 scrollback）
 *
 * 刻意在 `useInput` 回调里记录而不是直接监听 `stdin` 的 data 事件：
 * 后者会把流切成 flowing 模式，与 Ink 内部的 readable 读取抢数据。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { cliEnv } from "../env.js";

export const KEY_DEBUG_ENABLED = process.env.AIZ_DEBUG_KEYS === "1";

/** 改落点的环境变量（给了就用它，不再跟数据根走） */
const KEY_DEBUG_FILE_ENV = "AIZ_KEYS_FILE";

/**
 * 日志落盘路径：`AIZ_KEYS_FILE`，缺省 `<数据根>/logs/cli/keys.log`（CLI 那一格）。
 *
 * **用的时候才算，不在模块顶层求值**：数据根由 `cliEnv()` 给（`applyCliEnv` 在 `CliApp`
 * 构造时才钉下），而本模块在 TUI 里被导入的时机可能早于那一下 —— 顶层求值要么撞上「还没
 * 设置」，要么拿到上一次的根。
 *
 * 导出是为了与用例共用**同一个**已解析值（用例要 `stat` 它）。
 */
export function keyDebugFile(): string {
  const override = process.env[KEY_DEBUG_FILE_ENV];
  if (override) return override;
  return join(cliEnv().aiZenDir, "logs", "cli", "keys.log");
}

/** Ink `useInput` 的 key 对象里我们关心的字段（结构化，避免依赖 ink 的类型导出） */
export interface KeyFlags {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  home?: boolean;
  end?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/** 终端环境摘要：排查「只在某终端失灵」时先看这一行 */
export function terminalSummary(env: NodeJS.ProcessEnv = process.env): string {
  const keys = [
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "COLORTERM",
    "LANG",
    "COLUMNS",
    "LINES",
  ];
  const parts = keys.map((k) => `${k}=${env[k] ?? "-"}`);
  parts.push(`platform=${process.platform}`, `node=${process.version}`);
  return parts.join(" ");
}

const FLAG_NAMES: (keyof KeyFlags)[] = [
  "ctrl",
  "meta",
  "shift",
  "upArrow",
  "downArrow",
  "leftArrow",
  "rightArrow",
  "pageUp",
  "pageDown",
  "home",
  "end",
  "return",
  "escape",
  "tab",
  "backspace",
  "delete",
];

/**
 * 把一次按键格式化成单行记录。
 *
 * `input` 用 JSON.stringify 转义（控制字符会变成 `\u001b` 这类可读形式），
 * `raw` 表示按下时 stdin 是否仍在 raw mode —— 为 false 时键会被终端自己吃掉。
 */
export function formatKeyEvent(input: string, key: KeyFlags, raw: boolean): string {
  const flags = FLAG_NAMES.filter((name) => key[name]).join(",");
  return `key input=${JSON.stringify(input ?? "")} flags=[${flags}] raw=${raw}`;
}

/** 当前 stdin 是否处于 raw mode（非 TTY 或平台不支持时视为 false） */
function stdinIsRaw(): boolean {
  const stdin = process.stdin as { isRaw?: boolean };
  return Boolean(stdin.isRaw);
}

let started = false;

/**
 * 记录一行到诊断日志；仅在 `AIZ_DEBUG_KEYS=1` 时生效。
 *
 * 同步写：调试期每次按键都写一行，量小；异步写反而可能在崩溃时丢最后几行
 * —— 而那几行往往正是要看的那几行。
 */
function keyDebugLog(line: string): void {
  if (!KEY_DEBUG_ENABLED) return;
  try {
    const file = keyDebugFile();
    // 目录可能还不存在（`logs/cli/` 是 CLI 那一格，常见于刚装好的第一次调试）
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 诊断失败绝不能影响主流程 */
  }
}

/** 会话开始时写一行环境摘要（同一次运行只写一次） */
export function keyDebugStart(): void {
  if (!KEY_DEBUG_ENABLED || started) return;
  started = true;
  try {
    keyDebugLog(`=== start ${terminalSummary()} file=${keyDebugFile()} ===`);
  } catch {
    /* 求路径本身也可能失败（根还没钉）：诊断不该拦住主流程 */
  }
}

/** 记录一次按键 */
export function keyDebug(input: string, key: KeyFlags): void {
  if (!KEY_DEBUG_ENABLED) return;
  keyDebugLog(formatKeyEvent(input, key, stdinIsRaw()));
}
