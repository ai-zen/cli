/**
 * `log-notices.ts` —— 日志 → 本地通知的那一格：`info` 不上栏、同一句去重、每屏封顶、
 * 界面未起时攒几条。
 *
 * 这些护栏出自日志量：同一句会被反复刷，所以约束是「不冲垮通知栏」，而不是
 * 「哪一条更重要」。它们与日志写流分居两处：写流只负责把行落到盘上，这一格只负责「该不该上栏」。
 */

import { describe, expect, it } from "vitest";
import type { LogRecord } from "@ai-zen/agents-logger";
import { LogNotices, MAX_LOG_NOTICES, MAX_PENDING_NOTICES } from "./log-notices.js";

/** 造一条记录（`source` / `at` 这里不参与判据） */
function record(level: LogRecord["level"], message: string): LogRecord {
  return { level, source: "cli", message, at: "2026-01-01T00:00:00.000Z" };
}

/** 记录器：注册一个把每条都记下来的 sink，返回那个数组 */
function collect(relay: LogNotices): Array<[string, string]> {
  const seen: Array<[string, string]> = [];
  relay.setSink((level, message) => seen.push([level, message]));
  return seen;
}

const LOG_FILE = "/tmp/aiz/logs/cli/cli.log";

describe("LogNotices：日志 → 本地通知", () => {
  it("warn / error 上栏，info 只进文件（不刷屏）", () => {
    const relay = new LogNotices({ logFile: LOG_FILE });
    const seen = collect(relay);

    relay.record(record("info", "工具发现完成"));
    relay.record(record("warn", "这个文件不是工具模块"));
    relay.record(record("error", "连接失败"));

    expect(seen).toEqual([
      ["warn", "这个文件不是工具模块"],
      ["error", "连接失败"],
    ]);
  });

  it("界面还没起来时先攒，注册 sink 时补推（启动期的问题不该丢）", () => {
    const relay = new LogNotices({ logFile: LOG_FILE });
    relay.record(record("error", "启动期就出的错"));

    const seen = collect(relay);

    expect(seen).toEqual([["error", "启动期就出的错"]]);
  });

  it(`攒的条数封顶 ${MAX_PENDING_NOTICES} 条（只留最近那几条）`, () => {
    const relay = new LogNotices({ logFile: LOG_FILE });
    for (let i = 0; i < MAX_PENDING_NOTICES + 3; i += 1) relay.record(record("warn", `第 ${i} 条`));

    const seen = collect(relay);

    expect(seen).toHaveLength(MAX_PENDING_NOTICES);
    expect(seen.at(-1)).toEqual(["warn", `第 ${MAX_PENDING_NOTICES + 2} 条`]);
  });

  it("同一句话反复刷只上栏一次", () => {
    const relay = new LogNotices({ logFile: LOG_FILE });
    const seen = collect(relay);

    for (let i = 0; i < 5; i += 1) relay.record(record("warn", "每次请求都失败的同一句话"));

    expect(seen).toEqual([["warn", "每次请求都失败的同一句话"]]);
  });

  it(`每屏封顶 ${MAX_LOG_NOTICES} 条，到顶补一句「剩下的看文件」（只说一次）`, () => {
    const relay = new LogNotices({ logFile: LOG_FILE });
    const seen = collect(relay);

    for (let i = 0; i < MAX_LOG_NOTICES + 10; i += 1) relay.record(record("warn", `第 ${i} 条`));

    // 封顶的那些 + 一条收尾提示
    expect(seen).toHaveLength(MAX_LOG_NOTICES + 1);
    expect(seen.at(-1)![0]).toBe("warn");
    expect(seen.at(-1)![1]).toContain("More log notices suppressed");
    // 那条提示要说出日志在哪个文件
    expect(seen.at(-1)![1]).toContain(LOG_FILE);
  });

  it("注销 sink 之后只攒不投（重挂载期间不抛）", () => {
    const relay = new LogNotices({ logFile: LOG_FILE });
    const seen = collect(relay);
    relay.setSink(null);

    expect(() => relay.record(record("error", "卸载之后"))).not.toThrow();
    expect(seen).toEqual([]);
  });

  it("空消息不上栏（调用方常把空串直接透传进来）", () => {
    const relay = new LogNotices({ logFile: LOG_FILE });
    const seen = collect(relay);

    relay.record(record("warn", ""));

    expect(seen).toEqual([]);
  });
});
