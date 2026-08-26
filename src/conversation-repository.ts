/**
 * CLI 会话存储 — Conversation 类型与会话仓储。
 *
 * 会话是 CLI 的产品数据，由 CLI 自己维护（SDK 只负责驱动与能力）。
 * 复用 SDK 的 EntityRepository，按 id 一个 JSON 文件（${conversationsDir}/${id}.json）。
 */

import { EntityRepository } from "@ai-zen/agents-sdk";
import type { AgentNS } from "@ai-zen/agents-core";
import { CONVERSATIONS_DIR } from "./config.js";
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
 * 保存当前对话到 conversations 目录。
 * 迁移前落盘旧会话（onBeforeMigrate）、错误时自动保存等场景共同调用，保证 id 计算一致。
 */
export async function saveConversation(ctx: ConversationContext): Promise<string> {
  const id = ctx.currentId || ctx.currentName.replace(/[\\/:*?"<>|]/g, "_");
  await conversationRepository.write({
    id,
    agentId: ctx.agentId || "default",
    modelId: ctx.modelId,
    messages: ctx.agent.messages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}
