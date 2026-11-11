import { describe, it, expect, afterEach, afterAll } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyCliEnv, resolveCliEnv } from "./env.js";
import { getLogger, setLogger } from "@ai-zen/agents-sdk";
import {
  createFileLogger,
  createSilentLogger,
  formatSdkLogLine,
  installSdkLogger,
  MAX_LOG_BYTES,
  sdkLogEnabled,
  sdkLogFile,
} from "./sdk-log.js";

/** 本文件创建过的临时目录，`afterAll` 统一删除（否则每跑一次测试就在 /tmp 留一堆） */
const tempDirs: string[] = [];

/** 每次测试用独立临时文件，避免互相干扰 */
function tmpLogFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiz-sdk-log-test-"));
  tempDirs.push(dir);
  return join(dir, "sdk.log");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

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

  it("默认接管后日志器为文件实现：日志进文件而不是回到 console", () => {
    const file = tmpLogFile();
    const installed = installSdkLogger({ enabled: true, file });
    expect(getLogger()).toBe(installed);
    expect(installed).not.toBe(createSilentLogger()); // 每次返回新对象，避免共享状态
    expect(() => getLogger().info("[load_mcp] manifest 不该打到界面上")).not.toThrow();
    // 核心断言：接管后这条日志必须落在文件里（修复前它会绕过 setLogger 直接 console.log）
    expect(readFileSync(file, "utf8")).toContain("[load_mcp] manifest 不该打到界面上");
  });

  it("默认落盘到 <AI_ZEN_DIR>/logs/sdk.log", () => {
    // 走真实接线：改 `AI_ZEN_DIR` → 重新钉根（`applyCliEnv`）→ 不传参的 `sdkLogFile()`
    const dir = tmpLogFile(); // 只借用它建临时目录的能力
    const root = dirname(dir);
    const saved = process.env.AI_ZEN_DIR;
    try {
      process.env.AI_ZEN_DIR = root;
      applyCliEnv(resolveCliEnv({ env: process.env }));
      expect(sdkLogFile()).toBe(join(root, "logs", "sdk.log"));
    } finally {
      if (saved === undefined) delete process.env.AI_ZEN_DIR;
      else process.env.AI_ZEN_DIR = saved;
      applyCliEnv(resolveCliEnv({ env: process.env }));
    }
  });

  /**
   * `AIZ_DEBUG_SDK=0` 是用户真正会用的关掉方式，走的是 `sdkLogEnabled()` 的 env 分支
   * （`installSdkLogger({ enabled })` 传参那条路是另一回事）。它现在是函数、按调用时读 env，
   * 所以两个状态都能直接验。
   */
  it("AIZ_DEBUG_SDK=0 时默认不落盘，改回后恢复（按调用时读 env）", () => {
    const saved = process.env.AIZ_DEBUG_SDK;
    try {
      process.env.AIZ_DEBUG_SDK = "0";
      expect(sdkLogEnabled()).toBe(false);
      process.env.AIZ_DEBUG_SDK = "1";
      expect(sdkLogEnabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.AIZ_DEBUG_SDK;
      else process.env.AIZ_DEBUG_SDK = saved;
    }
  });

  it("超过单文件上限时轮转为 .1，文件不会无限膨胀", () => {
    const file = tmpLogFile();
    writeFileSync(file, "x".repeat(MAX_LOG_BYTES));
    createFileLogger(file).info("after-rotate");

    // 旧内容被挪到 .1，当前文件只剩轮转后的新内容
    expect(existsSync(`${file}.1`)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("after-rotate");
    expect(content.length).toBeLessThan(1000);
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
