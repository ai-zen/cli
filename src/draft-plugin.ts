/**
 * DraftPlugin — CLI 草稿自动保存插件。
 *
 * 草稿是 CLI 的产品特性（交互式对话暂存），不依赖 SDK。
 * 每次内循环结束后把当前消息列表写入草稿，供下次启动恢复。
 */

import type { AgentPlugin, SendContext } from "@ai-zen/agents-sdk";
import { draftRepository } from "./draft-repository.js";

export interface DraftPluginOptions {
  agentId: string;
  modelId: string;
  conversationId?: string;
  cwd?: string;
}

export class DraftPlugin implements AgentPlugin {
  constructor(private options: DraftPluginOptions) {}

  async onInnerLoopEnd(ctx: SendContext): Promise<void> {
    const { agentId, modelId, conversationId, cwd } = this.options;

    try {
      await draftRepository.write({
        conversationId,
        agentId,
        modelId,
        messages: ctx.agent.messages,
        cwd,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn(`[draft] 保存失败: ${err?.message ?? err}`);
    }
  }
}
