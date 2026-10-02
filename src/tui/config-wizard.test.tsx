import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AppConfig } from "@ai-zen/agents-sdk";
import type { McpConfig, McpScope } from "../config.js";
import { ConfigWizard, PromptScreen, promptLayout } from "./config-wizard.js";

const tick = () => new Promise((r) => setTimeout(r, 25));
const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";

function makeConfig(): AppConfig {
  return {
    endpoints: [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "" },
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-old-key-123456" },
    ],
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", endpointId: "deepseek", maxContextTokens: 250_000 },
      { id: "gpt-5.5", name: "GPT-5.5", endpointId: "openai", maxContextTokens: 250_000 },
    ],
    imageModels: [{ id: "cogview-4", name: "CogView-4", endpointId: "openai", modelName: "cogview-4" }],
    defaultModel: "deepseek-v4-flash",
    defaultImageModel: "cogview-4",
  };
}

const noop = () => {
  /* 占位 */
};

/** 带类型的持久化 mock：`calls[0][0]` 即写盘的配置 */
const makeOnSave = () => vi.fn<(config: AppConfig) => Promise<void>>(async () => undefined);

/** MCP 快照夹具：全局两个服务器、项目为空 */
const makeMcp = () => ({
  global: {
    mcpServers: {
      "socket-pty": { type: "stdio" as const, command: "npx", args: ["-y", "@ai-zen/socket-pty", "mcp"] },
      slack: { type: "http" as const, url: "https://slack.example.com" },
    },
  },
  project: { mcpServers: {} },
});

/** 带类型的 MCP 持久化 mock：`calls[0]` 即 `[scope, config]` */
const makeOnSaveMcp = () =>
  vi.fn<(scope: McpScope, config: McpConfig) => Promise<void>>(async () => undefined);

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
    stdin.write("\t");
    await tick();
    expect(lastFrame()).toContain("abc");
    expect(lastFrame()).toContain("明文显示");

    stdin.write(ESC);
    await tick();
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
    // 实测：应答被拆包后残留的整段 `[?0u` 会作为一个输入事件到达
    stdin.write("[?0u");
    await tick();
    expect(lastFrame()).not.toContain("[?0u");

    // 逐字键入同样四个字符是合法输入，不应被误伤
    stdin.write("[");
    await tick();
    stdin.write("?");
    await tick();
    stdin.write("0");
    await tick();
    stdin.write("u");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("[?0u");
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
    expect(layout.topPadding).toBe(23 - 7);
    expect(layout.contentLines + layout.topPadding).toBe(23);
  });

  it("硬件光标 y = 顶部留白 + 标题行数 + 输入行内偏移", () => {
    expect(promptLayout(base).cursor.y).toBe(16 + 4 + 0);
    expect(promptLayout({ ...base, cursorRow: 1 }).cursor.y).toBe(16 + 4 + 1);
    // 标题占位越多，留白越少，光标整体下移量不变
    expect(promptLayout({ ...base, headerLines: 6 }).cursor.y).toBe(14 + 6 + 0);
  });

  it("光标 x = 输入区左侧留白（3）+ 光标前文本显示宽度", () => {
    expect(promptLayout(base).cursor.x).toBe(3);
    expect(promptLayout({ ...base, cursorCol: 2, lineText: "sk" }).cursor.x).toBe(5);
    // 宽字符计 2 列
    expect(promptLayout({ ...base, cursorCol: 2, lineText: "密钥" }).cursor.x).toBe(7);
  });

  it("内容超过一帧时留白为 0（不出现负值）", () => {
    expect(promptLayout({ ...base, headerLines: 99 }).topPadding).toBe(0);
  });
});

describe("ConfigWizard（吸底布局）", () => {
  it("整帧高度 = 终端行数 − 1，内容贴底（顶部为空白，不会飘到视口外）", async () => {
    const { lastFrame, unmount } = render(
      <ConfigWizard config={makeConfig()} onSave={makeOnSave()} onClose={noop} />,
    );
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    // Ink 的输出末尾会多一个换行，故允许 1 行误差
    expect(lines.length).toBeGreaterThanOrEqual(23);
    expect(lines.length).toBeLessThanOrEqual(24);
    const titleIndex = lines.findIndex((line) => line.includes("配置中心"));
    const hintIndex = lines.findIndex((line) => line.includes("完成返回"));
    expect(titleIndex).toBeGreaterThan(0); // 顶部留白：标题不在第一行
    // 内容贴底：键位提示正好是整帧最后一行
    expect(hintIndex).toBe(lines.length - 1);
    unmount();
  });

  it("列表步骤同样贴底且不超帧", async () => {
    const { lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "endpoints" }}
        onSave={makeOnSave()}
        onClose={noop}
      />,
    );
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    const titleIndex = lines.findIndex((line) => line.includes("端点管理"));
    expect(titleIndex).toBeGreaterThan(0); // 顶部留白，而非顶格
    unmount();
  });
});

