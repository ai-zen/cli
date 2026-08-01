/**
 * CLI 草稿存储 — Draft 类型与草稿仓储。
 *
 * 草稿是 CLI 的产品特性（交互式对话暂存），Draft 无 id 字段，单独实现。
 * 文件名基于 conversationId：
 *   - 有 conversationId → ${conversationId}.json
 *   - 无 conversationId → _current.json
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AgentNS } from "@ai-zen/agents-core";
import { DRAFTS_DIR } from "./config.js";

export interface Draft {
  conversationId?: string;
  agentId: string;
  modelId: string;
  messages: AgentNS.Message[];
  cwd?: string;
  updatedAt: string;
}

const CURRENT_DRAFT = "_current.json";

/**
 * 草稿仓储。
 * 文件名基于 conversationId：
 *   - 有 conversationId → ${conversationId}.json
 *   - 无 conversationId → _current.json
 */
export class DraftRepository {
  constructor(private dir: string) {}

  private path(conversationId?: string): string {
    return join(this.dir, conversationId ? `${conversationId}.json` : CURRENT_DRAFT);
  }

  async read(conversationId?: string): Promise<Draft | null> {
    const p = this.path(conversationId);
    try {
      await fs.access(p);
    } catch {
      return null;
    }
    try {
      return JSON.parse(await fs.readFile(p, "utf-8")) as Draft;
    } catch {
      return null;
    }
  }

  async write(draft: Draft): Promise<void> {
    try {
      await fs.access(this.dir);
    } catch {
      await fs.mkdir(this.dir, { recursive: true });
    }
    await fs.writeFile(
      this.path(draft.conversationId),
      JSON.stringify(draft, null, 2),
      "utf-8",
    );
  }

  async delete(conversationId?: string): Promise<void> {
    const p = this.path(conversationId);
    try {
      await fs.access(p);
      await fs.unlink(p);
    } catch {
      // 文件不存在，忽略
    }
  }
}

/** CLI 草稿存储单例 */
export const draftRepository = new DraftRepository(DRAFTS_DIR);
