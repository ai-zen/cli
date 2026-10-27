/**
 * 输入框编辑的纯逻辑层 —— 与 Claude Code / readline 的键位语义对齐。
 *
 * 全部函数都是「(文本, 光标) → (文本, 光标)」的纯变换，便于单测；
 * chat.tsx 只负责把按键映射过来、套用结果、维护 kill ring 与撤销栈。
 *
 * 光标单位是**字素簇**（`graphemes`），不是 code point：`✌️` 是 2 个 code point
 * 但只是 1 个簇，按 code point 删会只删掉半个 emoji、留下孤立的变体选择符。
 *
 * 键位语义依据 Claude Code 官方文档（interactive-mode.md）：
 * - `Ctrl+W` 删到**前一空白**（标点不切分：`src/utils/foo.ts` 一次删掉整条路径）
 * - `Alt+B/F/D` 按「词」处理（标点算分隔符：停在 `ts` / `foo` / `utils` / `src`）
 */

import { graphemes } from "./text.js";

/** 一段可撤销的编辑状态（文本 + 字素簇光标） */
export interface EditState {
  text: string;
  cursor: number;
}

function clampCursor(chars: string[], cursor: number): number {
  return Math.max(0, Math.min(cursor, chars.length));
}

/**
 * 删到前一空白（Ctrl+W）：先吃掉光标前的空白，再吃掉一整段非空白。
 *
 * 与 `deleteWordLeft` 的区别在于标点：本函数只认空白为边界，
 * 因此 `src/utils/foo.ts` 会被整段删除，而不是只删 `foo.ts`。
 */
export function deleteToPrevWhitespace(text: string, cursor: number): EditState {
  const chars = graphemes(text);
  const cp = clampCursor(chars, cursor);
  let from = cp;
  while (from > 0 && /\s/.test(chars[from - 1])) from -= 1;
  while (from > 0 && !/\s/.test(chars[from - 1])) from -= 1;
  return {
    text: chars.slice(0, from).join("") + chars.slice(cp).join(""),
    cursor: from,
  };
}

/**
 * 求「被删掉的文本」：比较编辑前后，取中间不重合的那一段。
 *
 * 用于把 `Ctrl+W/U/K` 删掉的内容放进 kill ring 供 `Ctrl+Y` 取回，
 * 免去每个删除函数各自返回「删了什么」。
 */
export function killedText(before: string, after: string): string {
  const a = graphemes(before);
  const b = graphemes(after);
  let prefix = 0;
  while (prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return a.slice(prefix, a.length - suffix).join("");
}

// ==================== kill ring（Ctrl+Y / Alt+Y）====================/** kill ring 最大长度（够 Alt+Y 循环几次即可，不做无限历史） */
export const KILL_RING_SIZE = 5;

/**
 * 记录一段被删除的文本。
 *
 * 空串不入环；与栈顶相同的连续删除（如连按 `Ctrl+W` 删同一个词）不重复入栈，
 * 否则 `Alt+Y` 会在同一段文本上空转。
 */
export function pushKill(ring: string[], killed: string, limit = KILL_RING_SIZE): string[] {
  if (!killed) return ring;
  if (ring[0] === killed) return ring;
  return [killed, ...ring].slice(0, limit);
}

/** 取环中第 index 段（越界返回 undefined）；index 0 为最近一次删除 */
export function killAt(ring: string[], index: number): string | undefined {
  if (index < 0 || index >= ring.length) return undefined;
  return ring[index];
}

// ==================== 撤销栈（Ctrl+_）====================

/** 撤销栈上限：编辑很密，但每条只是一个短字符串，100 条足够 */
export const UNDO_LIMIT = 100;

/** 入栈一条编辑前快照；与栈顶相同的状态不重复入栈 */
export function pushUndo(stack: EditState[], state: EditState, limit = UNDO_LIMIT): EditState[] {
  const top = stack[stack.length - 1];
  if (top && top.text === state.text && top.cursor === state.cursor) return stack;
  return [...stack, state].slice(-limit);
}

/** 出栈一条快照（无历史时返回 null） */
export function popUndo(stack: EditState[]): { state: EditState; rest: EditState[] } | null {
  if (stack.length === 0) return null;
  return { state: stack[stack.length - 1], rest: stack.slice(0, -1) };
}
