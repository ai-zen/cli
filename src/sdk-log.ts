/**
 * SDK 全局日志接管 —— 把库的日志引到独立文件。
 *
 * 背景：SDK 的 `getLogger()` 接口本身没问题，问题在**默认实现**是
 * `console.log / console.warn / console.error`（`@ai-zen/agents-sdk` 的 `shared/logger.ts`）。
 * 对通用库来说这是合理兜底，对 Ink TUI 却是灾难 —— 直接写 stdout 会穿到渲染区外面
 * 把界面撕成乱码（例如 `load_mcp` 的 `log.info(JSON.stringify(manifest, null, 2))`
 * 会把整份 tools / resources 清单砸在界面上）。
 *
 * 所以 TUI 启动时用 `setLogger()` 把 SDK 的日志出口换成**落盘实现**：
 *   - 日志一律进 `~/.ai-zen/logs/sdk.log`，界面上一个字都不出现；
 *   - 单文件 2MB 上限，超出轮转为 `sdk.log.1`，不会无限膨胀；
 *   - 写失败一律吞掉，磁盘满 / 权限不足绝不能拖垮 TUI。
 *
 * 用法：
 *   aiz                            → 追加写到 ~/.ai-zen/logs/sdk.log（默认开）
 *   AIZ_DEBUG_SDK=0 aiz            → 完全静默
 *   AIZ_SDK_LOG_FILE=/path aiz     → 写到指定文件
 *
 * 与 `key-debug.ts` 同一套约定（环境变量开关 + 固定日志文件），免得排查时记两套。
 *
 * ⚠️ 本模块只解决「日志往哪写」。SDK 内部若有地方绕过 `getLogger()` 直接抓 `console`
 * （模块顶层 `const log = getLogger()` 这类快照），换 logger 是救不回来的 —— 那属于
 * SDK 侧的接线问题，须在 SDK 里改为运行时取 logger，见对应 commit。
 *
 * 注意 stdio 模式不需要本模块：`stdio-runner.ts` 已把日志改道 stderr —— 那里 stdout
 * 只留给结果，日志本身是有用的。本模块只服务「界面被占用」的 TUI。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setLogger, type Logger } from "@ai-zen/agents-sdk";

/** 共享根目录 `~/.ai-zen`（与 config.ts 的 AI_ZEN_DIR 同一约定） */
const AI_ZEN_DIR =
  process.env.AI_ZEN_DIR ||
  join(process.env.HOME || process.env.USERPROFILE || "", ".ai-zen");

/** 是否把 SDK 日志落盘（默认开启，`AIZ_DEBUG_SDK=0` 关闭） */
export const SDK_LOG_ENABLED = process.env.AIZ_DEBUG_SDK !== "0";

/** 日志落盘路径（测试与用户都可能改写，故导出常量） */
export const SDK_LOG_FILE =
  process.env.AIZ_SDK_LOG_FILE || join(AI_ZEN_DIR, "logs", "sdk.log");

/** 单文件上限 2MB；超出后轮转为 `<file>.1`（只保留上一份，总量有界） */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** 单行日志格式：`<ISO 时间> [level] message` */
export function formatSdkLogLine(
  level: keyof Logger,
  message: string,
  at: Date = new Date(),
): string {
  return `${at.toISOString()} [${level}] ${message}`;
}

/** 大小超限时把当前文件挪成 `.1`，让下一次写入从空文件开始 */
function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    /* 文件还不存在：首次写入，无需轮转 */
  }
}

/**
 * 落盘版日志器。
 *
 * 写失败要吞掉：日志是旁路能力，磁盘满 / 权限不足时绝不能把 TUI 拖垮。
 */
export function createFileLogger(file: string): Logger {
  const write =
    (level: keyof Logger) =>
    (message: string): void => {
      try {
        mkdirSync(dirname(file), { recursive: true });
        rotateIfNeeded(file);
        appendFileSync(file, `${formatSdkLogLine(level, message)}\n`);
      } catch {
        /* 诊断失败绝不能影响主流程 */
      }
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** 全静默日志器（`AIZ_DEBUG_SDK=0` 时使用） */
export function createSilentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop };
}

/**
 * 接管 SDK 全局日志：默认落盘，`AIZ_DEBUG_SDK=0` 静默。
 *
 * 返回实际安装的日志器，便于测试断言 / 上层复用。
 */
export function installSdkLogger(
  options: { enabled?: boolean; file?: string } = {},
): Logger {
  const enabled = options.enabled ?? SDK_LOG_ENABLED;
  const file = options.file ?? SDK_LOG_FILE;
  const logger = enabled ? createFileLogger(file) : createSilentLogger();
  setLogger(logger);
  return logger;
}
