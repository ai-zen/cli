import { describe, it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { Message } from "@ai-zen/agents-core";
import { render } from "ink-testing-library";
import type { AgentDefinition, AppConfig, McpEntry, ReasoningPresets } from "../config.js";
import type { HostClient } from "../server-client/index.js";
import {
  ConfigWizard,
  PromptScreen,
  promptLayout,
  type WizardHost,
  type WizardStep,
} from "./config-wizard/index.js";
import { setLocale, t } from "../i18n/index.js";

// 配置中心文案已 i18n 化：这些用例断言中文，显式锁定语言（不依赖宿主 LANG）
setLocale("zh");

/** 让出几拍宏任务：让的是执行顺序，不是时长（敲键之前必须先让一拍，见 {@link tick}） */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// 普通按键的帧变化实测 0.5~3.4ms；单独 ESC 要 20ms（ink 对 lone ESC 的序列判定）
//
// 为什么不是单纯的 `setTimeout(4)`：帧是在 commit 里画的，而 `useInput` 的订阅落在 passive
// effect 里，同一拍里排在画帧**之后**（React 的 Scheduler 在 Node 下走 `setImmediate`）。事件循环
// 被占着时，`setTimeout(4)`（timers 阶段）会先于 Scheduler 的回调（check 阶段）醒 —— 那一刻
// 敲进去的键会被**吐掉**（不是延后处理，是永远不到）。所以先让一拍执行顺序，再计那 4ms 真
// 时间（后者留给 ink 的 lone-ESC 判定这类真的按时间来的事）。
const tick = async () => {
  await settle(1);
  await new Promise((r) => setTimeout(r, 4));
};

/**
 * 等到 `check()` 成立就返回；超时抛错，错误里说清等的是什么。
 *
 * 凡是等异步结果（`calls` / `onClose` / 屏上那句话）的一律走它；上限 1000ms 是
 * **失败上限**，不是等待时长。
 */
const until = async (check: () => boolean, what: string, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等不到：${what}（上限 ${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";
const TAB = "\t";

/**
 * 固定终端尺寸：`ConfigWizard` 的「吸底」帧高由终端行数决定，
 * 而 ink-testing-library 的假 stdout 未提供 rows，ink 会回退探测真实终端。
 */
const SIZE = { columns: 100, rows: 24 };

// ==================== 假宿主（一条 tRPC 客户端，按 procedure 名分派）====================

interface RecordedCall {
  method: string;
  params: unknown;
}

interface FakeHost {
  host: WizardHost;
  calls: RecordedCall[];
}

/**
 * 造一个只认「调一条 procedure」的 `api`。
 *
 * 路径按 `Proxy` 拼成 procedure 名（`api.config.models.create.mutate` → `"config.models.create"`），
 * 于是「打了哪条」的断言与生产代码里的那条调用逐字对得上；没登记的路由**直接抛**，
 * 「向导偷偷调了第二条」会当场红。
 */
function makeHost(handlers: Record<string, (params: unknown) => unknown>): FakeHost {
  const calls: RecordedCall[] = [];
  const make = (path: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, property: string) {
        if (property === "query" || property === "mutate") {
          const method = path.join(".");
          return async (params: unknown = {}) => {
            calls.push({ method, params });
            const handler = handlers[method];
            if (!handler) throw new Error(`用例没预料到的 procedure：${method}`);
            return handler(params);
          };
        }
        return make([...path, property]);
      },
    });
  return { host: { api: make([]) as HostClient["api"] }, calls };
}

/** 宿主回的「还有模型挂在它上面」（`conflict`：一句能直接上屏的话） */
const referencedError = () =>
  Object.assign(new Error("conflict"), {
    code: "conflict",
    message: "端点 deepseek 上还挂着模型 DeepSeek-V4-Flash，先把它们换走或删掉",
  });

// ==================== 夹具（全部是契约形状）====================

const makeConfig = (): AppConfig => ({
  endpoints: [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      // 配置里存的是**明文**（宿主这一版不再掩码），屏上看到的是 `sk-…9f3a`
      apiKey: "sk-live-9f3a",
      capabilities: { filesApi: false },
    },
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      description: "备用",
      capabilities: { filesApi: true },
    },
  ],
  models: [
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek-V4-Flash",
      endpointId: "deepseek",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: {},
      reasoningPreset: "deepseek",
      custom: false,
    },
  ],
  imageModels: [
    {
      id: "cogview-4",
      name: "CogView-4",
      endpointId: "openai",
      modelName: "cogview-4",
      custom: true,
    },
  ],
  defaultAgent: "default",
  defaultImageModel: "cogview-4",
  maxToolOutput: 32768,
});

/** 档位表（模型上的 `reasoningPreset` 指它的键） */
const makePresets = (): ReasoningPresets => ({
  deepseek: {
    levels: {
      low: { thinking: { type: "enabled" }, reasoning_effort: "low" },
      high: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    },
  },
});

