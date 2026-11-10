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

const { created, createFakeSession, fakeIndex } = vi.hoisted(() => {
  const created: { notifier: any; session: any; options: any } = {
    notifier: null,
    session: null,
    options: null,
  };

  /**
   * 本工作区的文件清单 —— 假会话的「服务端磁盘」。
   *
   * 它刻意不代表本机目录：`@` 补全只能从这里出候选（远程时会话跑在服务端，
   * 屏幕这边扫本机磁盘只会列出客户端的文件）。
   */
  const fakeIndex = [
    { path: "src/tui", dir: true },
    { path: "src/tui/screens/chat.tsx", dir: false },
    { path: "README.md", dir: false },
  ];

  /** 只实现 Chat 会用的成员；`send` 默认立即把用户消息追加进 messages */
  const createFakeSession = (notifier: any) => {
    const messages: any[] = [];
    /** 主 / 子 Agent 切换条的数据源；用例里直接 push 进去 */
    const subAgents: any[] = [];
    return {
      agentId: "default",
      modelId: "gpt-6-astra",
      currentId: "chat_test",
      messages,
      subAgents,
      lastUsage: undefined,
      totalUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      rateSample: { live: null, average: null, running: false },
      phase: null,
      send: vi.fn(
        async (input: string, images: readonly { base64: string; mime: string }[] = []) => {
          // 与真实 ChatSession.send 同形：有图时内容是多段（文本 + image_url 的 data URL），
          // 于是 messages 里真的带着图片 —— `↑` 的图片还原才有东西可解。
          const content =
            images.length === 0
              ? input
              : [
                  { type: "text", text: input },
                  ...images.map((image) => ({
                    type: "image_url",
                    image_url: { url: `data:${image.mime};base64,${image.base64}` },
                  })),
                ];
          messages.push({ id: `m${messages.length}`, role: "user", content });
          // 与真实 ChatSession 一致：新一轮输入清空上一轮的子 Agent
          subAgents.length = 0;
          notifier.onChange(true);
        },
      ),
      abort: vi.fn(),
      dispose: vi.fn(),
      reset: vi.fn(async () => null),
      reload: vi.fn(async () => undefined),
      migrate: vi.fn(async () => "/tmp/handoff.md"),
      handoff: vi.fn(async () => "/tmp/handoff.md"),
      rollbackTo: vi.fn(() => ""),
      save: vi.fn(async () => "chat_test"),
      // `@` 补全的唯一来源：清单由会话提供，屏幕不碰本地磁盘
      listWorkspaceFiles: vi.fn(async () => fakeIndex as any),
    };
  };

  return { created, createFakeSession, fakeIndex };
});

/**
 * 全部依赖改为**注入**（`Chat` 的 `deps`），不再 `vi.mock`：
 * 模块级 mock 是全局注册的，进程内共享模块（`isolate: false`）时会污染其他测试文件
 * —— 实测它会把这个文件里的假 `readConfig`（models 为空）泄漏给同进程的其它模块。
 */
const fakeAgentStore = () =>
  ({ agents: [], subAgents: [], save: async () => {}, remove: async () => {} }) as any;

/** 空配置 + 空 Agent 仓储：向导与思考档位读取都走它 */
const fakeConfig = () => ({ models: [], endpoints: [], imageModels: [] }) as any;

/**
 * 假配置面（`ConfigPort`）—— 本轮接线的核心：屏幕上的每处配置读写都该落在这里。
 *
 * 用注入的假端口而不是 `vi.mock("../../config.js")`：模块级 mock 是全局注册的，
 * 进程内共享模块时会把这个假配置泄漏给别的测试文件。
 *
 * `satisfies ConfigPort` 是故意的：端口长出新方法时，这里会先红，提醒测试同步。
 */
const fakePort = (config: any = fakeConfig()) =>
  ({
    readConfig: vi.fn(async () => config),
    readConfigFile: vi.fn(async () => ({ config, path: "/srv/.ai-zen/config.json" })),
    saveConfig: vi.fn(async (_next: any) => {}),
    readReasoningPresets: vi.fn(async () => ({}) as any),
    readMcpConfig: vi.fn(async (_scope?: any) => ({ ok: true, config: { mcpServers: {} } }) as any),
    writeMcpConfig: vi.fn(async (_config: any, _scope?: any) => {}),
    readAgentStore: vi.fn(async () => fakeAgentStore()),
    setModel: vi.fn(async (_agentId: string, _modelId: string) => {}),
    setDefaultAgent: vi.fn(async (_agentId: string) => {}),
    setDefaultModel: vi.fn(async (_modelId: string) => {}),
  }) satisfies ConfigPort;

