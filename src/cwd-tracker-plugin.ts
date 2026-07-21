/**
 * CwdTrackerPlugin — 追踪当前工作目录变化，动态通知 Agent
 *
 * == 设计思路 ==
 *
 * 1. system prompt 保持静态不变，不破坏 LLM 前缀缓存
 * 2. 利用 onInnerLoopStart 钩子，此时用户刚输入的消息已加入 messages
 * 3. 将 cwd 信息直接追加到该条用户消息末尾，不引入额外消息
 * 4. 仅在 cwd 变化时注入，零开销
 *
 * == 为什么用 onInnerLoopStart 而不是 onBeforeSend ==
 *
 * onBeforeSend 触发时，用户消息尚未 append 到 messages 中。
 * 如果在此注入独立 user 消息，会导致连续两条 user 消息，部分 API 不支持。
 * 同时，SdkAgent.send() 中 onBeforeSend 修改 ctx.content 后，
 * super.send(content) 使用的仍是原始 content 参数，修改不生效。
 *
 * onInnerLoopStart 触发时，send() 内部已完成：
 *   append(Message.User(content))  → 用户消息已加入 messages
 *   append(Message.Assistant())    → 占位
 * 此时可以安全地找到最后一条 user 消息（即用户刚输入的消息）
 * 并追加 cwd 信息，对 API 完全透明。
 *
 * == 恢复旧对话时的行为 ==
 *
 * 恢复草稿/已保存对话时，会创建新的 CwdTrackerPlugin 实例（lastCwd = null），
 * 同时 agent.messages 被替换为历史消息。用户重新输入新消息后，
 * onInnerLoopStart 找到的最后一条 user 消息是用户刚输入的消息，
 * cwd 会正确地追加到新消息末尾，不会污染历史消息。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { AgentPlugin, SendContext } from "@ai-zen/agents-sdk";

export class CwdTrackerPlugin implements AgentPlugin {
  /** 上一次记录的 cwd，null 表示尚未初始化 */
  private lastCwd: string | null = null;

  async onInnerLoopStart(ctx: SendContext): Promise<void> {
    const currentCwd = process.cwd();

    // cwd 未变化，不做任何事
    if (this.lastCwd === currentCwd) return;

    const isFirstTime = this.lastCwd === null;
    this.lastCwd = currentCwd;

    // 找到最后一条 user 消息，将 cwd 信息追加到其末尾
    const lastUserMsg = [...ctx.agent.messages]
      .reverse()
      .find((m) => m.role === AgentNS.Role.User && typeof m.content === "string");

    if (!lastUserMsg || typeof lastUserMsg.content !== "string") return;

    const prefix = isFirstTime ? "" : "\n\n[工作目录变更]";
    lastUserMsg.content += `${prefix}\n当前工作目录: ${currentCwd}`;
  }
}
