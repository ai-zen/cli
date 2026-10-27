import { describe, expect, it, vi, afterAll } from "vitest";
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

// 本文件把 AI_ZEN_DIR 指到 /tmp 下的临时目录做隔离；跑完删掉，不在 /tmp 留垃圾。
// （下面用例的注释里提到过「afterAll 会清理 state.dir」，但此前并没有这个 hook）
afterAll(async () => {
  await fs.rm(state.dir, { recursive: true, force: true });
});

// 把 agent-creator 打桩，避免真实构建 Agent / 访问网络
vi.mock("../agent-creator.js", () => ({
  createAgent: vi.fn(async (opts: any) => ({
    // definition 是模型真相源（ChatSession.modelId 从它读）
    definition: { id: opts?.agentId ?? "default", modelId: "m1", messages: [] },
    messages: opts?.messages ? [...opts.messages] : [],
    lastUsage: undefined,
    use: () => {},
    init: async () => {},
    abort: () => {},
    send: async () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  })),
  resetScope: vi.fn(async () => {}),
  listSkillDirs: vi.fn(() => []),
}));

describe("ChatSession.reset（/new 归档旧对话）", () => {
  it("空对话不落盘；有内容则归档到原 id，且不误写到新 id", async () => {
    const dir = state.dir;
    const convFile = (id: string) => join(dir, "cli", "conversations", `${id}.json`);
    const session = await ChatSession.create(
      {},
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

describe("ChatSession.currentId（唯一真相源 = ctx）", () => {
  it("只改 ctx.currentId 时 session.currentId 立即跟随（自动迁移换 id 的回归）", async () => {
    const session = await ChatSession.create(
      {},
      { onChange: () => {}, onNotice: () => {} },
    );
    const before = session.currentId;

    // 模拟 SDK 的 HandoffService.onMigrated：自动迁移由 AutoMigratePlugin 直接驱动，
    // 只写 ctx.currentId，不经过 ChatSession 的任何方法。
    // 旧实现另持一份 this.currentId，此处会停在旧值上，导致
    // ConversationPersistPlugin.getId() 拿到旧 id，把 prune 后的空会话写回旧文件。
    (session as any).ctx.currentId = "会话_迁移后";

    expect(session.currentId).toBe("会话_迁移后");
    expect(session.currentId).not.toBe(before);
  });

  it("赋值 session.currentId 会同步写回 ctx", async () => {
    const session = await ChatSession.create(
      {},
      { onChange: () => {}, onNotice: () => {} },
    );

    session.currentId = "会话_手动";

    expect((session as any).ctx.currentId).toBe("会话_手动");
  });
  it("端到端：handoffService.migrate() 之后 currentId 必须跟随新会话（自动迁移路径）", async () => {
    const session = await ChatSession.create(
      {},
      { onChange: () => {}, onNotice: () => {} },
    );
    session.currentId = "会话_自动迁移前";
    session.messages.push({ role: AgentNS.Role.User, content: "旧对话内容" } as any);

    // 补齐 summary 模式所需的最小 agent 面（无 write 工具 → 走独立摘要，不触网）
    const agent = (session as any).agent;
    agent.client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "# 交接文档\n".padEnd(600, "x") } }],
          }),
        },
      },
    };
    agent.model = "m";
    agent.modelConfig = {};
    agent.tools = [];
    agent.definition = { messages: [] };

    // 交接文档目录固化自模块加载时的 cwd（`PROJECT_HANDOFFS_DIR`），
    // 这里改指临时区，避免在仓库里留下 .ai-zen/handoffs（afterAll 会清理 state.dir）
    (session as any).handoffService.handoffDirPath = join(state.dir, "handoffs");

    // 模拟 AutoMigratePlugin：直接调 SDK 服务，不经过 ChatSession.migrate()
    await (session as any).handoffService.migrate({
      agent,
      conversationId: "会话_自动迁移前",
    });

    // 修复前：currentId 停在旧值 → ConversationPersistPlugin 会把 prune 后的
    // 「系统提示 + 交接断点」写回「会话_自动迁移前」，覆盖掉完整历史。
    expect(session.currentId).not.toBe("会话_自动迁移前");

    const archived = JSON.parse(
      await fs.readFile(
        join(state.dir, "cli", "conversations", "会话_自动迁移前.json"),
        "utf-8",
      ),
    );
    // 旧会话保住了原历史（含交接回合），没有被 prune 后的空壳覆盖
    expect(archived.messages.length).toBeGreaterThanOrEqual(1);
    expect(String(archived.messages[0].content)).toContain("旧对话内容");
  });
});

describe("ChatSession.totalUsage（本会话累计用量）", () => {
  it("逐消息求和：assistant 的 usage + 工具消息的 subAgentUsage（含子 Agent）", async () => {
    const session = await ChatSession.create(
      {},
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