type FakePort = ReturnType<typeof fakePort>;

/** 剪贴板桩：不打桩就会真去 spawn `pbpaste` / `wl-paste` */
const clipboardMock = vi.hoisted(() => ({
  image: { kind: "none" } as { kind: string; image?: { base64: string; mime: string } },
  text: { kind: "unavailable" } as ClipboardTextResult,
}));

import { Chat } from "./chat.js";
import type { ConfigPort } from "../../server-client/index.js";
import { getCommandHints } from "../../commands/registry.js";
import type { ClipboardTextResult } from "../../clipboard.js";

/** 等 effect / Promise / FrameBuffer 合帧跑完（合帧间隔 60ms） */
const flush = async (ms = 4) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 轮询直到条件成立（上限 `ms`，超时就交给后续断言去报错）。
 *
 * 合帧间隔是 60ms，而按键触发的状态更新要等一次重渲染才会被下一个按键看到 ——
 * 用固定的 `flush(20)` 等这件事就是玄学：本机快的时候够、CI 或负载高的时候不够，
 * 于是同一份代码时红时绿。这里改成「等到可观测的效果出现」。
 */
const waitFor = async (predicate: () => boolean, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await flush(8);
};

/**
 * 取帧里输入框那一行的内容（分隔线之后、状态栏之前），用于判断草稿是否已经落到输入框
 */
const inputLineOf = (frame: string): string => {
  const lines = frame.split("\n");
  const divider = lines.map((line) => line.includes("───")).lastIndexOf(true);
  return divider >= 0 ? (lines[divider + 1] ?? "") : "";
};

/**
 * 等到输入区真的可编辑（会话空闲）。
 *
 * 生成中第一个 `useInput` 是关着的（`isActive: !busy`），此时按键直接被丢掉 ——
 * 而发送后的 `busy` 翻转要等 Promise 回调 + 合帧，用固定 `flush(20)` 撞不撞得上
 * 全看机器快慢，于是同一条用例时红时绿（发版门禁被它卡住过一次）。
 *
 * 判据用「敲一个字符看输入框有没有回显」：有回显就证明编辑处理器在收键，
 * 随即退格清掉，不影响后续断言。
 */
const waitUntilEditable = async (
  stdin: { write: (data: string) => void },
  lastFrame: () => string | undefined,
) => {
  for (let i = 0; i < 60; i++) {
    stdin.write("z");
    await flush(16);
    if (inputLineOf(lastFrame() ?? "").includes("z")) {
      stdin.write("\u007f"); // Backspace：把探针字符退掉
      await flush(16);
      return;
    }
  }
};

const mount = (options: { initialInput?: string; resume?: boolean; port?: FakePort } = {}) => {
  const port = options.port ?? fakePort();
  return render(
    <Chat
      agentId="default"
      initialInput={options.initialInput}
      resume={options.resume}
      deps={{
        // 配置面是唯一入口，向导快照读取也由它派生（不再单独注入 wizardReaders）
        config: port,
        createSession: (async (sessionOptions: unknown, notifier: any) => {
          const session = createFakeSession(notifier);
          created.notifier = notifier;
          created.session = session;
          // 存下屏幕交给会话的选项：`resume` 这类「意图」是否透传就看它
          created.options = sessionOptions;
          return session;
        }) as any,
        readClipboardImage: async () => clipboardMock.image as any,
        readClipboardText: async () => clipboardMock.text,
      }}
    />,
  );
};