describe("ConfigWizard（配置中心）", () => {
  it("菜单展示配置概览与配置文件路径", async () => {
    const { lastFrame, unmount } = render(
      <ConfigWizard config={makeConfig()} onSave={makeOnSave()} onClose={noop} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("配置中心");
    expect(frame).toContain("config.json");
    expect(frame).toContain("端点管理");
    expect(frame).toContain("模型管理");
    expect(frame).toContain("图片模型");
    expect(frame).toContain("默认项");
    expect(frame).toContain("工具输出上限");
    expect(frame).toContain("DeepSeek ✗");
    unmount();
  });

  it("菜单 → 端点管理 → 选中端点 → 就地编辑 API Key：写盘并回列表，Esc 关闭时上报变更", async () => {
    const onSave = makeOnSave();
    const onClose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard config={makeConfig()} onSave={onSave} onClose={onClose} />,
    );
    await tick();

    stdin.write(ENTER); // 首项即「端点管理」
    await tick();
    expect(lastFrame()).toContain("端点管理");
    expect(lastFrame()).toContain("＋ 新建端点");
    expect(lastFrame()).toContain("未设置");

    stdin.write(DOWN); // → DeepSeek（跳过「新建端点」）
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("◆ 端点 · DeepSeek");

    stdin.write(DOWN); // 名称 → Base URL
    await tick();
    stdin.write(DOWN); // Base URL → API Key
    await tick();
    stdin.write(ENTER); // 选中 API Key 字段 → 进入就地编辑
    await tick();
    stdin.write("sk-new-key");
    await tick();
    stdin.write(ENTER); // 保存
    await tick();
    await tick();

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0];
    expect(saved.endpoints[0]!.apiKey).toBe("sk-new-key");
    expect(saved.endpoints[1]!.apiKey).toBe("sk-old-key-123456");
    // 原地停留并给出提示
    expect(lastFrame()).toContain("API Key 已更新");

    stdin.write(ESC); // 回到端点列表
    await tick();
    stdin.write(ESC); // 回到菜单
    await tick();
    stdin.write(ESC); // 关闭
    await tick();
    expect(onClose).toHaveBeenCalledWith({
      dirty: true,
      summary: ["端点 DeepSeek 的 API Key 已更新"],
      changedEndpointIds: ["deepseek"],
    });
    unmount();
  });

  it("空 Key 不写盘并给出校验错误", async () => {
    const onSave = makeOnSave();
    const onClose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "edit", field: "apiKey", endpointId: "deepseek" }}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("API Key 不能为空");
    unmount();
  });

  it("closeOnSave：保存后立刻关闭并上报 dirty（首启引导 / `/key` 路径）", async () => {
    const onSave = makeOnSave();
    const onClose = vi.fn();
    const { stdin, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        onboarding
        closeOnSave
        initialStep={{ kind: "edit", field: "apiKey", endpointId: "deepseek" }}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await tick();
    stdin.write(" sk-boot ");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].endpoints[0]!.apiKey).toBe("sk-boot");
    expect(onClose).toHaveBeenCalledWith({
      dirty: true,
      summary: ["端点 DeepSeek 的 API Key 已更新"],
      changedEndpointIds: ["deepseek"],
    });
    unmount();
  });

  it("Base URL 校验：非 http(s) 前缀被拒绝", async () => {
    const onSave = makeOnSave();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "edit", field: "baseUrl", endpointId: "deepseek" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write("\u0015"); // Ctrl+U 清空
    await tick();
    stdin.write("ftp://x");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Base URL 需以 http:// 或 https:// 开头");
    unmount();
  });

  it("新建端点：名称 → Base URL → API Key 三步后写盘", async () => {
    const onSave = makeOnSave();
    const onClose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "new-endpoint", field: "name", draft: { name: "", baseUrl: "", apiKey: "" } }}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await tick();
    stdin.write("My Gateway");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("新建端点 · Base URL");

    stdin.write("https://gw.local/v1");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("新建端点 · API Key");

    stdin.write("sk-gw");
    await tick();
    stdin.write(ENTER);
    await tick();
    const saved = onSave.mock.calls[0]![0];
    expect(saved.endpoints).toHaveLength(3);
    expect(saved.endpoints[2]).toEqual({
      id: "my-gateway",
      name: "My Gateway",
      baseUrl: "https://gw.local/v1",
      apiKey: "sk-gw",
    });
    unmount();
  });

  it("默认模型可切换", async () => {
    const onSave = makeOnSave();
    const { stdin, unmount } = render(
      <ConfigWizard config={makeConfig()} onSave={onSave} onClose={noop} />,
    );
    await tick();
    stdin.write(DOWN); // → 模型管理
    await tick();
    stdin.write(DOWN); // → 图片模型
    await tick();
    stdin.write(DOWN); // → MCP 服务器
    await tick();
    stdin.write(DOWN); // → 默认项
    await tick();
    stdin.write(ENTER); // 打开默认项
    await tick();
    stdin.write(ENTER); // 默认模型（第一项）
    await tick();
    stdin.write(DOWN); // → GPT-5.5
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave.mock.calls[0]![0].defaultModel).toBe("gpt-5.5");
    unmount();
  });
});