const makeAgents = (): AgentDefinition[] => [
  {
    id: "default",
    name: "默认助手定义",
    // 定义是「能写就能读」的：提示词就是我们读回来、改完再写回去的那一串
    messages: [Message.System("你是默认助手定义"), Message.User("开始吧")],
    modelId: "deepseek-v4-flash",
    modelParams: {},
    permissions: { tools: { allow: ["*"] } },
    custom: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "reviewer",
    name: "审阅助手定义",
    description: "只管审稿",
    messages: [Message.System("")],
    modelParams: {},
    function: { name: "review", description: "审稿", parameters: { type: "object" } },
    custom: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const makeServers = (): McpEntry[] => [
  {
    scope: "user",
    server: {
      id: "socket-pty",
      transport: "stdio",
      description: "终端复用",
      command: "npx",
      args: ["-y", "socket-pty"],
      env: { PTY_MODE: "1" },
    },
  },
];

const noop = () => undefined;

/**
 * 假的系统编辑器：把 `content` 写进那个临时文件。
 *
 * 真起一个 `vi` 会把整个 worker 挂死（本仓不隔离模块图，中途只能强杀），所以 `agent-text`
 * 屏的编辑器一律靠 `openEditor` 注入。
 */
const fakeEditor = (content: string) => (_editor: string, file: string) => {
  writeFileSync(file, content, "utf-8");
};

interface MountOptions {
  handlers?: Record<string, (params: unknown) => unknown>;
  config?: AppConfig;
  presets?: ReasoningPresets;
  agents?: AgentDefinition[];
  servers?: McpEntry[];
  /** 每个 AgentDefinition 上挂着几段会话（向导宿主数出来的；不给 = 数不出来，代价那一句不给数字） */
  sessionsByAgent?: Record<string, number> | null;
  initialStep?: WizardStep;
  closeOnSave?: boolean;
  /** 注入假的系统编辑器（`agent-text` 屏用），见 {@link fakeEditor} */
  openEditor?: (editor: string, file: string) => void;
}

function mount(options: MountOptions = {}) {
  const fake = makeHost(options.handlers ?? {});
  const onClose = vi.fn();
  const view = render(
    <ConfigWizard
      host={fake.host}
      workspaceId="ws-1"
      config={options.config ?? makeConfig()}
      presets={options.presets ?? makePresets()}
      agents={options.agents ?? makeAgents()}
      servers={options.servers ?? makeServers()}
      sessionsByAgent={options.sessionsByAgent}
      initialStep={options.initialStep}
      terminalSize={SIZE}
      closeOnSave={options.closeOnSave}
      openEditor={options.openEditor}
      onClose={onClose}
    />,
  );
  return { ...view, ...fake, onClose };
}

// ==================== 输入屏（与契约无关，形状未变）====================

describe("PromptScreen（凭据输入屏）", () => {
  it("掩码显示：不把明文回显到屏幕，Enter 提交原值", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <PromptScreen
        columns={80}
        rows={24}
        title="设置 API Key"
        mask
        hints={[["Enter", "保存"]]}
        onSubmit={onSubmit}
        onCancel={noop}
      />,
    );
    await tick();
    expect(lastFrame()).toContain("设置 API Key");

    stdin.write("sk-secret");
    await tick();
    expect(lastFrame()).toContain("•••••••••");
    expect(lastFrame()).not.toContain("sk-secret");

    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("sk-secret");
    unmount();
  });

  it("Tab 切换明文/掩码，Esc 取消", async () => {
    const onCancel = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <PromptScreen
        columns={80}
        rows={24}
        title="设置 API Key"
        mask
        hints={[["Enter", "保存"]]}
        onSubmit={noop}
        onCancel={onCancel}
      />,
    );
    stdin.write("abc");
    await tick();
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain("abc");
    stdin.write(ESC);
    // lone ESC 要等 ink 自己的序列判定（~20ms）才认成 Esc —— 等「取消真的发生了」
    await until(() => onCancel.mock.calls.length > 0, "Esc 取消真的发生了");
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });

  it("丢弃终端应答序列（如 Kitty 查询应答 `[?0u`），不写进输入框", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <PromptScreen
        columns={80}
        rows={24}
        title="设置 API Key"
        mask
        hints={[["Enter", "保存"]]}
        onSubmit={onSubmit}
        onCancel={noop}
      />,
    );
    await tick();
    stdin.write("[?0u");
    await tick();
    expect(lastFrame()).not.toContain("[?0u");
    unmount();
  });
  it("支持 Backspace / Home / End 编辑", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <PromptScreen
        columns={80}
        rows={24}
        title="Base URL"
        initialValue="https://a/v1"
        hints={[["Enter", "保存"]]}
        onSubmit={onSubmit}
        onCancel={noop}
      />,
    );
    await tick();
    stdin.write("\u007F"); // Backspace：删掉 "1"
    await tick();
    stdin.write("\u001B[H"); // Home：光标到行首
    await tick();
    stdin.write("X");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("Xhttps://a/v");
    unmount();
  });
});

describe("promptLayout（吸底留白 + IME 光标）", () => {
  const base = {
    terminalRows: 24,
    headerLines: 4,
    inputLines: 1,
    extraLines: 1,
    hintLines: 1,
    cursorRow: 0,
    cursorCol: 0,
    lineText: "",
  };

  it("内容总行数 + 顶部留白 = 终端行数 − 1", () => {
    const layout = promptLayout(base);
    expect(layout.contentLines).toBe(7);
    expect(layout.contentLines + layout.topPadding).toBe(23);
  });

  it("光标 x = 输入区左侧留白（3）+ 光标前文本显示宽度", () => {
    expect(promptLayout({ ...base, cursorCol: 2, lineText: "密钥" }).cursor.x).toBe(7);
  });

  it("硬件光标 y = 顶部留白 + 标题行数 + 输入行内偏移", () => {
    const layout = promptLayout(base);
    expect(layout.cursor.y).toBe(layout.topPadding + 4);
    expect(promptLayout({ ...base, headerLines: 6 }).cursor.y).toBe(
      promptLayout({ ...base, headerLines: 6 }).topPadding + 6,
    );
  });

  it("内容超过一帧时留白为 0（不出现负值）", () => {
    expect(promptLayout({ ...base, headerLines: 99 }).topPadding).toBe(0);
  });
});

// ==================== 菜单 ====================

describe("配置中心菜单", () => {
  it("每一行都印契约给的现成事实（端点 / 模型 / MCP 两层 / 默认项 / 上限）", async () => {
    const { lastFrame, unmount } = mount();
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("配置中心");
    expect(frame).toContain("DeepSeek ✓"); // 端点摘要（✓ = 那一格非空）
    expect(frame).toContain("OpenAI ✗");
    expect(frame).toContain("端点管理");
    expect(frame).toContain("模型管理");
    expect(frame).toContain("用户 1 · 工作区 0"); // MCP 两个可写层各自的条数
    expect(frame).toContain("助手定义 1 · 子助手 1");
    expect(frame).toContain("32768 字符");
    // 上限这一行的数值必须真的被替换进驻位符：漏传参时 `t()` 会原样留下 `{n}`
    expect(frame).not.toContain("{n}");
    unmount();
  });

  it("整帧高度 = 终端行数 − 1，内容贴底", async () => {
    const { lastFrame, unmount } = mount();
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(23);
    expect(lines.length).toBeLessThanOrEqual(24);
    const hintIndex = lines.findIndex((line) => line.includes("完成并返回"));
    expect(hintIndex).toBe(lines.length - 1);
    unmount();
  });

  it("没有任何写入时关闭：回传 dirty=false", async () => {
    const { stdin, onClose, unmount } = mount();
    await tick();
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0, "Esc 关闭真的发生了");
    expect(onClose).toHaveBeenCalledWith({ dirty: false, summary: [] });
    unmount();
  });
});

describe("列表屏布局", () => {
  it("列表步骤同样贴底且不超帧", async () => {
    const { lastFrame, unmount } = mount({ initialStep: { kind: "endpoints" } });
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    const titleIndex = lines.findIndex((line) => line.includes("端点管理"));
    expect(titleIndex).toBeGreaterThan(0); // 顶部留白，而非顶格
    unmount();
  });
});

// ==================== 端点 ====================

