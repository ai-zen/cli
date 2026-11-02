import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { writeFileSync } from "fs";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { Message } from "@ai-zen/agents-core";
import { ConfigWizard } from "./config-wizard/index.js";
import type { AgentStore } from "../agents-store.js";
import { setLocale } from "../i18n/index.js";

// 步骤标题已 i18n 化：用例断言的是中文标题，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => {
  setLocale("zh");
});

// 拦截系统编辑器：把「打开编辑器」替换为直接把新内容写回临时文件

const tick = () => new Promise((r) => setTimeout(r, 25));
const ENTER = "\r";

const makeConfig = (): AppConfig => ({
  endpoints: [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x" }],
  models: [{ id: "m", name: "M", endpointId: "deepseek", tokenThresholds: { handoff: 1000, guard: 1500 } }],
});

const makeAgent = (): AgentDefinition => ({
  id: "default",
  name: "默认助手",
  description: "",
  messages: [Message.System("你是助手")],
  permissions: { tools: { allow: ["*"] } },
  custom: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("Agent 提示词（系统编辑器）", () => {
  it("Enter 调起编辑器，保存后回写首条 system 消息", async () => {
    const save = vi.fn<(kind: string, def: AgentDefinition) => Promise<void>>(async () => undefined);
    const store = { agents: [makeAgent()], subAgents: [], save, remove: vi.fn(async () => undefined) } as unknown as AgentStore;
    // 编辑器实现直接注入：不再依赖 vi.mock("child_process")（模块级 mock 是全局的，
    // 多个测试文件各自 mock 同一说明符会互相覆盖）
    const openEditor = vi.fn((_editor: string, file: string) => {
      writeFileSync(file, "改写后的提示词", "utf-8");
    });

    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        openEditor={openEditor}
        initialStep={{ kind: "agent-text", agentKind: "agent", agentId: "default", field: "prompt" }}
        agentStore={store}
        onSave={vi.fn(async () => undefined)}
        onClose={() => undefined}
      />,
    );
    await tick();
    expect(lastFrame()).toContain("提示词");
    expect(lastFrame()).toContain("你是助手"); // 屏内预览当前提示词

    stdin.write(ENTER);
    await tick();
    await tick();
    await tick();

    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    const def = save.mock.calls[0]![1];
    expect(def.messages[0]!.role).toBe("system");
    expect(def.messages[0]!.content).toBe("改写后的提示词");
    unmount();
  });

  it("编辑器启动失败时屏内报错，不写盘", async () => {
    const save = vi.fn(async () => undefined);
    const store = { agents: [makeAgent()], subAgents: [], save, remove: vi.fn(async () => undefined) } as unknown as AgentStore;
    const openEditor = vi.fn(() => {
      throw new Error("boom");
    });

    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
        openEditor={openEditor}
        initialStep={{ kind: "agent-text", agentKind: "agent", agentId: "default", field: "prompt" }}
        agentStore={store}
        onSave={vi.fn(async () => undefined)}
        onClose={() => undefined}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();
    await tick();
    expect(save).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("打开编辑器失败");
    unmount();
  });
});
