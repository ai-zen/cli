// 由 src/tui/screens.tsx 拆分而来 —— 行渲染与「消息 → 块」
import { Text } from "ink";
import { AgentNS } from "@ai-zen/agents-core";
import { theme } from "../theme.js";
import { RLine, ToolLine, Block } from "./lines.js";
import { nextId } from "./state.js";

// ==================== 行渲染 ====================

export function LineView({ line }: { line: RLine }) {
  switch (line.kind) {
    case "gap":
      return <Text>{line.text}</Text>;
    case "user-header":
      return <Text color={theme.user} bold>{line.text}</Text>;
    case "user-text":
      return <Text wrap="truncate">{line.text}</Text>;
    case "ai-header":
      return <Text color={theme.brand[2]} bold>{line.text}</Text>;
    case "reasoning":
      return <Text color={theme.reasoning} italic wrap="truncate">{line.text}</Text>;
    case "tool":
      return <Text color={theme.tool} wrap="truncate">{line.text}</Text>;
    case "content":
      return <Text color={theme.assistant} wrap="truncate">{line.text}</Text>;
    case "notice":
      return <Text color={theme.dim} wrap="truncate">{line.text}</Text>;
    case "error":
      return <Text color={theme.error} wrap="truncate">{line.text}</Text>;
    default:
      return <Text>{line.text}</Text>;
  }
}

// ==================== 消息 → 块（撤回后重建视图）====================

export function contentToText(content: AgentNS.MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "image_url"
          ? `[图片: ${part.image_url.url}]`
          : "",
    )
    .join("");
}

export function messagesToBlocks(messages: AgentNS.Message[]): Block[] {
  const blocks: Block[] = [];
  for (const message of messages) {
    if (message.role === AgentNS.Role.User) {
      const text = contentToText(message.content);
      if (text.trim()) blocks.push({ id: nextId(), kind: "user", text });
    } else if (message.role === AgentNS.Role.Assistant) {
      const content = contentToText(message.content);
      const reasoning = message.reasoning_content ?? "";
      const tools: ToolLine[] = (message.tool_calls ?? []).map((tc) => ({
        name: tc.function?.name ?? "",
        args: tc.function?.arguments ?? "",
      }));
      if (content.trim() || reasoning.trim() || tools.some((t) => t.name)) {
        blocks.push({ id: nextId(), kind: "assistant", reasoning, content, tools });
      }
    }
  }
  return blocks;
}

export function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