describe("端点", () => {
  it("列表上印掩码与「未配置密钥」，两处分开说", async () => {
    const { lastFrame, unmount } = mount({ initialStep: { kind: "endpoints" } });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("sk-…9f3a");
    expect(frame).toContain("（未配置密钥）");
    unmount();
  });

  it("改 API Key：一次 config.endpoints.update，只发改的那一项", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "endpoint", endpointId: "deepseek" },
      handlers: {
        "config.endpoints.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    // 屏上显示的是掩码，不是明文
    expect(lastFrame()).toContain("sk-…9f3a");

    stdin.write(DOWN); // → Base URL
    await tick();
    stdin.write(DOWN); // → API Key
    await tick();
    stdin.write(ENTER); // 进入编辑
    await tick();
    stdin.write("sk-new-key");
    await tick();
    stdin.write(ENTER); // 提交
    // 等的是那次写入真的写进 messages（异步结果），不是「16ms 大概够了」
    await until(() => calls.length > 0, "保存端点的那次写入落地");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.endpoints.update",
      // `update` 是合并语义（`{...当前, ...change}`），所以只发这一项
      params: { id: "deepseek", change: { apiKey: "sk-new-key" } },
    });
    unmount();
  });

  it("没动 API Key 就不发那一项：掩码不会被当成密钥回写", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "endpoint", endpointId: "deepseek" },
      handlers: {
        "config.endpoints.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // → 描述
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("主端点");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "带描述的那次写入落地");

    expect(calls).toHaveLength(1);
    const params = calls[0]!.params as { id: string; change: Record<string, unknown> };
    expect(params.change.description).toBe("主端点");
    // 省略 = 保留原密钥（`update` 是合并语义）
    expect("apiKey" in params.change).toBe(false);
    unmount();
  });

  it("删被引用的端点：宿主的拒绝原话上屏（说清还有谁在用）", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "endpoint", endpointId: "deepseek" },
      handlers: {
        "config.endpoints.delete": () => {
          throw referencedError();
        },
      },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN); // 走到「删除端点」动作行
      await tick();
    }
    stdin.write(ENTER); // 二次确认
    // 代价在**事前**摆出来（宿主那句拒绝是事后）：模型 id 就在这句话里
    await until(
      () => (lastFrame() ?? "").includes("还有 1 个模型挂在它上面"),
      "「还有谁挂着」那句话上屏",
    );
    expect(lastFrame() ?? "").toContain("deepseek-v4-flash");
    await tick(); // 让确认屏的按键订阅接上（与别处同一类等待）
    stdin.write(ENTER); // 确认
    // 宿主的拒绝是一次异步结果：等那句拒绝真的上屏（它带的是模型标题，代价那一句带的是 id）
    await until(
      () => (lastFrame() ?? "").includes("✖ 端点 deepseek 上还挂着模型"),
      "宿主的拒绝上屏",
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("DeepSeek-V4-Flash");
    unmount();
  });

  it("删端点：代价里点出挂在上面的图片模型（模型与图片模型都算）", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "endpoint", endpointId: "openai" },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER); // 二次确认
    await until(
      () => (lastFrame() ?? "").includes("还有 1 个图片模型挂在它上面"),
      "图片模型也数进代价里",
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cogview-4");
    // 这个端点上没有（文字）模型：那一句就不出现，不是编一个「0 个模型」
    expect(frame).not.toContain("个模型挂在它上面：");
    unmount();
  });

  it("删端点选「否」：一条写请求都没有", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "endpoint", endpointId: "deepseek" },
      handlers: {
        "config.endpoints.delete": () => {
          throw referencedError();
        },
      },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER); // 二次确认
    await until(() => (lastFrame() ?? "").includes("还有 1 个模型挂在它上面"), "代价那一句上屏");
    await tick();
    stdin.write(DOWN); // 从「确认删除端点」移到「取消」
    await tick();
    stdin.write(ENTER);
    // 回到详情屏（代价那一句消失）才是按键真的被处理过的证据
    await until(() => !(lastFrame() ?? "").includes("还有 1 个模型挂在它上面"), "回到详情屏");
    expect(calls).toEqual([]);
    expect(lastFrame() ?? "").toContain("◆ 端点 · DeepSeek");
    unmount();
  });

  it("Base URL 不是 http(s)：当场拦住，一次写都不发", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "endpoint", endpointId: "deepseek" },
    });
    await tick();
    stdin.write(DOWN); // → Base URL
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("\u0015");
    await tick();
    stdin.write("ftp://nope");
    await tick();
    stdin.write(ENTER);
    // 「一次写都不发」是负向断言：先等「校验没过的那句话」上屏 —— 它才是回车真的被处理过的
    // 证据。没有它，`calls` 为空也可能只是「什么都没发生」（键被吐掉也会绿）。
    await until(() => (lastFrame() ?? "").includes("Base URL 必须以"), "校验提示上屏");
    expect(calls).toHaveLength(0);
    expect(lastFrame()).toContain("http");
    unmount();
  });

  it("新建端点：id 由名称派生，走 config.endpoints.create（整条，密钥必须给）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: {
        kind: "new-endpoint",
        field: "name",
        draft: { name: "", baseUrl: "", apiKey: "" },
      },
      handlers: {
        "config.endpoints.create": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write("My Gateway");
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("https://gw.example.com/v1");
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER); // API Key 留空 = 先不配（`add` 收整条，这一格给空串）
    await until(() => calls.length > 0, "新建端点的那次写入落地");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.endpoints.create",
      params: {
        endpoint: {
          id: "my-gateway",
          name: "My Gateway",
          baseUrl: "https://gw.example.com/v1",
          apiKey: "",
        },
      },
    });
    unmount();
  });
});

// ==================== 模型 / 图片模型 ====================

