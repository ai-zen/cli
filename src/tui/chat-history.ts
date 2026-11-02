/**
 * `↑` 历史的唯一数据源 —— 直接派生自 `session.messages` 里的用户消息。
 *
 * ## 为什么不另存一份历史
 *
 * 旧实现在 `useInputEditing` 内部维护 `string[]`：只有文本。于是 `↑` 翻回一条**带图片**
 * 的消息时图片静默丢失，用户直接回车就把「图 + 文」重发成了纯文本 —— 看起来什么都没少，
 * 但模型收到的完全不同。而真相本来就在 messages 的内容段里（`Ctrl+V` 粘贴的图会以
 * `image_url` 的 data URL 落进用户消息），派生出来即可，不需要第二份会漂移的副本。
 *
 * ## 还原不了的情况（刻意如此）
 *
 * 走 Files API 上传过的图片在消息里是 `file_id`，本地没有副本 —— 这种只恢复文本，
 * 不塞一个空壳附件（重发时才会真的丢图，而不是假装有）。
 */
import { AgentNS } from "@ai-zen/agents-core";
import type { ClipboardImage } from "../clipboard.js";
import { stripCwdNote } from "./text.js";

/** 一条可再次编辑的草稿：文本 + 附件 */
export interface HistoryEntry {
  text: string;
  images: readonly ClipboardImage[];
}

/** `data:<mime>;base64,<data>` → `{ base64, mime }`；不是内联图片（http URL 等）返回 null */
function parseDataUrl(url: string): ClipboardImage | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mime: match[1]!, base64: match[2]! };
}

/** 一条用户消息 → 草稿（文本剥掉 CwdTracker 追加的工作目录注记） */
function toDraft(message: AgentNS.Message): HistoryEntry {
  const content = message.content;
  if (content == null) return { text: "", images: [] };
  if (typeof content === "string") return { text: stripCwdNote(content), images: [] };

  const texts: string[] = [];
  const images: ClipboardImage[] = [];
  for (const part of content) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }
    if (part.type !== "image_url") continue; // `file`（Files API）本地无副本
    const image = parseDataUrl(part.image_url.url);
    if (image) images.push(image);
  }
  return { text: stripCwdNote(texts.join("")), images };
}

/**
 * 用户消息 → 草稿列表（按发送顺序，**最后一条最新**）。
 *
 * `↑` 从末尾往回走，与「最近说过的话先翻出来」一致。
 */
export function userDrafts(messages: readonly AgentNS.Message[]): HistoryEntry[] {
  return messages.filter((message) => message.role === AgentNS.Role.User).map(toDraft);
}
