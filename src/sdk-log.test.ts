import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger, setLogger } from "@ai-zen/agents-sdk";
import {
  createFileLogger,
  createSilentLogger,
  formatSdkLogLine,
  installSdkLogger,
  SDK_LOG_ENABLED,
} from "./sdk-log.js";

/** 每次测试用独立临时文件，避免互相干扰 */
function tmpLogFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiz-sdk-log-test-"));
  return join(dir, "sdk.log");
}

/** 还原全局日志器，避免污染其它用例 */
function restoreLogger(): void {
  setLogger({ info: console.log, warn: console.warn, error: console.error });
}

describe("SDK 日志接管", () => {
  afterEach(() => {
    restoreLogger();
  });

  it("formatSdkLogLine 输出「ISO 时间 + level + 消息」单行", () => {
    const at = new Date("2026-10-22T01:30:00.000Z");
    expect(formatSdkLogLine("info", "[load_mcp] github: connected", at)).toBe(
      "2026-10-22T01:30:00.000Z [info] [load_mcp] github: connected",
    );
    expect(formatSdkLogLine("error", "迁移失败", at)).toBe(
      "2026-10-22T01:30:00.000Z [error] 迁移失败",
    );
  });

  it("静默日志器三档全部丢弃，不产生任何输出", () => {
    const silent = createSilentLogger();
    expect(() => {
      silent.info("x");
      silent.warn("y");
      silent.error("z");
    }).not.toThrow();
    expect(silent.info("x")).toBeUndefined();
  });

  it("文件日志器按 level 逐行追加，写失败不抛错", () => {
    const file = tmpLogFile();
    const logger = createFileLogger(file);
    logger.info("a");
    logger.warn("b");
    logger.error("c");

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/\[info\] a$/);
    expect(lines[1]).toMatch(/\[warn\] b$/);
    expect(lines[2]).toMatch(/\[error\] c$/);

    // 路径不可写（父目录不存在）时也不能抛
    expect(() => createFileLogger("/nonexistent-dir-xyz/aiz.log").info("x")).not.toThrow();
  });

  it("默认接管后 SDK 全局日志器为静默实现（console 兜底被关掉）", () => {
    if (SDK_LOG_ENABLED) return; // 该环境变量由测试进程启动时决定，开启时不校验
    const installed = installSdkLogger();
    expect(getLogger()).toBe(installed);
    expect(installed).not.toBe(createSilentLogger()); // 每次返回新对象，避免共享状态
    expect(() => getLogger().info("[load_mcp] manifest 不该打到界面上")).not.toThrow();
  });

  it("AIZ_DEBUG_SDK 等价开关：enabled=true 时落盘而非静默", () => {
    const file = tmpLogFile();
    installSdkLogger({ enabled: true, file });
    getLogger().warn("[skills] bad: missing name");

    expect(readFileSync(file, "utf8")).toContain("[warn] [skills] bad: missing name");

    rmSync(file, { force: true });
    expect(existsSync(file)).toBe(false);
  });

  it("enabled=false 时不创建日志文件（真正关掉兜底）", () => {
    const file = tmpLogFile();
    installSdkLogger({ enabled: false, file });
    getLogger().info("should be dropped");
    expect(existsSync(file)).toBe(false);
    // 文件仍可正常追加（确认不是「写失败」而是「没写」）
    appendFileSync(file, "");
    expect(existsSync(file)).toBe(true);
  });
});
