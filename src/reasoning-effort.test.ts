import { describe, it, expect, vi } from "vitest";
import type { AgentDefinition, AppConfig, Model } from "@ai-zen/agents-sdk";
import type { ReasoningEffort } from "./reasoning-effort.js";
import {
  EFFORT_LABELS,
  describeEffort,
  effortChoices,
  isAdjustable,
  setAgentEffort,
} from "./reasoning-effort.js";

/** DeepSeek：low/high/max，可关闭（thinking.type） */
const DEEPSEEK = {
  id: "deepseek-flash",
  name: "DeepSeek",
  endpointId: "deepseek",
  tokenThresholds: { handoff: 250_000, guard: 375_000 },
  reasoning: { efforts: ["low", "high", "max"] as ReasoningEffort[], disable: "thinking" as const },
} as Model;

/** 智谱 GLM-5.3：只认三档且不能关 */
const GLM53 = {
  id: "glm-5.3",
  name: "GLM-5.3",
  endpointId: "bigmodelcn",
  tokenThresholds: { handoff: 250_000, guard: 375_000 },
  reasoning: { efforts: ["low", "high", "max"] as ReasoningEffort[] },
} as Model;

/** 不可调档（GLM-4.7 强制思考、无 effort 参数） */
const FORCED = {
  id: "glm-4.7-flash",
  name: "GLM-4.7",
  endpointId: "bigmodelcn",
  tokenThresholds: { handoff: 100_000, guard: 150_000 },
  reasoning: { efforts: [] as ReasoningEffort[] },
} as Model;

function makeConfig(): AppConfig {
  return {
    endpoints: [],
    defaultModel: "deepseek-flash",
    models: [DEEPSEEK, GLM53, FORCED],
  } as unknown as AppConfig;
}

function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "default",
    name: "默认",
    messages: [{ role: "system", content: "hi" }] as AgentDefinition["messages"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("档位标签与可选值", () => {
  it("每个档位都有中文标签", () => {
    for (const level of ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as ReasoningEffort[]) {
      expect(EFFORT_LABELS[level]).toBeTruthy();
    }
  });

  it("可选值来自模型能力：off 只在支持关闭时出现", () => {
    expect(effortChoices(DEEPSEEK)).toEqual(["off", "low", "high", "max"]);
    expect(effortChoices(GLM53)).toEqual(["low", "high", "max"]); // 无 off
    expect(effortChoices(FORCED)).toEqual([]);
    expect(effortChoices(undefined)).toEqual([]);
  });

  it("isAdjustable 判定模型是否可调", () => {
    expect(isAdjustable(DEEPSEEK)).toBe(true);
    expect(isAdjustable(FORCED)).toBe(false);
    expect(isAdjustable(null)).toBe(false);
  });
});

describe("describeEffort 状态栏文案", () => {
  it("模型不可调 → 「—」", () => {
    expect(describeEffort(FORCED, makeDefinition())).toBe("—");
    expect(describeEffort(undefined, null)).toBe("—");
  });

  it("Agent 声明了档位 → 中文标签", () => {
    expect(describeEffort(GLM53, makeDefinition({ reasoningEffort: "max" }))).toBe("最高");
    expect(describeEffort(DEEPSEEK, makeDefinition({ reasoningEffort: "off" }))).toBe("关");
    expect(describeEffort(DEEPSEEK, makeDefinition({ reasoningEffort: "low" }))).toBe("低");
  });

  it("可调但 Agent 未声明 → 「默认」", () => {
    expect(describeEffort(DEEPSEEK, makeDefinition())).toBe("默认");
    expect(describeEffort(DEEPSEEK, null)).toBe("默认");
  });
});

describe("setAgentEffort 写入 Agent 定义", () => {
  it("写入 reasoningEffort，保留其它字段，不动 config", async () => {
    const definition = makeDefinition({ custom: true, modelId: "glm-5.3" });
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});
    const config = makeConfig();

    const result = await setAgentEffort({
      config,
      agentId: "default",
      effort: "high",
      readAgent: async () => definition,
      writeAgent,
      now: new Date("2026-10-22T03:00:00.000Z"),
    });

    expect(writeAgent).toHaveBeenCalledTimes(1);
    const written = writeAgent.mock.calls[0]![0];
    expect(written.reasoningEffort).toBe("high");
    expect(written.updatedAt).toBe("2026-10-22T03:00:00.000Z");
    expect(written.custom).toBe(true);
    expect(written.messages).toEqual(definition.messages);
    expect(result.model.id).toBe("glm-5.3");
    expect(result.summary).toContain("「高」");
    expect(config.models![0]).toBe(DEEPSEEK); // 配置对象未被修改
  });

  it("effort = null → 删除声明，恢复跟随模型默认", async () => {
    const definition = makeDefinition({ reasoningEffort: "max" });
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});

    const result = await setAgentEffort({
      config: makeConfig(),
      agentId: "default",
      effort: null,
      readAgent: async () => definition,
      writeAgent,
    });

    const written = writeAgent.mock.calls[0]![0];
    expect(written).not.toHaveProperty("reasoningEffort");
    expect(result.summary).toContain("跟随模型默认");
  });

  it("模型不支持的档位 → 抛错且不写盘", async () => {
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});
    await expect(
      setAgentEffort({
        config: makeConfig(),
        agentId: "default",
        effort: "medium", // GLM-5.3 只认 low/high/max
        readAgent: async () => makeDefinition({ modelId: "glm-5.3" }),
        writeAgent,
      }),
    ).rejects.toThrow(/不支持档位 "medium"/);
    expect(writeAgent).not.toHaveBeenCalled();
  });

  it("模型不可调档 → 抛错", async () => {
    await expect(
      setAgentEffort({
        config: makeConfig(),
        agentId: "default",
        effort: "high",
        readAgent: async () => makeDefinition({ modelId: "glm-4.7-flash" }),
        writeAgent: async () => {},
      }),
    ).rejects.toThrow(/未声明可调档位/);
  });

  it("Agent 不存在 → 抛错", async () => {
    await expect(
      setAgentEffort({
        config: makeConfig(),
        agentId: "nope",
        effort: "low",
        readAgent: async () => null,
        writeAgent: async () => {},
      }),
    ).rejects.toThrow(/不存在/);
  });

  it("未绑定模型的 Agent 用 defaultModel", async () => {
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});
    const result = await setAgentEffort({
      config: makeConfig(),
      effort: "max",
      readAgent: async () => makeDefinition(), // 无 modelId
      writeAgent,
    });
    expect(result.model.id).toBe("deepseek-flash");
    expect(writeAgent.mock.calls[0]![0].reasoningEffort).toBe("max");
  });
});
