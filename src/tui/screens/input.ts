// 由 src/tui/screens.tsx 拆分而来 —— 输入区折行 / 硬件光标 / 跨词移动
import { displayWidth, layoutInput, INPUT_PREFIX_WIDTH } from "../text.js";

// ==================== 对话屏布局（吸底）====================

/** 输入区文本折行（不含提示符 `❯ `，交由渲染层补齐）；空输入用占位提示 */
export function inputLines(text: string, columns: number): string[] {
  const width = Math.max(4, columns - 4);
  const body = text.length > 0 ? text : "输入消息，/ 查看命令…";
  return layoutInput(body, 0, width).lines;
}

/**
 * 计算终端硬件光标坐标（相对 Ink 输出原点），用于让 IME（输入法）候选框
 * 跟随编辑光标。x 为列、y 为行。
 */
export function computeInputCursorPosition(input: {
  /** 对话区行数（输入区之前的行偏移基数） */
  transcriptLines: number;
  /** 斜杠命令菜单行数 */
  hintCount: number;
  /** 光标在输入框内的行 / 列（列以 code point 计） */
  cursorRow: number;
  cursorCol: number;
  /** 光标所在行的文本（不含提示符） */
  lineText: string;
  /** 是否为空输入占位状态 */
  placeholder: boolean;
}): { x: number; y: number } {
  const before = input.placeholder
    ? ""
    : Array.from(input.lineText).slice(0, input.cursorCol).join("");
  return {
    x: INPUT_PREFIX_WIDTH + displayWidth(before),
    // 对话区 + 斜杠菜单 + 分隔线 + 输入行内偏移
    y: input.transcriptLines + input.hintCount + 1 + input.cursorRow,
  };
}

// ==================== 跨词移动（Ctrl/Alt + ← →）====================

/** 是否为「单词字符」：ASCII 下为字母/数字/下划线，非 ASCII（CJK 等）一律算单词字符 */
export function isWordChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0)!;
  if (code < 128) return /[A-Za-z0-9_]/.test(ch);
  return !/\s/.test(ch);
}

/** 向左跨词后的光标位置（跳过分隔符与单词，停在词首） */
export function wordLeft(text: string, cursor: number): number {
  const chars = Array.from(text);
  let i = Math.max(0, Math.min(cursor, chars.length));
  while (i > 0 && !isWordChar(chars[i - 1])) i -= 1;
  while (i > 0 && isWordChar(chars[i - 1])) i -= 1;
  return i;
}

/** 向右跨词后的光标位置（跳过单词与分隔符，停在词尾） */
export function wordRight(text: string, cursor: number): number {
  const chars = Array.from(text);
  let i = Math.max(0, Math.min(cursor, chars.length));
  while (i < chars.length && !isWordChar(chars[i])) i += 1;
  while (i < chars.length && isWordChar(chars[i])) i += 1;
  return i;
}

