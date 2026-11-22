// 公用键位的单元测试 —— 纯函数，直接断言「哪个键触发哪个滚动 / 是否被消费」
//
// 这层之所以值得单独测：会话屏的空闲态与忙碌态是两个 `useInput`，两边共用同一份
// 判定。任何一边想「顺手加点特例」，都会在这里被拦住或被明确记录。
import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import {
  CTRL_D_WINDOW,
  handleClearAllNoticesKey,
  handleClearNoticesKey,
  handleCtrlDExit,
  handleOpenImageKey,
  handleScrollKey,
} from "./common-keys.js";

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

describe("handleOpenImageKey（打开图片的键）", () => {
  const counter = () => {
    const state = { opened: 0 };
    return { state, deps: { open: () => void (state.opened += 1) } };
  };

  it("Ctrl+O 开那一问，并消费该键", () => {
    const { state, deps } = counter();
    expect(handleOpenImageKey("o", noKey({ ctrl: true }), deps)).toBe(true);
    expect(state.opened).toBe(1);
  });

  it("光秃的 `o` 与 Alt+O 都不算：一个是打字，另一个不归它", () => {
    const { state, deps } = counter();
    expect(handleOpenImageKey("o", noKey(), deps)).toBe(false);
    expect(handleOpenImageKey("o", noKey({ meta: true }), deps)).toBe(false);
    expect(state.opened).toBe(0);
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

describe("handleClearAllNoticesKey（通知栏的清全部键）", () => {
  const counter = () => {
    const state = { asked: 0 };
    return { state, deps: { ask: () => void (state.asked += 1) } };
  };

  it("Alt+Shift+X 只开那一问（它自己不清任何东西），并消费该键", () => {
    const { state, deps } = counter();
    expect(handleClearAllNoticesKey("X", noKey({ meta: true, shift: true }), deps)).toBe(true);
    expect(state.asked).toBe(1);
  });

  it("与 Alt+X（清本会话）分得开：小写不归它", () => {
    const { state, deps } = counter();
    expect(handleClearAllNoticesKey("x", noKey({ meta: true }), deps)).toBe(false);
    expect(state.asked).toBe(0);
  });

  it("光秃的 `X` 与 Ctrl+X 都不算：那是往输入框里打字", () => {
    const { state, deps } = counter();
    expect(handleClearAllNoticesKey("X", noKey({ shift: true }), deps)).toBe(false);
    expect(handleClearAllNoticesKey("x", noKey({ ctrl: true }), deps)).toBe(false);
    expect(state.asked).toBe(0);
  });
});

describe("handleClearNoticesKey（通知栏的清本会话键）", () => {
  const counter = () => {
    const state = { cleared: 0 };
    return { state, deps: { clear: () => void (state.cleared += 1) } };
  };

  it("Alt+X 触发一次清空，并消费该键", () => {
    const { state, deps } = counter();
    expect(handleClearNoticesKey("x", noKey({ meta: true }), deps)).toBe(true);
    expect(state.cleared).toBe(1);
  });

  it("只有光秃秃的 `x`（或 Ctrl+X）不算：那是往输入框里打字", () => {
    const { state, deps } = counter();
    expect(handleClearNoticesKey("x", noKey(), deps)).toBe(false);
    expect(handleClearNoticesKey("x", noKey({ ctrl: true }), deps)).toBe(false);
    expect(handleClearNoticesKey("X", noKey({ meta: true, shift: true }), deps)).toBe(false);
    expect(state.cleared).toBe(0);
  });

  it("别的 Alt 键不误触发（Alt+B / Alt+D 等各有各的语义）", () => {
    const { state, deps } = counter();
    expect(handleClearNoticesKey("b", noKey({ meta: true, ctrl: false }), deps)).toBe(false);
    expect(state.cleared).toBe(0);
  });
});
