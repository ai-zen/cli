/**
 * CLI 自己的日志出口 —— 一个进程一格目录、一个实例、一个主人。
 *
 * ## 两档，只有目的地不同
 *
 * | 这一档 | 写哪儿 | 为什么 |
 * |---|---|---|
 * | 交互界面 / 其余路由 | `<dataRoot>/logs/cli/cli.log`（单份 2MB，保留 2 份） | 「一个进程一格目录」：`logs/cli/` 只归 CLI 写（PRD 布局，见 `config.ts` 的那棵树） |
 * | 管道模式（`stdio`） | `writeErr`（stderr），**不建文件** | PRD 439：stdout 只留给结果，日志与进度走 stderr、默认不落盘 |
 *
 * 两档的行格式是同一条（`formatLine`：时间 + 级别 + 来源 + 消息），所以「日志长什么样」只有
 * 一处答案，变的只是它往哪去。轮转 / 排队写盘 / 收尾 flush 都不在这里 —— 那是
 * `@ai-zen/agents-logger` 的事，本文件只给它参数。
 *
 * ## 为什么这里没有单例
 *
 * 日志实例的主人是根（{@link CliApp}）：它造、它传给各层、它在 `run()` 的 finally 里关。一个
 * 模块级的 `getLogger()` 会让「这行是谁写的、落到哪个文件」重新变成要读实现才知道的事 ——
 * 那正是 SDK 那个全局日志口被摘掉的原因（`sdk-log.ts` 已删）。要写日志的模块从参数上收一个
 * `LogSink`，于是「谁在写」在签名里看得见。
 *
 * ## 边界
 *
 * **不读环境变量**（没有 `AIZ_DEBUG_SDK` / `AIZ_SDK_LOG_FILE` 那类开关；级别开关是另一条未决
 * 的事），**不认识「通知」**：想知道刚写出去了一条什么，订阅 `onRecord` —— 根在接线处把
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

/** 保留 2 份（正在写的 + 上一份）：布局那张表里 CLI 那一行 */
export const CLI_LOG_MAX_FILES = 2;

/** 行里的来源标签：`cli.log` 里每一条都是 CLI 进程自己写的 */
export const CLI_LOG_SOURCE = "cli";

/** 这一次进程的日志落在哪个文件（`<dataRoot>/logs/cli/cli.log`） */
export function cliLogFile(dataRoot: string): string {
  return join(dataRoot, "logs", "cli", "cli.log");
}

export interface CliLogOptions {
  /** 数据根（`CliEnv.aiZenDir`）：落盘那一档写 `<dataRoot>/logs/cli/cli.log` */
  dataRoot: string;
  /** `true` = 落盘；`false` = 管道模式那一档（写 `writeErr`，不建文件） */
  persist: boolean;
  /** 管道模式的出口（根递 `writeErr`） */
  writeErr: (text: string) => void;
  /** 每写一条就回调一次（根用它把 `warn` / `error` 接给本地通知） */
  onRecord?: (record: LogRecord) => void;
}

export interface CliLog {
  /** 注入给各层的三档日志口 */
  readonly logger: LogSink;
  /** 写流落在哪个文件；`null` = 这一档不落盘 */
  readonly filePath: string | null;
  /** 收尾：排队的行写完再关流。**幂等**；一行都没写过时是 no-op（不留空文件） */
  close(): Promise<void>;
}

/**
 * 造这一次进程的日志实例（调用方只有根）。
 *
 * 写盘失败**不兜底**：日志是旁路能力，磁盘满 / 权限不足时丢掉那一行，比拖垮一条命令好。
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
