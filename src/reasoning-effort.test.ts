import { describe, it, expect, vi } from "vitest";
import { beforeEach } from "vitest";
import type { AgentDefinition, AppConfig, Model } from "@ai-zen/agents-sdk";
import { FACTORY_REASONING_PRESETS } from "@ai-zen/agents-sdk";
import {
  KNOWN_EFFORT_LEVELS,
  describeEffort,
  describeEffortView,
  effortChoices,
  effortDimmed,
  effortLabel,
  isAdjustable,
  setAgentEffort,
} from "./reasoning-effort.js";
import { matchLevel, presetFor } from "./reasoning-presets.js";
import { setLocale } from "./i18n/index.js";

// 档位文案现在由 i18n 词典提供：这些用例断言的是中文文案，故显式锁定语言
beforeEach(() => setLocale("zh"));

const PRESETS = FACTORY_REASONING_PRESETS;

/** DeepSeek：low/high/max + off，出厂只开思考不指定档位 */
const DEEPSEEK = {
  id: "deepseek-flash",
  name: "DeepSeek",
  endpointId: "deepseek",
  tokenThresholds: { handoff: 250_000, guard: 375_000 },
  defaultParams: { thinking: { type: "enabled" } },
  reasoningPreset: "deepseek",
} as Model;

/** 智谱 GLM-5.3：只认三档且不能关；出厂即 max */
const GLM53 = {
  id: "glm-5.3",
  name: "GLM-5.3",
  endpointId: "bigmodelcn",
  tokenThresholds: { handoff: 250_000, guard: 375_000 },
  defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
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
    for (const level of KNOWN_EFFORT_LEVELS) {
      // 中文界面下每个已知档位都应有本土化文案（不等于档位名本身）
      expect(effortLabel(level)).not.toBe(level);
    }
    expect(effortLabel("high")).toBe("高");
    expect(effortLabel("ultra-max")).toBe("ultra-max"); // 用户自建档位名
  });

  it("英文界面下档位标签跟着变（文案不参与任何逻辑）", () => {
    setLocale("en");
    expect(effortLabel("high")).toBe("high");
    expect(effortLabel("off")).toBe("off");
    setLocale("zh");
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
    const custom = {
      "my-endpoint": { levels: { turbo: { effort: "turbo" }, chill: { effort: "chill" } } },
    };
    const model = { ...DEEPSEEK, reasoningPreset: "my-endpoint" } as Model;
    expect(effortChoices(model, custom)).toEqual(["turbo", "chill"]);
  });
});

describe("describeEffort 状态栏文案（从生效参数反查，不做额外推导）", () => {
  it("模型不可调 → 「—」", () => {
    expect(describeEffort(FORCED, PRESETS, makeDefinition())).toBe("—");
    expect(describeEffort(BROKEN, PRESETS, makeDefinition())).toBe("—");
    expect(describeEffort(undefined, PRESETS, null)).toBe("—");
  });

  it("模型默认参数就命中某档 → 显示该档（配置即事实，不假装「默认」）", () => {
    expect(describeEffort(GLM53, PRESETS, makeDefinition())).toBe("最高");
  });

  it("Agent 覆盖后按覆盖值显示", () => {
    const def = makeDefinition({
      modelParams: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    });
    expect(describeEffort(GLM53, PRESETS, def)).toBe("低");

    const offDef = makeDefinition({ modelParams: { thinking: { type: "disabled" } } });
    expect(describeEffort(DEEPSEEK, PRESETS, offDef)).toBe("关");
  });

  it("参数不完整匹配任何档位 → 「默认」（如 DeepSeek 出厂只开思考不指定档位）", () => {
    expect(describeEffort(DEEPSEEK, PRESETS, makeDefinition())).toBe("默认");
    expect(describeEffort(DEEPSEEK, PRESETS, null)).toBe("默认");
  });

  it("Agent 写了参数但匹配不到任何档位 → 「自定义」（用户手改过）", () => {
    const def = makeDefinition({
      modelParams: { thinking: { type: "enabled" }, reasoning_effort: "weird" },
    });
    expect(describeEffort(GLM53, PRESETS, def)).toBe("自定义");
  });
});

describe("effortDimmed / describeEffortView（置灰不靠文案判断）", () => {
  it("不可调档 → 置灰", () => {
    expect(effortDimmed(FORCED, PRESETS, makeDefinition())).toBe(true);
    expect(effortDimmed(undefined, PRESETS, null)).toBe(true);
  });

  it("off 档 → 置灰；其他档位 → 不置灰", () => {
    const offDef = makeDefinition({ modelParams: { thinking: { type: "disabled" } } });
    expect(effortDimmed(DEEPSEEK, PRESETS, offDef)).toBe(true);
    expect(effortDimmed(GLM53, PRESETS, makeDefinition())).toBe(false);
  });

  it("切到英文后置灰结果不变（证明判断依据是档位而非文案）", () => {
    const before = effortDimmed(DEEPSEEK, PRESETS, makeDefinition({ modelParams: { thinking: { type: "disabled" } } }));
    setLocale("en");
    const after = effortDimmed(DEEPSEEK, PRESETS, makeDefinition({ modelParams: { thinking: { type: "disabled" } } }));
    setLocale("zh");
    expect(after).toBe(before);
  });

  it("describeEffortView 一次给出文案与置灰", () => {
    const view = describeEffortView(GLM53, PRESETS, makeDefinition());
    expect(view.text).toBe("最高");
    expect(view.dimmed).toBe(false);
  });
});

