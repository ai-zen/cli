// 对话屏布局 —— 吸底 + 应用内翻页（只做截取 / 补白，不自建转录内容）
import { RLine } from "./lines.js";
import { inputLines, INPUT_MAX_ROWS } from "./input.js";
import { usableFrameRows } from "../text.js";

/** 确认框固定高度（外 marginTop 1 + 上下边框 2 + 问题 1 + marginTop 1 + 选项 1） */
export const CONFIRM_LINES = 6;
/** 底部状态栏行数下限：模型/Agent 一行 + 用量与速率一行（宽度不够时会折成更多行，
 *  实际值由 `statusBarRows()` 量出后传入 `computeChatLayout({ statusBarLines })`） */
export const STATUS_BAR_LINES = 2;
/** 选择覆盖层高度（相对条目数） */
export function pickerLines(itemCount: number): number {
  return 7 + itemCount;
}

/**
 * 一个终端能放下多少条**选择器候选**。
 *
 * 为什么它是渲染层的函数：它由两个渲染事实构成 —— 帧高要预留下末行
 * （`usableFrameRows`）、覆盖层与状态栏各占几行（`pickerLines` / `STATUS_BAR_LINES`）。
 * 命令层（`/load` / `/back`）只需要那个**结果**（`ChatCommandHost.rows`）：把这三条公式
 * 搬到命令层，就是拿一个终端概念去换一个 ink 依赖（它们全在 `tui/` 里）。
 *
 * 这条式子只该有一处，且那一处要在能看到布局的地方：它少扣 2 行，选择器就会把状态栏顶出屏幕。
 */
export function pickerCapacity(terminalRows: number): number {
  return Math.max(1, usableFrameRows(terminalRows) - (pickerLines(0) + STATUS_BAR_LINES));
}

/** Agent 栏目行数：只有「存在子 Agent」时才出现，且恒为一行（超出宽度由组件截断） */
export const AGENT_TABS_LINES = 1;

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
  /**
   * 待发送附件行数（粘贴图片的提示行，位于通知栏与菜单之间）。
   * 与 `noticeCount` / `agentTabLines` 同类：多算或少算一行，输入框就会整体位移，
   * 硬件光标（IME）也跟着偏。缺省 0。
   */
  attachmentLines?: number;
  /**
   * Agent 栏目行数（主 / 子 Agent 切换条，位于对话区与底栏之间）。
   * 无子 Agent 时为 0（不占位）；缺省 0。
   */
  agentTabLines?: number;
  overlay: "none" | "confirm" | "picker";
  pickerItems: number;
  /** 视口顶部行索引（相对整个对话行）；null / undefined = 贴底（自动跟随最新） */
  viewTop?: number | null;
  /**
   * 状态栏实际占据的行数（由 `statusBarRows()` 实测得出 —— 它会随终端宽度折行）。
   * 缺省用 `STATUS_BAR_LINES`。
   */
  statusBarLines?: number;
  /**
   * 内容不足一屏时，余量怎么分。
   *
   * 缺省 `bottom`：余量全部补在头部，内容贴底（对话屏的常规行为——最新一行的
   * 下沿永远紧挨分隔线）。
   *
   * `center`：余量上下均分，内容落在对话区垂直中部 —— 只用于空对话的欢迎块
   * （否则 6 行 logo + 标语只能贴顶或贴底，两个位置都不好看）。
   *
   * 内容超出一屏时该参数无效（此时两侧都没有余量）。
   */
  anchor?: "bottom" | "center";
}

export interface ChatLayout {
  /** 对话区（含顶部补齐空行），行数恒为 `rows - bottomLines` */
  lines: RLine[];
  /** 底部区域（输入 / 覆盖层 + 状态栏）占用行数 */
  bottomLines: number;
  /** 对话框总行数（未截取前） */
  totalLines: number;
  /**
   * 菜单**实际**占用的行数（`min(想吃, 剩余空间)`）。
   *
   * 渲染（`BottomMenu.maxRows`）与硬件光标（`computeInputCursorPosition` 的
   * `hintCount`）都必须从这里取，不许自己另算 —— 三处差一行，输入框与 IME 候选框
   * 就会整体偏移（通知栏最容易被漏算）。
   */
  hintRows: number;
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

  // 输入区限高：多出来的折行由窗口滚动，而不是把对话区挤空（窗口跟随光标）
  const inputHeight = input.busy
    ? 1
    : Math.min(inputLines(input.input, input.columns).length, INPUT_MAX_ROWS);
  const overlayHeight =
    input.overlay === "confirm"
      ? CONFIRM_LINES
      : input.overlay === "picker"
        ? pickerLines(input.pickerItems)
        : 0;
  const noticeCount = input.noticeCount ?? 0;
  const attachmentLines = input.attachmentLines ?? 0;
  const agentTabLines = input.agentTabLines ?? 0;
  const statusBarLines = Math.max(1, input.statusBarLines ?? STATUS_BAR_LINES);
  /** 菜单之外、恒占的底部行（含输入框与状态栏） */
  const fixedBottom =
    agentTabLines /* Agent 栏目 */ +
    noticeCount /* 通知栏 */ +
    attachmentLines /* 附件提示行 */ +
    1 /* 分隔线 */ +
    inputHeight +
    statusBarLines;
  /**
   * 菜单能吃多少行：输入框上方到屏幕顶端的**全部**剩余空间，不设固定行数上限 ——
   * 放不下的候选由 `BottomMenu` 从顶端丢弃（滚动窗口）。
   *
   * 覆盖层（确认 / 选择器）整块替换输入区时菜单不参与布局，故归零。
   */
  const hintRows =
    input.overlay === "none"
      ? Math.min(Math.max(0, input.hintCount), Math.max(0, input.rows - fixedBottom))
      : 0;
  const bottomLines =
    input.overlay === "none" ? fixedBottom + hintRows : overlayHeight + statusBarLines;

  const budget = Math.max(0, input.rows - bottomLines);
  const totalLines = transcript.length;
  const maxTop = Math.max(0, totalLines - budget);
  const top = input.viewTop == null ? maxTop : Math.min(Math.max(0, input.viewTop), maxTop);
  const viewLines = transcript.slice(top, top + budget);
  const slack = Math.max(0, budget - viewLines.length);
  const padTop = input.anchor === "center" ? Math.floor(slack / 2) : slack;
  const padBottom = slack - padTop;
  const lines: RLine[] = [
    ...Array.from({ length: padTop }, (_, i) => ({
      key: `pad-${i}`,
      kind: "gap" as const,
      text: " ",
    })),
    ...viewLines,
    ...Array.from({ length: padBottom }, (_, i) => ({
      key: `tail-${i}`,
      kind: "gap" as const,
      text: " ",
    })),
  ];
  return { lines, bottomLines, totalLines, budget, viewTop: top, scrolled: top < maxTop, hintRows };
}
