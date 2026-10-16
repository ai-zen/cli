import { describe, expect, it, vi } from "vitest";
import type { ConversationContext } from "./types.js";
import { createMigrationService } from "./migration-service.js";

// 在静态导入之前固定 AI_ZEN_DIR（config.ts 导入时即固化路径，避免污染真实 ~/.ai-zen）
const state = vi.hoisted(() => {
  const dir = `/tmp/aiz-mig-${process.pid}-${Date.now()}`;
  process.env.AI_ZEN_DIR = dir;
  return { dir };
});

/** 构造一个足以驱动 TaskMigrationService.migrate 的假 agent（不触网，交接文档用桩返回） */
function makeAgent(lastUsage: unknown) {
  return {
    messages: [{ role: "user", content: "任务1" }] as any[],
    definition: { messages: [] as any[] },
    client: {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "# 交接文档\n## 💬 对话断点\n- 桩" } }],
          })),
        },
      },
    },
    model: "m",
    modelConfig: {},
    lastUsage,
  };
}

function makeCtx(agent: ReturnType<typeof makeAgent>): ConversationContext {
  return {
    agent: agent as any,
    input: "",
    currentName: "会话_x",
    modelId: "m",
    currentId: "会话_x",
    agentId: "default",
    running: true,
  } as unknown as ConversationContext;
}

describe("createMigrationService（迁移后清理陈旧用量）", () => {
  it("迁移完成后清空 agent.lastUsage，避免护栏用迁移前的旧 prompt_tokens 误判超限", async () => {
    expect(state.dir).toBeTruthy(); // 确保临时目录已生效，不落到真实 HOME

    const agent = makeAgent({ prompt_tokens: 999, completion_tokens: 1, total_tokens: 1000 });
    const ctx = makeCtx(agent);
    const service = createMigrationService(ctx, { log: () => {} });

    await service.migrate({ agent: agent as any });

    // 关键断言：陈旧用量被清空（护栏 onInnerLoopStart 无据可查 → 放行）
    expect(agent.lastUsage).toBeUndefined();
    // 附带确认：prune 生效——仅剩模板(def.messages) + 对话断点
    expect(agent.messages.length).toBe(1);
    expect(String(agent.messages[0].content)).toContain("任务交接文档");
  });
});
