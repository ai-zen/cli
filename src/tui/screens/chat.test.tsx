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
    /** 主 / 子 Agent 切换条的数据源；用例里直接 push 进去 */
    const subAgents: any[] = [];
    return {
      agentId: "default",
      modelId: "gpt-6-astra",
      currentId: "chat_test",
      currentName: "chat_test",
      messages,
      subAgents,
      lastUsage: undefined,
      totalUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      rateSample: { live: null, average: null, running: false },
      phase: null,
      send: vi.fn(async (input: string) => {
        messages.push({ id: `m${messages.length}`, role: "user", content: input });
        // 与真实 ChatSession 一致：新一轮输入清空上一轮的子 Agent
        subAgents.length = 0;
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

/**
 * 全部依赖改为**注入**（`Chat` 的 `deps`），不再 `vi.mock`：
 * 模块级 mock 是全局注册的，进程内共享模块（`isolate: false`）时会污染其他测试文件
 * —— 实测它会把这个文件里的假 `readConfig`（models 为空）泄漏给 `agent-creator` 等。
 */
const fakeAgentStore = () => ({ agents: [], subAgents: [], save: async () => {}, remove: async () => {} }) as any;

/** 空配置 + 空 Agent 仓储：向导与思考档位读取都走它 */
const fakeConfig = () => ({ models: [], endpoints: [], imageModels: [] }) as any;
const fakeReaders = {
  readConfig: async () => fakeConfig(),
  readMcpConfig: async () => ({ mcpServers: {} }) as any,
  readReasoningPresets: async () => ({}),
  readAgentStore: async () => fakeAgentStore(),
};

const fakeIndex = [
  { path: "src/tui", dir: true },
  { path: "src/tui/screens/chat.tsx", dir: false },
  { path: "README.md", dir: false },
];

/** 剪贴板桩：不打桩就会真去 spawn `pbpaste` / `wl-paste` */
const clipboardMock = vi.hoisted(() => ({
  image: { kind: "none" } as { kind: string; image?: { base64: string; mime: string } },
  text: null as string | null,
}));

import { Chat } from "./chat.js";

/** 等 effect / Promise / FrameBuffer 合帧跑完（合帧间隔 60ms） */
const flush = async (ms = 4) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const mount = (options: { initialInput?: string } = {}) =>
  render(
    <Chat
      agentId="default"
      initialInput={options.initialInput}
      deps={{
        readConfig: async () => fakeConfig(),
        readReasoningPresets: async () => ({}),
        readAgentStore: async () => fakeAgentStore(),
        createSession: (async (_options: unknown, notifier: any) => {
          const session = createFakeSession(notifier);
          created.notifier = notifier;
          created.session = session;
          return session;
        }) as any,
        listProjectPaths: async () => fakeIndex as any,
        readClipboardImage: async () => clipboardMock.image as any,
        readClipboardText: async () => clipboardMock.text,
        // 向导路径（`/config`、`/key`）也要注入，否则会读写真实配置目录
        wizardReaders: fakeReaders,
        saveConfig: async () => {},
        writeMcpConfig: async () => {},
      }}
    />,
  );

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
    expect(created.session.send).toHaveBeenCalledWith("你好", []);
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
    expect(created.session.send).toHaveBeenCalledWith("hi", []);
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

  // ==================== ↑/↓：多行先移光标，到边界才翻历史 ====================

  it("光标已在首行时 ↑ 才翻历史（单行输入保持原行为）", async () => {
    const { stdin, unmount } = mount();
    await flush();
    stdin.write("hello");
    await flush();
    stdin.write("\r");
    await flush(20);
    expect(created.session.send).toHaveBeenCalledTimes(1);

    // 输入框已空、单行 → ↑ 拿回历史，再回车又发一遍同样的内容
    // （箭头键要等一次重渲染才能把新草稿交给按键处理器，实测 20ms 够）
    stdin.write("\u001b[A");
    await flush(20);
    stdin.write("\r");
    await flush();
    expect(created.session.send).toHaveBeenCalledTimes(2);
    expect(created.session.send.mock.calls[1]![0]).toBe("hello");
    unmount();
  });

  // ==================== 多行光标移动（PLAN：↑/↓ 优先在行间移动）====================

  it("输入 ≥ 2 行时 ↑/↓ 先移动光标，不到首/末行不翻历史", async () => {
    const { stdin, lastFrame, unmount } = mount({ initialInput: "aa\nbb" });
    await flush();

    stdin.write("\u001b[A"); // ↑：光标从第二行行尾移到第一行行尾
    await flush(20);
    stdin.write("X"); // 插在第一行 → 证明光标确实上去了
    await flush();
    expect(lastFrame() ?? "").toContain("aaX");

    stdin.write("\u001b[B"); // ↓：回到第二行行尾
    await flush(20);
    stdin.write("Y");
    await flush();
    expect(lastFrame() ?? "").toContain("bbY");
    unmount();
  });

  // ==================== 输入区限高 8 行（PLAN L17）====================

  /** 20 行草稿：L0 … L19；挂载时光标在末尾（第 19 行） */
  const twentyLines = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");

  it("草稿超过 8 行时只渲染 8 行，且光标在末行时窗口贴底", async () => {
    const { lastFrame, unmount } = mount({ initialInput: twentyLines });
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("L19"); // 光标所在行一定可见
    expect(frame).toContain("L12");
    expect(frame).not.toContain("L11"); // 窗口上方折叠
    // 只渲染 8 行输入（1 提示符行 + 7 缩进行）
    expect(frame.split("\n").filter((row) => /^\s*(❯ )?L\d+$/.test(row.trimEnd()))).toHaveLength(8);
    unmount();
  });

  it("窗口跟随光标：在末行按 ↑ 后整窗上移一行（不是钉在末尾）", async () => {
    const { stdin, lastFrame, unmount } = mount({ initialInput: twentyLines });
    await flush();
    stdin.write("\u001b[A"); // 光标到第 19 行 → 窗口 from = 11
    await flush(20);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("L18");
    expect(frame).toContain("L11");
    expect(frame).not.toContain("L19"); // 已滚到窗口下方之外
    expect(frame).not.toContain("L10");
    unmount();
  });

  // ==================== 底部锚定菜单（PLAN L14 + L16）====================

  /** 找出包含某片段的行号（-1 = 没渲染） */
  const rowOf = (frame: string, needle: string) =>
    frame.split("\n").findIndex((row) => row.includes(needle));

  it("斜杠菜单自底部锚定：首项紧贴分隔线，其余候选向上生长", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("/c"); // 候选只有 /clear 与 /config 两条，便于定位
    await flush();
    const frame = lastFrame() ?? "";
    const clear = rowOf(frame, "/clear");
    const config = rowOf(frame, "/config");
    const separator = rowOf(frame, "───");
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(config).toBeGreaterThanOrEqual(0);
    // 数据顺序 clear → config；视觉上 config 在 clear 上方，clear 紧贴输入框的分隔线
    expect(config).toBeLessThan(clear);
    expect(separator).toBe(clear + 1);
    // 默认高亮第一条（最底下那条）
    expect(frame.split("\n")[clear]).toContain("❯");
    unmount();
  });

  it("菜单打开时 ↑ = 选下一条（高亮上移）、↓ = 选上一条", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("/c");
    await flush();

    stdin.write("\u001b[A"); // ↑
    await flush();
    let rows = (lastFrame() ?? "").split("\n");
    const configRow = rowOf(lastFrame() ?? "", "/config");
    const clearRow = rowOf(lastFrame() ?? "", "/clear");
    expect(rows[configRow]).toContain("❯");
    expect(rows[clearRow]).not.toContain("❯");

    stdin.write("\u001b[B"); // ↓
    await flush();
    rows = (lastFrame() ?? "").split("\n");
    expect(rows[rowOf(lastFrame() ?? "", "/clear")]).toContain("❯");
    unmount();
  });

  it("`@` 菜单与斜杠菜单共用同一套底部锚定菜单（目录带尾斜杠）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    await flush(); // 等文件索引回填（注入的 listProjectPaths 是 Promise）
    const frame = lastFrame() ?? "";
    const readme = rowOf(frame, "README.md");
    // 「src/tui/」是「src/tui/screens/chat.tsx」的子串，必须锁行尾才能定位到那条目录
    const dir = frame
      .split("\n")
      .findIndex((row) => row.trim().endsWith("src/tui/"));
    const separator = rowOf(frame, "───");
    expect(readme).toBeGreaterThanOrEqual(0);
    expect(dir).toBeGreaterThanOrEqual(0);
    // 空查询时 rankPaths 按「浅 → 短」排序：README.md < src/tui < src/tui/screens/chat.tsx
    expect(dir).toBe(readme - 1);
    expect(readme).toBe(separator - 1);
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
    expect(created.session.send).toHaveBeenCalledWith("继续干", []);
    expect(frame).toContain("继续干");
    expect(frame).not.toContain("子 Agent 的结论");
    unmount();
  });
});