describe("模型", () => {
  it("改交接阈值：一次 config.models.update，两条阈值一起给", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "model", modelId: "deepseek-v4-flash" },
      handlers: {
        "config.models.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN); // 名称/端点/模型名/思考策略 → 交接阈值
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    // 清掉原值再输入
    stdin.write("\u0015"); // Ctrl+U
    await tick();
    stdin.write("100000");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改交接阈值的那次写入落地");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.models.update",
      // `tokenThresholds` 是**整格**替换（宿主按它判两条线的大小关系），所以两条一起给
      params: {
        id: "deepseek-v4-flash",
        change: { tokenThresholds: { handoff: 100_000, guard: 375_000 } },
      },
    });
    unmount();
  });

  it("阈值越线由宿主判定：宿主说不行就原样上屏", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "model", modelId: "deepseek-v4-flash" },
      handlers: {
        "config.models.update": () => {
          throw Object.assign(new Error("bad"), {
            code: "invalid_params",
            message: "交接阈值必须小于阻断阈值",
            detail: { field: "tokenThresholds", reason: "handoff_not_below_guard" },
          });
        },
      },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write("\u0015");
    await tick();
    stdin.write("400000");
    await tick();
    stdin.write(ENTER);
    await until(
      () => (lastFrame() ?? "").includes("交接阈值必须小于阻断阈值"),
      "阈值的大小关系提示上屏",
    );
    expect(lastFrame()).toContain("交接阈值必须小于阻断阈值");
    unmount();
  });

  it("恢复出厂：一次 config.models.reset（出厂清单在宿主，客户端不判断）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "model", modelId: "deepseek-v4-flash" },
      handlers: {
        "config.models.reset": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    for (let i = 0; i < 8; i += 1) {
      stdin.write(DOWN); // 8 个字段之后是「恢复出厂设置」
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "恢复出厂的那次写入落地");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.models.reset",
      params: { id: "deepseek-v4-flash" },
    });
    unmount();
  });

  it("删模型：代价里点出会被改指的默认项，以及改指到哪一条", async () => {
    // 两个模型同一个端点、三个默认项都指着要删的那个：宿主会把它俩改指到同端点的第一条剩余
    const config: AppConfig = {
      ...makeConfig(),
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek-V4-Flash",
          endpointId: "deepseek",
          tokenThresholds: { handoff: 250_000, guard: 375_000 },
          defaultParams: {},
          custom: false,
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek-V4-Pro",
          endpointId: "deepseek",
          tokenThresholds: { handoff: 250_000, guard: 375_000 },
          defaultParams: {},
          custom: true,
        },
      ],
      defaultModel: "deepseek-v4-flash",
      defaultMigrationModel: "deepseek-v4-flash",
      namingModel: "deepseek-v4-flash",
    };
    const { stdin, lastFrame, unmount } = mount({
      config,
      initialStep: { kind: "model", modelId: "deepseek-v4-flash" },
    });
    await tick();
    for (let i = 0; i < 9; i += 1) {
      stdin.write(DOWN); // 8 个字段之后是「恢复出厂设置」，再一格格是「删除模型」
      await tick();
    }
    stdin.write(ENTER); // 二次确认
    await until(() => (lastFrame() ?? "").includes("兜底模型会被改指到"), "代价里点出默认项");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("「DeepSeek-V4-Pro」");
    // 三格默认项都指着它，三句都要摆出来
    expect(frame).toContain("默认迁移模型");
    expect(frame).toContain("取名模型");
    unmount();
  });

  it("删模型选「否」：一条写请求都没有", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      config: {
        ...makeConfig(),
        defaultModel: "deepseek-v4-flash",
      },
      initialStep: { kind: "model", modelId: "deepseek-v4-flash" },
    });
    await tick();
    for (let i = 0; i < 9; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await until(
      () => (lastFrame() ?? "").includes("兜底模型会被清空"),
      "代价里点出「改指不成会被清空」",
    );
    await tick();
    stdin.write(DOWN); // 移到「取消」
    await tick();
    stdin.write(ENTER);
    await until(() => !(lastFrame() ?? "").includes("兜底模型会被清空"), "回到详情屏");
    expect(calls).toEqual([]);
    expect(lastFrame() ?? "").toContain("◆ 模型 · DeepSeek-V4-Flash");
    unmount();
  });

  it("新建模型：两条阈值按出厂推荐值给（宿主不再替我们补）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "new-model" },
      handlers: {
        "config.models.create": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write("My GPT");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "新建模型的那次写入落地");
    expect(calls).toHaveLength(1);
    // `ModelService.add` 写前就要求两条阈值都是数字：给的是一个能就地改的起点
    expect(calls[0]).toEqual({
      method: "config.models.create",
      params: {
        model: {
          id: "my-gpt",
          name: "My GPT",
          endpointId: "deepseek",
          tokenThresholds: { handoff: 128_000, guard: 256_000 },
        },
      },
    });
    unmount();
  });

  it("新建模型：配置里一个模型都没有也照建", async () => {
    const empty: AppConfig = { ...makeConfig(), models: [] };
    const { stdin, calls, unmount } = mount({
      config: empty,
      initialStep: { kind: "new-model" },
      handlers: {
        "config.models.create": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write("First");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "新建模型的那次写入落地");
    expect(calls.map((call) => call.method)).toEqual(["config.models.create"]);
    expect((calls[0]!.params as { model: { id: string } }).model.id).toBe("first");
    unmount();
  });
});

describe("图片模型", () => {
  it("改尺寸：config.imageModels.update 只发这一项", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "image-model", modelId: "cogview-4" },
      handlers: {
        "config.imageModels.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    for (let i = 0; i < 3; i += 1) {
      stdin.write(DOWN); // 名称/端点/模型名 → 尺寸
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write("1024x1024");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "图片模型的那次写入落地");
    expect(calls[0]).toEqual({
      method: "config.imageModels.update",
      params: { id: "cogview-4", change: { defaultSize: "1024x1024" } },
    });
    unmount();
  });

  it("删被默认图片模型指着的条目：宿主拒绝，屏上报出来", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "image-model", modelId: "cogview-4" },
      handlers: {
        "config.imageModels.delete": () => {
          throw referencedError();
        },
      },
    });
    await tick();
    for (let i = 0; i < 6; i += 1) {
      stdin.write(DOWN); // 6 个字段之后是删除动作
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("先把它们换走或删掉"), "宿主的拒绝上屏");
    unmount();
  });
});

// ==================== 默认项 / 上限 ====================

describe("默认项", () => {
  it("子菜单列出五格默认值 + 两项中断策略 + 自动命名开关", async () => {
    const { lastFrame, unmount } = mount({ initialStep: { kind: "defaults" } });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("默认助手定义");
    expect(frame).toContain("兜底模型");
    expect(frame).toContain("默认迁移模型");
    expect(frame).toContain("默认图片模型");
    expect(frame).toContain("取名模型");
    expect(frame).toContain("中断时保留已输出内容");
    expect(frame).toContain("中断时的工具调用");
    expect(frame).toContain("自动命名");
    unmount();
  });

  it("选兜底模型：一次改动只发一次 config.defaults.update", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "pick-default", target: "defaultModel" },
      handlers: {
        "config.defaults.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write(ENTER); // 第一个候选就是那条模型
    await until(() => calls.length > 0, "改默认模型的那次写入落地");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.defaults.update",
      params: { defaultModel: "deepseek-v4-flash" },
    });
    unmount();
  });

  it("「不设置」写 null（契约里 null = 清掉这一项）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "pick-default", target: "namingModel" },
      handlers: {
        "config.defaults.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write(DOWN); // → 「（未设置）」
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改命名模型的那次写入落地");
    expect(calls[0]).toEqual({
      method: "config.defaults.update",
      params: { namingModel: null },
    });
    unmount();
  });

  it("中断策略走 config.update", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "pick-default", target: "abortedMessageStrategy" },
      handlers: {
        "config.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write(DOWN); // → 丢弃（drop）
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改中断策略的那次写入落地");
    expect(calls[0]).toEqual({
      method: "config.update",
      params: { abortedMessageStrategy: "drop" },
    });
    unmount();
  });

  it("两项互不影响：改哪一格就只发哪一格", async () => {
    // 思考与正文那一格
    const message = mount({
      initialStep: { kind: "pick-default", target: "abortedMessageStrategy" },
      handlers: { "config.update": () => ({ config: makeConfig() }) },
    });
    await tick();
    message.stdin.write(DOWN);
    await tick();
    message.stdin.write(ENTER);
    await until(() => message.calls.length > 0, "消息那一格的写入落地");
    expect(message.calls[0]).toEqual({
      method: "config.update",
      params: { abortedMessageStrategy: "drop" },
    });
    message.unmount();

    // 被中断的那组工具调用那一格：同一个写口，带的是另一个字段
    const toolRound = mount({
      initialStep: { kind: "pick-default", target: "abortedToolRoundStrategy" },
      handlers: { "config.update": () => ({ config: makeConfig() }) },
    });
    await tick();
    toolRound.stdin.write(DOWN);
    await tick();
    toolRound.stdin.write(ENTER);
    await until(() => toolRound.calls.length > 0, "工具轮那一格的写入落地");
    expect(toolRound.calls[0]).toEqual({
      method: "config.update",
      params: { abortedToolRoundStrategy: "drop" },
    });
    toolRound.unmount();
  });

  it("屏上说的是宿主回来的那一档", async () => {
    const { stdin, lastFrame, calls, unmount } = mount({
      initialStep: { kind: "pick-default", target: "abortedToolRoundStrategy" },
      handlers: {
        // 真宿主会把刚写的那一格回显在整份配置里；这里故意回另一档，钉住「屏上照回执说」
        "config.update": () => ({
          config: { ...makeConfig(), abortedToolRoundStrategy: "drop" },
        }),
      },
    });
    await tick();
    stdin.write(ENTER); // 整轮保留（fill）
    await until(() => calls.length > 0, "改工具轮策略的那次写入落地");
    // 写成功之后回到默认项那一屏（那一屏的标题是「默认项」，两个子屏标题不是）
    const backOnDefaults = () => {
      const frame = lastFrame() ?? "";
      return frame.includes("默认项") && frame.includes("中断时的工具调用");
    };
    await until(backOnDefaults, "回到默认项那一屏");
    // 那一项的摘要是宿主回执里的「丢弃」，不是这里选的「整轮保留」
    expect(lastFrame()).toContain("丢弃");
    unmount();
  });

  /** 默认项子菜单里「自动命名」那一行（那一行末尾印的是它现在是哪一档） */
  const autoTitleLine = (frame: string) =>
    frame.split("\n").find((line) => line.includes("自动命名")) ?? "";

  it("自动命名那一格印的是配置里的现状（没写这一格按开着算，只有显式 false 是关）", async () => {
    const missing = mount({ initialStep: { kind: "defaults" } });
    await tick();
    expect(autoTitleLine(missing.lastFrame() ?? "")).toContain("开");
    missing.unmount();

    const off = mount({
      initialStep: { kind: "defaults" },
      config: { ...makeConfig(), autoTitle: false },
    });
    await tick();
    expect(autoTitleLine(off.lastFrame() ?? "")).toContain("关");
    off.unmount();
  });

  it("切一次自动命名：config.update 只带 autoTitle，屏上照回执那一格说", async () => {
    const { stdin, lastFrame, calls, unmount } = mount({
      initialStep: { kind: "pick-default", target: "autoTitle" },
      handlers: {
        // 真宿主会把刚写的那一格回显在整份配置里；这里故意回「开着」，钉住「屏上照回执说」
        "config.update": () => ({ config: { ...makeConfig(), autoTitle: true } }),
      },
    });
    await tick();
    // 屏上写清它是什么：关掉只省下那一次起名请求，不影响手工改名
    expect(lastFrame()).toContain("不影响手工改名");
    stdin.write(DOWN); // → 「关」
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改自动命名的那次写入落地");
    expect(calls).toEqual([{ method: "config.update", params: { autoTitle: false } }]);
    // 写成功之后回到默认项那一屏（标题「默认项」；选值那一屏的标题就是「自动命名」）
    await until(() => (lastFrame() ?? "").includes("中断时的工具调用"), "回到默认项那一屏");
    expect(autoTitleLine(lastFrame() ?? "")).toContain("开");
    unmount();
  });

  it("自动命名：宿主拒绝时原话上屏，留在选值那一屏", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "pick-default", target: "autoTitle" },
      handlers: {
        "config.update": () => {
          throw Object.assign(new Error("bad"), {
            code: "invalid_params",
            message: "配置里这一格只收 true 或 false",
          });
        },
      },
    });
    await tick();
    stdin.write(ENTER); // 开着
    await until(
      () => (lastFrame() ?? "").includes("配置里这一格只收 true 或 false"),
      "宿主的拒绝原话上屏",
    );
    // 没写成就留在这一屏，不假装已经写进去
    expect(lastFrame()).toContain("不影响手工改名");
    unmount();
  });
});

