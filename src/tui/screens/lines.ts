// 行渲染原语 —— 折行 / 语法高亮 / 裁剪（与「渲染来源」解耦，纯函数）
import { wrapText, displayWidth, clusterWidth, graphemes } from "../text.js";
import { theme, syntaxStyle } from "../theme.js";
import { highlightCode, highlightJson, splitFences, type HlToken } from "../highlight.js";

// ==================== 行模型 ====================

export type LineKind =
  | "gap"
  | "user-header"
  | "user-text"
  | "ai-header"
  | "reasoning"
  | "tool"
  | "content"
  | "notice"
  | "error";

/** 行内**着色分段**：存在则逐段渲染（语法高亮），否则整行按 kind 默认色渲染 */
export interface Span {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
}

export interface RLine {
  key: string;
  kind: LineKind;
  text: string;
  /** 着色分段；`text` 恒为这些分段的纯文本拼接（便于测试与裁剪） */
  spans?: Span[];
}

/** 缩进 2 列后的可用文本宽度 */
export function innerWidth(columns: number): number {
  return Math.max(4, columns - 4);
}

export function indentLines(kind: LineKind, key: string, text: string, width: number): RLine[] {
  return wrapText(text, width).map((line, i) => ({ key: `${key}-${i}`, kind, text: `  ${line}` }));
}

// ==================== 语法高亮 → 分段 ====================

/** scope → 样式覆盖（未知 scope 沿用所在行基础色） */
function scopeSpan(text: string, scope: string): Span {
  return { text, ...syntaxStyle(scope) };
}

function tokensToSpans(tokens: HlToken[]): Span[] {
  return tokens.map((t) => scopeSpan(t.text, t.scope));
}

/** 把含换行的 token 序列按行切开（保留行内 token 结构） */
function splitTokenLines(tokens: HlToken[]): HlToken[][] {
  const rows: HlToken[][] = [[]];
  for (const t of tokens) {
    t.text.split("\n").forEach((part, i) => {
      if (i > 0) rows.push([]);
      if (part) rows[rows.length - 1]!.push({ text: part, scope: t.scope });
    });
  }
  return rows;
}

/**
 * 折行单元：**单字素簇** + 其样式（仅颜色/属性，不含文本）。
 *
 * 必须是字素簇而不是 code point：`✌️` 是两个 code point 但占 2 列、`👨‍👩‍👧`
 * 是五个 code point 但只占 2 列。按 code point 建单元会让宽度算错（VS16 序列少算
 * → 行超宽 → Ink 渲染期二次折行 → 整帧高出一行，把输入框顶出屏幕；ZWJ 序列多算
 * → 提前折行）。宽度一律取 `clusterWidth()`，与 Ink 排版用的是同一把尺子。
 */
interface SpanCell {
  ch: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
}

function toCells(spans: Span[]): SpanCell[] {
  const cells: SpanCell[] = [];
  for (const s of spans) {
    for (const ch of graphemes(s.text)) {
      cells.push({ ch, color: s.color, dim: s.dim, bold: s.bold, italic: s.italic });
    }
  }
  return cells;
}

/** 折行单元序列 → 分段（合并相邻同样式，减少渲染节点） */
function cellsToSpans(cells: SpanCell[]): Span[] {
  const out: Span[] = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (
      last &&
      last.color === cell.color &&
      last.dim === cell.dim &&
      last.bold === cell.bold &&
      last.italic === cell.italic
    ) {
      last.text += cell.ch;
    } else {
      out.push({ text: cell.ch, color: cell.color, dim: cell.dim, bold: cell.bold, italic: cell.italic });
    }
  }
  return out;
}

/**
 * 按显示宽度把分段折行，并合并相邻同样式分段。
 *
 * - `preferSpace=false`（默认，代码块）：逐字符硬断，保留缩进语义；
 * - `preferSpace=true`（散文 / markdown 正文）：优先在**最近的空格处**断行，
 *   避免把英文单词从中间切断。
 */
