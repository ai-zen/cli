// 由 src/tui/screens.tsx 拆分而来 —— 吸底布局 computeChatLayout + 覆盖层高度
import { RLine, Block, LiveAssistant, blockToLines, liveToLines } from "./lines.js";
import { inputLines } from "./input.js";

/** 确认框固定高度（外 marginTop 1 + 上下边框 2 + 问题 1 + marginTop 1 + 选项 1） */
export const CONFIRM_LINES = 6;
/** 选择覆盖层高度（相对条目数） */
export function pickerLines(itemCount: number): number {
  return 7 + itemCount;
}

export interface ChatLayoutInput {
  columns: number;
  rows: number;
  blocks: Block[];
  live: LiveAssistant | null;
  input: string;
  busy: boolean;
  hintCount: number;
  overlay: "none" | "confirm" | "picker";
  pickerItems: number;
  /** 视口顶部行索引（相对整个对话行）；null / undefined = 贴底（自动跟随最新） */
  viewTop?: number | null;
}

export interface ChatLayout {
  /** 对话区（含顶部补齐空行），行数恒为 `rows - bottomLines` */
  lines: RLine[];
  /** 底部区域（输入 / 覆盖层 + 状态栏）占用行数 */
  bottomLines: number;
  /** 对话框总行数（未截取前） */
  totalLines: number;
  /** 对话区可用高度（已扣除底部区域） */
  budget: number;
  /** 本次实际生效的视口顶部索引 */
  viewTop: number;
  /** 是否处于滚动状态（视口未贴底，下方仍有更新的内容） */
  scrolled: boolean;
}

/**
 * 计算对话屏布局：底部区域高度固定后，把「对话行」按视口截取到可用高度，顶部用空行
 * 补齐 —— 使整帧高度恒等于传入的 `rows`（调用方以 `usableFrameRows()` 预留末行），
 * 输入框稳定吸附底部。
 *
 * `viewTop` 指定视口顶部对应的对话行索引：省略 / `null` 表示贴底（自动跟随最新内容）；
 * 传入具体值时按 [0, totalLines - budget] 钳制，用于「应用内翻页」回看更早的历史。
 */
export function computeChatLayout(input: ChatLayoutInput): ChatLayout {
  const transcript: RLine[] = [];
  for (const block of input.blocks) transcript.push(...blockToLines(block, input.columns));
  if (input.live) transcript.push(...liveToLines(input.live, input.columns));

  const inputHeight = input.busy ? 1 : inputLines(input.input, input.columns).length;
  const overlayHeight =
    input.overlay === "confirm"
      ? CONFIRM_LINES
      : input.overlay === "picker"
        ? pickerLines(input.pickerItems)
        : 0;
  const bottomLines =
    input.overlay === "none"
      ? 1 /* 分隔线 */ + input.hintCount + inputHeight + 1 /* 状态栏 */
      : overlayHeight + 1 /* 状态栏 */;

  const budget = Math.max(0, input.rows - bottomLines);
  const totalLines = transcript.length;
  const maxTop = Math.max(0, totalLines - budget);
  const top = input.viewTop == null ? maxTop : Math.min(Math.max(0, input.viewTop), maxTop);
  const viewLines = transcript.slice(top, top + budget);
  const padTop = Math.max(0, budget - viewLines.length);
  const lines: RLine[] = [
    ...Array.from({ length: padTop }, (_, i) => ({ key: `pad-${i}`, kind: "gap" as const, text: " " })),
    ...viewLines,
  ];
  return { lines, bottomLines, totalLines, budget, viewTop: top, scrolled: top < maxTop };
}