describe("工具输出上限", () => {
  it("改上限走 config.update 的那一格", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "max-tool-output" },
      handlers: {
        "config.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write("\u0015"); // Ctrl+U 清空
    await tick();
    stdin.write("4096");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改上限的那次写入落地");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "config.update", params: { maxToolOutput: 4096 } });
    unmount();
  });
});

// ==================== MCP ====================

describe("MCP", () => {
  it("每一层只列写在自己这一层的服务器，别的层不混进来", async () => {
    const servers: McpEntry[] = [
      ...makeServers(),
      // 项目 `.mcp.json`（只读层）与家目录那层：界面不给它们入口
      { scope: "workspace", server: { id: "shared", transport: "stdio", command: "x" } },
      { scope: "userAgents", server: { id: "home", transport: "stdio", command: "y" } },
    ];
    const user = mount({ servers, initialStep: { kind: "mcp", scope: "user" } });
    await tick();
    const userFrame = user.lastFrame() ?? "";
    expect(userFrame).toContain("socket-pty");
    expect(userFrame).not.toContain("shared");
    expect(userFrame).not.toContain("home");
    user.unmount();

    const project = mount({ servers, initialStep: { kind: "mcp", scope: "workspace" } });
    await tick();
    const projectFrame = project.lastFrame() ?? "";
    // 项目可写的那一层（`.ai-zen/mcp.json`）现在是空的
    expect(projectFrame).toContain("0 个");
    expect(projectFrame).not.toContain("socket-pty");
    project.unmount();
  });

  it("已有条目带着传输方式印出来，且照样能新建", async () => {
    const { lastFrame, unmount } = mount({ initialStep: { kind: "mcp", scope: "user" } });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("socket-pty");
    // InboxEntry 行印的是「启用状态 · 传输方式与它的目标 · 描述」
    expect(frame).toContain("已启用 · stdio · npx -y socket-pty");
    expect(frame).toContain("＋ 新建服务器");
    unmount();
  });

  it("空层可以建：一次 mcp.save 只发这一条（transport 默认 stdio）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "mcp", scope: "workspace" },
      handlers: {
        "config.mcp.update": () => ({
          servers: [{ scope: "workspaceAiZen", server: { id: "github", transport: "stdio" } }],
        }),
      },
    });
    await tick();
    stdin.write(DOWN); // 切换作用域是第 1 项，新建是第 2 项
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("github");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "新建 MCP 的那次写入落地");

    expect(calls).toHaveLength(1);
    // 界面上的「工作区」= 契约里的 `workspaceAiZen`（宿主唯一可写的项目层）
    expect(calls[0]).toEqual({
      method: "config.mcp.update",
      params: {
        workspaceId: "ws-1",
        scope: "workspaceAiZen",
        server: { id: "github", transport: "stdio" },
      },
    });
    unmount();
  });

  it("改已有条目：只发这一条，其余字段原样带上", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "mcp-server", scope: "user", serverName: "socket-pty" },
      handlers: {
        "config.mcp.update": () => ({ servers: makeServers() }),
      },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN); // id → transport → enabled → description → command
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write("\u0015"); // 清掉原来的 npx
    await tick();
    stdin.write("node");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改 MCP 命令的那次写入落地");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.mcp.update",
      params: {
        workspaceId: "ws-1",
        scope: "user",
        server: {
          id: "socket-pty",
          transport: "stdio",
          description: "终端复用",
          command: "node",
          args: ["-y", "socket-pty"],
          env: { PTY_MODE: "1" },
        },
      },
    });
    unmount();
  });

  it("启用开关：把 enabled 折回 SDK 的 disabled 发一次写入", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "mcp-server", scope: "user", serverName: "socket-pty" },
      handlers: {
        "config.mcp.update": () => ({ servers: makeServers() }),
      },
    });
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // → enabled
    await tick();
    stdin.write(ENTER); // bool：直接切换
    await until(() => calls.length > 0, "切换 enabled 的那次写入落地");

    expect(calls).toHaveLength(1);
    expect((calls[0]!.params as { server: Record<string, unknown> }).server).toMatchObject({
      id: "socket-pty",
      disabled: true,
    });
    unmount();
  });

  /** 带 oauth 的那一条：明文在配置里，屏上只印掩码 */
  const OAUTH_SECRET = "oauth-secret-9f3a";
  const serversWithOauth = (): McpEntry[] => [
    {
      scope: "user",
      server: {
        id: "remote-oauth",
        transport: "http",
        url: "https://api.example/mcp",
        oauth: {
          authorizationUrl: "https://auth.example/a",
          tokenUrl: "https://auth.example/t",
          clientId: "client-1",
          scope: "mcp",
          clientSecret: OAUTH_SECRET,
        },
      },
    },
  ];

  it("详情屏把客户端密钥印成掩码（明文不整串上屏）", async () => {
    const { lastFrame, unmount } = mount({
      servers: serversWithOauth(),
      initialStep: { kind: "mcp-server", scope: "user", serverName: "remote-oauth" },
    });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("客户端密钥：oau…9f3a");
    expect(frame).not.toContain(OAUTH_SECRET);
    return unmount();
  });

  it("改这一条的别的字段：oauth 原样往返（密钥不是被抹掉，而是没动）", async () => {
    const { stdin, calls, unmount } = mount({
      servers: serversWithOauth(),
      initialStep: { kind: "mcp-server", scope: "user", serverName: "remote-oauth" },
      handlers: {
        "config.mcp.update": () => ({ servers: serversWithOauth() }),
      },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN); // id → transport → enabled → description → url
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write("\u0015"); // 清掉原来的地址
    await tick();
    stdin.write("https://api2.example/mcp");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改 MCP 地址的那次写入落地");

    expect(calls).toHaveLength(1);
    // `mcp.save` 收的就是 `McpServerDefinition` 本身：没改的那几项（含 oauth 的密钥）原样带着，
    // 「不把密钥弄丢」靠的是这条往返（宿主那边与磁盘上那一条浅合并）
    expect(calls[0]).toEqual({
      method: "config.mcp.update",
      params: {
        workspaceId: "ws-1",
        scope: "user",
        server: {
          id: "remote-oauth",
          transport: "http",
          url: "https://api2.example/mcp",
          oauth: {
            authorizationUrl: "https://auth.example/a",
            tokenUrl: "https://auth.example/t",
            clientId: "client-1",
            scope: "mcp",
            clientSecret: OAUTH_SECRET,
          },
        },
      },
    });
    unmount();
  });

  it("删除走 mcp.remove（只删这一条）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "mcp-server", scope: "user", serverName: "socket-pty" },
      handlers: {
        "config.mcp.delete": () => ({ servers: [] }),
      },
    });
    await tick();
    for (let i = 0; i < 7; i += 1) {
      stdin.write(DOWN); // 七个字段之后是「删除服务器」动作行
      await tick();
    }
    stdin.write(ENTER); // 进入二次确认
    await tick();
    stdin.write(ENTER); // 确认
    await until(() => calls.length > 0, "删 MCP 的那次写入落地");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.mcp.delete",
      params: { workspaceId: "ws-1", scope: "user", name: "socket-pty" },
    });
    unmount();
  });

  it("改名：新名字走 save、旧名字走 remove，合成一条通知", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "mcp-server", scope: "user", serverName: "socket-pty" },
      handlers: {
        "config.mcp.update": () => ({ servers: makeServers() }),
        "config.mcp.delete": () => ({ servers: makeServers() }),
      },
    });
    await tick();
    stdin.write(ENTER); // id 字段进入编辑
    await tick();
    stdin.write("\u0015");
    await tick();
    stdin.write("pty");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length === 2, "改名的一对写入（save + remove）落地");

    expect(calls.map((one) => one.method)).toEqual(["config.mcp.update", "config.mcp.delete"]);
    expect((calls[0]!.params as { server: { id: string } }).server.id).toBe("pty");
    expect(calls[1]!.params).toEqual({
      workspaceId: "ws-1",
      scope: "user",
      name: "socket-pty",
    });
    unmount();
  });
});

