// Chat 集成测试 —— 拆分前的护栏。
//
// 这个组件此前没有任何测试：它依赖 `ChatSession`（读配置 / 建 Agent / 连 MCP），测试里
// 起不来，于是「输入 → 提交 → 忙碌 → 通知 → 中止」这条主链路完全没有断言。而它正是
// 要拆 hook 的对象 —— 拆坏了，其余 533 个测试一个都不会红。
//
// 这里把 `ChatSession.create` 换成假会话（只需实现 Chat 真正碰到的成员），其余依赖
// （配置 / Agent 仓储 / 思考档位）一并打桩，让组件能在 ink-testing-library 里跑起来。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { setLocale } from "../../i18n/index.js";

const { created, createFakeSession } = vi.hoisted(() => {
  const created: { notifier: any; session: any } = { notifier: null, session: null };

  /** 只实现 Chat 会用的成员；`send` 默认立即把用户消息追加进 messages */
  const createFakeSession = (notifier: any) => {
    const messages: any[] = [];
    return {
      agentId: "default",
      modelId: "gpt-6-astra",
      currentId: "chat_test",
      currentName: "chat_test",
      messages,
      /** 主 / 子 Agent 切换条的数据源；用例里直接 push 进去 */
      subAgents: [] as any[],
      lastUsage: undefined,
      totalUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      rateSample: { live: null, average: null, running: false },
      phase: null,
      send: vi.fn(async (input: string) => {
        messages.push({ id: `m${messages.length}`, role: "user", content: input });
        notifier.onChange(true);
      }),
      abort: vi.fn(),
      dispose: vi.fn(),
      reset: vi.fn(async () => null),
      reload: vi.fn(async () => undefined),
      migrate: vi.fn(async () => "/tmp/handoff.md"),
      handoff: vi.fn(async () => "/tmp/handoff.md"),
      rollbackTo: vi.fn(() => ""),
      save: vi.fn(async () => "chat_test"),
    };
  };

  return { created, createFakeSession };
});

vi.mock("../chat-session.js", () => ({
  ChatSession: {
    create: vi.fn(async (_options: unknown, notifier: any) => {
      const session = createFakeSession(notifier);
      created.notifier = notifier;
      created.session = session;
      return session;
    }),
  },
  // chat-commands 也从这里 import 它
  stripCwdNote: (text: string) => text,
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    readConfig: vi.fn(async () => ({ models: [], endpoints: [], imageModels: [] })),
    readReasoningPresets: vi.fn(async () => ({})),
    readMcpConfig: vi.fn(async () => ({ mcpServers: {} })),
    saveConfig: vi.fn(async () => undefined),
    writeMcpConfig: vi.fn(async () => undefined),
  };
});

vi.mock("../../agents-store.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, readAgentStore: vi.fn(async () => actual.createAgentStore([], [])) };
});

import { Chat } from "./chat.js";

/** 等 effect / Promise / FrameBuffer 合帧跑完（合帧间隔 60ms） */
const flush = async (ms = 80) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const mount = () => render(<Chat agentId="default" />);