describe("setAgentEffort 写入 Agent 定义", () => {
  it("写入的是展开后的参数（不是档位名）", async () => {
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
    expect(written.modelParams).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(written).not.toHaveProperty("reasoningEffort");
    expect(written.updatedAt).toBe("2026-10-22T03:00:00.000Z");
    expect(written.custom).toBe(true);
    expect(result.model.id).toBe("glm-5.3");
    expect(result.summary).toContain("「高」");
    expect(config.models![0]).toBe(DEEPSEEK); // 配置对象未被修改
  });

  it("max → off 不残留上一档的 reasoning_effort", async () => {
    const definition = makeDefinition({
      modelId: "deepseek-flash",
      modelParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    });
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});

    await setAgentEffort({
      config: makeConfig(),
      presets: PRESETS,
      effort: "off",
      readAgent: async () => definition,
      writeAgent,
    });

    expect(writeAgent.mock.calls[0]![0].modelParams).toEqual({ thinking: { type: "disabled" } });
  });

  it("保留与思考无关的参数（如 temperature）", async () => {
    const definition = makeDefinition({
      modelId: "glm-5.3",
      modelParams: { temperature: 0.2, reasoning_effort: "max" },
    });
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});

    await setAgentEffort({
      config: makeConfig(),
      presets: PRESETS,
      effort: "low",
      readAgent: async () => definition,
      writeAgent,
    });

    expect(writeAgent.mock.calls[0]![0].modelParams).toEqual({
      temperature: 0.2,
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  });

  it("effort = null → 剔除思考参数；清空后连 modelParams 一起删掉", async () => {
    const definition = makeDefinition({
      modelId: "glm-5.3",
      modelParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    });
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});

    const result = await setAgentEffort({
      config: makeConfig(),
      presets: PRESETS,
      effort: null,
      readAgent: async () => definition,
      writeAgent,
    });

    expect(writeAgent.mock.calls[0]![0]).not.toHaveProperty("modelParams");
    expect(result.summary).toContain("跟随模型默认");
  });

  it("effort = null 但还有其它参数 → 只删思考键，保留其余", async () => {
    const definition = makeDefinition({
      modelId: "glm-5.3",
      modelParams: { temperature: 0.2, reasoning_effort: "max" },
    });
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});

    await setAgentEffort({
      config: makeConfig(),
      presets: PRESETS,
      effort: null,
      readAgent: async () => definition,
      writeAgent,
    });

    expect(writeAgent.mock.calls[0]![0].modelParams).toEqual({ temperature: 0.2 });
  });

  it("策略里没有的档位 → 抛错且不写盘", async () => {
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});
    await expect(
      setAgentEffort({
        config: makeConfig(),
        presets: PRESETS,
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
        effort: "high",
        readAgent: async () => makeDefinition({ modelId: "glm-4.7-flash" }),
        writeAgent: async () => {},
      }),
    ).rejects.toThrow(/未关联可用的思考策略/);

    await expect(
      setAgentEffort({
        config: makeConfig(),
        presets: PRESETS,
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

  it("未绑定模型的 Agent 直接报错（不再回退 defaultModel）", async () => {
    const writeAgent = vi.fn(async (_def: AgentDefinition) => {});
    await expect(
      setAgentEffort({
        config: makeConfig(),
        presets: PRESETS,
        effort: "max",
        readAgent: async () => makeDefinition(), // 无 modelId
        writeAgent,
      }),
    ).rejects.toThrow(/未绑定模型/);
    expect(writeAgent).not.toHaveBeenCalled();
  });
});

describe("写入后再读回：往返一致", () => {
  it("每个合法档位写入后都能被反查回来", async () => {
    for (const modelId of ["glm-5.3", "deepseek-flash"]) {
      for (const level of effortChoices(
        modelId === "glm-5.3" ? GLM53 : DEEPSEEK,
        PRESETS,
      )) {
        let written: AgentDefinition | undefined;
        await setAgentEffort({
          config: makeConfig(),
          presets: PRESETS,
          effort: level,
          readAgent: async () => makeDefinition({ modelId }),
          writeAgent: async (def) => {
            written = def;
          },
        });
        const model = makeConfig().models.find((m) => m.id === modelId);
        expect(matchLevel(presetFor(modelId, model!.reasoningPreset, PRESETS), written!.modelParams)).toBe(
          level,
        );
      }
    }
  });
});
