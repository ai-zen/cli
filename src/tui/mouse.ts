/**
 * 鼠标滚轮支持 —— 终端模式开关 + SGR 上报解析
 *
 * 为什么需要自己实现：Ink 7 没有 `useMouse`（整个 `ink/build` 里 "mouse" 只出现在
 * `measure-element.js` 的一句注释中），终端也默认**不把**鼠标事件发给应用——滚轮被
 * 终端自己拿去滚 scrollback。要收到滚轮，必须由应用主动打开终端上报模式。
 *
 * 两种编码，只认后者：
 *   - `DECSET 1000`：上报「按钮按下 / 释放」（滚轮也算按钮），是收到滚轮的前提；
 *   - `DECSET 1006`：改用 SGR 扩展坐标 `CSI < b ; x ; y M`（释放为 `m`）。**必须开**：
 *     老的 X10 编码（`CSI M` + 3 个原始字节）会被 Ink 的输入解析器拆成 `[M` 和三个
 *     普通字符两条事件，后者会被当正文插进输入框（已实测重现）。
 *
 * 上报到 Ink 的形态（pty 实测）：`useInput` 的 `char` 是 `"[<64;10;5M"`，`key` 的
 * 所有标志位都是 false。也就是说**鼠标序列和用户打字走的是同一条路**——任何可能插入
 * 文本的处理器都必须先拦一道（见 `isTerminalReply` 与各屏守卫）。
 *
 * 取舍（用户已知情并选择开启）：
 *   - 点击 / 拖拽被应用吃掉，多数终端需按住 `Shift` 才回退到原生选词复制；
 *   - tmux / screen 需 `set -g mouse off`，否则滚轮先被多路复用器拦进 copy-mode；
 *   - 应用内滚动只动视口，不产生终端 scrollback。
 */

/** 开启上报：1000（按钮事件，含滚轮）+ 1006（SGR 扩展坐标） */
export const MOUSE_ENABLE = "\u001b[?1000h\u001b[?1006h";

/** 关闭上报。任何退出路径都必须下发，否则 shell 提示符后面会开始吐 `^[[<64;…M` */
export const MOUSE_DISABLE = "\u001b[?1000l\u001b[?1006l";

/** 滚轮一格滚动的行数（各终端应用的通行值） */
export const WHEEL_STEP = 3;

/**
 * SGR 鼠标上报：`CSI < b ; x ; y M|m`。
 *
 * 前导 ESC 可有可无 —— Ink 喂给 `useInput` 的 `char` 已被剥掉 ESC（实测为 `[<64;…`），
 * 但直接处理原始 stdin 数据时它还带着，两种都接受才不会漏。
 */
const SGR_MOUSE = /^(?:\u001b)?\[<(\d+);(\d+);(\d+)([Mm])$/;

/** 修饰位：Shift(4) / Meta(8) / Ctrl(16) / Motion(32) —— 判定滚轮前要剥掉 */
const MODIFIER_BITS = 0b11100;

export interface WheelEvent {
  /** `-1` = 向上滚（回看更早的内容），`1` = 向下滚（回到更新的内容） */
  direction: -1 | 1;
  /** 终端列（1-based），当前仅用于将来做「按鼠标位置定位」 */
  x: number;
  /** 终端行（1-based） */
  y: number;
}

/** 是否为鼠标上报序列（滚轮、点击、拖拽、移动都算） */
export function isMouseSequence(input: string): boolean {
  return SGR_MOUSE.test(input);
}

/**
 * 从鼠标序列中解出滚轮事件；不是滚轮（点击 / 拖拽 / 横向滚轮）返回 `null`。
 *
 * SGR 的按钮码：`64` 滚轮上、`65` 滚轮下、`66` / `67` 横向滚轮。横向在这个视口里
 * 没有对应维度，直接丢弃——否则横向滚一下就莫名其妙跳几行。
 */
export function parseWheel(input: string): WheelEvent | null {
  const match = SGR_MOUSE.exec(input);
  if (!match) return null;
  const code = Number(match[1]) & ~MODIFIER_BITS;
  if (code !== 64 && code !== 65) return null;
  return {
    direction: code === 64 ? -1 : 1,
    x: Number(match[2]),
    y: Number(match[3]),
  };
}

/**
 * 打开终端鼠标上报。
 *
 * 输出的是纯模式设置序列（不打印字符、不移动光标），因此可以安全地直接写 stdout，
 * 不会与 Ink 的增量重绘打架。重复下发是幂等的。
 */
export function enableMouseTracking(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(MOUSE_ENABLE);
}

/** 关闭终端鼠标上报（幂等）。退出 / 信号 / 异常路径都要调用。 */
export function disableMouseTracking(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(MOUSE_DISABLE);
}
