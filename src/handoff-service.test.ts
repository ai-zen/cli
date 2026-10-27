import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationContext } from "./types.js";
import { createHandoffService } from "./handoff-service.js";
import { conversationRepository } from "./conversation-repository.js";
import { setLocale } from "./i18n/index.js";

// 交接日志已 i18n 化：这些用例断言中文，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

// 在静态导入之前固定 AI_ZEN_DIR（config.ts 导入时即固化路径，避免污染真实 ~/.ai-zen）
const state = vi.hoisted(() => {
  const dir = `/tmp/aiz-handoff-${process.pid}-${Date.now()}`;
  process.env.AI_ZEN_DIR = dir;
  return { dir };
});

let handoffDir: string;

beforeAll(async () => {
  handoffDir = await fs.mkdtemp(join(tmpdir(), "aizen-cli-handoff-"));
});

afterAll(async () => {
  await fs.rm(handoffDir, { recursive: true, force: true });
  await fs.rm(state.dir, { recursive: true, force: true });
});

/**
 * 假 agent：无 `write` 工具 → 交接走「独立摘要」路径（不触网，文档由桩返回）。
 * 这样测试聚焦 CLI 钩子（存档 / 新会话 / lastUsage），不重复测 SDK 的自交接细节。
 */
function makeAgent(lastUsage: unknown) {
  return {
    messages: [{ role: "user", content: "任务1" }] as any[],
    definition: { messages: [] as any[] },
    tools: [] as any[],
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

function uniqueDir(name: string): string {
  return join(handoffDir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe("createHandoffService", () => {
  it("migrate：交接 + 剔除历史 + 清空陈旧用量 + 开启新会话", async () => {
    expect(state.dir).toBeTruthy(); // 确保临时目录已生效，不落到真实 HOME

    const agent = makeAgent({ prompt_tokens: 999, completion_tokens: 1, total_tokens: 1000 });
    const ctx = makeCtx(agent);
    const dir = uniqueDir("migrate");
    const service = createHandoffService(ctx, { log: () => {}, handoffDir: dir });

    const result = await service.migrate({ agent: agent as any, conversationId: "会话_x" });

    // 关键断言：陈旧用量被清空（护栏 onInnerLoopStart 无据可查 → 放行）
    expect(agent.lastUsage).toBeUndefined();
    // prune 生效：仅剩模板(def.messages) + 交接断点
    expect(agent.messages.length).toBe(1);
    expect(String(agent.messages[0].content)).toContain(result.handoffPath);
    // 交接文档落盘
    expect(existsSync(result.handoffPath)).toBe(true);
    expect(result.handoffPath.startsWith(dir)).toBe(true);
    // 新会话：id 已切换并落盘
    expect(ctx.currentId).not.toBe("会话_x");
    const saved = await conversationRepository.read(ctx.currentId!);
    expect(saved).toBeTruthy();
    expect(saved!.messages.length).toBe(1);
  });

  it("handoff：只写文档，不切换会话、不改动历史", async () => {
    const agent = makeAgent(undefined);
    const ctx = makeCtx(agent);
    const dir = uniqueDir("handoff");
    const service = createHandoffService(ctx, { log: () => {}, handoffDir: dir });

    const result = await service.handoff({ agent: agent as any, conversationId: "会话_x" });

    expect(existsSync(result.handoffPath)).toBe(true);
    expect(result.handoffPath.startsWith(dir)).toBe(true);
    // 会话元信息与会话历史均不变
    expect(ctx.currentId).toBe("会话_x");
    expect(agent.messages).toHaveLength(1);
  });

  it("日志上报交接文档路径（供 TUI notice 展示）", async () => {
    const logs: string[] = [];
    const agent = makeAgent(undefined);
    const ctx = makeCtx(agent);
    const service = createHandoffService(ctx, {
      log: (text) => logs.push(text),
      handoffDir: uniqueDir("log"),
    });

    await service.handoff({ agent: agent as any });

    expect(logs.some((line) => line.includes("📄 交接文档："))).toBe(true);
  });
});
