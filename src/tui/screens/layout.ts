// 对话屏布局 —— 吸底 + 应用内翻页（只做截取 / 补白，不自建转录内容）
import { RLine } from "./lines.js";
import { inputLines } from "./input.js";

/** 确认框固定高度（外 marginTop 1 + 上下边框 2 + 问题 1 + marginTop 1 + 选项 1） */
export const CONFIRM_LINES = 6;
/** 底部状态栏行数下限：模型/Agent 一行 + 用量与速率一行（宽度不够时会折成更多行，
 *  实际值由 `statusBarRows()` 量出后传入 `computeChatLayout({ statusBarLines })`） */
export const STATUS_BAR_LINES = 2;
/** 选择覆盖层高度（相对条目数） */
export function pickerLines(itemCount: number): number {
  return 7 + itemCount;
}

export interface ChatLayoutInput {
  columns: number;
  rows: number;
  /** 已折行的对话行（由 messages-view 依 agent.messages 产出） */
  transcript: RLine[];
  input: string;
  busy: boolean;
  hintCount: number;
  /** 通知栏行数（notice / error 独立栏位），缺省 0 */
  noticeCount?: number;
  overlay: "none" | "confirm" | "picker";
  pickerItems: number;
  /** 视口顶部行索引（相对整个对话行）；null / undefined = 贴底（自动跟随最新） */
  viewTop?: number | null;
  /**
   * 状态栏实际占据的行数（由 `statusBarRows()` 实测得出 —— 它会随终端宽度折行）。
   * 缺省用 `STATUS_BAR_LINES`。
   */
  statusBarLines?: number;
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
 * 把「想要的视口顶部」钳制成合法值：下限 0、上限 `totalLines - budget`。
 *
 * 返回 `null` 表示**已贴底**（视口顶恰好等于最大顶，或内容不足一屏）—— 调用方据此
 * 清掉滚动状态，让视口重新跟随最新内容。所有滚动动作（翻页 / 按行 / 鼠标滚轮）都
 * 走这一个函数，越界方向自然被吃掉，不会出现「滚过头回不来」。
 */
export function clampViewTop(totalLines: number, budget: number, nextTop: number): number | null {
  const maxTop = Math.max(0, totalLines - budget);
  const clamped = Math.max(0, Math.min(maxTop, nextTop));
  return clamped >= maxTop ? null : clamped;
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
  const transcript = input.transcript;

  const inputHeight = input.busy ? 1 : inputLines(input.input, input.columns).length;
  const overlayHeight =
    input.overlay === "confirm"
      ? CONFIRM_LINES
      : input.overlay === "picker"
        ? pickerLines(input.pickerItems)
        : 0;
  const noticeCount = input.noticeCount ?? 0;
  const statusBarLines = Math.max(1, input.statusBarLines ?? STATUS_BAR_LINES);
  const bottomLines =
    input.overlay === "none"
      ? noticeCount /* 通知栏 */ + 1 /* 分隔线 */ + input.hintCount + inputHeight + statusBarLines
      : overlayHeight + statusBarLines;

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
