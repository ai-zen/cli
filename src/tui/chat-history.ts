/**
 * `↑` 历史的唯一数据源：直接派生自 `session.messages` 里的用户消息。
 *
 * 不另存一份历史的代价是真实的：只存文本的话，`↑` 翻回一条带图片的消息时图片会静默丢失，
 * 用户回车就把图与文本重发成了纯文本，看起来什么都没少，模型收到的内容却完全不同。
 * 原始内容本来就在 messages 的内容段里（`Ctrl+V` 粘贴的图会以 `image_url` 的 data URL
 * 落进用户消息），派生出来即可，不需要第二份会漂移的副本。
 *
 * 剪贴板内联的图在段里是 `data:` 的 base64，本地有字节，还原成 `ClipboardImage`，
 * 重发时再传一次，与首次粘贴走同一条路。已经上传的图在段上留着 Asset id（`__asset_id`），
 * 还原成 id；重发不必再传一遍，本地也不需要副本：同一张图全机只存一份，按内容认。
 */
import { AgentNS } from "@ai-zen/agents-core";
import type { ClipboardImage } from "../clipboard.js";
import { stripCwdNote } from "./text.js";

/**
 * 段上的本地标记：指回数据根下的一份 Asset。
 *
 * 写它的是 `user-content.ts`（`contentOfInput`），宿主 `ASSET_ID_KEY` 是同一个词；这里只读，
 * 不造第二个名字。
 */
const ASSET_ID_KEY = "__asset_id";

/** 可再次编辑的草稿 */
export interface HistoryEntry {
  text: string;
  /** 粘进消息里的图（内联 base64 那种） */
  images: readonly ClipboardImage[];
  /** 已经传上去的 Asset id（段上的本地标记，按原顺序） */
  assetIds: readonly string[];
}

/** 非内联图片（http URL 等）返回 null */
function parseDataUrl(url: string): ClipboardImage | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mime: match[1]!, base64: match[2]! };
}

/** 一条用户消息 → 草稿（文本剥掉 CwdTracker 追加的工作目录注记） */
function toDraft(message: AgentNS.Message): HistoryEntry {
  const content = message.content;
  if (content == null) return { text: "", images: [], assetIds: [] };
  if (typeof content === "string") return { text: stripCwdNote(content), images: [], assetIds: [] };

  const texts: string[] = [];
  const images: ClipboardImage[] = [];
  const assetIds: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }
    if (part.type !== "image_url") continue; // `file`（Files API）本地无副本，也没有素材 id
    const assetId = (part as { [ASSET_ID_KEY]?: unknown })[ASSET_ID_KEY];
    if (typeof assetId === "string" && assetId.length > 0) {
      // 已经传上去的那张：放回的是 id（不去重 —— 用户放两次就是两张）
      assetIds.push(assetId);
      continue;
    }
    const image = parseDataUrl(part.image_url.url);
    if (image) images.push(image);
  }
  return { text: stripCwdNote(texts.join("")), images, assetIds };
}

/**
 * 用户消息 → 草稿列表，按发送顺序，最后一条最新。
 *
 * `↑` 从末尾往回走，先翻出最近发送的一条。
 */
export function userDrafts(messages: readonly AgentNS.Message[]): HistoryEntry[] {
  return messages.filter((message) => message.role === AgentNS.Role.User).map(toDraft);
}