describe("ConfigWizard（端点详情 · 就地编辑）", () => {
  it("↑ ↓ 切换字段后 Enter 就地编辑 Base URL 并写盘", async () => {
    const onSave = makeOnSave();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "endpoint", endpointId: "deepseek" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    expect(lastFrame()).toContain("◆ 端点 · DeepSeek");
    expect(lastFrame()).toContain("API Key");
    expect(lastFrame()).toContain("Base URL");

    stdin.write(DOWN); // → Base URL
    await tick();
    stdin.write(ENTER); // 进入编辑（预填现有地址）
    await tick();
    stdin.write("\u0015"); // Ctrl+U 清空
    await tick();
    stdin.write("https://new.example/v1");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave.mock.calls[0]![0].endpoints[0]!.baseUrl).toBe("https://new.example/v1");
    unmount();
  });

  it("就地编辑 Base URL：非 http(s) 前缀被拒绝，不写盘", async () => {
    const onSave = makeOnSave();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "endpoint", endpointId: "deepseek" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(DOWN); // → Base URL
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("\u0015");
    await tick();
    stdin.write("ftp://x");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Base URL 需以 http:// 或 https:// 开头");
    unmount();
  });

  it("就地编辑 API Key：预填现有密钥，未改动直接退出（不写盘）", async () => {
    const onSave = makeOnSave();
    const { stdin, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "endpoint", endpointId: "openai" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(DOWN); // 名称 → Base URL
    await tick();
    stdin.write(DOWN); // Base URL → API Key
    await tick();
    stdin.write(ENTER); // API Key 字段 → 编辑（预填 sk-old-key-123456）
    await tick();
    stdin.write(ENTER); // 未改动，保存应被跳过
    await tick();
    expect(onSave).not.toHaveBeenCalled();
    unmount();
  });

  it("就地编辑 API Key：Tab 切明文后可见完整密钥", async () => {
    const onSave = makeOnSave();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "endpoint", endpointId: "openai" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(DOWN); // 名称 → Base URL
    await tick();
    stdin.write(DOWN); // Base URL → API Key
    await tick();
    stdin.write(ENTER); // 编辑 API Key
    await tick();
    expect(lastFrame()).not.toContain("sk-old-key-123456"); // 掩码态
    stdin.write("\t"); // Tab 切明文
    await tick();
    expect(lastFrame()).toContain("sk-old-key-123456");
    unmount();
  });
});