// ==================== Agent ====================

describe("Agent", () => {
  it("列表上印「默认 / 出厂内置」这两件事（定义 + 配置给的事实）", async () => {
    const { lastFrame, unmount } = mount({ initialStep: { kind: "agents" } });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("默认助手定义");
    expect(frame).toContain("审阅助手定义");
    expect(frame).toContain("· 默认");
    expect(frame).toContain("· 出厂内置");
    unmount();
  });

  it("详情把提示词与函数定义摆成一行摘要（多行内容不撑破详情列表）", async () => {
    const { lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
    });
    await tick();
    const frame = lastFrame() ?? "";
    // 提示词是单行 → 直接印出来；函数说明同理；参数 schema 是格式化后的 JSON → 印行数
    expect(frame).toContain("系统提示词");
    expect(frame).toContain("（空）· Enter 打开编辑器");
    expect(frame).toContain("函数说明");
    expect(frame).toContain("审稿 · Enter 打开编辑器");
    expect(frame).toContain("参数 schema");
    expect(frame).toContain("3 行 · Enter 打开编辑器");
    expect(frame).toContain("思考强度");
    expect(frame).toContain("权限");
    unmount();
  });

  it("改系统提示词：Enter 进编辑器，提交后发 messages 补丁（整串，其余消息原样带上）", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "default" },
      openEditor: fakeEditor("新的系统提示词\n 第二行"),
      handlers: { "config.agents.update": () => ({ definition: makeAgents()[0]! }) },
    });
    await tick();
    // 名称 / 描述 / 模型 / 思考强度 → 系统提示词
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    expect(lastFrame()).toContain("你是默认助手定义 · Enter 打开编辑器");
    stdin.write(ENTER); // 进多行编辑屏
    await tick();
    stdin.write(ENTER); // 打开系统编辑器（假实现直接把新内容写进临时文件）
    // 改的是**定义**：写之前先出一次确认（PRD 1.6），文案说影响面不说字段名
    await until(() => (lastFrame() ?? "").includes("确认改这份助手定义"), "改定义的二次确认上屏");
    expect(lastFrame() ?? "").toContain("你正在看的那段回答会断");
    await tick(); // 让确认屏的按键订阅接上
    stdin.write(ENTER); // 确认
    await until(() => calls.length > 0, "改提示词的那次写入落地");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("config.agents.update");
    const params = calls[0]!.params as {
      agentId: string;
      change: { messages: { role: string; content?: unknown }[] };
    };
    expect(params.agentId).toBe("default");
    // 宿主对 `messages` 是整份替换：补丁要给整串（只发一条会被当成「提示词只剩这一条」）
    expect(params.change.messages).toHaveLength(2);
    expect(params.change.messages[0]!.role).toBe("system");
    expect(params.change.messages[0]!.content).toBe("新的系统提示词\n 第二行");
    expect(params.change.messages[1]!.content).toBe("开始吧");
    unmount();
  });

  it("清空提示词也是合法写入：空串照发，不替用户补默认值", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "default" },
      openEditor: fakeEditor(""),
      handlers: { "config.agents.update": () => ({ definition: makeAgents()[0]! }) },
    });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("确认改这份助手定义"), "改定义的二次确认上屏");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改提示词的那次写入落地");

    const params = calls[0]!.params as {
      change: { messages: { role: string; content?: unknown }[] };
    };
    // 空串就是空串：客户端既不拦也不编一句默认提示词
    expect(params.change.messages[0]!.content).toBe("");
    unmount();
  });

  it("改函数说明：function 整份提交（只改 description，parameters 原样带上）", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
      openEditor: fakeEditor("审稿（加强版）"),
      handlers: { "config.agents.update": () => ({ definition: makeAgents()[1]! }) },
    });
    await tick();
    // 名称 / 描述 / 模型 / 系统提示词 → 函数说明
    for (let i = 0; i < 4; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("确认改这份助手定义"), "改定义的二次确认上屏");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改函数 schema 的那次写入落地");

    // 宿主对 `function` 也是整份替换：只发改的那一项会把 `parameters` 冲掉
    expect(calls[0]).toEqual({
      method: "config.agents.update",
      params: {
        agentId: "reviewer",
        change: {
          function: {
            name: "review",
            description: "审稿（加强版）",
            parameters: { type: "object" },
          },
        },
      },
    });
    unmount();
  });

  it("参数 schema 不是合法 JSON：当场拦下，一次写都不发", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
      openEditor: fakeEditor('{ "type": "object",'),
    });
    await tick();
    // 名称 / 描述 / 模型 / 系统提示词 / 函数说明 → 参数 schema
    for (let i = 0; i < 5; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    // 先确认、后校验：非法 JSON 是在确认之后才发现的（校验在写口那一侧）
    await until(() => (lastFrame() ?? "").includes("确认改这份助手定义"), "改定义的二次确认上屏");
    await tick();
    stdin.write(ENTER);
    // 「一次写都不发」是负向断言：先等「解析失败」上屏 —— 那是回车真的被处理过的证据
    await until(() => (lastFrame() ?? "").includes("JSON 解析失败"), "解析失败提示上屏");

    expect(calls).toEqual([]);
    expect(lastFrame()).toContain("JSON 解析失败");
    unmount();
  });

  it("Esc 从多行编辑屏回来：不改动，也不发请求", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
      openEditor: fakeEditor("这份内容不该被写进去"),
    });
    await tick();
    for (let i = 0; i < 5; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER); // 进参数 schema 编辑屏
    await tick();
    stdin.write(ESC); // 直接返回
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain("审阅助手定义");
    expect(calls).toEqual([]);
    unmount();
  });

  it("改模型走 agentDefinition.update 的 modelId（改「以后的会话」用哪个模型）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
      handlers: {
        "config.agents.update": () => ({ definition: makeAgents()[1]! }),
      },
    });
    await tick();
    stdin.write(DOWN); // 名称 → 描述
    await tick();
    stdin.write(DOWN); // → 模型
    await tick();
    stdin.write(ENTER); // 打开候选
    await tick();
    stdin.write(ENTER); // 选第一个（DeepSeek-V4-Flash）
    await until(() => calls.length > 0, "设置模型的那次写入落地");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.agents.update",
      params: { agentId: "reviewer", change: { modelId: "deepseek-v4-flash" } },
    });
    unmount();
  });

  it("改思考档位走 agentDefinition.update 的 modelParams（档位展开成参数）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "agent", agentId: "default" },
      handlers: {
        "config.agents.update": () => ({ definition: makeAgents()[0]! }),
      },
    });
    await tick();
    for (let i = 0; i < 3; i += 1) {
      stdin.write(DOWN); // 名称/描述/模型 → 思考档位
      await tick();
    }
    stdin.write(ENTER); // 候选
    await tick();
    stdin.write(DOWN); // low → high
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "改思考档位的那次写入落地");
    expect(calls[0]).toEqual({
      method: "config.agents.update",
      params: {
        agentId: "default",
        // 定义里存的是**展开后的参数**（配置即事实），档位名只活在档位表里
        change: { modelParams: { thinking: { type: "enabled" }, reasoning_effort: "high" } },
      },
    });
    unmount();
  });

  it("权限四维走 agentDefinition.update 的 permissions 补丁", async () => {
    const { stdin, calls, lastFrame, unmount } = mount({
      initialStep: { kind: "agent-perms", agentId: "reviewer" },
      handlers: {
        "config.agents.update": () => ({ definition: makeAgents()[1]! }),
      },
    });
    await tick();
    stdin.write(ENTER); // 第一维（工具）
    await tick();
    stdin.write("allow: *");
    await tick();
    stdin.write(ENTER);
    // 权限也是定义的一部分：写之前先出一次确认（与提示词同一句口径）
    await until(() => (lastFrame() ?? "").includes("确认改这份助手定义"), "改权限的二次确认上屏");
    await tick();
    stdin.write(ENTER); // 确认
    await until(() => calls.length > 0, "改权限的那次写入落地");
    expect(calls[0]).toEqual({
      method: "config.agents.update",
      params: { agentId: "reviewer", change: { permissions: { tools: { allow: ["*"] } } } },
    });
    unmount();
  });

  it("新建 Agent：agentDefinition.create 收整条定义（提示词至少一条 system）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "agent-new" },
      handlers: { "config.agents.create": () => ({ definition: makeAgents()[0]! }) },
    });
    await tick();
    stdin.write("Coder");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "新建助手定义的那次写入落地");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("config.agents.create");
    const params = calls[0]!.params as {
      definition: { id: string; name: string; messages: { role: string }[] };
    };
    expect(params.definition.id).toBe("coder");
    expect(params.definition.name).toBe("Coder");
    // 契约要求至少一条 system（新建的这一条先是空的，建完在「系统提示词」里写）
    expect(params.definition.messages[0]!.role).toBe("system");
    unmount();
  });

  it("删助手定义走 agentDefinition.remove；删完重读配置（默认助手定义可能被清）", async () => {
    const { stdin, calls, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
      handlers: {
        "config.agents.delete": () => ({ agentId: "reviewer" }),
        "config.get": () => ({ config: makeConfig(), presets: makePresets() }),
      },
    });
    await tick();
    // 七个字段（名称/描述/模型/提示词/函数说明/参数 schema/权限）之后是删除动作
    for (let i = 0; i < 7; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length === 2, "删助手定义之后的那两次调用都落地了");
    expect(calls.map((call) => call.method)).toEqual(["config.agents.delete", "config.get"]);
    expect(calls[0]!.params).toEqual({ agentId: "reviewer" });
    unmount();
  });

  it("删助手定义：代价里说清影响面（数得出几段会话就说几段）", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
      // 向导宿主用 `workspace.list` + `session.list` 数出来的那一份
      sessionsByAgent: { default: 5, reviewer: 3 },
    });
    await tick();
    for (let i = 0; i < 7; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER); // 二次确认
    await until(
      () => (lastFrame() ?? "").includes("还有 3 段会话在用这个助手定义"),
      "有几段会话在用它",
    );
    expect(lastFrame() ?? "").toContain("你正在看的那段回答会断");
    unmount();
  });

  it("删助手定义：数不出来就不给数字，只说一句人话", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "reviewer" },
      // 缺省 = 数不出来（读失败 / 没读）：这时候不许编一个数
      sessionsByAgent: null,
    });
    await tick();
    for (let i = 0; i < 7; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await until(
      () => (lastFrame() ?? "").includes("所有用这个助手定义的会话都会受影响"),
      "影响面那句人话",
    );
    expect(lastFrame() ?? "").not.toMatch(/\d+ 段会话/);
    unmount();
  });

  it("删默认助手：代价里一并说清默认项会被清空", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialStep: { kind: "agent", agentId: "default" },
      sessionsByAgent: {},
    });
    await tick();
    // default 这个 AgentDefinition 有六个字段（没有函数定义那两格：它不是子 Agent），之后是删除动作
    for (let i = 0; i < 6; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("它还是默认助手"), "默认项会被清空那一句上屏");
    unmount();
  });
});

