/**
 * 日志 → 本地通知的那一条接线：**同一句去重、每屏封顶、界面未起时攒几条**。
 *
 * ## 为什么这几道保护不在日志里
 *
 * 日志是热路径（一次请求几十行），而且它**不认识通知** —— 谁想知道刚写出去了一条什么，订阅
 * `onRecord` 自己处理（接线在根那边，`app.ts`）。「哪些该上通知栏、上几条、同一句要不要去重」
 * 因此全在这一格，日志的写流一行都不掺和。
 *
 * ## 三道保护（都是被日志量逼出来的）
 *
 * 1. **同一句只上栏一次**：日志会把同一句反复刷（每失败一次刷一次），不去重通知栏立刻被冲垮；
 * 2. **每屏封顶 {@link MAX_LOG_NOTICES} 条**，到顶时补一句「剩下的看文件」—— 栏位有界，
 *    信息也不丢；
 * 3. **界面还没起来时先攒 {@link MAX_PENDING_NOTICES} 条**（启动期的问题恰恰最该看见），
 *    sink 注册时补推。晚绑定是必须的：日志在 Ink 渲染之前就在写了，而通知栏活在会话屏的
 *    state 里。
 *
 * ## 与通知的关系只有一条
 *
 * `warn` / `error` 上栏、`info` 只进文件 —— 就是这一条过滤。转过去的通知**带 `origin: "log"`**
 * （打在注册 sink 的那一端，`tui/screens/chat.tsx`），于是它跟着「发送那一刻清掉」那一条规矩走，
 * 不会像业务提示（`origin: "app"`）那样一直挂着。
 *
 * 管道模式不注册 sink（没有屏），攒到上限就停 —— 那一档的日志本来就只在 stderr 上。
 */

import type { LogRecord } from "@ai-zen/agents-logger";

/** 一条该上栏的日志（`info` 到不了这里） */
export type LogNoticeLevel = "warn" | "error";

/** 通知栏的入口（界面注册它；`null` = 界面还没起来 / 已卸载） */
export type LogNoticeSink = (level: LogNoticeLevel, message: string) => void;

/** 每屏封顶：日志量按「每次请求 / 每次刷新」计，不封顶会把栏位和 React 状态一起冲垮 */
export const MAX_LOG_NOTICES = 20;

/** 界面起来之前最多攒几条（启动期的问题最该看见，但不能无限攒） */
export const MAX_PENDING_NOTICES = 5;

export interface LogNoticesOptions {
  /** `cli.log` 的完整路径（封顶那句要指路）；管道模式没有文件 → `null` */
  logFile: string | null;
}

export class LogNotices {
  private readonly logFile: string | null;
  private sink: LogNoticeSink | null = null;
  /** 已经上过栏几条（封顶用） */
  private delivered = 0;
  /** 封顶那句只说一次（否则它自己就成了新的刷屏源） */
  private capReported = false;
  /** 上过栏的文案：同一句话反复刷只显示第一次 */
  private readonly seen = new Set<string>();
  /** 界面还没起来时攒下的那几条，注册 sink 时补推 */
  private readonly pending: Array<{ level: LogNoticeLevel; message: string }> = [];

  constructor(options: LogNoticesOptions) {
    this.logFile = options.logFile;
  }

  /** `onRecord` 的订阅端：`info` 不上栏（只进文件），`warn` / `error` 转通知 */
  record(record: LogRecord): void {
    if (record.level === "info") return;
    this.deliver(record.level, record.message);
  }

  /** 注册 / 注销通知栏；注册时把攒下的那几条补推出去（按到达顺序） */
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
