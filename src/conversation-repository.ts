/**
 * CLI 会话存储 — Conversation 类型与会话仓储。
 *
 * 会话是 CLI 的产品数据，由 CLI 自己维护（SDK 只负责驱动与能力）。
 * 复用 SDK 的 EntityRepository，按 id 一个 JSON 文件（${conversationsDir}/${id}.json）。
 *
 * 「上一轮会话 id」指针（session-pointer.ts）随每次落盘更新，供下次启动续接。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { EntityRepository } from "@ai-zen/agents-sdk";
import type { AgentNS } from "@ai-zen/agents-core";
import { CONVERSATIONS_DIR } from "./config.js";
import { formatShortTime } from "./format-time.js";
import { writeLastSession } from "./session-pointer.js";
import type { ConversationContext } from "./types.js";

export interface Conversation {
  id: string;
  agentId: string;
  modelId: string;
  messages: AgentNS.Message[];
  lastPromptTokens?: number;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
}

/** 会话仓储：每个会话一个 JSON 文件（${conversationsDir}/${id}.json） */
export const conversationRepository = new EntityRepository<Conversation>(CONVERSATIONS_DIR);

/**
 * 生成文件名安全的会话 id（语义化中文时间戳，天然不含非法字符）。
 * 形如 `对话_2025年07月01日14时30分00秒`。
 */
export function generateConversationId(date: Date = new Date()): string {
  return `对话_${formatShortTime(date.toISOString())}`.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * 保存当前对话到 conversations 目录，并更新「上一轮会话 id」指针。
 * 迁移前落盘旧会话（onBeforeMigrate）、手动 /save 等场景共同调用，保证 id 计算一致。
 */
export async function saveConversation(ctx: ConversationContext): Promise<string> {
  const id = ctx.currentId || generateConversationId();
  const existing = await conversationRepository.read(id);
  const now = new Date().toISOString();
  await conversationRepository.write({
    id,
    agentId: ctx.agentId || "default",
    modelId: ctx.modelId,
    messages: ctx.agent.messages,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await writeLastSession(id);
  return id;
}

/**
 * 列出已保存的会话（仅读文件名与 mtime，不解析 JSON 内容，快），按更新时间倒序。
 * 供对话内 `/load` 选择器使用。
 */
export async function listConversations(): Promise<
  Array<{ id: string; name: string; updatedAt: string; size: number }>
> {
  try {
    await fs.access(CONVERSATIONS_DIR);
  } catch {
    return [];
  }
  const files = await fs.readdir(CONVERSATIONS_DIR);
  const result: Array<{ id: string; name: string; updatedAt: string; size: number }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    try {
      const st = await fs.stat(join(CONVERSATIONS_DIR, file));
      result.push({ id, name: id, updatedAt: st.mtime.toISOString(), size: st.size });
    } catch {
      /* 跳过读取失败的条目 */
    }
  }
  return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
