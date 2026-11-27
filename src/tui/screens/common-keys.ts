// 两个输入处理器共用的键位 —— 「滚轮 / 翻页 / ⌘ 习惯键 / Ctrl+D 双击退出」
//
// 会话屏有两个 `useInput`：一个是空闲态（编辑输入框），一个是忙碌态（生成 / 迁移中，
// 只放行中止与回看）。两者对**同一批键**的处理保持一致 —— 否则「生成时能滚、空闲时
// 不能滚」这类不一致迟早会出现。所以这一段只写一次：纯函数，不碰 React，键盘回归可以直接断言。
//
// ## 这里没有一个 Alt 键位
//
// Alt（终端里的 `meta`）在本产品里不作为快捷键：它被终端模拟器、shell、tmux 与系统输入法
// 抢得太多（Option 在某些终端根本不发 meta、macOS 的 Option+←/→ 变成 `ESC b`），同一个组合在
// 两台机器上可能是完全不同的两件事。于是：
//
//   · 应用级动作全落在 **Ctrl** 上（`Ctrl+X` 清本会话通知、`Ctrl+G` 清全部、`Ctrl+B`/`Ctrl+F` 翻页、
//     `Ctrl+O` 开图片）；
//   · 读线编辑那一套 Alt 键位（`Alt+B/F/D/Y`、`Alt+Backspace`、`Alt+Enter`）**全部退场** ——
//     它们各自都有 Ctrl 侧的等价物（`Ctrl+←/→`、`Ctrl+Delete`、`Ctrl+Backspace`、`Ctrl+J`），
//     重复的一套只会多出「两边行为不一致」的隐患。
//
// 于是这个文件里剩下的 `meta` 只剩**判断输入要不要落进输入框**那一处（`isMetaChar` 之类），
// 不再有任何「按键执行动作」的 Alt 分支。
import type { Key } from "ink";
import { parseWheel } from "../mouse.js";
import { isTerminalReply } from "../text.js";

/** 滚动动作的注入点（由 `useChatViewport` 提供） */
export interface ScrollKeyDeps {
  scrollByWheel: (dir: -1 | 1) => void;
  scrollByPage: (dir: -1 | 1) => void;
  scrollByLine: (dir: -1 | 1) => void;
}

/**
 * 处理「回看历史」类按键：鼠标滚轮、PgUp/PgDn、Ctrl+B / Ctrl+F、⌘[ / ⌘]、⌘; / ⌘'。
 *
 * @returns 是否已消费该键（`true` 时调用方应立即 return）
 */
export function handleScrollKey(char: string, key: Key, deps: ScrollKeyDeps): boolean {
  // 滚轮**先于** `isTerminalReply` 判定：后者会把整条鼠标序列当「终端上报」
  // 消费掉，排到它后面就永远收不到滚轮。
  const wheel = parseWheel(char);
  if (wheel) {
    deps.scrollByWheel(wheel.direction);
    return true;
  }
  // 其余鼠标事件（点击 / 拖拽 / 横向滚轮）与终端应答全部丢弃，不会落到输入框里。
  if (isTerminalReply(char)) return true;
  if (key.pageUp) {
    deps.scrollByPage(-1);
    return true;
  }
  if (key.pageDown) {
    deps.scrollByPage(1);
    return true;
  }
  // 翻页的兜底键：部分终端把 PgUp/PgDn 留给自己滚 scrollback，应用收不到。
  // 落在 Ctrl+B / Ctrl+F 上（B = backward、F = forward），`Ctrl+V` 预留给图片粘贴、
  // `Ctrl+Y` 给了 kill-ring，都不兼职。
  if (char === "b" && key.ctrl) {
    deps.scrollByPage(-1);
    return true;
  }
  if (char === "f" && key.ctrl) {
    deps.scrollByPage(1);
    return true;
  }
  // macOS 习惯键。Cmd 只在 kitty 键盘协议下才会带 super 位；终端把 ⌘ 组合映射成
  // 带 8 号修饰位的转义序列时，会落到 meta 分支里 —— 而 meta 已不再作为快捷键，
  // 那几条组合于是不再生效（与「Alt 不作为快捷键」同一条口径）。
  if (key.super && (char === "[" || char === "]")) {
    deps.scrollByPage(char === "[" ? -1 : 1);
    return true;
  }
  if (key.super && (char === ";" || char === "'")) {
    deps.scrollByLine(char === ";" ? -1 : 1);
    return true;
  }
  return false;
}

export interface ClearNoticesDeps {
  /** 清空通知栏（本地队列 + 宿主上这一段会话的通知） */
  clear: () => void;
}