describe("Chat 集成（拆分前的护栏）", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
  });

  it("会话就绪后渲染输入占位与状态栏身份块", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("输入消息");
    expect(frame).toContain("gpt-6-astra");
    unmount();
  });

  it("回车把输入框内容作为消息发出", async () => {
    const { stdin, unmount } = mount();
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await flush();
    expect(created.session.send).toHaveBeenCalledWith("你好");
    unmount();
  });

  it("生成中显示阶段提示，且消息已上屏", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 让本轮一直挂着，停留在忙碌态
    created.session.send = vi.fn(() => new Promise<void>(() => {}));
    stdin.write("hi");
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("处理中");
    expect(created.session.send).toHaveBeenCalledWith("hi");
    unmount();
  });

  it("通知通道的内容出现在提示栏（不进对话转录）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    created.notifier.onNotice("配置已更新：模型名");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("配置已更新：模型名");
    unmount();
  });

  it("忙碌时 Ctrl+C 触发中止（不退出）", async () => {
    const { stdin, unmount } = mount();
    await flush();
    created.session.send = vi.fn(() => new Promise<void>(() => {}));
    stdin.write("hi");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\u0003");
    await flush();
    expect(created.session.abort).toHaveBeenCalled();
    unmount();
  });

  it("PgUp 把视口切到滚动态（状态栏提示变更）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 塞满转录，保证「一屏放不下」——否则贴底时往上翻会被钳制回 null，观察不到变化
    for (let i = 0; i < 200; i++) {
      created.session.messages.push({ id: `m${i}`, role: "user", content: `第 ${i} 行` });
    }
    stdin.write("x"); // 任意按键触发一次重渲染，让新消息上屏
    await flush();
    expect(lastFrame() ?? "").toContain("Enter 发送");
    stdin.write("\u001b[5~");
    await flush();
    expect(lastFrame() ?? "").toContain("滚动中");
    unmount();
  });

  it("斜杠前缀弹出命令候选菜单", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("/s");
    await flush();
    const frame = lastFrame() ?? "";
    // `/save` 的说明来自词典，出现即说明候选菜单已渲染
    expect(frame).toContain("/save");
    unmount();
  });

  // ==================== Agent 栏目（主 / 子 Agent 切换）====================

  /** 造一个子 Agent 视图（只需 messages 与状态，组件只读这些） */
  const addSubAgent = (content: string) => {
    const index = created.session.subAgents.length + 1;
    created.session.subAgents.push({
      id: `sub-${index}`,
      index,
      status: "done",
      agent: { messages: [{ id: `sub-${index}`, role: "assistant", content }] },
    });
  };
  /** 触发一帧重绘（不走输入框：敲字符会让「输入为空」的前提失效） */
  const repaint = async () => {
    created.notifier.onChange(true);
    await flush();
  };

  it("有子 Agent 时出现栏目（主AGENT + 子AGENT1/2）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    // 没有子 Agent 时整条栏目不存在
    expect(lastFrame() ?? "").not.toContain("主AGENT");

    addSubAgent("子结论");
    addSubAgent("审查结论");
    await repaint();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("主AGENT");
    expect(frame).toContain("子AGENT1");
    expect(frame).toContain("子AGENT2");
    unmount();
  });

  it("输入框为空时 ←/→ 切换消息列表数据源（主 ↔ 子）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.messages.push({ id: "m1", role: "user", content: "主 Agent 的提问" });
    addSubAgent("子 Agent 的结论");
    await repaint();
    expect(lastFrame() ?? "").toContain("主 Agent 的提问");

    // →：切到子 Agent，列表换成它自己的 messages
    stdin.write("\u001b[C");
    await flush();
    const subFrame = lastFrame() ?? "";
    expect(subFrame).toContain("子 Agent 的结论");
    expect(subFrame).not.toContain("主 Agent 的提问");

    // →：再切一格循环回主 Agent
    stdin.write("\u001b[C");
    await flush();
    const mainFrame = lastFrame() ?? "";
    expect(mainFrame).toContain("主 Agent 的提问");
    expect(mainFrame).not.toContain("子 Agent 的结论");

    // ←：从主 Agent 反向切到最后一个子 Agent
    stdin.write("\u001b[D");
    await flush();
    expect(lastFrame() ?? "").toContain("子 Agent 的结论");
    unmount();
  });

  it("输入框有内容时 ←/→ 仍是移光标，不切栏目", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.messages.push({ id: "m1", role: "user", content: "主 Agent 的提问" });
    addSubAgent("子 Agent 的结论");
    await repaint();

    stdin.write("abc");
    await flush();
    stdin.write("\u001b[C");
    await flush();
    const frame = lastFrame() ?? "";
    // 视图没变，输入内容也没被破坏（左右键只移光标）
    expect(frame).toContain("主 Agent 的提问");
    expect(frame).not.toContain("子 Agent 的结论");
    unmount();
  });

  it("发送消息时自动切回主 Agent 视图（否则看不到自己的提问）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    addSubAgent("子 Agent 的结论");
    await repaint();
    stdin.write("\u001b[C");
    await flush();
    expect(lastFrame() ?? "").toContain("子 Agent 的结论");

    stdin.write("继续干");
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(created.session.send).toHaveBeenCalledWith("继续干");
    expect(frame).toContain("继续干");
    expect(frame).not.toContain("子 Agent 的结论");
    unmount();
  });
});
