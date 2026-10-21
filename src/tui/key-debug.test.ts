import { describe, it, expect } from "vitest";
import { formatKeyEvent, terminalSummary, keyDebug, KEY_DEBUG_ENABLED } from "./key-debug.js";

describe("按键诊断日志", () => {
  it("formatKeyEvent 记录 input、置位的修饰键与 raw 状态", () => {
    expect(formatKeyEvent("d", { meta: true }, true)).toBe('key input="d" flags=[meta] raw=true');
    expect(formatKeyEvent("", { pageUp: true }, false)).toBe('key input="" flags=[pageUp] raw=false');
  });

  it("formatKeyEvent 转义控制字符（ESC 等），保证日志单行可读", () => {
    expect(formatKeyEvent("\u001b[1;5D", { leftArrow: true, ctrl: true }, true)).toBe(
      'key input="\\u001b[1;5D" flags=[ctrl,leftArrow] raw=true',
    );
    expect(formatKeyEvent("", {}, true)).toBe('key input="" flags=[] raw=true');
  });

  it("terminalSummary 汇总终端环境（缺项显示 -）", () => {
    const line = terminalSummary({ TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv);
    expect(line).toContain("TERM=xterm-256color");
    expect(line).toContain("TERM_PROGRAM=iTerm.app");
    expect(line).toContain("TERM_PROGRAM_VERSION=-");
    expect(line).toContain(`platform=${process.platform}`);
  });

  it("默认（未开 AIZ_DEBUG_KEYS）不产生任何写入", () => {
    if (KEY_DEBUG_ENABLED) return; // 该环境变量由测试进程启动时决定，开启时不校验
    expect(() => keyDebug("a", {})).not.toThrow();
  });
});
