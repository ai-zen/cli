/**
 * ConversationPersistPlugin — 会话自动落盘插件。
 *
 * 取代原 `DraftPlugin`：不再写单文件草稿，而是每轮内循环结束后把当前
 * 消息写入该会话文件（`conversations/<id>.json`），并更新「上一轮会话 id」指针。
 *
 * 采用「方案 B」：仅在产生实质内容（至少一条用户消息）时落盘，避免留下空会话。
 * 会话 id 通过 `getId()` 动态获取，以便任务迁移切换新会话后依然落盘到正确的文件。
 */

import type { AgentPlugin, SendContext } from "@ai-zen/agents-sdk";
import { AgentNS } from "@ai-zen/agents-core";
import { conversationRepository } from "./conversation-repository.js";
import { writeLastSession } from "./session-pointer.js";

export interface ConversationPersistPluginOptions {
  /** 动态返回当前会话 id（迁移切换会话后随之变化） */
  getId: () => string;
  agentId: string;
  modelId: string;
  cwd?: string;
  /** 落盘失败时的上报（TUI 走 Ink notice）；默认丢弃 */
  onError?: (text: string) => void;
}

export class ConversationPersistPlugin implements AgentPlugin {
  constructor(private options: ConversationPersistPluginOptions) {}

  async onInnerLoopEnd(ctx: SendContext): Promise<void> {
    const { getId, agentId, modelId, cwd, onError } = this.options;
    const messages = ctx.agent.messages;

    // 尚无实质内容（没有用户消息）时不落盘，避免产生空会话文件
    if (!messages.some((m) => m.role === AgentNS.Role.User)) return;

    const id = getId();
    try {
      const existing = await conversationRepository.read(id);
      const now = new Date().toISOString();
      await conversationRepository.write({
        id,
        agentId,
        modelId,
        messages,
        cwd,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      await writeLastSession(id);
    } catch (err: any) {
      onError?.(`⚠️ 会话落盘失败：${err?.message ?? err}`);
    }
  }
}