describe("ConfigWizard（模型 / 图片模型 / 默认项 / 工具上限）", () => {
  it("模型管理：新建模型自动 custom: true 并进入详情", async () => {
    const onSave = makeOnSave();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard config={makeConfig()} onSave={onSave} onClose={noop} />,
    );
    await tick();
    stdin.write(DOWN); // → 模型管理
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("模型管理");
    expect(lastFrame()).toContain("＋ 新建模型");

    stdin.write(ENTER); // 新建模型（首项）
    await tick();
    expect(lastFrame()).toContain("新建模型 · 名称");
    stdin.write("My GPT");
    await tick();
    stdin.write(ENTER);
    await tick();

    const saved = onSave.mock.calls[0]![0];
    const created = saved.models.find((m) => m.name === "My GPT");
    expect(created).toBeTruthy();
    expect(created!.id).toBe("my-gpt");
    expect(created!.custom).toBe(true);
    expect(lastFrame()).toContain("◆ 模型 · My GPT");
    unmount();
  });

  it("模型详情：切换「视觉」（bool）即时写盘", async () => {
    const onSave = makeOnSave();
    const { stdin, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "model", modelId: "deepseek-v4-flash" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    // 字段顺序：名称(0) 端点(1) 模型名(2) 迁移阈值(3) 视觉(4) …
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER); // 切换视觉
    await tick();
    expect(onSave.mock.calls[0]![0].models[0]!.vision).toBe(true);
    unmount();
  });

  it("模型详情：编辑「出厂托管」模型会自动标记为自定义", async () => {
    const onSave = makeOnSave();
    const { stdin, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "model", modelId: "deepseek-v4-flash" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(ENTER); // 名称 → 编辑
    await tick();
    stdin.write("\u0015"); // Ctrl+U 清空
    await tick();
    stdin.write("DS Renamed");
    await tick();
    stdin.write(ENTER);
    await tick();
    const saved = onSave.mock.calls[0]![0];
    expect(saved.models[0]!.name).toBe("DS Renamed");
    expect(saved.models[0]!.custom).toBe(true);
    unmount();
  });

  it("删除端点：仍被模型引用时拒绝，不写盘", async () => {
    const onSave = makeOnSave();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "endpoint", endpointId: "deepseek" }}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    // 字段：名称(0) Base URL(1) API Key(2) 描述(3) 删除端点(4)
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER); // 删除端点 → 确认子屏
    await tick();
    stdin.write(ENTER); // 确认删除端点（首项）
    await tick();
    expect(onSave).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("仍被");
    unmount();
  });

  it("默认项：切换默认 Agent（枚举选择）", async () => {
    const onSave = makeOnSave();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        agents={[
          { id: "default", name: "默认助手" },
          { id: "coder", name: "Coder" },
        ]}
        onSave={onSave}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // → MCP 服务器
    await tick();
    stdin.write(DOWN); // → 默认项
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("默认项");
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // → 默认 Agent（第 3 项）
    await tick();
    stdin.write(ENTER); // 打开 Agent 选择
    await tick();
    expect(lastFrame()).toContain("默认 Agent");
    stdin.write(DOWN); // → Coder
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave.mock.calls[0]![0].defaultAgent).toBe("coder");
    unmount();
  });

  it("工具输出上限：写入正整数", async () => {
    const onSave = makeOnSave();
    const { stdin, unmount } = render(
      <ConfigWizard config={makeConfig()} initialStep={{ kind: "max-tool-output" }} onSave={onSave} onClose={noop} />,
    );
    await tick();
    stdin.write("\u0015"); // Ctrl+U 清空
    await tick();
    stdin.write("4096");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave.mock.calls[0]![0].maxToolOutput).toBe(4096);
    unmount();
  });
});

