import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentNS, Message } from "@ai-zen/agents-core";
import { ConversationContext } from "../types.js";
import { handleBack } from "./back.js";

// Mock inquirer
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

import inquirer from "inquirer";

function createMockAgent(messages: AgentNS.Message[]) {
  return { messages };
}

function createCtx(agent: any): ConversationContext {
  return {
    agent,
    input: "",
    currentName: "test",
    modelId: "test-model",
    currentId: undefined,
    agentId: undefined,
    running: true,
  };
}

describe("handleBack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("没有消息时返回提示", async () => {
    const agent = createMockAgent([]);
    const ctx = createCtx(agent);

    await handleBack(ctx);

    expect(ctx.input).toBe("");
    expect(agent.messages.length).toBe(0);
  });

  it("只有 system 消息时无目标消息", async () => {
    const agent = createMockAgent([
      Message.System("system prompt"),
    ]);
    const ctx = createCtx(agent);

    await handleBack(ctx);

    expect(ctx.input).toBe("");
  });

  it("选择取消操作时不修改消息", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("hello"),
      Message.Assistant("hi"),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ selectedIndex: -1 });

    await handleBack(ctx);

    expect(ctx.input).toBe("");
    expect(agent.messages.length).toBe(3);
  });

  it("撤回用户消息后选择取消操作", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("hello"),
      Message.Assistant("hi"),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editChoice: "cancel" });

    await handleBack(ctx);

    expect(ctx.input).toBe("");
    expect(ctx.shouldSend).toBeUndefined();
    expect(agent.messages.length).toBe(1);
    expect(agent.messages[0].content).toBe("system");
  });

  it("撤回用户消息后选择原样重新发送", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("hello"),
      Message.Assistant("hi"),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editChoice: "resend" });

    await handleBack(ctx);

    expect(ctx.input).toBe("hello");
    expect(ctx.shouldSend).toBe(true);
    expect(agent.messages.length).toBe(1);
  });

  it("撤回用户消息后选择修改并输入新内容", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("hello"),
      Message.Assistant("hi"),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editChoice: "edit" })
      .mockResolvedValueOnce({ editedContent: "modified message" });

    await handleBack(ctx);

    expect(ctx.input).toBe("modified message");
    expect(ctx.shouldSend).toBe(true);
    expect(agent.messages.length).toBe(1);
  });

  it("撤回用户消息后选择修改但输入空内容则取消", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("hello"),
      Message.Assistant("hi"),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editChoice: "edit" })
      .mockResolvedValueOnce({ editedContent: "" });

    await handleBack(ctx);

    expect(ctx.input).toBe("");
    expect(ctx.shouldSend).toBeUndefined();
  });

  it("撤回工具消息后输入新消息继续对话", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("calculate 1+1"),
      new Message({ role: AgentNS.Role.Assistant, content: "", tool_calls: [{ id: "call1", type: "function", function: { name: "calc", arguments: "{}" } }] }),
      new Message({ role: AgentNS.Role.Tool, content: "2", name: "calc" }),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 3 })
      .mockResolvedValueOnce({ newMessage: "继续" });

    await handleBack(ctx);

    expect(ctx.input).toBe("继续");
    expect(ctx.shouldSend).toBe(true);
    expect(agent.messages.length).toBe(4);
  });

  it("撤回工具消息后输入空内容返回错误", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("hello"),
      new Message({ role: AgentNS.Role.Assistant, content: "", tool_calls: [{ id: "call1", type: "function", function: { name: "calc", arguments: "{}" } }] }),
      new Message({ role: AgentNS.Role.Tool, content: "result" }),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 3 })
      .mockResolvedValueOnce({ newMessage: "" });

    await handleBack(ctx);

    expect(ctx.input).toBe("");
    expect(ctx.shouldSend).toBeUndefined();
  });

  it("撤回用户消息后修改时输入空白字符视为取消", async () => {
    const agent = createMockAgent([
      Message.System("system"),
      Message.User("hello"),
      Message.Assistant("hi"),
    ]);
    const ctx = createCtx(agent);

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editChoice: "edit" })
      .mockResolvedValueOnce({ editedContent: "   " });

    await handleBack(ctx);

    expect(ctx.input).toBe("");
    expect(ctx.shouldSend).toBeUndefined();
  });
});
