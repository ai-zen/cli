// 由 src/tui/screens.tsx 拆分而来 —— 行模型与预折行
import { wrapText, displayWidth } from "../text.js";
import { theme, syntaxStyle } from "../theme.js";
import { highlightCode, highlightJson, splitFences, type HlToken } from "../highlight.js";

// ==================== 行模型（对话区按行渲染，精确控高）====================

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

export interface ToolLine {
  name: string;
  args: string;
}

export type Block =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; reasoning: string; content: string; tools: ToolLine[] }
  | { id: number; kind: "notice"; tone: "info" | "error"; text: string };

export interface LiveAssistant {
  reasoning: string;
  content: string;
  tools: ToolLine[];
  sub: string | null;
  /**
   * 本轮（一次 API 请求）工具调用在 `tools` 中的起始下标。
   *
   * AI 一轮回复里可并行调用多个工具，且**工具执行后会在同一轮对话内继续下一轮**
   * （每次请求 SDK 都 `emit("open")`）；每轮的 `tool_calls.index` 都会从 `0` 重新
   * 计数。用它分段，避免新一轮与上一轮同 index 的工具调用被拼到同一行
   * （如 `read` + `edit` → `readedit`）。
   */
  roundBase?: number;
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

/** 按显示宽度把分段折行（逐字符硬断，贴合代码），并合并相邻同样式分段 */
function wrapSpans(spans: Span[], limit: number): Span[][] {
  const max = Math.max(1, limit);
  const rows: Span[][] = [];
  let row: Span[] = [];
  let width = 0;
  const flush = () => {
    rows.push(row);
    row = [];
    width = 0;
  };
  for (const span of spans) {
    for (const ch of span.text) {
      const w = displayWidth(ch);
      if (row.length && width + w > max) flush();
      const last = row[row.length - 1];
      if (
        last &&
        last.color === span.color &&
        last.dim === span.dim &&
        last.bold === span.bold &&
        last.italic === span.italic
      ) {
        last.text += ch;
      } else {
        row.push({ ...span, text: ch });
      }
      width += w;
    }
  }
  if (row.length || rows.length === 0) rows.push(row);
  return rows;
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
    for (const ch of span.text) {
      const w = displayWidth(ch);
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
function spanLine(key: string, kind: LineKind, spans: Span[]): RLine {
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
 * 正文 / 思考内容 → 预折行；**围栏代码块**（` ```lang `）按语言高亮，其余按普通文本折行。
 * 围栏行本身不显示（见 `splitFences`）。
 */
export function contentLines(kind: LineKind, key: string, text: string, width: number): RLine[] {
  const out: RLine[] = [];
  let n = 0;
  for (const seg of splitFences(text)) {
    if (seg.type === "text") {
      for (const row of wrapText(seg.text, width)) {
        out.push({ key: `${key}-${n++}`, kind, text: `  ${row}` });
      }
    } else {
      for (const rowTokens of splitTokenLines(highlightCode(seg.text, seg.lang))) {
        for (const rowSpans of wrapSpans(tokensToSpans(rowTokens), width)) {
          out.push(spanLine(`${key}-${n++}`, kind, [{ text: "  " }, ...rowSpans]));
        }
      }
    }
  }
  return out;
}

/** 单个对话块 → 若干预折行 */
export function blockToLines(block: Block, columns: number): RLine[] {
  const width = innerWidth(columns);
  const id = `b${block.id}`;
  if (block.kind === "user") {
    return [
      { key: `${id}-gap`, kind: "gap", text: " " },
      { key: `${id}-h`, kind: "user-header", text: "❯ 你" },
      ...indentLines("user-text", id, block.text, width),
    ];
  }
  if (block.kind === "notice") {
    const prefix = block.tone === "error" ? "✖ " : "· ";
    return wrapText(block.text, width).map((line, i) => ({
      key: `${id}-${i}`,
      kind: block.tone === "error" ? ("error" as const) : ("notice" as const),
      text: `  ${i === 0 ? prefix : "  "}${line}`,
    }));
  }
  const lines: RLine[] = [
    { key: `${id}-gap`, kind: "gap", text: " " },
    { key: `${id}-h`, kind: "ai-header", text: "✦ AI" },
  ];
  if (block.reasoning.trim()) {
    lines.push(...contentLines("reasoning", `${id}-r`, block.reasoning.trim(), width));
  }
  for (const tool of block.tools) {
    if (tool.name) {
      lines.push(spanLine(`${id}-t${lines.length}`, "tool", clipSpans(toolSpans(tool.name, tool.args), columns - 2)));
    }
  }
  if (block.content.trim()) {
    // 思考 / 工具与正文之间留一个空行，便于区分「过程」与「结论」
    if (lines.length > 2) lines.push({ key: `${id}-cgap`, kind: "gap", text: " " });
    lines.push(...contentLines("content", `${id}-c`, block.content.trim(), width));
  }
  return lines;
}

/** 流式中的 AI 块 → 若干预折行（与完成态一致：前置一个空行隔开上文） */
export function liveToLines(live: LiveAssistant, columns: number): RLine[] {
  const width = innerWidth(columns);
  const id = "live";
  const lines: RLine[] = [
    { key: `${id}-gap`, kind: "gap", text: " " },
    { key: `${id}-h`, kind: "ai-header", text: "✦ AI" },
  ];
  if (live.reasoning.trim()) {
    lines.push(...contentLines("reasoning", `${id}-r`, live.reasoning.trim(), width));
  }
  for (const tool of live.tools) {
    if (tool.name) {
      lines.push(spanLine(`${id}-t${lines.length}`, "tool", clipSpans(toolSpans(tool.name, tool.args), columns - 2)));
    }
  }
  if (live.content.trim()) {
    // 思考 / 工具与正文之间留一个空行，便于区分「过程」与「结论」
    if (lines.length > 2) lines.push({ key: `${id}-cgap`, kind: "gap", text: " " });
    lines.push(...contentLines("content", `${id}-c`, live.content.trim(), width));
  }
  return lines;
}