describe("Chat 集成（拆分前的护栏）", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
  });

  it("会话就绪后渲染输入占位与状态栏身份块", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("输入消息");
    expect(frame).toContain("gpt-6-astra");
    unmount();
  });

  it("空对话在对话区顶部显示欢迎块（logo + 标语），且不阻塞输入", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("终端里的 AI 协作台");
    // 品牌 logo（宽终端出 6 行宽版，窄终端退化成单行）
    expect(frame).toMatch(/█████╗|AI · ZEN/);
    // 底部输入框与状态栏照常在
    expect(frame).toContain("输入消息");
    unmount();
  });

  it("发出首条消息后欢迎块消失", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame() ?? "").not.toContain("终端里的 AI 协作台");
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

  /**
   * 这条要连走两屏（`/key` → 输入 → 保存），用例自己的等待上限合计 8000ms —— 比 vitest
   * 默认的 `testTimeout`（5000ms，本仓没有改过）还长。所以显式放宽这一条的时限。
   *
   * 为什么不把那些 2000/4000 调小：它们是「慢机器上最多等多久」，调小了就在慢机器上误伤；
   * 而**预算合计 > 时限**这个结构问题，只能从时限这一侧修（逻辑写错时仍然会在第一个
   * 等不到的 `waitFor` 上以清晰的断言失败报出来，不会因为时限放宽而变成挂死）。
   */
  it("向导落盘走配置面：`/key` 保存时调用假端口的 saveConfig", async () => {
    // 有模型 + 端点的配置，`/key` 才能定位到「当前模型用的那个端点」
    const port = fakePort({
      models: [{ id: "gpt-6-astra", name: "Astra", endpointId: "ep1" }],
      endpoints: [{ id: "ep1", name: "EP", baseUrl: "https://api.example.com/v1", apiKey: "" }],
      imageModels: [],
    });
    const { stdin, lastFrame, unmount } = mount({ port });
    await waitUntilEditable(stdin, lastFrame);

    stdin.write("/key");
    await flush();
    stdin.write("\r");
    // 向导整屏接管（标题含「设置 API Key」）—— 快照也是从配置面读出来的
    await waitFor(() => (lastFrame() ?? "").includes("设置 API Key"), 4000);
    // 帧先出现、向导自己的 useInput 监听稍后（mount 后的 effect）才就位：
    // 不等这一步就敲字，按键会落在一个还没人收的窗口里（实测丢字）。
    await flush(40);

    stdin.write("sk-test-123");
    // 看到掩码回显再回车：状态与渲染就绪后，Enter 拿到的才是刚输入的值
    await waitFor(() => (lastFrame() ?? "").includes("••"), 2000);
    stdin.write("\r");
    await flush(20);
    await waitFor(() => port.saveConfig.mock.calls.length > 0, 2000);

    // 写的是**配置面**，不是某个本地函数：远程模式下这一跳才是「写到服务端」
    expect(port.saveConfig).toHaveBeenCalledTimes(1);
    expect((port.saveConfig.mock.calls[0][0] as any).endpoints[0].apiKey).toBe("sk-test-123");
    unmount();
  }, 15_000);

  /**
   * 同上一类：连走三屏（MCP 服务器 → 列表 → 详情）再切「启用」，用例自己的等待上限合计
   * 10232ms，而 vitest 默认 `testTimeout` 是 5000ms。**这就是那次「机器一慢就 1 failed」的
   * 真凶**（实测：全量第一遍 `5007ms` 红、第二遍全绿、单跑 413ms）。所以显式放宽时限。
   */
  it("向导 MCP 落盘走配置面：切换启用状态调用假端口的 writeMcpConfig", async () => {
    const port = fakePort();
    // 全局作用域里放一个服务器：`/config` 的 MCP 列表才有条目可进
    port.readMcpConfig.mockImplementation(async (scope?: any) =>
      scope === "global"
        ? ({ ok: true, config: { mcpServers: { fs: { type: "stdio", command: "npx" } } } } as any)
        : ({ ok: true, config: { mcpServers: {} } } as any),
    );
    const { stdin, lastFrame, unmount } = mount({ port });
    await waitUntilEditable(stdin, lastFrame);

    stdin.write("/config");
    await flush();
    stdin.write("\r");
    // 打开向导 = 串行读 5 份快照（配置 / Agent / 策略表 / 两份 mcp）再整屏接管。
    // 这台机器忙时实测有 6.4s 的（全量首跑红、单跑 392ms），所以这里给到 10s ——
    // 与「外层 20s、内层预算合计小于它」同一条口径（见定案 30）。
    await waitFor(() => (lastFrame() ?? "").includes("配置中心"), 10_000);
    await flush(40); // 等向导自己的按键监听就位（同上一条用例）

    // 菜单：端点 → 模型 → 图片模型 → MCP 服务器
    for (let i = 0; i < 3; i += 1) {
      stdin.write("\u001B[B");
      await flush(16);
    }
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("MCP 服务器 · 全局"), 2000);
    await flush(40);

    // 列表：首项是「切换作用域」，第二项是「新建」，之后才是已有服务器
    for (let i = 0; i < 2; i += 1) {
      stdin.write("\u001B[B");
      await flush(16);
    }
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("MCP · fs"), 2000);
    await flush(40);

    // 详情：名称 → 传输方式 → 「启用」（bool，回车即写盘）
    for (let i = 0; i < 2; i += 1) {
      stdin.write("\u001B[B");
      await flush(16);
    }
    stdin.write("\r");
    await waitFor(() => port.writeMcpConfig.mock.calls.length > 0, 2000);

    // 作用域也要原样透传：屏幕把 `(scope, cfg)` 翻成 `writeMcpConfig(cfg, scope)`
    expect(port.writeMcpConfig).toHaveBeenCalledTimes(1);
    expect(port.writeMcpConfig.mock.calls[0]![1]).toBe("global");
    unmount();
  }, 20_000);

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
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("hello");
    await flush();
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    expect(created.session.send).toHaveBeenCalledTimes(1);

    // 输入框已空、单行 → ↑ 拿回历史，再回车又发一遍同样的内容
    await waitUntilEditable(stdin, lastFrame);
    stdin.write("\u001b[A");
    await waitFor(() => inputLineOf(lastFrame() ?? "").includes("hello"));
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 2);
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

  /**
   * 高亮项（菜单行的 `❯` 在**两格**缩进之后；输入行的 `❯` 只有一格缩进，不能用它）。
   *
   * 方向断言**必须用 ≥ 3 条候选**：只有 2 条时 `(i−1+n)%n` 与 `(i+1)%n` 结果恒等，
   * 映射写反了也照样“绿”—— 真机上 19 条候选才暴露出 `↑` 实际冲向最顶端。
   */
  const highlightedCommand = (frame: string): string | null => {
    for (const row of frame.split("\n")) {
      const match = /^ {2}❯ (\S+)/.exec(row);
      if (match) return match[1]!;
    }
    return null;
  };

  it("菜单打开时 ↑ 选上一条（相邻项，视觉上移）、↓ 选下一条，到顶/底才环绕", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("/"); // 全部 19 条候选
    await flush();
    const hints = getCommandHints();
    const name = (i: number) => `/${hints[i]!.names[0]}`;
    expect(hints.length).toBeGreaterThan(2);

    // 初始：高亮最底那条（`hints[0]`）
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(0));

    // ↑：上移**一格**到相邻项，而不是回卷到最顶（候选够多时才区分得出来）
    stdin.write("\u001b[A");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(1));

    // ↓：回到最底
    stdin.write("\u001b[B");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(0));

    // ↓ 在最底 → 环绕到最顶（视觉上从底部穿出、从顶部冒出来）
    stdin.write("\u001b[B");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(hints.length - 1));

    // ↑ 在最顶 → 环绕回最底
    stdin.write("\u001b[A");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(0));
    unmount();
  });

  it("`@` 菜单与斜杠菜单共用同一套底部锚定菜单（目录带尾斜杠）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    await flush(); // 等文件清单回填（`session.listWorkspaceFiles()` 是 Promise）
    const frame = lastFrame() ?? "";
    const readme = rowOf(frame, "README.md");
    // 「src/tui/」是「src/tui/screens/chat.tsx」的子串，必须锁行尾才能定位到那条目录
    const dir = frame.split("\n").findIndex((row) => row.trim().endsWith("src/tui/"));
    const separator = rowOf(frame, "───");
    expect(readme).toBeGreaterThanOrEqual(0);
    expect(dir).toBeGreaterThanOrEqual(0);
    // 空查询时 rankPaths 按「浅 → 短」排序：README.md < src/tui < src/tui/screens/chat.tsx
    expect(dir).toBe(readme - 1);
    expect(readme).toBe(separator - 1);
    unmount();
  });

  // ==================== Agent 栏目（主 / 子 Agent 切换）====================

  /** 造一个子 Agent 视图（契约里它就是数据：自己的 messages + 状态，组件只读这些） */
  const addSubAgent = (content: string) => {
    const index = created.session.subAgents.length + 1;
    created.session.subAgents.push({
      id: `sub-${index}`,
      index,
      status: "done",
      messages: [{ id: `sub-${index}`, role: "assistant", content }],
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

  /**
   * 子 Agent 视图的数据形状（`messages` 而不是 `agent` 实例）—— 切到栏目读的是哪份对话。
   *
   * 只断言这一件事：屏幕读的是子 Agent 自己那份 messages，不是主会话的 messages。
   * 契约若退回「实例」形态，这条会直接红（`activeSub.agent` 取不到东西）。
   */
  it("子 AGENT 栏目显示子 Agent 自己的 messages（不是主会话的）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.messages.push({ id: "m1", role: "assistant", content: "主 Agent 的话" });
    created.session.subAgents.push({
      id: "sub-1",
      index: 1,
      messages: [{ id: "s1", role: "assistant", content: "子 Agent 自己的话" }],
      status: "running",
    });
    await repaint();

    // →：输入框为空，切到子 AGENT1
    stdin.write("\u001b[C");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("子 Agent 自己的话");
    expect(frame).not.toContain("主 Agent 的话");
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
    created.options = null;
  });

  it("候选来自 session.listWorkspaceFiles（问会话，不扫客户端磁盘）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 换成一份「只在服务端存在」的清单（本机根本不可能有这些文件）：
    // 它们能出现在候选里，就证明候选确实来自会话，而不是屏幕这边扫盘
    created.session.listWorkspaceFiles = vi.fn(async () => [
      { path: "服务端工作区/只有那里才有的文件.md", dir: false },
    ]);
    stdin.write("@");
    await flush();
    await flush();
    const frame = lastFrame() ?? "";
    expect(created.session.listWorkspaceFiles).toHaveBeenCalled();
    expect(frame).toContain("只有那里才有的文件.md");
    // 旧实现会去扫本机磁盘：换成会话给的清单后，这份假索引里的条目一条也不该出现
    expect(frame).not.toContain("README.md");
    unmount();
  });

  it("敲下 @ 后弹出候选菜单（先显示扫描中，再出结果）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    const frame = lastFrame() ?? "";
    // 候选整体来自会话，不是本机扫描
    expect(created.session.listWorkspaceFiles).toHaveBeenCalled();
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

describe("续接意图透传（resume）", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
  });

  it("resume 原样交给 createSession（屏幕不判断有没有上一轮）", async () => {
    const { unmount } = mount({ resume: true });
    await flush();
    expect(created.options?.resume).toBe(true);
    unmount();
  });

  it("不给 resume 时选项里就是空的（不会凭空宣称要接着上次）", async () => {
    const { unmount } = mount();
    await flush();
    expect(created.options?.resume).toBeUndefined();
    unmount();
  });
});

