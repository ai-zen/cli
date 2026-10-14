/**
 * Token 用量统计 — 纯函数
 *
 * 数据源为 core 为每条 assistant 消息钉上的 `usage`（`Agent.lastUsage` 的近亲，
 * 由流式响应的最后一个 chunk 写入）。因每轮请求都会重发完整历史，
 * 「各 assistant 消息 usage 之和」即计费口径的累计消耗。
 *
 * 本模块为纯数据与纯函数，不依赖 React / Ink，可直接单测。
 */

import { AgentNS } from "@ai-zen/agents-core";

/** 零用量（复用为累加初值；调用方勿直接修改） */
export const ZERO_USAGE: AgentNS.Usage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

/** 累加两个 usage（逐字段相加，返回新对象） */
export function addUsage(a: AgentNS.Usage, b: AgentNS.Usage): AgentNS.Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

/**
 * 求和一组消息中 assistant 消息的 usage。
 * 非 assistant 消息、以及无 usage 的消息（如被中断的轮次）一律忽略。
 */
export function sumMessagesUsage(
  messages: readonly AgentNS.Message[],
): AgentNS.Usage {
  const acc = { ...ZERO_USAGE };
  for (const message of messages) {
    if (message.role !== AgentNS.Role.Assistant || !message.usage) continue;
    acc.prompt_tokens += message.usage.prompt_tokens ?? 0;
    acc.completion_tokens += message.usage.completion_tokens ?? 0;
    acc.total_tokens += message.usage.total_tokens ?? 0;
  }
  return acc;
}