describe("`@` 文件路径补全", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
  });

  it("敲下 @ 后弹出候选菜单（先显示扫描中，再出结果）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("README.md");
    // 目录带尾斜杠：一眼能看出「选中它会继续往下钻」
    expect(frame).toContain("src/tui/");
    unmount();
  });

  it("Tab 把选中项补进草稿，且不发送", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@chat");
    await flush();
    stdin.write("\t");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("@src/tui/screens/chat.tsx");
    expect(created.session.send).not.toHaveBeenCalled();
    unmount();
  });

  it("菜单开着时回车 = 补全（不发送半截消息）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@chat");
    await flush();
    stdin.write("\r");
    await flush();
    expect(created.session.send).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").toContain("@src/tui/screens/chat.tsx");
    unmount();
  });

  it("↓ 换高亮项：第二条被补进去", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    // 空查询下顺序：README.md → src/tui → src/tui/screens/chat.tsx
    stdin.write("\u001b[B");
    await flush();
    stdin.write("\t");
    await flush();
    expect(lastFrame() ?? "").toContain("@src/tui/");
    unmount();
  });

  it("Esc 只关菜单，草稿仍在", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@chat");
    await flush();
    stdin.write("\u001b");
    await flush(30); // lone ESC 需 ~20ms（ink 序列判定）
    const frame = lastFrame() ?? "";
    expect(frame).toContain("@chat");
    expect(frame).not.toContain("screens/chat.tsx");
    unmount();
  });

  it("没有匹配时不弹菜单，回车照常发送", async () => {
    const { stdin, unmount } = mount();
    await flush();
    stdin.write("@zzz");
    await flush();
    stdin.write("\r");
    await flush();
    expect(created.session.send).toHaveBeenCalledWith("@zzz", []);
    unmount();
  });
});

