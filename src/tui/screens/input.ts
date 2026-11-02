// 由 src/tui/screens.tsx 拆分而来 —— 输入区折行 / 硬件光标 / 跨词移动
import { displayWidth, graphemes, layoutInput, INPUT_PREFIX_WIDTH } from "../text.js";
import { t } from "../../i18n/index.js";

// ==================== 对话屏布局（吸底）====================

/** 输入区文本折行（不含提示符 `❯ `，交由渲染层补齐）；空输入用占位提示 */
export function inputLines(text: string, columns: number): string[] {
  const width = Math.max(4, columns - 4);
  const body = text.length > 0 ? text : t("input.placeholder");
  return layoutInput(body, 0, width).lines;
}

/** 输入区最多占用几行（超出的折行开窗滚动，不把对话区挤没） */
export const INPUT_MAX_ROWS = 8;

/**
 * 输入区可见窗口：总行数 + 光标所在行 → `[from, to)`。
 *
 * 窗口**跟随光标**（而不是固定显示末尾 N 行）：`←` 在行首会退到上一行，光标能一路
 * 退到第一行 —— 钉住末尾的窗口会让光标“消失”在框外。光标所在行恒为窗口**末行**
 * （除非已贴底），于是往上走时窗口连续上滚。
 *
 * 三处必须同源：`computeChatLayout` 的 `inputHeight`、渲染的 `slice(from, to)`、
 * 硬件光标 y 里的行内偏移（`cursorRow − from`）。
 */
export function inputWindow(
  total: number,
  cursorRow: number,
  max = INPUT_MAX_ROWS,
): { from: number; to: number } {
  const size = Math.min(total, Math.max(1, max));
  const from = Math.min(Math.max(0, cursorRow - size + 1), Math.max(0, total - size));
  return { from, to: from + size };
}

/**
 * 计算终端硬件光标坐标（相对 Ink 输出原点），用于让 IME（输入法）候选框
 * 跟随编辑光标。x 为列、y 为行（0 起始，从整帧第一行算起）。
 *
 * y 必须把输入行**上方渲染的全部行**算进去，顺序与 `chat.tsx` 的渲染顺序严格一致：
 *
 *   对话区（`layout.lines`）→ Agent 栏目 → 通知栏（`noticeLines`）→ 附件提示行
 *   → 斜杠 / `@` 菜单（`hints`）→ 分隔线 → 输入行
 *
 * 漏算任何一段，硬件光标就会整体偏移那么多行（Ink 的 `moveUp = 总行数 − y`，
 * 所以 y 少几行，光标就高几行）。历史上「通知栏」就被漏过：`/help` 这类多行通知
 * 一出现，IME 候选框会浮到输入行上方好几行。
 */
