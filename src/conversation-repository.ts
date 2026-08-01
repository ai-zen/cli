/**
 * CLI 会话存储 — Conversation 类型与会话仓储。
 *
 * 会话是 CLI 的产品数据，由 CLI 自己维护（SDK 只负责驱动与能力）。
 * 复用 SDK 的 EntityRepository，按 id 一个 JSON 文件（${conversationsDir}/${id}.json）。
 */

import { EntityRepository } from "@ai-zen/agents-sdk";
import type { AgentNS } from "@ai-zen/agents-core";
import { CONVERSATIONS_DIR } from "./config.js";

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
