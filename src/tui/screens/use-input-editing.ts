// 输入编辑 —— 草稿文本与光标、历史、kill ring、撤销栈、暂存区的唯一实现
//
// 从 `chat.tsx` 抽出来的理由：这一整块（`input` / `cursor` / `history` / kill ring /
// undo / stash + 20 个编辑动作）是**纯编辑器语义**，与「对话屏」毫无关系，却和会话、
// 向导、渲染挤在同一个组件里 —— 于是既不能单测，也每次都被误认为「对话的一部分」。
//
// 两条贯穿全篇的约定：
//
//   1. **按字素簇编辑**：所有位置计算都走 `graphemes()`。`❤️` 是 2 个 code point、
//      `👨‍👩‍👧` 是 5 个，但它们都是**一个**字符 —— 按 code point 删会切出半个字素簇。
//   2. **纯函数算、hook 只套用**：具体「删哪个词、删到哪」在 `input.ts` /
//      `input-editing.ts` 里（有独立测试），这里只负责「拿到结果 → 更新状态 + 记撤销」。
import { useRef, useState } from "react";
import {
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordLeft,
  deleteWordRight,
  wordLeft,
  wordRight,
} from "./input.js";
import {
  deleteToPrevWhitespace,
  killedText,
  killAt,
  popUndo,
  pushKill,
  pushUndo,
  type EditState,
} from "../input-editing.js";
import { graphemes } from "../text.js";
import { t } from "../../i18n/index.js";
import type { Notice } from "./notice.js";

export interface InputEditingDeps {
  /** 初始草稿（`/back` 撤回后重挂载用的预填内容），缺省空 */
  initialText?: string;
  /** 通知出口（暂存 / 取回草稿的提示，走通知通道而不是转录） */
  notify: (text: string, tone?: Notice["tone"]) => void;
}

export interface InputEditing {
  /** 当前草稿 */
  input: string;
  /** 光标位置：以字素簇计的索引（0..字数），可落在末尾之后一格 */
  cursor: number;
  /** 整体替换草稿（光标移到末尾） */
  setInputText: (text: string) => void;
  insertAtCursor: (text: string) => void;
  deleteBeforeCursor: () => void;
  deleteAfterCursor: () => void;
  deleteWordBeforeCursor: () => void;
  deleteWordAfterCursor: () => void;
  deleteToStartOfLine: () => void;
  deleteToEndOfLine: () => void;
  /** Ctrl+W：删到前一空白（标点不切分） */
  deletePrevWhitespace: () => void;
  /** Ctrl+Y / Alt+Y：取回 kill ring 里的一段；`advance` 为真时循环到更早的一段 */
  yank: (advance: boolean) => void;
  /** Ctrl+_：撤销上一次编辑 */
  undoEdit: () => void;
  /** Ctrl+S：暂存草稿 / 取回草稿 */
  toggleStash: () => void;
  moveCursor: (delta: number) => void;
  moveCursorToLineStart: () => void;
  moveCursorToLineEnd: () => void;
  /** 按词左右移动：`dir` 为 -1 往前、1 往后 */
  moveCursorByWord: (dir: -1 | 1) => void;
  /** 历史：上一条 / 下一条（没有可翻的时候自动空转） */
  historyPrev: () => void;
  historyNext: () => void;
  /** 提交时调用：清空草稿并退出历史浏览（历史游标复位到底部） */
  clearDraft: () => void;
  /** 提交成功时调用：记进历史并把历史游标复位到底部 */
  rememberSubmitted: (text: string) => void;
}

