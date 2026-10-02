/**
 * TUI 文本度量与折行 —— 纯函数（无 React / Ink 依赖）
 *
 * 从 `screens.tsx` 中抽出，供对话屏、凭据设置屏、配置中心共用，
 * 避免 `screens.tsx ↔ config-wizard.tsx` 相互 import 形成循环依赖。
 */

// ==================== 显示宽度 ====================

/** 是否宽字符（CJK / 全角 / 常见 Emoji），占 2 列 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 终端显示宽度（宽字符计 2，组合字符计 0） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0300 && cp <= 0x036f) continue; // 组合附加符号
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度把文本折成多行（保留显式换行）。
 * 拉丁文优先在空格处断行，CJK / 超长词按字符硬断；保证每行显示宽度 ≤ limit。
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
    for (const ch of raw) {
      const w = displayWidth(ch);
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
  /** 光标在该行内的字符偏移（code point 计） */
  cursorCol: number;
}

/**
 * 把输入文本按显示宽度折行，并定位光标（`cursor` 为字符索引，以 code point 计）。
 * 折行采用逐字符硬断（不做空格优先），以保证光标映射精确、支持跨行编辑。
 */
export function layoutInput(text: string, cursor: number, width: number): InputLayout {
  const limit = Math.max(1, width);
  const chars = Array.from(text);
  const pos = Math.max(0, Math.min(cursor, chars.length));
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  let row = 0;
  let col = 0;
  let cursorRow = 0;
  let cursorCol = 0;
  let processed = 0;
  // 记录「处理完 processed 个字符后」的光标位置；processed === pos 即为光标处
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
    const w = displayWidth(ch);
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
 * 判断一段输入是否为「终端应答序列」而非用户输入。
 *
 * 典型来源：
 *   - Kitty 键盘协议查询的应答：`CSI ? <flags> u`（Ink 开启 `kittyKeyboard` 时会发 `CSI ? u`）；
 *   - 光标位置报告（CPR）：`CSI <row>;<col> R`；
 *   - 设备状态报告：`CSI ? <n> n`。
 *
 * 这类序列本应由 Ink 的解析器整体吞掉。但当它被**拆包**时（前导 ESC 被 Ink 的
 * 「待定转义刷新定时器」当作一次独立的 Escape 键消费），残留在后一个 chunk 里的
 * `[?0u` 会退化成普通文本并被当作输入插入输入框（实测重现）。此处做一层护栏；
 * 根因（不再向终端发查询）已在渲染选项里关闭。
 */
export function isTerminalReply(sequence: string): boolean {
  return (
    /^\[\?\d+u$/.test(sequence) || // Kitty 键盘协议应答（CSI ? <flags> u）
    /^\[\d+;\d+R$/.test(sequence) || // 光标位置报告（CSI <row>;<col> R）
    /^\[\?\d+n$/.test(sequence) // 设备状态报告（CSI ? <n> n）
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
  for (const ch of text) {
    const w = displayWidth(ch);
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
