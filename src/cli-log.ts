/**
 * CLI 自己的日志出口：一个进程一格目录、一个实例、一个主人。
 *
 * 两档只有目的地不同。交互界面与其余路由写 `<dataRoot>/logs/cli/cli.log`（单份 2MB，保留 2 份），
 * `logs/cli/` 只归 CLI 写；管道模式（`stdio`）写 `writeErr`（stderr），不建文件 —— stdout 只留给结果。
 * 两档的行格式相同（`formatLine`：时间 + 级别 + 来源 + 消息），所以日志长什么样只有一处答案。轮转、
 * 排队写盘与收尾 flush 都不在这里，那是 `@ai-zen/agents-logger` 的事，本文件只给它参数。
 *
 * 这里没有单例：日志实例的主人是根（{@link CliApp}），它造、它传给各层、它在 `run()` 的 finally
 * 里关。一个模块级的 `getLogger()` 会让「这行是谁写的、落到哪个文件」重新变成要读实现才知道的事。
 * 要写日志的模块从参数上收一个 `LogSink`，于是「谁在写」在签名里看得见。
 *
 * 边界：不读环境变量；也不认识通知 —— 想知道刚写出去了一条什么，订阅 `onRecord`，根在接线处把
 * `warn` / `error` 接给本地通知（`app.ts`），日志这一层不决定该不该弹。
 */

import {
  FileLogger,
  formatLine,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from "@ai-zen/agents-logger";
import { join } from "node:path";

/** 单份上限 2MB：到点换下一份（`cli.log.1`） */
export const CLI_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 保留 2 份：正在写的加一份上一份（`cli.log.1`） */
export const CLI_LOG_MAX_FILES = 2;

export const CLI_LOG_SOURCE = "cli";

export function cliLogFile(dataRoot: string): string {
  return join(dataRoot, "logs", "cli", "cli.log");
}

export interface CliLogOptions {
  dataRoot: string;
  /** `false` = 管道模式：写 `writeErr`，不建文件 */
  persist: boolean;
  writeErr: (text: string) => void;
  /** 每写一条就回调一次，根用它把 `warn` / `error` 接给本地通知 */
  onRecord?: (record: LogRecord) => void;
}

export interface CliLog {
  readonly logger: LogSink;
  /** `null` = 这一档不落盘 */
  readonly filePath: string | null;
  /** 排队的行写完再关流；幂等，一行都没写过时是 no-op（不留空文件） */
  close(): Promise<void>;
}

/**
 * 造这一次进程的日志实例（调用方只有根）。
 *
 * 写盘失败不兜底：日志是旁路能力，磁盘满或权限不足时丢掉那一行，比拖垮一条命令好。
 */
export function createCliLog(options: CliLogOptions): CliLog {
  if (!options.persist) {
    const write =
      (level: LogLevel) =>
      (message: string, detail?: unknown): void =>
        options.writeErr(
          formatLine(new Date().toISOString(), level, CLI_LOG_SOURCE, message, detail),
        );
    return {
      logger: { info: write("info"), warn: write("warn"), error: write("error") },
      filePath: null,
      // 不落盘就没有待写的行：关它是 no-op（`CliApp.closeLog()` 因此不必知道是哪一档）
      close: async () => {},
    };
  }

  const file = cliLogFile(options.dataRoot);
  const logger = new FileLogger({
    file,
    maxBytes: CLI_LOG_MAX_BYTES,
    maxFiles: CLI_LOG_MAX_FILES,
    source: CLI_LOG_SOURCE,
    ...(options.onRecord === undefined ? {} : { onRecord: options.onRecord }),
  });
  return { logger, filePath: file, close: () => logger.close() };
}