describe("粘贴：Ctrl+V 图片优先、无图回退文本", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
    clipboardMock.image = { kind: "none" };
    clipboardMock.text = { kind: "unavailable" };
  });

  /** Ctrl+V（`\x16` → char "v" + ctrl） */
  const paste = async (stdin: any) => {
    stdin.write("\u0016");
    await flush();
  };
  const oneImage = { kind: "image", image: { base64: "QUJD", mime: "image/png" } };

  it("剪贴板没有图片时，粘贴的是文本", async () => {
    clipboardMock.text = { kind: "text", text: "粘贴进来的文字" };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("粘贴进来的文字");
    unmount();
  });

  it("剪贴板有图片时附到消息上，并显示附件行", async () => {
    clipboardMock.image = oneImage;
    clipboardMock.text = { kind: "text", text: "不该被粘贴的文字" };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("已附加 1 张图片");
    expect(frame).not.toContain("不该被粘贴的文字");
    unmount();
  });

  it("↑ 回到带图片的消息：文本与附件一起回来，重发仍带图", async () => {
    clipboardMock.image = oneImage;
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("看这张");
    await flush();
    await paste(stdin);
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    expect(created.session.send).toHaveBeenCalledWith("看这张", [oneImage.image]);
    // 发送后附件行清空
    expect(lastFrame() ?? "").not.toContain("已附加");

    await waitUntilEditable(stdin, lastFrame);
    stdin.write("\u001b[A"); // ↑ 翻回上一条
    await waitFor(() => (lastFrame() ?? "").includes("已附加 1 张图片"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("看这张"); // 文本回来了
    expect(frame).toContain("已附加 1 张图片"); // 图片也回来了（旧实现只有文本）

    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 2);
    expect(created.session.send).toHaveBeenLastCalledWith("看这张", [oneImage.image]);
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

  it("剪贴板文本超过上限：报错且不粘贴（不截断半截内容）", async () => {
    clipboardMock.text = { kind: "too-large", bytes: 300 * 1024 };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("超过");
    expect(frame).toContain("没有粘贴");
    unmount();
  });

  it("剪贴板既没图片也没文字时给提示，不插任何东西", async () => {
    clipboardMock.text = { kind: "text", text: "" };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("剪贴板里没有内容");
    unmount();
  });
});
