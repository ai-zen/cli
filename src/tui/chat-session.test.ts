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

// 让假 Agent 真的能分发事件（阶段测试要按 SDK 的事件时序驱动）
const harness = vi.hoisted(() => ({ agents: [] as any[] }));

/** 一个最小的事件总线（SDK 的 EventBus 只用到 on / off / emit） */
function makeEvents() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    on: (name: string, fn: (...args: any[]) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    off: (name: string, fn: (...args: any[]) => void) => {
      listeners.get(name)?.delete(fn);
    },
    emit: (name: string, ...args: any[]) => {
      for (const fn of listeners.get(name) ?? []) fn(...args);
    },
  };
}

// 把 agent-creator 打桩，避免真实构建 Agent / 访问网络
vi.mock("../agent-creator.js", () => ({
  createAgent: vi.fn(async (opts: any) => {
    const agent: any = {
      // definition 是模型真相源（ChatSession.modelId 从它读）
      definition: { id: opts?.agentId ?? "default", modelId: "m1", messages: [] },
      messages: opts?.messages ? [...opts.messages] : [],
      lastUsage: undefined,
      use: () => {},
      init: async () => {},
      abort: () => {},
      send: async () => {},
      events: makeEvents(),
    };
    harness.agents.push(agent);
    return agent;
  }),
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

describe("生成阶段（消息栏 spinner 的六态）", () => {
  /** 造一个带事件总线的子 Agent（onSubStart 会给它挂监听） */
  const makeSubAgent = () => {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    return {
      events: {
        on: (name: string, fn: (...args: any[]) => void) => {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name)!.add(fn);
        },
        off: (name: string, fn: (...args: any[]) => void) => listeners.get(name)?.delete(fn),
        emit: (name: string, ...args: any[]) => {
          for (const fn of listeners.get(name) ?? []) fn(...args);
        },
      },
    };
  };

  it("按 SDK 事件时序推进：open → queued，delta → thinking/streaming，parsed+tool_calls → tool-waiting", async () => {
    const session = await ChatSession.create({}, { onChange: () => {}, onNotice: () => {} });
    const agent = harness.agents.at(-1)!;

    agent.events.emit("open");
    expect(session.phase).toEqual({ kind: "queued" });

    agent.events.emit("chunk-parsed", {}, { choices: [{ delta: { reasoning_content: "想" } }] });
    expect(session.phase).toEqual({ kind: "thinking" });

    agent.events.emit("chunk-parsed", {}, { choices: [{ delta: { content: "说" } }] });
    expect(session.phase).toEqual({ kind: "streaming" });

    agent.events.emit("parsed", { tool_calls: [{ function: { name: "grep" } }] });
    expect(session.phase).toEqual({ kind: "tool-waiting", tool: "grep" });
  });

  it("子 Agent 的输出**不**覆盖主阶段（主 Agent 此刻在等工具返回）", async () => {
    const session = await ChatSession.create({}, { onChange: () => {}, onNotice: () => {} });
    const agent = harness.agents.at(-1)!;

    agent.events.emit("open");
    agent.events.emit("parsed", { tool_calls: [{ function: { name: "sub_agent_default" } }] });
    expect(session.phase).toEqual({ kind: "tool-waiting", tool: "sub_agent_default" });

    const subAgent = makeSubAgent();
    agent.events.emit("sub-agent-start", {
      subAgent,
      toolCallContext: { tool_call: { function: { name: "sub_agent_default" } } },
    });
    // 子 Agent 开始吐内容 / 换轮次：主阶段必须仍停在「等待 xxx 返回」
    subAgent.events.emit("open");
    subAgent.events.emit("chunk-parsed", {}, { choices: [{ delta: { content: "子任务输出" } }] });
    expect(session.phase).toEqual({ kind: "tool-waiting", tool: "sub_agent_default" });
  });

  it("send 结束时阶段归零（spinner 消失后不留残影）", async () => {
    const session = await ChatSession.create({}, { onChange: () => {}, onNotice: () => {} });
    // send() 内部会调用 agent.send()，此处假 Agent 立即返回
    await session.send("你好");
    expect(session.phase).toBeNull();
  });
});

describe("ChatSession.subAgents（Agent 栏目的数据源）", () => {
  /** 带事件总线的假子 Agent（onSubStart 会给它挂监听） */
  const makeSubAgent = () => {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    return {
      messages: [] as any[],
      events: {
        on: (name: string, fn: (...args: any[]) => void) => {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name)!.add(fn);
        },
        off: (name: string, fn: (...args: any[]) => void) => listeners.get(name)?.delete(fn),
        emit: (name: string, ...args: any[]) => {
          for (const fn of listeners.get(name) ?? []) fn(...args);
        },
      },
    };
  };

  it("按出现顺序编号（标签就叫「子AGENT1/2」，不看工具名）", async () => {
    const session = await ChatSession.create({}, { onChange: () => {}, onNotice: () => {} });
    const agent = harness.agents.at(-1)!;
    expect(session.subAgents).toEqual([]);

    // 同一个委派工具连开两次（现实中就是这么撞名的）——靠序号区分
    agent.events.emit("sub-agent-start", {
      subAgent: makeSubAgent(),
      toolCallContext: { tool_call: { function: { name: "sub_agent_default" } } },
    });
    agent.events.emit("sub-agent-start", {
      subAgent: makeSubAgent(),
      toolCallContext: { tool_call: { function: { name: "sub_agent_default" } } },
    });

    expect(session.subAgents.map((view) => view.index)).toEqual([1, 2]);
    expect(new Set(session.subAgents.map((view) => view.id)).size).toBe(2);
    // 刚开跑：都在运行中
    expect(session.subAgents.map((view) => view.status)).toEqual(["running", "running"]);
  });

  it("委派结束后仍保留实例且状态转 done（栏目可回看子 Agent 自己的 messages）", async () => {
    const session = await ChatSession.create({}, { onChange: () => {}, onNotice: () => {} });
    const agent = harness.agents.at(-1)!;
    const subAgent = makeSubAgent();
    subAgent.messages.push({ role: AgentNS.Role.Assistant, content: "子 Agent 的结论" });
    const toolCallContext = { tool_call: { function: { name: "sub_agent_default" } } };

    agent.events.emit("sub-agent-start", { subAgent, toolCallContext });
    agent.events.emit("sub-agent-end", { subAgent, toolCallContext });

    expect(session.subAgents).toHaveLength(1);
    expect(session.subAgents[0]!.agent).toBe(subAgent);
    expect(session.subAgents[0]!.agent.messages[0]!.content).toBe("子 Agent 的结论");
    expect(session.subAgents[0]!.status).toBe("done");
  });

  it("子 Agent 出错 → failed，且不会被随后的 end 覆盖成 done", async () => {
    const session = await ChatSession.create({}, { onChange: () => {}, onNotice: () => {} });
    const agent = harness.agents.at(-1)!;
    const subAgent = makeSubAgent();
    const toolCallContext = { tool_call: { function: { name: "sub_agent_default" } } };

    agent.events.emit("sub-agent-start", { subAgent, toolCallContext });
    // core 的 onSubAgentEnd 在 finally 里分发：出错后 end 照样会来
    subAgent.events.emit("error", new Error("boom"));
    agent.events.emit("sub-agent-end", { subAgent, toolCallContext });

    expect(session.subAgents[0]!.status).toBe("failed");
  });

  it("子 Agent 的进度不进通知栏（只更新状态，避免整帧高度跳动）", async () => {
    const notices: string[] = [];
    const session = await ChatSession.create(
      {},
      { onChange: () => {}, onNotice: (text) => notices.push(text) },
    );
    const agent = harness.agents.at(-1)!;
    const subAgent = makeSubAgent();
    const toolCallContext = { tool_call: { function: { name: "sub_agent_default" } } };

    agent.events.emit("sub-agent-start", { subAgent, toolCallContext });
    subAgent.events.emit("chunk-parsed", {}, { choices: [{ delta: { content: "干活中" } }] });
    agent.events.emit("sub-agent-end", { subAgent, toolCallContext });

    expect(notices).toEqual([]);
    expect(session.subAgents[0]!.status).toBe("done");
  });
});
