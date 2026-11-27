/**
 * 日志转本地通知的那一条接线：同一句去重、每屏封顶、界面未起时攒几条。
 *
 * 这几道保护不放在日志里，因为日志是热路径（一次请求几十行），而且它不认识通知 —— 谁想知道刚写出去了一
 * 条什么，订阅 `onRecord` 自己处理（接线在根那边，`app.ts`）。哪些该上通知栏、上几条、同一句要不要去
 * 重，因此全在这一格，日志的写流一行都不掺和。
 *
 * 三道保护都是被日志量逼出来的：同一句只上栏一次（日志会把同一句反复刷，每失败一次刷一次，不去重通知栏
 * 立刻被冲垮）；每屏封顶 {@link MAX_LOG_NOTICES} 条，到顶时补一句「剩下的看文件」，栏位有界、信息也不
 * 丢；界面还没起来时先攒 {@link MAX_PENDING_NOTICES} 条，sink 注册时补推 —— 启动期的问题恰恰最该看见，
 * 而晚绑定是必须的，因为日志在 Ink 渲染之前就在写，通知栏却活在会话屏的 state 里。
 *
 * 与通知的关系只有一条过滤：`warn` / `error` 上栏，`info` 只进文件。转过去的通知带 `origin: "log"`，
 * 于是它跟着「发送那一刻清掉」那条规矩走，不会像业务提示（`origin: "app"`）那样一直挂着。
 *
 * 管道模式不注册 sink（没有屏），攒到上限就停 —— 那一档的日志本来就只在 stderr 上。
 */

import type { LogRecord } from "@ai-zen/agents-logger";

export type LogNoticeLevel = "warn" | "error";

export type LogNoticeSink = (level: LogNoticeLevel, message: string) => void;

export const MAX_LOG_NOTICES = 20;

export const MAX_PENDING_NOTICES = 5;

export interface LogNoticesOptions {
  logFile: string | null;
}

export class LogNotices {
  private readonly logFile: string | null;
  private sink: LogNoticeSink | null = null;
  private delivered = 0;
  private capReported = false;
  private readonly seen = new Set<string>();
  private readonly pending: Array<{ level: LogNoticeLevel; message: string }> = [];

  constructor(options: LogNoticesOptions) {
    this.logFile = options.logFile;
  }

  record(record: LogRecord): void {
    if (record.level === "info") return;
    this.deliver(record.level, record.message);
  }

  setSink(sink: LogNoticeSink | null): void {
    this.sink = sink;
    if (sink === null) return;
    for (const item of this.pending.splice(0)) this.deliver(item.level, item.message);
  }

  private deliver(level: LogNoticeLevel, message: string): void {
    if (!message) return;
    if (this.sink === null) {
      this.pending.push({ level, message });
      if (this.pending.length > MAX_PENDING_NOTICES) this.pending.shift();
      return;
    }
    if (this.seen.has(message)) return;
    if (this.delivered >= MAX_LOG_NOTICES) {
      if (!this.capReported) {
        this.capReported = true;
        this.sink("warn", `More log notices suppressed — see ${this.logFile ?? "the CLI log"}`);
      }
      return;
    }
    this.seen.add(message);
    this.delivered += 1;
    this.sink(level, message);
  }
}
