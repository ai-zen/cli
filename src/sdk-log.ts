/**
 * SDK 全局日志接管 —— 关掉库自带的 `console` 兜底。
 *
 * 背景：SDK 的 `getLogger()` 默认实现是 `console.log / console.warn / console.error`
 * （`@ai-zen/agents-sdk` 的 `shared/logger.ts`）。对通用库来说这是合理兜底，对 Ink TUI
 * 却是灾难 —— `console.log` 直接写 stdout，会穿到 Ink 的渲染区外面把界面撕成乱码。
 * 例如 `load_mcp` 有一行 `log.info(JSON.stringify(manifest, null, 2))`，未接管时整份
 * tools / resources 清单会砸在界面上。
 *
 * 所以 TUI 启动第一件事就是接管：
 *   - 默认**全部丢弃**（界面上不该出现库的内部日志，用户也读不懂）；
 *   - 需要排查时用 `AIZ_DEBUG_SDK=1` 落盘，既不污染渲染也不丢信息。
 *
 * 用法：
 *   aiz                                → SDK 日志静默
 *   AIZ_DEBUG_SDK=1 aiz                → 追加写到 <tmp>/aiz-sdk.log
 *   AIZ_DEBUG_SDK=1 AIZ_SDK_LOG_FILE=/path aiz → 写到指定文件
 *
 * 与 `key-debug.ts` 同一套约定（环境变量开关 + tmp 下日志文件），免得排查时记两套。
 *
 * 注意 stdio 模式不需要本模块：`stdio-runner.ts` 已把日志改道 stderr —— 那里 stdout
 * 只留给结果，日志本身是有用的。本模块只服务「界面被占用」的 TUI。
 */

import { appendFileSync } from "node:fs";
import { setLogger, type Logger } from "@ai-zen/agents-sdk";

/** 是否把 SDK 日志落盘（默认关闭） */
export const SDK_LOG_ENABLED = process.env.AIZ_DEBUG_SDK === "1";

/** 日志落盘路径（测试与用户都可能改写，故导出常量） */
export const SDK_LOG_FILE = process.env.AIZ_SDK_LOG_FILE || "/tmp/aiz-sdk.log";

/** 单行日志格式：`<ISO 时间> [level] message` */
export function formatSdkLogLine(
  level: keyof Logger,
  message: string,
  at: Date = new Date(),
): string {
  return `${at.toISOString()} [${level}] ${message}`;
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
        appendFileSync(file, `${formatSdkLogLine(level, message)}\n`);
      } catch {
        /* 诊断失败绝不能影响主流程 */
      }
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** 全静默日志器（TUI 默认） */
export function createSilentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop };
}

/**
 * 接管 SDK 全局日志：默认静默，`AIZ_DEBUG_SDK=1` 时改为落盘。
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
