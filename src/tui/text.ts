/**
 * TUI 文本度量与折行 —— 纯函数（无 React / Ink 依赖）
 *
 * 从 `screens.tsx` 中抽出，供对话屏、凭据设置屏、配置中心共用，
 * 避免 `screens.tsx ↔ config-wizard.tsx` 相互 import 形成循环依赖。
 */

import stringWidth from "string-width";
import { isMouseSequence } from "./mouse.js";

// ==================== 显示宽度 ====================
//
// 宽度计算直接交给 `string-width` —— **Ink 排版时用的就是它**
//（`ink/build/output.js` 第一行 `import stringWidth from 'string-width'`）。
//
// 曾经这里手写了一张 `isWide` 区间表，逐 code point 累加。结果是两把尺子：
//   - `⚡` `✅` `✨` `⭐` 这类 East Asian Wide 符号我们算 1 列、Ink 算 2 列；
//   - `👨‍👩‍👧` 逐 code point 累加得 8 列，实际只占 2 列；
//   - `✌️`（VS16 序列）与 `🇨🇳`（国旗对）同样对不上。
// 于是一切依赖宽度的东西（折行、状态栏装行、光标列号）都差一截，还靠
// 「预留 1 列余量」硬顶。现在两边用同一把尺子，这类偏差从根上没了。
//
// 仍然需要 `graphemes()`：`string-width` 只管宽度，不管「光标该以什么为单位移动」。

/**
 * 单簇宽度缓存 —— `string-width` 内部要跑 emoji / EAW 正则，而折行是每帧热路径；
 * 字素簇的种类远少于出现次数，缓存后几乎零成本。
 */
const clusterWidthCache = new Map<string, number>();
const CLUSTER_CACHE_LIMIT = 4096;

/** 终端显示宽度（按字素簇，与 Ink 的排版完全一致） */
export function displayWidth(text: string): number {
  if (text === "") return 0;
  return stringWidth(text);
}

/** 单个字素簇的显示宽度（结果带缓存） */
export function clusterWidth(cluster: string): number {
  if (cluster === "") return 0;
  const cached = clusterWidthCache.get(cluster);
  if (cached !== undefined) return cached;
  const width = stringWidth(cluster);
  if (clusterWidthCache.size >= CLUSTER_CACHE_LIMIT) clusterWidthCache.clear();
  clusterWidthCache.set(cluster, width);
  return width;
}

/**
 * 把一个字符串切成**字素簇**（用户感知的「一个字符」）。
 *
 * 为什么不能按 code point 切：`✌️` 是 `U+270C U+FE0F` 两个 code point、`👨‍👩‍👧` 是
 * 五个、`🇨🇳` 是两个区域指示符——它们都是**一个**字素簇。按 code point 切会让光标
 * 停在簇中间（例如停在 `✌` 与 `U+FE0F` 之间），后果是：
 *   - 反显光标变成在反显一个变体选择符 —— 屏幕上什么都不显示（实测：Ink 的输出里
 *     整个反显段直接消失）；
 *   - 退格只删掉半个 emoji，留下一个孤立的 `U+FE0F`；
 *   - 光标列号也会因为「半个簇」的宽度而算错。
 *
 * 用 `Intl.Segmenter`（Node 内置，无需依赖）；环境不支持时退回 code point 切分。
 */
const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh", { granularity: "grapheme" })
    : null;

export function graphemes(text: string): string[] {
  if (text === "") return [];
  if (!segmenter) return Array.from(text);
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/**
 * 按显示宽度把文本折成多行（保留显式换行）。
 * 拉丁文优先在空格处断行，CJK / 超长词按**字素簇**硬断；保证每行显示宽度 ≤ limit。
 */
export function wrapText(text: string, limit: number): string[] {
  const width = Math.max(1, limit);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const ch of graphemes(raw)) {
      const w = clusterWidth(ch);
      if (lineWidth + w > width && line !== "") {
        const space = line.lastIndexOf(" ");
        if (space > 0) {
          out.push(line.slice(0, space));
          line = line.slice(space + 1);
          lineWidth = displayWidth(line);
        } else {
          out.push(line);
          line = "";
          lineWidth = 0;
        }
      }
      line += ch;
      lineWidth += w;
    }
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}

// ==================== 单行输入区折行与光标定位 ====================

/** 带光标位置的输入区折行结果 */
export interface InputLayout {
  /** 折行后的各行文本（不含提示符） */
  lines: string[];
  /** 光标所在行（0 起始） */
  cursorRow: number;
  /** 光标在该行内的字符偏移（**字素簇**计，不是 code point） */
  cursorCol: number;
}

/**
 * 把输入文本按显示宽度折行，并定位光标（`cursor` 为**字素簇**索引）。
 * 折行采用逐簇硬断（不做空格优先），以保证光标映射精确、支持跨行编辑。
 */
