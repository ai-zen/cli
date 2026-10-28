// SDK 日志 → 通知栏的通用通道（`sdk-log.ts` 的 tee）
//
// 这里测的是「机制」而不是某个功能：SDK 任何模块只要 `getLogger().warn/error`，
// 就应该出现在通知栏，不需要为此新加回调。另含封顶 / 去重 / 启动期缓冲三件护栏。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

/**
 * 每个用例取一份**全新**的模块状态。
 *
 * `sdk-log.ts` 里的 sink / 缓冲 / 计数是模块级单例（本来就该如此：它们描述的是
 * 「进程内的一个界面」），所以用例之间必须靠 `resetModules()` 隔离，而不是给它
 * 加一个只为测试存在的 reset 接口。
 */
async function freshLib() {
  vi.resetModules();
  const sdkLog = await import("./sdk-log.js");
  // 必须在 sdk-log 之后取：这样才能拿到它 setLogger() 写进去的那个「同一个」模块实例
  const { getLogger } = await import("@ai-zen/agents-sdk");
  return { sdkLog, getLogger };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aizen-sdklog-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SDK 日志 → 通知栏", () => {
  it("warn / error 上栏；info 只进文件（不刷屏）", async () => {
    const { sdkLog, getLogger } = await freshLib();
    sdkLog.installSdkLogger({ enabled: true, file: join(dir, "sdk.log") });
    const seen: Array<[string, string]> = [];
    sdkLog.setSdkNoticeSink((level, message) => seen.push([level, message]));

    const log = getLogger();
    log.info("工具发现完成");
    log.warn("这个文件不是工具模块");
    log.error("连接失败");

    expect(seen).toEqual([
      ["warn", "这个文件不是工具模块"],
      ["error", "连接失败"],
    ]);
  });

  it("界面起来之前先入缓冲，注册 sink 时补推（启动期的问题不该丢）", async () => {
    const { sdkLog, getLogger } = await freshLib();
    sdkLog.installSdkLogger({ enabled: true, file: join(dir, "sdk.log") });

    getLogger().error("启动期就出的错");

    const seen: Array<[string, string]> = [];
    sdkLog.setSdkNoticeSink((level, message) => seen.push([level, message]));

    expect(seen).toEqual([["error", "启动期就出的错"]]);
  });

  it("同一句话反复刷只上栏一次", async () => {
    const { sdkLog, getLogger } = await freshLib();
    sdkLog.installSdkLogger({ enabled: true, file: join(dir, "sdk.log") });
    const seen: string[] = [];
    sdkLog.setSdkNoticeSink((_level, message) => seen.push(message));

    for (let i = 0; i < 5; i++) getLogger().warn("每轮都失败的同一句话");

    expect(seen).toEqual(["每轮都失败的同一句话"]);
  });

  it("超过封顶后补一句「剩下的看文件」，不再继续刷", async () => {
    const { sdkLog, getLogger } = await freshLib();
    sdkLog.installSdkLogger({ enabled: true, file: join(dir, "sdk.log") });
    const seen: string[] = [];
    sdkLog.setSdkNoticeSink((_level, message) => seen.push(message));

    const total = sdkLog.MAX_SDK_NOTICES + 10;
    for (let i = 0; i < total; i++) getLogger().warn(`第 ${i} 条`);

    // 封顶的那些 + 一条收尾提示
    expect(seen).toHaveLength(sdkLog.MAX_SDK_NOTICES + 1);
    expect(seen.at(-1)).toContain("More SDK warnings suppressed");
  });

  it("注销 sink 后日志只进文件，不报错", async () => {
    const { sdkLog, getLogger } = await freshLib();
    sdkLog.installSdkLogger({ enabled: true, file: join(dir, "sdk.log") });
    const seen: string[] = [];
    sdkLog.setSdkNoticeSink((_level, message) => seen.push(message));
    sdkLog.setSdkNoticeSink(null);

    expect(() => getLogger().error("卸载之后")).not.toThrow();
    expect(seen).toEqual([]);
  });

  it("AIZ_DEBUG_SDK 关闭（静默日志器）时不上栏", async () => {
    const { sdkLog, getLogger } = await freshLib();
    sdkLog.installSdkLogger({ enabled: false, file: join(dir, "sdk.log") });
    const seen: string[] = [];
    sdkLog.setSdkNoticeSink((_level, message) => seen.push(message));

    getLogger().error("静默模式");

    expect(seen).toEqual([]);
  });
});
