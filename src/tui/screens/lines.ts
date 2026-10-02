// 由 src/tui/screens.tsx 拆分而来 —— 行模型与预折行
import { wrapText, clipWidth } from "../text.js";

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

export interface RLine {
  key: string;
  kind: LineKind;
  text: string;
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

/**
 * 工具调用行的单行文本：`  ⚙ name(args)`。
 *
 * 参数（`args`，流式累积的 JSON 片段）折叠空白后内联展示；无参数时省略括号。
 * 调用方按显示宽度 `clipWidth` 裁剪，保证**严格单行**（折行会顶高吸底整帧）。
 */
export function toolLineText(name: string, args: string): string {
  const inline = args.replace(/\s+/g, " ").trim();
  return inline ? `  ⚙ ${name}(${inline})` : `  ⚙ ${name}`;
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
    lines.push(...indentLines("reasoning", `${id}-r`, block.reasoning.trim(), width));
  }
  for (const tool of block.tools) {
    if (tool.name) {
      lines.push({
        key: `${id}-t${lines.length}`,
        kind: "tool",
        text: clipWidth(toolLineText(tool.name, tool.args), columns - 2),
      });
    }
  }
  if (block.content.trim()) {
    // 思考 / 工具与正文之间留一个空行，便于区分「过程」与「结论」
    if (lines.length > 2) lines.push({ key: `${id}-cgap`, kind: "gap", text: " " });
    lines.push(...indentLines("content", `${id}-c`, block.content.trim(), width));
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
    lines.push(...indentLines("reasoning", `${id}-r`, live.reasoning.trim(), width));
  }
  for (const tool of live.tools) {
    if (tool.name) {
      lines.push({
        key: `${id}-t${lines.length}`,
        kind: "tool",
        text: clipWidth(toolLineText(tool.name, tool.args), columns - 2),
      });
    }
  }
  if (live.content.trim()) {
    // 思考 / 工具与正文之间留一个空行，便于区分「过程」与「结论」
    if (lines.length > 2) lines.push({ key: `${id}-cgap`, kind: "gap", text: " " });
    lines.push(...indentLines("content", `${id}-c`, live.content.trim(), width));
  }
  return lines;
}