/**
 * 通知栏的「清空本会话」键（`Ctrl+X`）。
 *
 * 只认这一个组合：通知栏没有焦点、也不接管方向键，所以入口只能是一个全局键 —— 而它不
 * 与输入编辑（Ctrl 系）和滚动（PgUp/PgDn、Ctrl+B/F、⌘ 系）撞车。提示文字就在通知栏最后一行
 * （`notice.ts` 的 `noticeLines`），改这里要同步改词条。
 *
 * 为什么是 `Ctrl+X`：`Ctrl` 的空格子里，X 念作「去掉」，且不与 `Ctrl+C`（中断 / 清草稿）、
 * `Ctrl+L`（清屏）、`Ctrl+G`（下面那一档）混淆。不用 Alt —— Alt 系在本产品里不作为快捷键。
 *
 * 「清」有三档粒度（`prd/08-client.md` 的通知那一节）：清一条（补看那条路，`pending-notices.ts`）、
 * 清一段会话的（这一支）、清全部（{@link handleClearAllNoticesKey}）。
 *
 * 与其它共用键一样放成纯函数：键位回归不必挂一个 React 渲染。
 *
 * @returns 是否已消费该键
 */
export function handleClearNoticesKey(char: string, key: Key, deps: ClearNoticesDeps): boolean {
  if (!(char === "x" && key.ctrl)) return false;
  deps.clear();
  return true;
}

export interface ClearAllNoticesDeps {
  /**
   * 开「清全部」那一问（确认之后才真的清）。
   *
   * 键位函数只负责按键分流，「问一次」与「清」都在屏幕那一侧：那里才有选择器与连接。
   */
  ask: () => void;
}

/**
 * 通知栏的「清全部」键（`Ctrl+G`）。
 *
 * 为什么是这一组：三档粒度要在栏位这一处排得开，而 `Ctrl` 的空格子只剩几个 ——
 * `Ctrl+X` 已经给了「清本会话」，与它成对的 `Ctrl+Shift+X` **不可用**：`kittyKeyboard` 是
 * 刻意关掉的（`tui/index.tsx` 的 `RENDER_OPTIONS`），不带 kitty 协议时终端把 `Ctrl+Shift+X`
 * 与 `Ctrl+X` 报成同一个字节，两档就变成了一档。所以第二档换字母：`G`（= 「全局」那一档的
 * 首字母）。
 *
 * 这里**不做**任何清除动作：清全部会连全局通知、连别的会话的通知一起抹掉，所以它只开那一问
 * （`chat.tsx` 的 `clearAllNotices`），用户点头之后才发 `notice.deleteAll`。
 *
 * @returns 是否已消费该键
 */
export function handleClearAllNoticesKey(
  char: string,
  key: Key,
  deps: ClearAllNoticesDeps,
): boolean {
  if (!(char === "g" && key.ctrl)) return false;
  deps.ask();
  return true;
}

export interface OpenImageDeps {
  /** 开「这一段里哪一张图」那一问（取字节、落临时文件、交给本机程序都在筛选之后） */
  open: () => void;
}

/**
 * 打开消息里图片的键（`Ctrl+O`）。
 *
 * 为什么是 Ctrl+O：转录里的图统一折成占位（终端不可能内联渲染），需要一个动作把它交给
 * 本机看图器。`o` = open，而 Ctrl 系里剩下的空格子已经不多了：`Ctrl+C/D/L/U/K/W/Y/S/V/A/E/J/P/N/X/G/B/F`
 * 都有主，`Ctrl+O` 是空的（它不相邻任何一个已有语义，不会被当成「多按一下」的组合）。
 * 不用 Alt 系：本产品里 Alt 不作为快捷键（见文件头）。
 *
 * 它**只**开那一问：一张图都不在这一段里时也要说一句（不能一声不响，否则用户以为键坏了）。
 *
 * @returns 是否已消费该键
 */
export function handleOpenImageKey(char: string, key: Key, deps: OpenImageDeps): boolean {
  if (!(char === "o" && key.ctrl)) return false;
  deps.open();
  return true;
}

/** Ctrl+D 双击退出的时间窗（毫秒） */
export const CTRL_D_WINDOW = 800;

export interface CtrlDExitDeps {
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
  deps: CtrlDExitDeps,
  now: number = Date.now(),
): boolean {
  if (!(char === "d" && key.ctrl)) return false;
  if (now - deps.lastAt.current < CTRL_D_WINDOW) {
    deps.exit();
    return true;
  }
  deps.lastAt.current = now;
  deps.notify();
  return true;
}
