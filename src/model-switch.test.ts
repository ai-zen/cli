import { describe, it, expect, vi } from "vitest";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { resolveModelWriteTarget, switchModel } from "./model-switch.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoints: [],
    models: [
      { id: "glm-5.3", name: "GLM-5.3", endpointId: "bigmodelcn", tokenThresholds: { handoff: 250_000, guard: 375000 } },
      { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", endpointId: "deepseek", tokenThresholds: { handoff: 250_000, guard: 375000 } },
    ],
    defaultModel: "glm-5.3",
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

describe("模型切换的写入目标判定", () => {
  it("Agent 显式绑定过模型 → 写 Agent 定义", () => {
    expect(resolveModelWriteTarget(makeDefinition({ modelId: "glm-5.3" }))).toBe("agent");
  });

  it("Agent 未绑定模型 → 写全局默认模型", () => {
    expect(resolveModelWriteTarget(makeDefinition())).toBe("default");
  });

  it("Agent 定义缺失 → 写全局默认模型", () => {
    expect(resolveModelWriteTarget(null)).toBe("default");
    expect(resolveModelWriteTarget(undefined)).toBe("default");
  });
});

describe("switchModel 写入配置", () => {
  it("绑定过模型的 Agent：改 definition.modelId，保留其它字段，不动 config", async () => {
    const definition = makeDefinition({
      modelId: "glm-5.3",
      custom: true,
      permissions: { tools: { allow: ["read"] } } as AgentDefinition["permissions"],
    });
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});
    const saveConfig = vi.fn(async (_config: AppConfig) => {});

    const result = await switchModel({
      config: makeConfig(),
      agentId: "default",
      modelId: "deepseek-flash",
      readAgent: async () => definition,
      writeAgent,
      saveConfig,
      now: new Date("2026-10-22T02:00:00.000Z"),
    });

    expect(result.target).toBe("agent");
    expect(saveConfig).not.toHaveBeenCalled();
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
    expect(result.summary).toContain("绑定模型");
  });

  it("未绑定模型的 Agent：写 config.defaultModel，不碰 Agent 定义", async () => {
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});
    const saveConfig = vi.fn(async (_config: AppConfig) => {});
    const original = makeConfig();

    const result = await switchModel({
      config: original,
      agentId: "default",
      modelId: "deepseek-flash",
      readAgent: async () => makeDefinition(),
      writeAgent,
      saveConfig,
    });

    expect(result.target).toBe("default");
    expect(writeAgent).not.toHaveBeenCalled();
    expect(saveConfig).toHaveBeenCalledTimes(1);
    const written = saveConfig.mock.calls[0]![0] as AppConfig;
    expect(written.defaultModel).toBe("deepseek-flash");
    // 新对象而非就地改：原配置对象（Scope 持有它的快照）不能被篡改
    expect(result.config).not.toBe(original);
    expect(original.defaultModel).toBe("glm-5.3");
    expect(result.summary).toContain("默认模型配置");
  });

  it("模型不存在时抛错，且不写任何配置", async () => {
    const writeAgent = vi.fn(async (_definition: AgentDefinition) => {});
    const saveConfig = vi.fn(async (_config: AppConfig) => {});

    await expect(
      switchModel({
        config: makeConfig(),
        agentId: "default",
        modelId: "not-exist",
        readAgent: async () => makeDefinition({ modelId: "glm-5.3" }),
        writeAgent,
        saveConfig,
      }),
    ).rejects.toThrow(/不存在/);

    expect(writeAgent).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("缺省 agentId 视为 default", async () => {
    const readAgent = vi.fn(async () => makeDefinition());
    await switchModel({
      config: makeConfig(),
      modelId: "deepseek-flash",
      readAgent,
      writeAgent: async () => {},
      saveConfig: async () => {},
    });
    expect(readAgent).toHaveBeenCalledWith("default");
  });
});
