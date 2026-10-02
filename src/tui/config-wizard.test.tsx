import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AppConfig } from "@ai-zen/agents-sdk";
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
    defaultModel: "deepseek-v4-flash",
  };
}

const noop = () => {
  /* 占位 */
};

/** 带类型的持久化 mock：`calls[0][0]` 即写盘的配置 */
const makeOnSave = () => vi.fn<(config: AppConfig) => Promise<void>>(async () => undefined);

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
        initialStep={{ kind: "pick-endpoint", field: "apiKey" }}
        onSave={makeOnSave()}
        onClose={noop}
      />,
    );
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    const titleIndex = lines.findIndex((line) => line.includes("选择端点"));
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
    expect(frame).toContain("默认模型");
    expect(frame).toContain("端点凭据（API Key）");
    expect(frame).toContain("DeepSeek ✗");
    unmount();
  });

  it("菜单 → 端点凭据 → 选中端点 → 输入 Key：写盘并回菜单，Esc 关闭时上报变更", async () => {
    const onSave = makeOnSave();
    const onClose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard config={makeConfig()} onSave={onSave} onClose={onClose} />,
    );
    await tick();

    stdin.write(DOWN); // → 端点凭据（API Key）
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("选择端点 · API Key");
    expect(lastFrame()).toContain("未设置");

    stdin.write(ENTER); // 选中第一个端点（DeepSeek）
    await tick();
    expect(lastFrame()).toContain("设置 API Key · DeepSeek");

    stdin.write("sk-new-key");
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0];
    expect(saved.endpoints[0]!.apiKey).toBe("sk-new-key");
    expect(saved.endpoints[1]!.apiKey).toBe("sk-old-key-123456");
    // 回到菜单，概览已更新
    expect(lastFrame()).toContain("DeepSeek ✓");

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
    stdin.write(ENTER); // 菜单第一项：默认模型
    await tick();
    stdin.write(DOWN); // → GPT-5.5
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSave.mock.calls[0]![0].defaultModel).toBe("gpt-5.5");
    unmount();
  });
});