describe("粘贴：Ctrl+V 图片优先、无图回退文本", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    clipboardMock.image = { kind: "none" };
    clipboardMock.text = null;
  });

  /** Ctrl+V（`\x16` → char "v" + ctrl） */
  const paste = async (stdin: any) => {
    stdin.write("\u0016");
    await flush();
  };
  const oneImage = { kind: "image", image: { base64: "QUJD", mime: "image/png" } };

  it("剪贴板没有图片时，粘贴的是文本", async () => {
    clipboardMock.text = "粘贴进来的文字";
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("粘贴进来的文字");
    unmount();
  });

  it("剪贴板有图片时附到消息上，并显示附件行", async () => {
    clipboardMock.image = oneImage;
    clipboardMock.text = "不该被粘贴的文字";
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("已附加 1 张图片");
    expect(frame).not.toContain("不该被粘贴的文字");
    unmount();
  });

  it("Esc 先清附件、草稿保留（误粘的退路）", async () => {
    clipboardMock.image = oneImage;
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("看这张");
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("已附加 1 张图片");

    stdin.write("\u001b");
    await flush(30); // lone ESC 需 ~20ms（ink 序列判定）
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("已附加 1 张图片");
    expect(frame).toContain("看这张");
    unmount();
  });

  it("发送时把图片一并交给会话（文案仍是纯文本）", async () => {
    clipboardMock.image = oneImage;
    const { stdin, unmount } = mount();
    await flush();
    stdin.write("看图");
    await flush();
    await paste(stdin);
    stdin.write("\r");
    await flush();
    expect(created.session.send).toHaveBeenCalledWith("看图", [oneImage.image]);
    unmount();
  });

  it("剪贴板既没图片也没文字时给提示，不插任何东西", async () => {
    clipboardMock.text = "";
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("剪贴板里没有内容");
    unmount();
  });
});
