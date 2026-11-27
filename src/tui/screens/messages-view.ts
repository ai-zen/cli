// 渲染层 —— 直接以 SDK 的 `AgentNS.Message[]` 为唯一数据源产出 RLine（不经过任何自定义中间模型）
//
// 顺序即真相：遍历 messages 数组（跨消息天然有序）；单条 assistant 内恒为
// `reasoning_content → tool_calls → content`。因此 不需要 自定义 Block / LiveAssistant，
// 也不需要把流式 delta 翻译成中间事件 —— 流式中 SDK 会实时更新「当前那条 message」，
// 直接读它即可。
import { AgentNS } from "@ai-zen/agents-core";
import { RLine, contentLines, clipSpans, toolSpans, spanLine, innerWidth } from "./lines.js";
import { stripCwdNote } from "../text.js";
import { t } from "../../i18n/index.js";
import { imagePlaceholderLines, type ImageSection } from "./message-images.js";

/**
 * 从消息内容提取纯文本；非文本块（图片 / 文件）以占位文本表示。
 *
 * 图片那一段是多行的：终端不内联渲染图片（内联 base64 动辄几十万字符，放进转录会让单行
 * 宽度失控），但占位不能只说「有图」—— 占位那块把现有的事实逐行说出来（第几张、尺寸、
 * 文件名），手里只有 `__asset_id` 时就写「不知道多大」。这一套在 `message-images.ts`，这里只
 * 负责把它拼进这段文字里。
 */
export function messageText(content: AgentNS.MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  let out = "";
  let imageIndex = 0;
  /** 上一块是不是图片：图片块自成几行，前后都要换行 */
  let afterImage = false;
  for (const part of content) {
    if (part.type === "text") {
      if (afterImage && part.text.length > 0) out += "\n";
      out += part.text;
      afterImage = false;
      continue;
    }
    if (part.type === "image_url") {
      imageIndex += 1;
      const block = imagePlaceholderLines(part as ImageSection, imageIndex).join("\n");
      out += out.length === 0 ? block : `\n${block}`;
      afterImage = true;
      continue;
    }
    if (part.type === "file") {
      const file = part as { file_id?: string; filename?: string };
      out += t("msg.file", { name: file.file_id ?? file.filename ?? t("msg.inlineFile") });
      afterImage = false;
    }
  }
  return out;
}

/**
 * 这条消息会不会进入下一次请求的上下文 —— 与 core `Agent.formatHistory()` 同一判据：
 * `status == undefined || status === Completed`，且未被 `omit`。
 *
 * 策略不需要在这里重新推断：`core/Agent.run()` 收尾时已经把策略写进字段里了
 * （`reconcileAbortedToolRounds()` + `reconcileAbortedMessages()`）：
 *   - `abortedMessageStrategy: keep` → 有内容的中断消息恢复 `Completed`（进上下文）；
 *     `drop` → 保持 `Aborted`（不进）；
 *   - `abortedToolRoundStrategy: fill` → 整轮恢复 `Completed`；`drop` → 整轮 `omit`（不进）。
 * 所以「进不进」读 `status` / `omit` 就是结果，渲染层不重复推导策略。
 */
export function entersContext(message: AgentNS.Message): boolean {
  const status = message.status;
  return (status == null || status === AgentNS.MessageStatus.Completed) && !message.omit;
}

/**
 * 流式中那条还没定局：`Pending`（占位）/ `Writing`（正在输出）。
 *
 * 它们在 `formatHistory()` 里同样不在（此刻确实还没进历史），但那是「尚未」而不是
 * 「被丢弃」——这次回答结束会变 `Completed` 或被策略改写成 `Aborted`，届时候选才确定。
 */
function isInFlight(message: AgentNS.Message): boolean {
  const status = message.status;
  return status === AgentNS.MessageStatus.Pending || status === AgentNS.MessageStatus.Writing;
}

/**
 * 单条消息 → 预折行（不可渲染的消息返回空数组）。
 *
 * - `hidden`：渲染层要求彻底不出现（内部注入 / 占位消息）→ 返回空数组；
 * - 不进上下文（`!entersContext()`，如中断后按 `drop` 处理的消息、`Error`）：
 *   照常渲染、整行划删除线 —— 消息凭空消失会让人以为丢了内容，划掉则明确表示
 *   「还在，但没发给模型」。
 */
export function messageToLines(message: AgentNS.Message, columns: number): RLine[] {
  if (message.hidden) return [];
  const lines = renderMessageLines(message, columns);
  if (entersContext(message) || isInFlight(message)) return lines;
  // 空行不划（没有文字，划线只会变成一条无来由的横杠）
  return lines.map((line) => (line.kind === "gap" ? line : { ...line, struck: true }));
}

/** 按角色把一条消息折成若干行（不含 `hidden` / `omit` 判定，见 `messageToLines`） */
function renderMessageLines(message: AgentNS.Message, columns: number): RLine[] {
  const key = `m${message.id}`;
  const width = innerWidth(columns);

  if (message.role === AgentNS.Role.User) {
    const text = stripCwdNote(messageText(message.content));
    if (!text.trim()) return [];
    return [
      { key: `${key}-gap`, kind: "gap", text: " " },
      { key: `${key}-h`, kind: "user-header", text: t("msg.userHeader") },
      // 用户的话也走 markdown 着色（围栏代码按语言高亮）：粘贴进来的一段代码、一个表格、一段
      // `强调` 现在与 AI 回答一样看得清结构。只是着色，标记符原样留着，不做语义渲染
      ...contentLines("user-text", `${key}-u`, text, width),
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
      { key: `${key}-h`, kind: "ai-header", text: t("msg.aiHeader") },
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
  // `omit` 也要进签名：它同样影响「进不进上下文」（决定要不要划删除线），
  // 且可能在状态不变的情况下翻转（如交接的 omit 策略）——不重算就会拿到旧行
  return `${reasoning}:${content}:${tools}:${message.status ?? ""}:${message.omit ? "omit" : ""}`;
}

/**
 * `messageToLines` 的缓存包装。
 *
 * 已完成消息的渲染结果按「消息对象 + 列宽 + 内容签名」缓存：流式期间每帧都要重排整个转录，
 * 命中缓存后历史消息的折行 / 高亮全部免算。用签名（而非仅对象身份）兜住「流式中那条正在
 * 增长的消息」——签名变了就重算，避免拿到陈旧结果。
 */
const messageLineCache = new WeakMap<
  AgentNS.Message,
  { columns: number; sig: string; lines: RLine[] }
>();

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
