import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { addUsage, sumMessagesUsage, ZERO_USAGE } from "./usage.js";

const usage = (prompt: number, completion: number, total: number): AgentNS.Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: total,
});

describe("sumMessagesUsage", () => {
  it("仅累加 assistant 消息的 usage，忽略其它角色", () => {
    const messages = [
      { role: AgentNS.Role.System, content: "系统" },
      { role: AgentNS.Role.User, content: "你好" },
      { role: AgentNS.Role.Assistant, content: "第一轮", usage: usage(100, 20, 120) },
      { role: AgentNS.Role.Tool, content: "工具结果" },
      { role: AgentNS.Role.Assistant, content: "第二轮", usage: usage(200, 30, 230) },
    ] as AgentNS.Message[];

    expect(sumMessagesUsage(messages)).toEqual(usage(300, 50, 350));
  });

  it("空数组归零", () => {
    expect(sumMessagesUsage([])).toEqual(ZERO_USAGE);
  });

  it("assistant 消息无 usage（如被中断的轮次）时忽略", () => {
    const messages = [
      { role: AgentNS.Role.Assistant, content: "无用量" },
      { role: AgentNS.Role.Assistant, content: "有用量", usage: usage(5, 5, 10) },
    ] as AgentNS.Message[];

    expect(sumMessagesUsage(messages)).toEqual(usage(5, 5, 10));
  });
});

describe("addUsage", () => {
  it("逐字段相加并返回新对象", () => {
    const a = usage(1, 2, 3);
    const b = usage(10, 20, 30);
    const sum = addUsage(a, b);
    expect(sum).toEqual(usage(11, 22, 33));
    // 不修改入参
    expect(a).toEqual(usage(1, 2, 3));
    expect(b).toEqual(usage(10, 20, 30));
  });
});
