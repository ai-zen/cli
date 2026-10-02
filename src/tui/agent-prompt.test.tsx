import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { writeFileSync } from "fs";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { Message } from "@ai-zen/agents-core";
import { spawnSync } from "child_process";
import { ConfigWizard } from "./config-wizard/index.js";
import type { AgentStore } from "../agents-store.js";

// 拦截系统编辑器：把「打开编辑器」替换为直接把新内容写回临时文件
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn(() => ({ status: 0 })) };
});

const tick = () => new Promise((r) => setTimeout(r, 25));
const ENTER = "\r";

const makeConfig = (): AppConfig => ({
  endpoints: [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x" }],
  models: [{ id: "m", name: "M", endpointId: "deepseek", maxContextTokens: 1000 }],
  defaultModel: "m",
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
    const spawnMock = vi.mocked(spawnSync);
    spawnMock.mockImplementation(((_editor: string, args: string[]) => {
      writeFileSync(args[0]!, "改写后的提示词", "utf-8");
      return { status: 0 } as never;
    }) as never);

    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
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

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    const def = save.mock.calls[0]![1];
    expect(def.messages[0]!.role).toBe("system");
    expect(def.messages[0]!.content).toBe("改写后的提示词");
    unmount();
  });

  it("编辑器启动失败时屏内报错，不写盘", async () => {
    const save = vi.fn(async () => undefined);
    const store = { agents: [makeAgent()], subAgents: [], save, remove: vi.fn(async () => undefined) } as unknown as AgentStore;
    const spawnMock = vi.mocked(spawnSync);
    spawnMock.mockImplementation((() => {
      throw new Error("boom");
    }) as never);

    const { stdin, lastFrame, unmount } = render(
      <ConfigWizard
        config={makeConfig()}
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