export function useInputEditing({ initialText, notify }: InputEditingDeps): InputEditing {
  const [input, setInput] = useState(initialText ?? "");
  const [cursor, setCursor] = useState(graphemes(initialText ?? "").length);
  const [history, setHistory] = useState<string[]>([]);
  /** 历史游标：-1 = 不在浏览历史（当前是草稿） */
  const historyIndex = useRef(-1);
  /** kill ring：Ctrl+W/U/K 删掉的文本，Ctrl+Y 取回、Alt+Y 循环 */
  const killRingRef = useRef<string[]>([]);
  const yankIndexRef = useRef(-1);
  /** 编辑撤销栈（Ctrl+_） */
  const undoStackRef = useRef<EditState[]>([]);
  /** 暂存区（Ctrl+S） */
  const stashRef = useRef<EditState | null>(null);

  const setInputText = (text: string) => {
    setInput(text);
    setCursor(graphemes(text).length);
  };

  /**
   * 取「当前文本 + 钳制后的光标」，所有编辑动作的统一起点。
   *
   * 钳制防的**不是**「cursor 越界」——`cursor` 的每个写入点都已保证落在 `[0, len]`；
   * 防的是**文本与光标不同步**：`input` 与 `cursor` 是两个 state，任何一处只改其一
   * （或将来新增编辑动作忘了同步）都会让 `cp > chars.length` 成立，那时 `slice`
   * 会静默切少、`cp - 1` 会变负。钳一下把后果限制在「本次编辑落点不对」。
   */
  const clampCursor = () => {
    const chars = graphemes(input);
    return { chars, cp: Math.max(0, Math.min(cursor, chars.length)) };
  };

  const insertAtCursor = (text: string) => {
    const { chars, cp } = clampCursor();
    setInput(chars.slice(0, cp).join("") + text + chars.slice(cp).join(""));
    setCursor(cp + graphemes(text).length);
  };

  const deleteBeforeCursor = () => {
    const { chars, cp } = clampCursor();
    if (cp === 0) return;
    setInput(chars.slice(0, cp - 1).join("") + chars.slice(cp).join(""));
    setCursor(cp - 1);
  };

  const deleteAfterCursor = () => {
    const { chars, cp } = clampCursor();
    if (cp >= chars.length) return;
    setInput(chars.slice(0, cp).join("") + chars.slice(cp + 1).join(""));
  };

  /** 套用纯函数算好的「文本 + 光标」结果（无变化则不触发重渲染，也不进撤销栈） */
  const applyEdit = (r: EditState) => {
    if (r.text === input && r.cursor === cursor) return;
    undoStackRef.current = pushUndo(undoStackRef.current, { text: input, cursor });
    setInput(r.text);
    setCursor(r.cursor);
  };

  /** 删除类编辑：额外把删掉的文本放进 kill ring（Ctrl+Y 可取回） */
  const applyKill = (r: EditState) => {
    if (r.text === input && r.cursor === cursor) return;
    killRingRef.current = pushKill(killRingRef.current, killedText(input, r.text));
    yankIndexRef.current = -1;
    applyEdit(r);
  };

  const yank = (advance: boolean) => {
    const ring = killRingRef.current;
    if (ring.length === 0) return;
    const next = advance ? yankIndexRef.current + 1 : 0;
    // 只用 `killAt` 的 undefined 做越界守卫（环已到头），不再先判一遍 `next >= ring.length`
    const text = killAt(ring, next);
    if (text === undefined) return;
    yankIndexRef.current = next;
    insertAtCursor(text);
  };

  const undoEdit = () => {
    const popped = popUndo(undoStackRef.current);
    if (!popped) return;
    undoStackRef.current = popped.rest;
    setInput(popped.state.text);
    setCursor(popped.state.cursor);
  };

  const toggleStash = () => {
    if (input.length > 0) {
      stashRef.current = { text: input, cursor };
      setInputText("");
      notify(t("notice.draftSaved"));
      return;
    }
    const stashed = stashRef.current;
    if (!stashed) return;
    stashRef.current = null;
    setInput(stashed.text);
    setCursor(stashed.cursor);
    notify(t("notice.draftRestored"));
  };

  const moveCursor = (delta: number) => {
    const len = graphemes(input).length;
    setCursor((c) => Math.max(0, Math.min(len, c + delta)));
  };

  const moveCursorByWord = (dir: -1 | 1) => {
    setCursor(dir === -1 ? wordLeft(input, cursor) : wordRight(input, cursor));
  };

  const moveCursorToLineStart = () => {
    const { chars, cp } = clampCursor();
    let i = cp;
    while (i > 0 && chars[i - 1] !== "\n") i -= 1;
    setCursor(i);
  };

  const moveCursorToLineEnd = () => {
    const { chars, cp } = clampCursor();
    let i = cp;
    while (i < chars.length && chars[i] !== "\n") i += 1;
    setCursor(i);
  };

  // 历史浏览：「上一条」从最新开始往回走，「下一条」走到底就回到空草稿。
  // 上下两处按键（Ctrl+P/N 与 ↑/↓）共用这一对，不再各写一遍。
  const historyPrev = () => {
    if (history.length === 0) return;
    const idx = historyIndex.current < 0 ? history.length - 1 : Math.max(0, historyIndex.current - 1);
    historyIndex.current = idx;
    setInputText(history[idx]!);
  };

  const historyNext = () => {
    if (historyIndex.current < 0) return;
    const idx = historyIndex.current + 1;
    if (idx >= history.length) {
      historyIndex.current = -1;
      setInputText("");
      return;
    }
    historyIndex.current = idx;
    setInputText(history[idx]!);
  };

  const clearDraft = () => {
    setInput("");
    setCursor(0);
    historyIndex.current = -1;
  };

  const rememberSubmitted = (text: string) => {
    setHistory((h) => [...h, text]);
    historyIndex.current = -1;
  };

  return {
    input,
    cursor,
    setInputText,
    insertAtCursor,
    deleteBeforeCursor,
    deleteAfterCursor,
    deleteWordBeforeCursor: () => applyKill(deleteWordLeft(input, cursor)),
    deleteWordAfterCursor: () => applyKill(deleteWordRight(input, cursor)),
    deleteToStartOfLine: () => applyKill(deleteToLineStart(input, cursor)),
    deleteToEndOfLine: () => applyKill(deleteToLineEnd(input, cursor)),
    deletePrevWhitespace: () => applyKill(deleteToPrevWhitespace(input, cursor)),
    yank,
    undoEdit,
    toggleStash,
    moveCursor,
    moveCursorToLineStart,
    moveCursorToLineEnd,
    moveCursorByWord,
    historyPrev,
    historyNext,
    clearDraft,
    rememberSubmitted,
  };
}
