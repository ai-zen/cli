// 渲染层 —— 直接以 SDK 的 `AgentNS.Message[]` 为唯一数据源产出 RLine（不经过任何自定义中间模型）
//
// 顺序即真相：遍历 messages 数组（跨消息天然有序）；单条 assistant 内恒为
// `reasoning_content → tool_calls → content`。因此 **不需要** 自定义 Block / LiveAssistant，
// 也不需要把流式 delta 翻译成中间事件 —— 流式中 SDK 会实时更新「当前那条 message」，
// 直接读它即可。
import { AgentNS } from "@ai-zen/agents-core";
import { RLine, contentLines, indentLines, clipSpans, toolSpans, spanLine, innerWidth } from "./lines.js";
import { stripCwdNote } from "../text.js";
import { t } from "../../i18n/index.js";

/** 从消息内容提取纯文本；非文本块（图片 / 文件）以占位文本表示 */
export function messageText(content: AgentNS.MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return t("msg.image", { url: part.image_url.url });
      if (part.type === "file") {
        const file = part as { file_id?: string; filename?: string };
        return t("msg.file", { name: file.file_id ?? file.filename ?? t("msg.inlineFile") });
      }
      return "";
    })
    .join("");
}

/** 单条消息 → 预折行（不可渲染的消息返回空数组） */
export function messageToLines(message: AgentNS.Message, columns: number): RLine[] {
  if (message.hidden || message.omit) return [];
  const key = `m${message.id}`;
  const width = innerWidth(columns);

  if (message.role === AgentNS.Role.User) {
    const text = stripCwdNote(messageText(message.content));
    if (!text.trim()) return [];
    return [
      { key: `${key}-gap`, kind: "gap", text: " " },
      { key: `${key}-h`, kind: "user-header", text: t("msg.userHeader") },
      ...indentLines("user-text", key, text, width),
    ];
  }

  if (message.role === AgentNS.Role.Assistant) {
    const reasoning = (message.reasoning_content ?? "").trim();
    const content = messageText(message.content).trim();
    const tools = (message.tool_calls ?? []).filter((t) => t?.function?.name);
    // 占位（流式尚未产出任何内容）：不渲染，避免空标题
    if (!reasoning && !content && tools.length === 0) return [];

    const lines: RLine[] = [
      { key: `${key}-gap`, kind: "gap", text: " " },
      { key: `${key}-h`, kind: "ai-header", text: "✦ AI" },
    ];
    if (reasoning) {
      lines.push(...contentLines("reasoning", `${key}-r`, reasoning, width));
    }
    if (reasoning && tools.length > 0) {
      // 思考与工具调用之间留一个空行，区分「过程」与「动作」
      lines.push({ key: `${key}-tg`, kind: "gap", text: " " });
    }
    tools.forEach((tool, i) => {
      const name = tool.function?.name ?? "";
      const args = tool.function?.arguments ?? "";
      lines.push(spanLine(`${key}-t${i}`, "tool", clipSpans(toolSpans(name, args), columns - 2)));
    });
    if (content) {
      // 思考 / 工具与正文之间留一个空行，便于区分「过程」与「结论」
      if (lines.length > 2) lines.push({ key: `${key}-cgap`, kind: "gap", text: " " });
      lines.push(...contentLines("content", `${key}-c`, content, width));
    }
    return lines;
  }

  // system / tool（工具结果）/ function：不进转录
  return [];
}

/** 内容签名：流式中同一条消息会持续增长，用它判断是否需要重算 */
function signature(message: AgentNS.Message): string {
  const reasoning = message.reasoning_content?.length ?? 0;
  const content =
    typeof message.content === "string"
      ? message.content.length
      : Array.isArray(message.content)
        ? message.content.length
        : 0;
  const tools =
    message.tool_calls?.reduce(
      (sum, t) => sum + (t.function?.name?.length ?? 0) + (t.function?.arguments?.length ?? 0),
      0,
    ) ?? 0;
  return `${reasoning}:${content}:${tools}:${message.status ?? ""}`;
}

/**
 * `messageToLines` 的缓存包装。
 *
 * 已完成消息的渲染结果按「消息对象 + 列宽 + 内容签名」缓存：流式期间每帧都要重排整个转录，
 * 命中缓存后历史消息的折行 / 高亮全部免算。用签名（而非仅对象身份）兜住「流式中那条正在
 * 增长的消息」——签名变了就重算，避免拿到陈旧结果。
 */
const messageLineCache = new WeakMap<AgentNS.Message, { columns: number; sig: string; lines: RLine[] }>();

export function cachedMessageToLines(message: AgentNS.Message, columns: number): RLine[] {
  const sig = signature(message);
  const hit = messageLineCache.get(message);
  if (hit && hit.columns === columns && hit.sig === sig) return hit.lines;
  const lines = messageToLines(message, columns);
  messageLineCache.set(message, { columns, sig, lines });
  return lines;
}

/** 整段转录 → 预折行 */
export function transcriptLines(messages: AgentNS.Message[], columns: number): RLine[] {
  const out: RLine[] = [];
  for (const message of messages) out.push(...cachedMessageToLines(message, columns));
  return out;
}
