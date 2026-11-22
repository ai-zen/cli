/**
 * 用例用的两个**日志替身**（注入面的那一格）。
 *
 * 日志实例平常由根（`CliApp`）造、由入口递下去；用例没有根，于是把那一格换成一个只记东西的
 * 实现 —— 这正是这一单把日志从全局口子改成参数的收益：**「报了一句什么」可以直接接住**，
 * 不必去碰 `console` / 模块级单例，也不会因为 `isolate: false`（进程内共享模块图）串到别的
 * 文件。
 */

import type { LogSink } from "@ai-zen/agents-logger";

/** 记账用的日志器：报出去的每一句都按顺序留在 {@link RecordingLog.messages} 里 */
export interface RecordingLog extends LogSink {
  /** 已经报出去的每一句（`info` 不进：要看的都是「有事」那两档） */
  readonly messages: string[];
}

/**
 * 造一个记账用的日志器。
 *
 * 断言侧拿 `log.messages` 看「报了什么」，与从前用 `setLogger` 抓 `warn` 是同一套判据 ——
 * 变的只是它从参数上来，不再从全局口子上来。
 */
export function recordingLog(): RecordingLog {
  const messages: string[] = [];
  return {
    messages,
    info: () => {},
    warn: (message) => void messages.push(message),
    error: (message) => void messages.push(message),
  };
}

/** 不关心日志的用例用它把必填的那一格填上（真的丢掉，不假装记了） */
export const QUIET_LOG: LogSink = { info: () => {}, warn: () => {}, error: () => {} };
