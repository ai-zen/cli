import { describe, expect, it, vi } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import { ChatSession } from "./chat-session.js";

// 在静态导入之前设置 AI_ZEN_DIR（config.ts 在导入时即固化该路径）
const state = vi.hoisted(() => {
  const dir = `/tmp/aiz-reset-${process.pid}-${Date.now()}`;
  process.env.AI_ZEN_DIR = dir;
  return { dir };
});

// 把 agent-creator 打桩，避免真实构建 Agent / 访问网络
vi.mock("../agent-creator.js", () => ({
  createAgent: vi.fn(async (opts: any) => ({
    messages: opts?.messages ? [...opts.messages] : [],
    lastUsage: undefined,
    use: () => {},
    init: async () => {},
    abort: () => {},
    send: async () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  })),
  resetScope: vi.fn(async () => {}),
}));

describe("ChatSession.reset（/new 归档旧对话）", () => {
  it("空对话不落盘；有内容则归档到原 id，且不误写到新 id", async () => {
    const dir = state.dir;
    const convFile = (id: string) => join(dir, "cli", "conversations", `${id}.json`);
    const session = await ChatSession.create(
      { modelId: "m1" },
      { onChange: () => {}, onNotice: () => {} },
    );

    // 情形 1：空对话 → 不落盘，仅切换到新 id
    session.currentId = "会话_旧对话A";
    session.currentName = "会话_旧对话A";
    expect(await session.reset()).toBeNull();
    expect(session.currentId).not.toBe("会话_旧对话A");
    expect(existsSync(convFile("会话_旧对话A"))).toBe(false);

    // 情形 2：有内容 → 归档到原 id
    session.currentId = "会话_旧对话B";
    session.currentName = "会话_旧对话B";
    session.messages.push({ role: AgentNS.Role.User, content: "你好" } as any);

    const archived = await session.reset();
    expect(archived).toBe("会话_旧对话B");
    expect(session.currentId).not.toBe("会话_旧对话B");

    const saved = JSON.parse(await fs.readFile(convFile("会话_旧对话B"), "utf-8"));
    expect(saved.id).toBe("会话_旧对话B");
    expect(saved.messages).toHaveLength(1);
    expect(saved.messages[0].content).toBe("你好");

    // 关键：不得把旧内容误写到新会话 id 上
    expect(existsSync(convFile(session.currentId))).toBe(false);
  });
});

describe("ChatSession.totalUsage（本会话累计用量）", () => {
  it("逐消息求和：assistant 的 usage + 工具消息的 subAgentUsage（含子 Agent）", async () => {
    const session = await ChatSession.create(
      { modelId: "m1" },
      { onChange: () => {}, onNotice: () => {} },
    );
    session.messages.push(
      { role: AgentNS.Role.User, content: "你好" } as any,
      {
        role: AgentNS.Role.Assistant,
        content: "第一轮",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as any,
      {
        role: AgentNS.Role.Tool,
        content: "子任务结果",
        subAgentUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      } as any,
      {
        role: AgentNS.Role.Assistant,
        content: "第二轮",
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      } as any,
    );

    expect(session.totalUsage).toEqual({
      prompt_tokens: 130,
      completion_tokens: 33,
      total_tokens: 163,
    });
  });
});
