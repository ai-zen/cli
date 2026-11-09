import { describe, expect, it, vi, afterAll, beforeEach } from "vitest";
import { existsSync, promises as fs, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import { ChatSession } from "./chat-session.js";
import { ContextGuardPlugin, HandoffAbortedError } from "@ai-zen/agents-sdk";
import { ConversationPersistPlugin } from "../conversation-persist-plugin.js";
import { readLastSession } from "../session-pointer.js";
import { refreshPaths } from "../config.js";

// 在静态导入之前设置 AI_ZEN_DIR（config.ts 在导入时即固化该路径）
const state = vi.hoisted(() => {
  const dir = `/tmp/aiz-reset-${process.pid}-${Date.now()}`;
  process.env.AI_ZEN_DIR = dir;
  return { dir };
});

// 进程内共享模块时其他文件会改写 process.env.AI_ZEN_DIR，每个用例前重新钉回去并刷新路径
beforeEach(() => {
  process.env.AI_ZEN_DIR = state.dir;
  refreshPaths();
});

// 本文件把 AI_ZEN_DIR 指到 /tmp 下的临时目录做隔离；跑完删掉，不在 /tmp 留垃圾。
// （下面用例的注释里提到过「afterAll 会清理 state.dir」，但此前并没有这个 hook）
afterAll(async () => {
  await fs.rm(state.dir, { recursive: true, force: true });
});

// 让假 Agent 真的能分发事件（阶段测试要按 SDK 的事件时序驱动）
const harness = vi.hoisted(() => ({ agents: [] as any[], plugins: [] as any[] }));

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

/**
 * 假的 Agent 工厂 / Scope 重置 —— 通过 `ChatSessionOptions.deps` 注入，
 * **不再** `vi.mock("../agent-creator.js")`：模块级 mock 是全局注册的，进程内共享
 * 模块时会泄漏到其他测试文件（`chat.test.tsx` 就因此读到真实配置）。
 */
const fakeCreateAgent = async (opts: any) => {
  const agent: any = {
    // definition 是模型真相源（ChatSession.modelId 从它读）
    definition: { id: opts?.agentId ?? "default", modelId: "m1", messages: [] },
    messages: opts?.messages ? [...opts.messages] : [],
    lastUsage: undefined,
    use: (plugin: any) => {
      harness.plugins.push(plugin);
    },
    init: async () => {},
    abort: () => {},
    send: async () => {},
    events: makeEvents(),
  };
  harness.agents.push(agent);
  return agent;
};
const fakeResetScope = async () => {};

/** 统一入口：把注入项塞进 options，用例只关心自己的参数 */
const newSession = (
  options: any = {},
  notifier: any = { onChange: () => {}, onNotice: () => {} },
): Promise<ChatSession> =>
  ChatSession.create(
    { ...options, deps: { createAgent: fakeCreateAgent as any, resetScope: fakeResetScope as any } },
    notifier,
  );

describe("ChatSession.reset（/new 归档旧对话）", () => {
  it("空对话不落盘；有内容则归档到原 id，且不误写到新 id", async () => {
    const dir = state.dir;
    const convFile = (id: string) => join(dir, "cli", "conversations", `${id}.json`);
    const session = await newSession(
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

describe("ChatSession.saveAs（`/save <名字>`）", () => {
  const convFile = (id: string) => join(state.dir, "cli", "conversations", `${id}.json`);

  it("写到新名字、删掉旧文件、更新 currentId 与 last-session 指针", async () => {
    const session = await newSession();
    session.currentId = "chat_before_rename";
    session.currentName = "chat_before_rename";
    session.messages.push({ role: AgentNS.Role.User, content: "你好" } as any);
    await session.save(); // 自动落盘先发生了：旧文件已存在
    expect(existsSync(convFile("chat_before_rename"))).toBe(true);

    expect(await session.saveAs("我的对话")).toBe("我的对话");

    expect(session.currentId).toBe("我的对话");
    expect(existsSync(convFile("我的对话"))).toBe(true);
    // 旧文件消失（否则同一份对话会有两条记录）
    expect(existsSync(convFile("chat_before_rename"))).toBe(false);
    // 指针跟着走：下次启动要续接到改名后的会话
    expect((await readLastSession(process.cwd()))?.id).toBe("我的对话");
    const saved = JSON.parse(await fs.readFile(convFile("我的对话"), "utf-8"));
    expect(saved.id).toBe("我的对话");
    expect(saved.messages).toHaveLength(1);
  });

  it("全新会话（旧文件还没落盘）也能存成新名字", async () => {
    const session = await newSession();
    session.currentId = "chat_never_saved";
    session.messages.push({ role: AgentNS.Role.User, content: "刚开的新会话" } as any);
    expect(existsSync(convFile("chat_never_saved"))).toBe(false);

    await session.saveAs("新名字");

    expect(existsSync(convFile("新名字"))).toBe(true);
    expect(session.currentId).toBe("新名字");
  });

  it("id 想逃出会话目录（`../x`）时明确报错，目录外不留文件", async () => {
    const session = await newSession();
    session.currentId = "chat_escape";
    session.messages.push({ role: AgentNS.Role.User, content: "x" } as any);
    await session.save();

    // 校验来自 SDK 的 `EntityRepository.path()`（alpha.25）：以前这里会静默写到
    // `<dir>/cli/逃逸.json` —— 删旧文件那一步还会顺手删掉目录外的同名文件
    await expect(session.saveAs("../逃逸")).rejects.toThrow(/Invalid entity id/);

    expect(existsSync(join(state.dir, "cli", "逃逸.json"))).toBe(false);
    // 当前会话不受影响：新文件没写成，旧文件也不该被删
    expect(session.currentId).toBe("chat_escape");
    expect(existsSync(convFile("chat_escape"))).toBe(true);
  });

  it("目标名与当前 id 相同：只落盘，不删自己", async () => {
    const session = await newSession();
    session.currentId = "chat_same";
    session.messages.push({ role: AgentNS.Role.User, content: "x" } as any);
    await session.save();

    expect(await session.saveAs("chat_same")).toBe("chat_same");

    expect(session.currentId).toBe("chat_same");
    expect(existsSync(convFile("chat_same"))).toBe(true);
  });
});

describe("ChatSession.currentId（唯一真相源 = ctx）", () => {
  it("只改 ctx.currentId 时 session.currentId 立即跟随（自动迁移换 id 的回归）", async () => {
    const session = await newSession(
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
    const session = await newSession(
      {},
      { onChange: () => {}, onNotice: () => {} },
    );

    session.currentId = "会话_手动";

    expect((session as any).ctx.currentId).toBe("会话_手动");
  });
  it("端到端：handoffService.migrate() 之后 currentId 必须跟随新会话（自动迁移路径）", async () => {
    const session = await newSession(
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
    await (session as any).handoffService.migrate({ agent });

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

describe("交接回合的护栏让行（ContextGuardPlugin.isSuspended）", () => {
  it("护栏接线为 handoffService.busy：交接中让行，结束后恢复硬线", async () => {
    // 护栏只在模型配了 tokenThresholds 时才装；假 agent 的模型 id 是 m1
    mkdirSync(state.dir, { recursive: true });
    writeFileSync(
      join(state.dir, "config.json"),
      JSON.stringify({
        endpoints: [],
        models: [
          {
            id: "m1",
            name: "M1",
            endpointId: "e",
            tokenThresholds: { handoff: 1000, guard: 1500 },
            custom: true,
          },
        ],
        version: 4,
      }),
    );

    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
    const guard = harness.plugins.filter((p) => p instanceof ContextGuardPlugin).at(-1) as any;
    expect(guard).toBeTruthy();

    // 上下文最满的时刻（交接恰好在这种时刻发起）
    const ctx = { agent: { lastUsage: { prompt_tokens: 10_000_000 } }, content: "", messages: [] };

    await expect(guard.onInnerLoopStart(ctx)).rejects.toThrow();

    const service = (session as any).handoffService;
    (service as any)._busy = true;
    await expect(guard.onInnerLoopStart(ctx)).resolves.toBeUndefined();

    (service as any)._busy = false;
    await expect(guard.onInnerLoopStart(ctx)).rejects.toThrow();
  });
});

describe("ChatSession 落盘失败的上报（PLAN L7）", () => {
  /**
   * 落盘是「每轮自动保存」，失败属于真错误（用户以为什么都没丢）—— 必须走 `error` 语气。
   * 修前这里传的是 `"info"`，日志栏一片灰字，与「已保存」类提示长得一样。
   */
  it("自动落盘失败时通知语气为 error（不是 info）", async () => {
    const notices: { text: string; tone?: string }[] = [];
    await newSession({}, { onChange: () => {}, onNotice: (text: string, tone?: string) => notices.push({ text, tone }) });

    const persist = harness.plugins.filter((p) => p instanceof ConversationPersistPlugin).at(-1) as any;
    expect(persist).toBeDefined();

    // 把根目录指向「文件下面」—— mkdir 必失败，从而必然走到 onError
    process.env.AI_ZEN_DIR = "/dev/null/aizen-impossible";
    refreshPaths();
    await persist.onInnerLoopEnd({ agent: { messages: [{ role: AgentNS.Role.User, content: "hi" }] } });

    expect(notices.at(-1)?.tone).toBe("error");
  });
});

describe("ChatSession.totalUsage（本会话累计用量）", () => {
  it("逐消息求和：assistant 的 usage + 工具消息的 subAgentUsage（含子 Agent）", async () => {
    const session = await newSession(
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
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
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
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
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
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
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
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
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
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
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
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
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
    const session = await newSession(
      {},
      { onChange: () => {}, onNotice: (text: string) => notices.push(text) },
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

  it("本轮内循环全部结束（send 收尾）时清空，序号归零", async () => {
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
    const agent = harness.agents.at(-1)!;
    const toolCallContext = { tool_call: { function: { name: "sub_agent_default" } } };

    // 子 Agent 是内循环里工具调用的产物：让它在本轮执行期间出现
    let seenDuringSend: number | undefined;
    agent.send = async () => {
      agent.events.emit("sub-agent-start", { subAgent: makeSubAgent(), toolCallContext });
      agent.events.emit("sub-agent-start", { subAgent: makeSubAgent(), toolCallContext });
      seenDuringSend = session.subAgents.length;
    };

    await session.send("统计一下文件数");

    // 执行期间栏目里有东西（能切换看）
    expect(seenDuringSend).toBe(2);
    // 内循环结束后清空：主 Agent 已给出答案，子 Agent 只剩历史价值
    expect(session.subAgents).toEqual([]);

    // 下一轮的第一个子 Agent 又是「子AGENT1」（标签不跳号）
    agent.send = async () => {
      agent.events.emit("sub-agent-start", { subAgent: makeSubAgent(), toolCallContext });
      expect(session.subAgents.map((view) => view.index)).toEqual([1]);
    };
    await session.send("再来一次");
    expect(session.subAgents).toEqual([]);
  });

  it("中止 / 出错也清空（finally 路径，不留残影）", async () => {
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
    const agent = harness.agents.at(-1)!;
    const toolCallContext = { tool_call: { function: { name: "sub_agent_default" } } };

    agent.send = async () => {
      agent.events.emit("sub-agent-start", { subAgent: makeSubAgent(), toolCallContext });
      throw new Error("boom");
    };
    await session.send("会失败的一轮");
    expect(session.subAgents).toEqual([]);
  });

  it("reset / reload 换了 Agent 也清空（它们不重建会话实例，不清就会残留）", async () => {
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
    const toolCallContext = { tool_call: { function: { name: "sub_agent_default" } } };

    harness.agents.at(-1)!.events.emit("sub-agent-start", {
      subAgent: makeSubAgent(),
      toolCallContext,
    });
    expect(session.subAgents).toHaveLength(1);
    await session.reset();
    expect(session.subAgents).toEqual([]);

    harness.agents.at(-1)!.events.emit("sub-agent-start", {
      subAgent: makeSubAgent(),
      toolCallContext,
    });
    expect(session.subAgents).toHaveLength(1);
    await session.reload();
    expect(session.subAgents).toEqual([]);
  });
});

describe("ChatSession.abort（Ctrl+C 中断交接）", () => {
  /**
   * 把 session 武装成「能跑 self 交接」：`self` 需要 `write` 工具 + `send`，
   * 文档目录改指临时区（`PROJECT_HANDOFFS_DIR` 固化自模块加载时的 cwd）。
   */
  function armSelfHandoff(session: ChatSession): any {
    const agent = (session as any).agent;
    agent.tools = [{ type: "function", function: { name: "write", parameters: {} } }];
    agent.model = "m";
    agent.modelConfig = {};
    (session as any).handoffService.handoffDirPath = join(state.dir, "handoffs-abort");
    return agent;
  }

  it("交接中被中断：会话退回交接前（消息逐条不变）", async () => {
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
    const agent = armSelfHandoff(session);
    session.messages.push({ role: AgentNS.Role.User, content: "帮我做任务" } as any);
    const before = JSON.parse(JSON.stringify(session.messages));

    // 真机形态：交接回合就是一次 `agent.send()`，Ctrl+C 后 send 正常返回
    // （core 把消息标记 Aborted、不抛错），所以取消只能靠服务那条 signal。
    agent.send = async (content: string) => {
      agent.messages.push({ role: AgentNS.Role.User, content });
      agent.messages.push({ role: AgentNS.Role.Assistant, content: "交接文档已写好" });
      session.abort();
    };

    await expect(session.handoff("self")).rejects.toThrow(HandoffAbortedError);

    // 那条几 KB 的 Skill 指令不能留在历史里：否则下一次请求会把它当历史再发一遍，
    // `↑` 翻历史也会把它翻出来
    expect(session.messages).toEqual(before);
  });

  it("abort() 把取消转交给 handoffService（自动迁移只有这一个开关）", async () => {
    const session = await newSession({}, { onChange: () => {}, onNotice: () => {} });
    const agent: any = (session as any).agent;
    const serviceAbort = vi.fn();
    (session as any).handoffService.abort = serviceAbort;
    const agentAbort = vi.fn();
    agent.abort = agentAbort;

    session.abort();

    // 自动迁移由 SDK 插件直接驱动、不经过本类，调用方递不进 signal ——
    // 服务自身的句柄是唯一入口，漏掉它就等于「自动迁移期间 Ctrl+C 无效」
    expect(serviceAbort).toHaveBeenCalledTimes(1);
    expect(agentAbort).toHaveBeenCalledTimes(1);
  });
});
