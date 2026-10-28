// 两个输入处理器共用的键位 —— 「滚轮 / 翻页 / ⌘ 习惯键 / Ctrl+D 双击退出」
//
// 对话屏有两个 `useInput`：一个是空闲态（编辑输入框），一个是忙碌态（生成 / 迁移中，
// 只放行中止与回看）。两者对**同一批键**的处理必须一致 —— 否则「生成时能滚、空闲时
// 不能滚」这类不一致迟早会出现。此前这段逻辑在两个处理器里各写一遍（约 40 行重复），
// 现在收敛到这里：纯函数，不碰 React，键盘回归可以直接断言。
import type { Key } from "ink";
import { parseWheel } from "../mouse.js";
import { isTerminalReply } from "../text.js";

/** 滚动动作的注入点（由 `useChatViewport` 提供） */
export interface ScrollKeyContext {
  scrollByWheel: (dir: -1 | 1) => void;
  scrollByPage: (dir: -1 | 1) => void;
  scrollByLine: (dir: -1 | 1) => void;
}

/**
 * 处理「回看历史」类按键：鼠标滚轮、PgUp/PgDn、⌘[ / ⌘]、⌘; / ⌘'、Alt+V。
 *
 * @returns 是否已消费该键（`true` 时调用方应立即 return）
 */
export function handleScrollKey(char: string, key: Key, ctx: ScrollKeyContext): boolean {
  // 滚轮**必须**排在 `isTerminalReply` 之前：后者会把整条鼠标序列当「终端上报」
  // 吃掉，排后面就永远收不到滚轮。
  const wheel = parseWheel(char);
  if (wheel) {
    ctx.scrollByWheel(wheel.direction);
    return true;
  }
  // 其余鼠标事件（点击 / 拖拽 / 横向滚轮）与终端应答一律丢弃，绝不落到输入框里。
  if (isTerminalReply(char)) return true;
  if (key.pageUp) {
    ctx.scrollByPage(-1);
    return true;
  }
  if (key.pageDown) {
    ctx.scrollByPage(1);
    return true;
  }
  // 翻页的兜底键：部分终端把 PgUp/PgDn 留给自己滚 scrollback，应用收不到。
  // 注意 `Ctrl+V` 预留给图片粘贴，不兼任 page-down。
  if (char === "v" && key.meta) {
    ctx.scrollByPage(-1);
    return true;
  }
  // macOS 习惯键。Cmd 只在 kitty 键盘协议下才会带 super 位；终端把 ⌘ 组合映射成
  // 带 8 号修饰位的转义序列时，会落到上面的 meta 分支里，同样生效。
  if (key.super && (char === "[" || char === "]")) {
    ctx.scrollByPage(char === "[" ? -1 : 1);
    return true;
  }
  if (key.super && (char === ";" || char === "'")) {
    ctx.scrollByLine(char === ";" ? -1 : 1);
    return true;
  }
  return false;
}

/** Ctrl+D 双击退出的时间窗（毫秒） */
export const CTRL_D_WINDOW = 800;

export interface CtrlDExitContext {
  /** 上一次 Ctrl+D 的时刻（调用方用一个 `{ current }` 容器持有，通常是 `useRef`） */
  lastAt: { current: number };
  /** 第一次按下时的提示（「再按一次退出」） */
  notify: () => void;
  /** 第二次按下：真的退出 */
  exit: () => void;
}

/**
 * Ctrl+D 双击退出（空闲态与忙碌态共用同一套判定）。
 *
 * 只认 `Ctrl+D`：草稿非空时删字符是**空闲态独有的语义**，由调用方在调用本函数
 * 之前自己处理，这里不看草稿。
 *
 * @param now 当前时刻，默认 `Date.now()`；测试可注入以避开假定时器
 * @returns 是否已消费该键
 */
export function handleCtrlDExit(
  char: string,
  key: Key,
  ctx: CtrlDExitContext,
  now: number = Date.now(),
): boolean {
  if (!(char === "d" && key.ctrl)) return false;
  if (now - ctx.lastAt.current < CTRL_D_WINDOW) {
    ctx.exit();
    return true;
  }
  ctx.lastAt.current = now;
  ctx.notify();
  return true;
}
