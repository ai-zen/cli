import { describe, it, expect } from "vitest";
import { decideMode, resolveInvocation, type TtyState } from "./mode.js";

const TTY: TtyState = { stdinIsTTY: true, stdoutIsTTY: true };
const PIPE_IN: TtyState = { stdinIsTTY: false, stdoutIsTTY: true };
const PIPE_OUT: TtyState = { stdinIsTTY: true, stdoutIsTTY: false };

describe("decideMode", () => {
  it("有位置参数 → stdio（即使全 TTY，绝不进 TUI）", () => {
    expect(decideMode(TTY, true)).toBe("stdio");
  });

  it("无参数 + 全 TTY → tui", () => {
    expect(decideMode(TTY, false)).toBe("tui");
  });

  it("无参数 + stdin 非 TTY → stdio", () => {
    expect(decideMode(PIPE_IN, false)).toBe("stdio");
  });

  it("无参数 + stdout 非 TTY → stdio", () => {
    expect(decideMode(PIPE_OUT, false)).toBe("stdio");
  });
});

describe("resolveInvocation", () => {
  it("无参数 + 全 TTY → tui", () => {
    expect(resolveInvocation([], TTY)).toEqual({ kind: "tui" });
  });

  it("位置参数拼接为指令 → stdio", () => {
    expect(resolveInvocation(["总结", "要点"], TTY)).toEqual({
      kind: "stdio",
      instruction: "总结 要点",
      save: false,
    });
  });

  it("无参数 + 管道 → stdio（指令为空，内容来自 stdin）", () => {
    expect(resolveInvocation([], PIPE_IN)).toEqual({
      kind: "stdio",
      instruction: "",
      save: false,
    });
  });

  it("--save 透传到 stdio", () => {
    expect(resolveInvocation(["--save", "你好"], TTY)).toEqual({
      kind: "stdio",
      instruction: "你好",
      save: true,
    });
  });

  it("hook 子命令短路", () => {
    expect(resolveInvocation(["hook", "install"], TTY)).toEqual({
      kind: "hook",
      action: "install",
    });
    expect(resolveInvocation(["hook", "uninstall"], PIPE_IN)).toEqual({
      kind: "hook",
      action: "uninstall",
    });
  });

  it("hook 缺参数/非法参数 → usage", () => {
    expect(resolveInvocation(["hook"], TTY)).toEqual({ kind: "hook", action: "usage" });
    expect(resolveInvocation(["hook", "boom"], TTY)).toEqual({
      kind: "hook",
      action: "usage",
    });
  });

  it("--help / --version 短路", () => {
    expect(resolveInvocation(["--help"], TTY)).toEqual({ kind: "help" });
    expect(resolveInvocation(["-h"], TTY)).toEqual({ kind: "help" });
    expect(resolveInvocation(["--version"], PIPE_IN)).toEqual({ kind: "version" });
    expect(resolveInvocation(["-v"], PIPE_IN)).toEqual({ kind: "version" });
  });

  it("`--` 之后的内容视为位置参数", () => {
    expect(resolveInvocation(["--", "--save"], TTY)).toEqual({
      kind: "stdio",
      instruction: "--save",
      save: false,
    });
  });

  it("未知的短横线选项按位置参数处理（不误伤以 - 开头的提问）", () => {
    expect(resolveInvocation(["-3", "+", "5", "等于几"], TTY)).toEqual({
      kind: "stdio",
      instruction: "-3 + 5 等于几",
      save: false,
    });
  });

  it("首个位置参数不是 hook 时，不会误判为子命令", () => {
    expect(resolveInvocation(["hook 是什么"], TTY)).toEqual({
      kind: "stdio",
      instruction: "hook 是什么",
      save: false,
    });
  });
});