describe("ConfigWizard（MCP 服务器管理）", () => {
  it("配置中心菜单列出「MCP 服务器」并显示全局/项目数量", async () => {
    const { lastFrame, unmount } = render(
      <ConfigWizard config={makeConfig()} mcp={makeMcp()} onSave={makeOnSave()} onClose={noop} />,
    );
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("MCP 服务器");
    expect(frame).toContain("全局 2 · 项目 0");
    unmount();
  });

  it("菜单 → MCP 服务器：显示作用域切换 / 新建 / 列表；可切换作用域", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard config={makeConfig()} mcp={makeMcp()} onSave={makeOnSave()} onClose={noop} />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // → MCP 服务器
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("MCP 服务器 · 全局");
    expect(frame).toContain("＋ 新建服务器");
    expect(frame).toContain("socket-pty");
    expect(frame).toContain("https://slack.example.com"); // http 服务器摘要显示 URL（而非 command）
    expect(frame).toContain("切换到「项目」作用域");

    stdin.write(ENTER); // 首项 = 切换到项目
    await tick();
    expect(lastFrame()).toContain("MCP 服务器 · 项目");
    expect(lastFrame()).toContain("切换到「全局」作用域");
    unmount();
  });

  it("新建服务器：名称 → 进入详情并写盘", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-new", scope: "global" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={noop}
      />,
    );
    await tick();
    expect(lastFrame()).toContain("新建 MCP 服务器 · 名称（全局）");
    stdin.write("My Server");
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();
    expect(onSaveMcp).toHaveBeenCalledTimes(1);
    expect(onSaveMcp.mock.calls[0]![0]).toBe("global");
    expect(onSaveMcp.mock.calls[0]![1].mcpServers["my-server"]).toEqual({ type: "stdio", disabled: false });
    expect(lastFrame()).toContain("◆ MCP · my-server");
    unmount();
  });

  it("详情：编辑参数写入解析后的 argv", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const { stdin, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-server", scope: "global", serverId: "socket-pty" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={noop}
      />,
    );
    await tick();
    for (let i = 0; i < 5; i += 1) {
      stdin.write(DOWN); // → 参数（第 6 行）
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    stdin.write("\u0015"); // Ctrl+U 清空
    await tick();
    stdin.write("-y new-pkg chcp 65001");
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();
    expect(onSaveMcp.mock.calls[0]![1].mcpServers["socket-pty"]!.args).toEqual(["-y", "new-pkg", "chcp", "65001"]);
    unmount();
  });

  it("详情：切换启用状态写入 disabled: true", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const { stdin, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-server", scope: "global", serverId: "socket-pty" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(DOWN); // → 传输
    await tick();
    stdin.write(DOWN); // → 启用
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();
    expect(onSaveMcp.mock.calls[0]![1].mcpServers["socket-pty"]!.disabled).toBe(true);
    unmount();
  });

  it("详情：重命名服务器改 key 并进入新详情", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-server", scope: "global", serverId: "slack" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(ENTER); // 名称字段
    await tick();
    stdin.write("\u0015"); // Ctrl+U 清空
    await tick();
    stdin.write("slack-old");
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();
    const saved = onSaveMcp.mock.calls[0]![1];
    expect(saved.mcpServers["slack-old"]).toBeDefined();
    expect(saved.mcpServers.slack).toBeUndefined();
    expect(lastFrame()).toContain("◆ MCP · slack-old");
    unmount();
  });

  it("详情：删除服务器需二次确认", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-server", scope: "global", serverId: "slack" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={noop}
      />,
    );
    await tick();
    for (let i = 0; i < 6; i += 1) {
      stdin.write(DOWN); // → 删除服务器
      await tick();
    }
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("删除服务器？");
    stdin.write(ENTER); // 确认删除
    await tick();
    await tick();
    expect(onSaveMcp).toHaveBeenCalledTimes(1);
    expect(onSaveMcp.mock.calls[0]![1].mcpServers.slack).toBeUndefined();
    unmount();
  });

  it("环境变量子屏：新增 KEY=VALUE 写入 env", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-kv", scope: "global", serverId: "socket-pty", field: "env" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={noop}
      />,
    );
    await tick();
    expect(lastFrame()).toContain("环境变量");
    stdin.write(ENTER); // 首项 = 新增
    await tick();
    stdin.write("PATH=/usr/bin");
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();
    expect(onSaveMcp.mock.calls[0]![1].mcpServers["socket-pty"]!.env).toEqual({ PATH: "/usr/bin" });
    unmount();
  });

  it("环境变量子屏：非 KEY=VALUE 报错且不写盘", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-kv", scope: "global", serverId: "socket-pty", field: "env" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={noop}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("noequals");
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();
    expect(onSaveMcp).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("格式应为 KEY=VALUE");
    unmount();
  });

  it("关闭时上报 mcpChanged（供宿主重建会话）", async () => {
    const onSaveMcp = makeOnSaveMcp();
    const onClose = vi.fn();
    const { stdin, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        initialStep={{ kind: "mcp-server", scope: "global", serverId: "socket-pty" }}
        mcp={makeMcp()}
        onSave={makeOnSave()}
        onSaveMcp={onSaveMcp}
        onClose={onClose}
      />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER); // 切换启用
    await tick();
    await tick();
    stdin.write(ESC); // → MCP 列表
    await tick();
    stdin.write(ESC); // → 菜单
    await tick();
    stdin.write(ESC); // 关闭
    await tick();
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ dirty: true, mcpChanged: true }));
    unmount();
  });
});
