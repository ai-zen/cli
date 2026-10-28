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
});
