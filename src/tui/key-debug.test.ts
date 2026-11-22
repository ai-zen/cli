import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { applyCliEnv } from "../env.js";
import { useTempAiZenDir } from "../test-support/temp-dir.js";
import {
  formatKeyEvent,
  terminalSummary,
  keyDebug,
  keyDebugFile,
  KEY_DEBUG_ENABLED,
} from "./key-debug.js";

describe("按键诊断日志", () => {
  it("formatKeyEvent 记录 input、置位的修饰键与 raw 状态", () => {
    expect(formatKeyEvent("d", { meta: true }, true)).toBe('key input="d" flags=[meta] raw=true');
    expect(formatKeyEvent("", { pageUp: true }, false)).toBe(
      'key input="" flags=[pageUp] raw=false',
    );
  });

  it("formatKeyEvent 转义控制字符（ESC 等），保证日志单行可读", () => {
    expect(formatKeyEvent("\u001b[1;5D", { leftArrow: true, ctrl: true }, true)).toBe(
      'key input="\\u001b[1;5D" flags=[ctrl,leftArrow] raw=true',
    );
    expect(formatKeyEvent("", {}, true)).toBe('key input="" flags=[] raw=true');
  });

  it("terminalSummary 汇总终端环境（缺项显示 -）", () => {
    const line = terminalSummary({
      TERM: "xterm-256color",
      TERM_PROGRAM: "iTerm.app",
    } as NodeJS.ProcessEnv);
    expect(line).toContain("TERM=xterm-256color");
    expect(line).toContain("TERM_PROGRAM=iTerm.app");
    expect(line).toContain("TERM_PROGRAM_VERSION=-");
    expect(line).toContain(`platform=${process.platform}`);
  });

  /**
   * 开关是加载时固化的常量（`AIZ_DEBUG_KEYS=1` 决定），所以只能靠「文件是否长大」判定行为，
   * 不能自己切开关。两个分支都要有真断言：未开启时**一个字节都不能写**（否则每键一次同步写盘）；
   * 开启时**必须**写（否则诊断日志根本不存在，而用户正是为它开的开关）。
   */
  it("keyDebug 落盘行为与开关一致（关闭时不写、开启时追加一行）", () => {
    const file = keyDebugFile();
    const size = () => (existsSync(file) ? statSync(file).size : 0);
    const before = size();
    keyDebug("a", {});
    const after = size();
    if (KEY_DEBUG_ENABLED) expect(after).toBeGreaterThan(before);
    else expect(after).toBe(before);
  });
});

describe("落点：CLI 那一格，且用的时候才算", () => {
  const zen = useTempAiZenDir("aizen-keys-");

  beforeEach(() => {
    zen.pin();
  });
  afterAll(() => {
    delete process.env.AIZ_KEYS_FILE;
    zen.cleanup();
  });

  it("缺省落 <数据根>/logs/cli/keys.log（不再写 /tmp 顶层）", () => {
    delete process.env.AIZ_KEYS_FILE;
    expect(keyDebugFile()).toBe(join(zen.dir, "logs", "cli", "keys.log"));
  });

  it("AIZ_KEYS_FILE 仍可覆盖缺省落点", () => {
    process.env.AIZ_KEYS_FILE = join(zen.dir, "somewhere-else.log");
    try {
      expect(keyDebugFile()).toBe(join(zen.dir, "somewhere-else.log"));
    } finally {
      delete process.env.AIZ_KEYS_FILE;
    }
  });

  it("根换了路径跟着换（不是模块加载时算死的快照）", () => {
    delete process.env.AIZ_KEYS_FILE;
    const first = keyDebugFile();
    applyCliEnv({ aiZenDir: join(zen.dir, "other-root") });
    try {
      expect(keyDebugFile()).toBe(join(zen.dir, "other-root", "logs", "cli", "keys.log"));
    } finally {
      // 钉回本文件的根：换根是这条用例自己造的，不该漏给后面
      zen.pin();
    }
    expect(keyDebugFile()).toBe(first);
  });
});