export function computeInputCursorPosition(input: {
  /** 对话区行数（输入区之前的行偏移基数） */
  transcriptLines: number;
  /** Agent 栏目行数（位于对话区与通知栏之间；不传视为 0） */
  agentTabCount?: number;
  /** 通知栏行数（位于对话区与斜杠菜单之间；不传视为 0） */
  noticeCount?: number;
  /** 待发送附件提示行数（位于通知栏与菜单之间；不传视为 0） */
  attachmentCount?: number;
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
    : graphemes(input.lineText).slice(0, input.cursorCol).join("");
  return {
    x: INPUT_PREFIX_WIDTH + displayWidth(before),
    // 对话区 + Agent 栏目 + 通知栏 + 附件提示行 + 斜杠菜单 + 分隔线 + 输入行内偏移
    y:
      input.transcriptLines +
      (input.agentTabCount ?? 0) +
      (input.noticeCount ?? 0) +
      (input.attachmentCount ?? 0) +
      input.hintCount +
      1 +
      input.cursorRow,
  };
}

// ==================== 上下移动光标（↑ / ↓）====================

/**
 * 光标上 / 下一行后的字素簇下标；已在首行按 ↑、或在末行按 ↓ 时返回 `null`。
 *
 * 「行」是**折行后的行**（含软折行），不是按 `\n` 切的物理行 —— 长段落在窄窗口里会被
 * 拆成多行，用户看到的就是多行，光标必须跟着视觉行移动。宽度必须与实际渲染一致
 * （`layoutInput` 的 `width`），否则会跨行/落错列。
 *
 * 列位置：目标行更短时落到行尾（与主流编辑器一致）；光标不会因此跳到相邻行。
 */
export function moveCursorRow(
  text: string,
  cursor: number,
  width: number,
  dir: -1 | 1,
): number | null {
  const layout = layoutInput(text, cursor, width);
  const target = layout.cursorRow + dir;
  if (target < 0 || target >= layout.lines.length) return null;
  const col = Math.min(layout.cursorCol, graphemes(layout.lines[target]!).length);
  return layout.rowStarts[target]! + col;
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
  const chars = graphemes(text);
  let i = Math.max(0, Math.min(cursor, chars.length));
  while (i > 0 && !isWordChar(chars[i - 1])) i -= 1;
  while (i > 0 && isWordChar(chars[i - 1])) i -= 1;
  return i;
}

/** 向右跨词后的光标位置（跳过单词与分隔符，停在词尾） */
export function wordRight(text: string, cursor: number): number {
  const chars = graphemes(text);
  let i = Math.max(0, Math.min(cursor, chars.length));
  while (i < chars.length && !isWordChar(chars[i])) i += 1;
  while (i < chars.length && isWordChar(chars[i])) i += 1;
  return i;
}

// ==================== 按词删除（Ctrl+W / Alt+Backspace、Alt+D / Ctrl+Delete）====================

/** 光标钳制到 [0, len]（按 code point 计） */
function clampCursor(chars: string[], cursor: number): number {
  return Math.max(0, Math.min(cursor, chars.length));
}

/**
 * 向左删一个词（Ctrl+W / Alt+Backspace）：删掉光标前的分隔符与单词。
 * 返回删除后的文本与光标位置 —— 光标原地不动，只是前面的内容被吃掉。
 */
export function deleteWordLeft(text: string, cursor: number): { text: string; cursor: number } {
  const chars = graphemes(text);
  const cp = clampCursor(chars, cursor);
  const from = wordLeft(text, cp);
  return {
    text: chars.slice(0, from).join("") + chars.slice(cp).join(""),
    cursor: from,
  };
}

/**
 * 向右删一个词（Alt+D / Ctrl+Delete）：删掉光标后的分隔符与单词。
 * 光标不动，后面的内容被吃掉。
 */
export function deleteWordRight(text: string, cursor: number): { text: string; cursor: number } {
  const chars = graphemes(text);
  const cp = clampCursor(chars, cursor);
  const to = wordRight(text, cp);
  return {
    text: chars.slice(0, cp).join("") + chars.slice(to).join(""),
    cursor: cp,
  };
}

/**
 * 删到行首（Ctrl+U）：删掉光标到本行开头（不含换行符）的内容。
 *
 * 语义与 readline 的 unix-line-discard / 主流 TUI 保持一致。注意 macOS 上
 * iTerm2 与 Terminal.app 会把 `Cmd+Backspace` 映射成 `Ctrl+U` —— 若此处做成
 * 「清空整个输入框」，Mac 用户按 ⌘⌫ 会丢掉全部草稿（多行输入时尤其致命）。
 */
export function deleteToLineStart(text: string, cursor: number): { text: string; cursor: number } {
  const chars = graphemes(text);
  const cp = clampCursor(chars, cursor);
  let from = cp;
  while (from > 0 && chars[from - 1] !== "\n") from -= 1;
  return {
    text: chars.slice(0, from).join("") + chars.slice(cp).join(""),
    cursor: from,
  };
}

/**
 * 删到行尾（Ctrl+K）：删掉光标到本行末尾（不含换行符）的内容；
 * 若光标已在行尾，则连该换行符一起删掉（与 readline 的 kill-line 一致）。
 */
export function deleteToLineEnd(text: string, cursor: number): { text: string; cursor: number } {
  const chars = graphemes(text);
  const cp = clampCursor(chars, cursor);
  let to = cp;
  while (to < chars.length && chars[to] !== "\n") to += 1;
  if (to === cp && chars[cp] === "\n") to += 1;
  return {
    text: chars.slice(0, cp).join("") + chars.slice(to).join(""),
    cursor: cp,
  };
}