export function layoutInput(text: string, cursor: number, width: number): InputLayout {
  const limit = Math.max(1, width);
  const chars = graphemes(text);
  const pos = Math.max(0, Math.min(cursor, chars.length));
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  let row = 0;
  let col = 0;
  let cursorRow = 0;
  let cursorCol = 0;
  let processed = 0;
  // 记录「处理完 processed 个簇后」的光标位置；processed === pos 即为光标处
  const mark = () => {
    if (processed === pos) {
      cursorRow = row;
      cursorCol = col;
    }
  };
  mark();
  for (const ch of chars) {
    if (ch === "\n") {
      lines.push(line);
      line = "";
      lineWidth = 0;
      row += 1;
      col = 0;
      processed += 1;
      mark();
      continue;
    }
    const w = clusterWidth(ch);
    if (col > 0 && lineWidth + w > limit) {
      lines.push(line);
      line = "";
      lineWidth = 0;
      row += 1;
      col = 0;
    }
    line += ch;
    lineWidth += w;
    col += 1;
    processed += 1;
    mark();
  }
  lines.push(line);
  mark();
  return { lines, cursorRow, cursorCol };
}

/** 单行输入左侧留白：Box paddingX(1) + 提示符 `❯ `（宽 2） */
export const INPUT_PREFIX_WIDTH = 3;

/**
 * 判断一段输入是否为「终端上报序列」而非用户输入。
 *
 * 典型来源：
 *   - Kitty 键盘协议查询的应答：`CSI ? <flags> u`（Ink 开启 `kittyKeyboard` 时会发 `CSI ? u`）；
 *   - 光标位置报告（CPR）：`CSI <row>;<col> R`；
 *   - 设备状态报告：`CSI ? <n> n`；
 *   - 鼠标上报（SGR）：`CSI < b ; x ; y M`——滚轮 / 点击 / 拖拽，见 `mouse.ts`。
 *
 * 这类序列本应由 Ink 的解析器整体吞掉。但当它被**拆包**时（前导 ESC 被 Ink 的
 * 「待定转义刷新定时器」当作一次独立的 Escape 键消费），残留在后一个 chunk 里的
 * `[?0u` 会退化成普通文本并被当作输入插入输入框（实测重现）。此处做一层护栏；
 * 根因（不再向终端发查询）已在渲染选项里关闭。
 *
 * 鼠标上报是**主动开启**的（`src/tui/mouse.ts`），且 Ink 会把整条序列当作 `char`
 * 交给 `useInput`，所以这里必须兜住——否则滚一下就往输入框里插一段 `[<64;10;5M`。
 * 注意：需要读滚轮的屏（对话屏）必须**在处理完滚轮之后**再调用本函数。
 */
export function isTerminalReply(sequence: string): boolean {
  return (
    /^\[\?\d+u$/.test(sequence) || // Kitty 键盘协议应答（CSI ? <flags> u）
    /^\[\d+;\d+R$/.test(sequence) || // 光标位置报告（CSI <row>;<col> R）
    /^\[\?\d+n$/.test(sequence) || // 设备状态报告（CSI ? <n> n）
    isMouseSequence(sequence) // 鼠标上报（CSI < b ; x ; y M|m）
  );
}

/**
 * 按显示宽度裁剪文本：超出上限则截断并补省略号（宽字符计 2 列）。
 *
 * 用于列表项等「必须恰好占一行」的场景 —— 让 Ink 不会二次折行，
 * 自底部向上布局时才能精确算出顶部留白。
 */
export function clipWidth(text: string, max: number): string {
  const limit = Math.max(1, max);
  if (displayWidth(text) <= limit) return text;
  let out = "";
  let width = 0;
  for (const ch of graphemes(text)) {
    const w = clusterWidth(ch);
    if (width + w > limit - 1) break; // 预留 1 列给省略号
    out += ch;
    width += w;
  }
  return `${out}…`;
}

// ==================== 整帧高度 ====================

/**
 * 整帧可用高度 = 终端行数 − 1。
 *
 * Ink 在主输出高度 ≥ 终端行数时判定为「全屏」（`ink/build/ink.js`）：Windows 控制台下
 * 每帧强制 `clearTerminal`，且渲染串末尾不补换行；但硬件光标定位仍假设「光标停在最后
 * 一行之后」，于是整体上移一行（IME 候选框随之偏上）。预留最后一行，让整帧高度严格小于
 * 终端行数，即可避开该分支，硬件光标与自绘光标精确对齐。
 */
export function usableFrameRows(terminalRows: number): number {
  return Math.max(1, terminalRows - 1);
}

/**
 * 自底部向上布局时的**顶部留白行数**。
 *
 * 内容行数不足一帧时，用空白行把内容顶到下方（吸底），而不是让它飘在顶部：
 * 短帧飘在顶部时，从「对话屏整帧」切过来的那一次重绘会因擦除/滚动错位被顶出视口，
 * 在 VS Code 等终端里表现为内容被截掉。顶到下方后，两种屏幕的帧高一致、内容贴底，
 * 既不会被裁剪，也顺带消掉了帧高突变带来的擦除错位。
 *
 * 传入行数超过一帧时返回 0（由调用方负责限制内容行数）。
 */
export function bottomPadding(terminalRows: number, contentLines: number): number {
  return Math.max(0, usableFrameRows(terminalRows) - Math.max(0, contentLines));
}

/**
 * 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示。
 * 该提示是喂给模型的上下文，不该显示给用户。
 */
export function stripCwdNote(text: string): string {
  return text.replace(/\n+(?:\[工作目录变更\]\n)?当前工作目录: [^\n]*$/, "");
}