function wrapSpans(spans: Span[], limit: number, preferSpace = false): Span[][] {
  const max = Math.max(1, limit);
  const cells = toCells(spans);
  const rows: SpanCell[][] = [];
  let row: SpanCell[] = [];
  let width = 0;
  let lastSpace = -1; // 当前行内最后一个空格的下标（用于空格优先断行）
  const reset = () => {
    row = [];
    width = 0;
    lastSpace = -1;
  };
  for (const cell of cells) {
    const w = clusterWidth(cell.ch);
    if (row.length && width + w > max) {
      if (preferSpace && lastSpace > 0) {
        // 在最近的空格处断开：空格及其右侧内容折到下一行
        rows.push(row.slice(0, lastSpace));
        const tail = row.slice(lastSpace + 1);
        reset();
        row = tail;
        width = tail.reduce((sum, c) => sum + clusterWidth(c.ch), 0);
        for (let i = tail.length - 1; i >= 0; i -= 1) {
          if (tail[i]!.ch === " ") {
            lastSpace = i;
            break;
          }
        }
      } else {
        rows.push(row);
        reset();
      }
    }
    row.push(cell);
    width += w;
    if (cell.ch === " ") lastSpace = row.length - 1;
  }
  if (row.length || rows.length === 0) rows.push(row);
  return rows.map(cellsToSpans);
}

/** 按显示宽度把分段裁成**严格单行**，超出补省略号（用于工具调用行） */
export function clipSpans(spans: Span[], max: number): Span[] {
  const limit = Math.max(1, max);
  const total = spans.reduce((sum, s) => sum + displayWidth(s.text), 0);
  if (total <= limit) return spans;
  const out: Span[] = [];
  let width = 0;
  for (const span of spans) {
    let text = "";
    for (const ch of graphemes(span.text)) {
      const w = clusterWidth(ch);
      if (width + w > limit - 1) {
        if (text) out.push({ ...span, text });
        out.push({ text: "…" });
        return out;
      }
      text += ch;
      width += w;
    }
    if (text) out.push({ ...span, text });
  }
  out.push({ text: "…" });
  return out;
}

/** 由分段拼出 RLine（`text` = 分段纯文本拼接） */
export function spanLine(key: string, kind: LineKind, spans: Span[]): RLine {
  return { key, kind, text: spans.map((s) => s.text).join(""), spans };
}

/**
 * 工具调用行的分段：`  ⚙ name(args)`，参数按 **JSON** 高亮。
 * 无参数时省略括号；调用方用 `clipSpans` 裁成严格单行。
 */
export function toolSpans(name: string, args: string): Span[] {
  const spans: Span[] = [{ text: "  " }, { text: `⚙ ${name}`, color: theme.tool }];
  const inline = args.replace(/\s+/g, " ").trim();
  if (inline) {
    spans.push(scopeSpan("(", "punctuation"));
    spans.push(...tokensToSpans(highlightJson(inline)));
    spans.push(scopeSpan(")", "punctuation"));
  }
  return spans;
}

/**
 * 正文 / 思考内容 → 预折行。
 *
 * - **普通文本段**按 **markdown 源码着色**（`highlightCode(text, "markdown")`）：
 *   AI 回答本身就是 markdown，交给 highlight.js 的 markdown 词法上色，标记符（`#`/`**`/`` ` `` 等）
 *   原样保留、只染色（不做语义渲染）；
 * - **围栏代码块**按标注语言做语法高亮，并**保留围栏行**（` ```lang ` 与 ` ``` `，
 *   以低调的暗灰渲染），不丢弃 —— 便于一眼看出代码块边界与语言。
 *   未标注 / 未知语言则不着色。
 *
 * 正文段用**空格优先**折行，代码段逐字符硬断。
 */
export function contentLines(kind: LineKind, key: string, text: string, width: number): RLine[] {
  const out: RLine[] = [];
  let n = 0;
  for (const seg of splitFences(text)) {
    const isCode = seg.type === "code";
    if (isCode) {
      // 开围栏（保留语言标注）
      const open = seg.lang ? `\`\`\`${seg.lang}` : "```";
      out.push(spanLine(`${key}-${n++}`, kind, [{ text: "  " }, { text: open, color: theme.dim }]));
    }
    const lang = isCode ? seg.lang : "markdown";
    for (const rowTokens of splitTokenLines(highlightCode(seg.text, lang))) {
      for (const rowSpans of wrapSpans(tokensToSpans(rowTokens), width, !isCode)) {
        out.push(spanLine(`${key}-${n++}`, kind, [{ text: "  " }, ...rowSpans]));
      }
    }
    if (isCode) {
      // 闭围栏
      out.push(spanLine(`${key}-${n++}`, kind, [{ text: "  " }, { text: "```", color: theme.dim }]));
    }
  }
  return out;
}
