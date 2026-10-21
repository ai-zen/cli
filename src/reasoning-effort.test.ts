import { describe, it, expect, vi } from "vitest";
import type { AgentDefinition, AppConfig, Model, ReasoningPresets } from "@ai-zen/agents-sdk";
import {
  EFFORT_LABELS,
  describeEffort,
  effortChoices,
  effortLabel,
  isAdjustable,
  setAgentEffort,
} from "./reasoning-effort.js";
import { FACTORY_REASONING_PRESETS } from "@ai-zen/agents-sdk";

const PRESETS = FACTORY_REASONING_PRESETS;

/** DeepSeek：low/high/max + off */
const DEEPSEEK = {
  id: "deepseek-flash",
  name: "DeepSeek",
  endpointId: "deepseek",
  tokenThresholds: { handoff: 250_000, guard: 375_000 },
  reasoningPreset: "deepseek",
} as Model;

/** 智谱 GLM-5.3：只认三档且不能关 */
const GLM53 = {
  id: "glm-5.3",
  name: "GLM-5.3",
  endpointId: "bigmodelcn",
  tokenThresholds: { handoff: 250_000, guard: 375_000 },
  reasoningPreset: "zhipu-5.3",
} as Model;

/** 未挂策略（GLM-4.7 强制思考、无 effort 参数） */
const FORCED = {
  id: "glm-4.7-flash",
  name: "GLM-4.7",
  endpointId: "bigmodelcn",
  tokenThresholds: { handoff: 100_000, guard: 150_000 },
} as Model;

/** 引用了不存在的策略名 */
const BROKEN = {
  id: "broken",
  name: "Broken",
  endpointId: "e",
  tokenThresholds: { handoff: 1000, guard: 1500 },
  reasoningPreset: "no-such-preset",
} as Model;

function makeConfig(): AppConfig {
  return {
    endpoints: [],
    defaultModel: "deepseek-flash",
    models: [DEEPSEEK, GLM53, FORCED, BROKEN],
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
  it("常见档位有中文标签，未知档位原样显示", () => {
    for (const level of ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(EFFORT_LABELS[level]).toBeTruthy();
    }
    expect(effortLabel("high")).toBe("高");
    expect(effortLabel("ultra-max")).toBe("ultra-max"); // 用户自建档位名
  });

  it("可选值完全来自策略表的键（含 off）", () => {
    expect(effortChoices(DEEPSEEK, PRESETS)).toEqual(["low", "high", "max", "off"]);
    expect(effortChoices(GLM53, PRESETS)).toEqual(["low", "high", "max"]); // 表里没有 off
    expect(effortChoices(FORCED, PRESETS)).toEqual([]);
    expect(effortChoices(BROKEN, PRESETS)).toEqual([]);
    expect(effortChoices(undefined, PRESETS)).toEqual([]);
  });

  it("isAdjustable 判定模型是否可调", () => {
    expect(isAdjustable(DEEPSEEK, PRESETS)).toBe(true);
    expect(isAdjustable(FORCED, PRESETS)).toBe(false);
    expect(isAdjustable(BROKEN, PRESETS)).toBe(false);
    expect(isAdjustable(null, PRESETS)).toBe(false);
  });

  it("用户自建的策略一样能列出来（档位名随意）", () => {
    const custom: ReasoningPresets = {
      "my-endpoint": { levels: { turbo: { effort: "turbo" }, chill: { effort: "chill" } } },
    };
    const model = { ...DEEPSEEK, reasoningPreset: "my-endpoint" } as Model;
    expect(effortChoices(model, custom)).toEqual(["turbo", "chill"]);
  });
});

describe("describeEffort 状态栏文案", () => {
  it("模型不可调 → 「—」", () => {
    expect(describeEffort(FORCED, PRESETS, makeDefinition())).toBe("—");
    expect(describeEffort(BROKEN, PRESETS, makeDefinition())).toBe("—");
    expect(describeEffort(undefined, PRESETS, null)).toBe("—");
  });

  it("Agent 声明了档位 → 中文标签", () => {
    expect(describeEffort(GLM53, PRESETS, makeDefinition({ reasoningEffort: "max" }))).toBe("最高");
    expect(describeEffort(DEEPSEEK, PRESETS, makeDefinition({ reasoningEffort: "off" }))).toBe("关");
    expect(describeEffort(DEEPSEEK, PRESETS, makeDefinition({ reasoningEffort: "low" }))).toBe("低");
  });

  it("可调但 Agent 未声明 → 「默认」", () => {
    expect(describeEffort(DEEPSEEK, PRESETS, makeDefinition())).toBe("默认");
    expect(describeEffort(DEEPSEEK, PRESETS, null)).toBe("默认");
  });

  it("Agent 声明了策略里没有的档位 → 退回模型默认", () => {
    expect(describeEffort(GLM53, PRESETS, makeDefinition({ reasoningEffort: "xhigh" }))).toBe("默认");
  });
});

describe("setAgentEffort 写入 Agent 定义", () => {
  it("写入 reasoningEffort，保留其它字段，不动 config", async () => {
    const definition = makeDefinition({ custom: true, modelId: "glm-5.3" });
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});
    const config = makeConfig();

    const result = await setAgentEffort({
      config,
      presets: PRESETS,
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
      presets: PRESETS,
      agentId: "default",
      effort: null,
      readAgent: async () => definition,
      writeAgent,
    });

    const written = writeAgent.mock.calls[0]![0];
    expect(written).not.toHaveProperty("reasoningEffort");
    expect(result.summary).toContain("跟随模型默认");
  });

  it("策略里没有的档位 → 抛错且不写盘", async () => {
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});
    await expect(
      setAgentEffort({
        config: makeConfig(),
        presets: PRESETS,
        agentId: "default",
        effort: "medium", // zhipu-5.3 只有 low/high/max
        readAgent: async () => makeDefinition({ modelId: "glm-5.3" }),
        writeAgent,
      }),
    ).rejects.toThrow(/没有档位 "medium"/);
    expect(writeAgent).not.toHaveBeenCalled();
  });

  it("模型未关联策略 / 策略名不存在 → 抛错", async () => {
    await expect(
      setAgentEffort({
        config: makeConfig(),
        presets: PRESETS,
        agentId: "default",
        effort: "high",
        readAgent: async () => makeDefinition({ modelId: "glm-4.7-flash" }),
        writeAgent: async () => {},
      }),
    ).rejects.toThrow(/未关联可用的思考策略/);

    await expect(
      setAgentEffort({
        config: makeConfig(),
        presets: PRESETS,
        agentId: "default",
        effort: "high",
        readAgent: async () => makeDefinition({ modelId: "broken" }),
        writeAgent: async () => {},
      }),
    ).rejects.toThrow(/未关联可用的思考策略/);
  });

  it("Agent 不存在 → 抛错", async () => {
    await expect(
      setAgentEffort({
        config: makeConfig(),
        presets: PRESETS,
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
      presets: PRESETS,
      effort: "max",
      readAgent: async () => makeDefinition(), // 无 modelId
      writeAgent,
    });
    expect(result.model.id).toBe("deepseek-flash");
    expect(writeAgent.mock.calls[0]![0].reasoningEffort).toBe("max");
  });
});