// ==================== 首启引导 ====================

describe("首启引导 / `/key`", () => {
  it("closeOnSave：写成功后直接关闭，并带回 dirty", async () => {
    const { stdin, onClose, calls, unmount } = mount({
      initialStep: { kind: "edit", field: "apiKey", endpointId: "deepseek" },
      closeOnSave: true,
      handlers: {
        "config.endpoints.update": () => ({ config: makeConfig() }),
      },
    });
    await tick();
    stdin.write("sk-boot");
    await tick();
    stdin.write(ENTER);
    await until(() => calls.length > 0, "首启保存密钥的那次写入落地");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "config.endpoints.update",
      params: { id: "deepseek", change: { apiKey: "sk-boot" } },
    });
    // 写成功之后才自动关闭：等「关闭」这件事真的发生，不去数那几个 tick
    await until(() => onClose.mock.calls.length > 0, "写成功后自动关闭");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]![0].dirty).toBe(true);
    unmount();
  });
});

/**
 * 首启那一条链：**先选服务商，再填密钥，最后把它的首要模型落成默认项**。
 *
 * 旧版是拿默认模型反推出一个端点、一上屏就要求那家的密钥 —— 服务商是它替用户挑的。这一组钉
 * 的就是「选」这一步真的在，以及选完之后的落点（`defaultModel` + 关闭时带回的
 * `onboardedModelId`，后者由 `tui/index.tsx` 落到这一段会话上）。
 */
