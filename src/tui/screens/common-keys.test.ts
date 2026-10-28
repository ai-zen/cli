// 公用键位的单元测试 —— 纯函数，直接断言「哪个键触发哪个滚动 / 是否被消费」
//
// 这层之所以值得单独测：对话屏的空闲态与忙碌态是两个 `useInput`，两边共用同一份
// 判定。任何一边想「顺手加点特例」，都会在这里被拦住或被明确记录。
import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { CTRL_D_WINDOW, handleCtrlDExit, handleScrollKey } from "./common-keys.js";

/** 构造一个「什么都没按」的按键对象 */
const noKey = (overrides: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  ...overrides,
});

/** 记录滚动调用的假上下文 */
const scrollCtx = () => {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      scrollByWheel: (dir: -1 | 1) => calls.push(`wheel:${dir}`),
      scrollByPage: (dir: -1 | 1) => calls.push(`page:${dir}`),
      scrollByLine: (dir: -1 | 1) => calls.push(`line:${dir}`),
    },
  };
};

describe("handleScrollKey", () => {
  it("普通字符不消费（留给输入框）", () => {
    const { calls, ctx } = scrollCtx();
    expect(handleScrollKey("a", noKey(), ctx)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("滚轮上 / 下各滚一格", () => {
    const { calls, ctx } = scrollCtx();
    expect(handleScrollKey("[<64;10;5M", noKey(), ctx)).toBe(true);
    expect(handleScrollKey("[<65;10;5M", noKey(), ctx)).toBe(true);
    expect(calls).toEqual(["wheel:-1", "wheel:1"]);
  });

  it("终端应答与点击 / 拖拽被丢弃，且不产生滚动", () => {
    const { calls, ctx } = scrollCtx();
    expect(handleScrollKey("[<0;10;5M", noKey(), ctx)).toBe(true); // 左键按下
    expect(handleScrollKey("[12;40R", noKey(), ctx)).toBe(true); // 光标位置报告
    expect(handleScrollKey("[?1u", noKey(), ctx)).toBe(true); // kitty 键盘协议应答
    expect(calls).toEqual([]);
  });

  it("PgUp / PgDn 翻页", () => {
    const { calls, ctx } = scrollCtx();
    expect(handleScrollKey("", noKey({ pageUp: true }), ctx)).toBe(true);
    expect(handleScrollKey("", noKey({ pageDown: true }), ctx)).toBe(true);
    expect(calls).toEqual(["page:-1", "page:1"]);
  });

  it("Alt+V 兜底翻页；Ctrl+V 不被消费（预留给图片粘贴）", () => {
    const { calls, ctx } = scrollCtx();
    expect(handleScrollKey("v", noKey({ meta: true }), ctx)).toBe(true);
    expect(handleScrollKey("v", noKey({ ctrl: true }), ctx)).toBe(false);
    expect(calls).toEqual(["page:-1"]);
  });

  it("⌘[ / ⌘] 翻页、⌘; / ⌘' 按行滚动", () => {
    const { calls, ctx } = scrollCtx();
    expect(handleScrollKey("[", noKey({ super: true }), ctx)).toBe(true);
    expect(handleScrollKey("]", noKey({ super: true }), ctx)).toBe(true);
    expect(handleScrollKey(";", noKey({ super: true }), ctx)).toBe(true);
    expect(handleScrollKey("'", noKey({ super: true }), ctx)).toBe(true);
    expect(calls).toEqual(["page:-1", "page:1", "line:-1", "line:1"]);
  });
});

describe("handleCtrlDExit", () => {
  const make = () => {
    const log: string[] = [];
    return {
      log,
      ctx: {
        lastAt: { current: 0 },
        notify: () => log.push("notify"),
        exit: () => log.push("exit"),
      },
    };
  };

  it("非 Ctrl+D 不消费", () => {
    const { log, ctx } = make();
    expect(handleCtrlDExit("d", noKey(), ctx, 1000)).toBe(false);
    expect(log).toEqual([]);
  });

  it("第一次按下只提示，不退出", () => {
    const { log, ctx } = make();
    expect(handleCtrlDExit("d", noKey({ ctrl: true }), ctx, 1000)).toBe(true);
    expect(log).toEqual(["notify"]);
    expect(ctx.lastAt.current).toBe(1000);
  });

  it("时间窗内第二次按下退出", () => {
    const { log, ctx } = make();
    handleCtrlDExit("d", noKey({ ctrl: true }), ctx, 1000);
    handleCtrlDExit("d", noKey({ ctrl: true }), ctx, 1000 + CTRL_D_WINDOW - 1);
    expect(log).toEqual(["notify", "exit"]);
  });

  it("超过时间窗则重新计时（只提示，不退出）", () => {
    const { log, ctx } = make();
    handleCtrlDExit("d", noKey({ ctrl: true }), ctx, 1000);
    handleCtrlDExit("d", noKey({ ctrl: true }), ctx, 1000 + CTRL_D_WINDOW);
    expect(log).toEqual(["notify", "notify"]);
  });
});
