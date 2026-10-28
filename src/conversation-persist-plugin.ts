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
import { persistConversation } from "./conversation-repository.js";
import { t } from "./i18n/index.js";

export interface ConversationPersistPluginOptions {
  /** 动态返回当前会话 id（迁移切换会话后随之变化） */
  getId: () => string;
  agentId: string;
  cwd?: string;
  /** 落盘失败时的上报（TUI 走 Ink notice）；默认丢弃 */
  onError?: (text: string) => void;
}

export class ConversationPersistPlugin implements AgentPlugin {
  constructor(private options: ConversationPersistPluginOptions) {}

  async onInnerLoopEnd(ctx: SendContext): Promise<void> {
    const { getId, agentId, cwd, onError } = this.options;
    const messages = ctx.agent.messages;

    // 尚无实质内容（没有用户消息）时不落盘，避免产生空会话文件
    if (!messages.some((m) => m.role === AgentNS.Role.User)) return;

    const id = getId();
    try {
      // 每轮自动落盘也算「本目录的上一轮会话」—— 下次在该目录启动时续接它。
      // `SendContext.cwd` 是 SDK 的可选字段，这里（调用点）是**唯一**需要兜底的地方。
      await persistConversation({ id, agentId, messages, cwd: cwd ?? process.cwd() });
    } catch (err: any) {
      onError?.(t("chat.persistFailed", { error: err?.message ?? err }));
    }
  }
}