describe("首启引导：选服务商 → 填密钥 → 定首要模型", () => {
  /** deepseek 已配钥匙、openai 缺钥匙；openai 那条模型标着 `primary` */
  const bootConfig = (): AppConfig => ({
    ...makeConfig(),
    models: [
      ...makeConfig().models,
      {
        id: "gpt-primary",
        name: "GPT-6.1 Sol",
        endpointId: "openai",
        primary: true,
        tokenThresholds: { handoff: 250_000, guard: 375_000 },
      },
    ],
  });

  it("列出的服务商带模型数与密钥状态，首要模型也先说出来", async () => {
    const { lastFrame, unmount } = mount({
      config: bootConfig(),
      initialStep: { kind: "onboarding" },
      closeOnSave: true,
    });
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain(t("wiz.onboard.title"));
    // 两家（各自至少一条对话模型）
    expect(frame).toContain("DeepSeek");
    expect(frame).toContain("OpenAI");
    expect(frame).toContain(t("wiz.onboard.keyReady"));
    expect(frame).toContain("GPT-6.1 Sol");
    unmount();
  });

  it("选一家缺钥匙的：先进密钥屏，保存后写密钥 + 默认项，并把首要模型带回", async () => {
    const { stdin, lastFrame, calls, onClose, unmount } = mount({
      config: bootConfig(),
      initialStep: { kind: "onboarding" },
      closeOnSave: true,
      handlers: {
        "config.endpoints.update": () => ({ config: bootConfig() }),
        "config.defaults.update": () => ({ config: bootConfig() }),
      },
    });
    await tick();

    // 第二项是 OpenAI（清单顺序 = 配置里端点的顺序）
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? "").toContain(t("wiz.onboard.keyTitle", { name: "OpenAI" }));

    stdin.write("sk-openai");
    await tick();
    stdin.write(ENTER);
    await until(() => onClose.mock.calls.length > 0, "填完密钥自动关闭");

    expect(calls).toEqual([
      {
        method: "config.endpoints.update",
        params: { id: "openai", change: { apiKey: "sk-openai" } },
      },
      // 首要模型：登记在模型上的那一位，不再问用户一遍
      { method: "config.defaults.update", params: { defaultModel: "gpt-primary" } },
    ]);
    const closed = onClose.mock.calls[0]![0];
    expect(closed.dirty).toBe(true);
    expect(closed.onboardedModelId).toBe("gpt-primary");
    unmount();
  });

  it("选一家已经配好钥匙的：不再问密钥，只把首要模型落成默认项", async () => {
    const config = bootConfig();
    config.models = config.models.map((model) =>
      model.endpointId === "deepseek" && model.id === "deepseek-v4-flash"
        ? { ...model, primary: true }
        : model,
    );
    const { stdin, calls, onClose, unmount } = mount({
      config,
      initialStep: { kind: "onboarding" },
      closeOnSave: true,
      handlers: {
        "config.defaults.update": () => ({ config }),
      },
    });
    await tick();

    stdin.write(ENTER); // 第一项：DeepSeek（已有密钥）
    await until(() => onClose.mock.calls.length > 0, "定完首要模型自动关闭");

    // 一个字节都不回写密钥（用户那把还是原来那把）
    expect(calls).toEqual([
      { method: "config.defaults.update", params: { defaultModel: "deepseek-v4-flash" } },
    ]);
    expect(onClose.mock.calls[0]![0].onboardedModelId).toBe("deepseek-v4-flash");
    unmount();
  });

  it("那家端点没有标记首要模型：密钥照存，但不动默认项、也不带回模型", async () => {
    // OpenAI 有一条对话模型但**没有** `primary`：这样它会出现在清单里，且落不到任何模型上
    const config = bootConfig();
    config.models = config.models.map((model) =>
      model.id === "gpt-primary" ? { ...model, primary: false } : model,
    );
    const { stdin, calls, onClose, unmount } = mount({
      config,
      initialStep: { kind: "onboarding" },
      closeOnSave: true,
      handlers: {
        "config.endpoints.update": () => ({ config }),
      },
    });
    await tick();

    stdin.write(DOWN); // OpenAI（缺钥匙）
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("sk-only");
    await tick();
    stdin.write(ENTER);
    await until(() => onClose.mock.calls.length > 0, "保存后关闭");

    expect(calls.map((call) => call.method)).toEqual(["config.endpoints.update"]);
    const closed = onClose.mock.calls[0]![0];
    expect(closed.dirty).toBe(true);
    expect(closed.onboardedModelId).toBeUndefined();
    unmount();
  });

  it("按 Esc：放弃并关闭，一个方法都不调", async () => {
    const { stdin, calls, onClose, unmount } = mount({
      config: bootConfig(),
      initialStep: { kind: "onboarding" },
      closeOnSave: true,
    });
    await tick();

    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0, "Esc 放弃并退出");

    expect(calls).toEqual([]);
    expect(onClose.mock.calls[0]![0].dirty).toBe(false);
    unmount();
  });
});
