import { existsSync, statSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  formatKeyEvent,
  terminalSummary,
  keyDebug,
  KEY_DEBUG_ENABLED,
  KEY_DEBUG_FILE,
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
    const size = () => (existsSync(KEY_DEBUG_FILE) ? statSync(KEY_DEBUG_FILE).size : 0);
    const before = size();
    keyDebug("a", {});
    const after = size();
    if (KEY_DEBUG_ENABLED) expect(after).toBeGreaterThan(before);
    else expect(after).toBe(before);
  });
});
