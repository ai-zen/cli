import { describe, it, expect, vi } from "vitest";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { switchModel } from "./model-switch.js";

/**
 * `switchModel` 只有一种写法：把目标模型写进 `AgentDefinition.modelId`。
 *
 * 之所以把这些断言写死在这里：曾经存在「写 Agent / 写 config.defaultModel」两条路径，
 * 于是 CLI 显示层的模型与 SDK 实发请求的模型会分叉——状态栏写着 DeepSeek、请求却
 * 发给了 GLM，用户看到 401 却怎么切都切不回来。现在只允许一处真相源。
 */

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoints: [],
    models: [
      { id: "glm-5.3", name: "GLM-5.3", endpointId: "bigmodelcn", tokenThresholds: { handoff: 250_000, guard: 375000 } },
      { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", endpointId: "deepseek", tokenThresholds: { handoff: 250_000, guard: 375000 } },
    ],
    ...overrides,
  } as AppConfig;
}

function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "default",
    name: "默认 Agent",
    messages: [{ role: "system", content: "你是助手" }] as AgentDefinition["messages"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("switchModel：唯一写入目标是 Agent 定义", () => {
  it("改 definition.modelId，保留其它字段", async () => {
    const definition = makeDefinition({
      modelId: "glm-5.3",
      custom: true,
      permissions: { tools: { allow: ["read"] } } as AgentDefinition["permissions"],
    });
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});

    const result = await switchModel({
      config: makeConfig(),
      agentId: "default",
      modelId: "deepseek-flash",
      readAgent: async () => definition,
      writeAgent,
      now: new Date("2026-10-22T02:00:00.000Z"),
    });

    expect(writeAgent).toHaveBeenCalledTimes(1);
    const written = writeAgent.mock.calls[0]![0] as AgentDefinition;
    expect(written.modelId).toBe("deepseek-flash");
    expect(written.updatedAt).toBe("2026-10-22T02:00:00.000Z");
    // 只改一个字段：权限、custom、提示词、创建时间必须原样带回
    expect(written.custom).toBe(true);
    expect(written.permissions).toEqual({ tools: { allow: ["read"] } });
    expect(written.messages).toEqual(definition.messages);
    expect(written.createdAt).toBe(definition.createdAt);
    expect(result.summary).toContain("DeepSeek-V4.1-Flash");
  });

  it("未绑定过模型的 Agent 也一样写进 Agent 定义（不再有 config.defaultModel 兜底）", async () => {
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});

    await switchModel({
      config: makeConfig(),
      agentId: "default",
      modelId: "deepseek-flash",
      readAgent: async () => makeDefinition(), // 无 modelId
      writeAgent,
    });

    expect(writeAgent).toHaveBeenCalledTimes(1);
    expect((writeAgent.mock.calls[0]![0] as AgentDefinition).modelId).toBe("deepseek-flash");
  });

  it("切换即重置思考强度：清空 modelParams，走目标模型默认", async () => {
    const definition = makeDefinition({
      modelId: "deepseek-flash",
      // DeepSeek 关思考的展开参数——带到 GLM-5.3 上会被直接拒绝
      modelParams: { thinking: { type: "disabled" } },
    });
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});

    await switchModel({
      config: makeConfig(),
      agentId: "default",
      modelId: "glm-5.3",
      readAgent: async () => definition,
      writeAgent,
    });

    const written = writeAgent.mock.calls[0]![0] as AgentDefinition;
    expect(written.modelId).toBe("glm-5.3");
    // 不是「剔除思考键」，而是整个删掉——不留任何思考强度设置
    expect(written.modelParams).toBeUndefined();
    expect("modelParams" in written).toBe(false);
  });

  it("原本没有思考强度时不多写一个空对象", async () => {
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});
    await switchModel({
      config: makeConfig(),
      modelId: "glm-5.3",
      readAgent: async () => makeDefinition({ modelId: "deepseek-flash" }),
      writeAgent,
    });
    expect("modelParams" in (writeAgent.mock.calls[0]![0] as AgentDefinition)).toBe(false);
  });

  it("模型不存在时抛错，且不写任何东西", async () => {
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});

    await expect(
      switchModel({
        config: makeConfig(),
        agentId: "default",
        modelId: "not-exist",
        readAgent: async () => makeDefinition({ modelId: "glm-5.3" }),
        writeAgent,
      }),
    ).rejects.toThrow(/不存在/);

    expect(writeAgent).not.toHaveBeenCalled();
  });

  it("Agent 定义缺失时抛错（不能凭空造一个 Agent）", async () => {
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});

    await expect(
      switchModel({
        config: makeConfig(),
        agentId: "ghost",
        modelId: "deepseek-flash",
        readAgent: async () => null,
        writeAgent,
      }),
    ).rejects.toThrow(/不存在/);

    expect(writeAgent).not.toHaveBeenCalled();
  });

  it("缺省 agentId 视为 default", async () => {
    const readAgent = vi.fn(async () => makeDefinition());
    await switchModel({
      config: makeConfig(),
      modelId: "deepseek-flash",
      readAgent,
      writeAgent: async () => {},
    });
    expect(readAgent).toHaveBeenCalledWith("default");
  });
});
