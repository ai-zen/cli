import { describe, it, expect, beforeEach } from "vitest";
import { checkAgentSwitch, listAgentChoices } from "./agent-switch.js";
import type { AgentList } from "./agents-store.js";
import type { AgentDefinition, AppConfig, EndpointDefinition, ModelDefinition } from "./config.js";
import { setLocale, t } from "./i18n/index.js";

// 结果与原因已 i18n 化：这些用例断言中文，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

/**
 * `/agent` 的选择器与预检现在**只搬运契约给的事实**：
 * 清单是 `agentDefinition.list`（定义本身），模型显示名从 `config.models` 里按 id 挑。
 *
 * 旧的那一格「能不能用」（`AgentView.available` / `unavailableReason`）随旧形状退场了 ——
 * 新契约只回定义，要判「跑不跑得起来」得解析模型、查端点密钥，那是宿主的判断。
 *
 * 所以这里钉两件事：
 *   · 选择器把主 AgentDefinition 摊平、把「它会用哪个模型」写出来（不再本地重算三级链）；
 *   · 预检给出一句能上屏的话，或者在「清单里没这个 AgentDefinition」时把原因交回去，一处入参都不改。
 */

/** 一个模型（`tokenThresholds` 是契约必填，用例不关心具体数值） */
function modelOf(id: string, name: string, endpointId: string): ModelDefinition {
  return {
    id,
    name,
    endpointId,
    tokenThresholds: { handoff: 1000, guard: 2000 },
    defaultParams: {},
  };
}

const ENDPOINT: EndpointDefinition = {
  id: "ep-main",
  name: "主端点",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-live-1234",
};

function configOf(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoints: [ENDPOINT],
    models: [modelOf("m1", "模型一", "ep-main"), modelOf("m2", "模型二", "ep-main")],
    imageModels: [],
    defaultAgent: "default",
    ...overrides,
  };
}

/** 一条 AgentDefinition（只给用例关心的字段赋真实值，其余按契约形状补空） */
function definitionOf(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "default",
    name: "默认 Agent",
    modelId: "m1",
    modelParams: {},
    messages: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function agentListOf(agents: AgentDefinition[]): AgentList {
  return { agents, defaultAgentId: "default" };
}

const AGENTS = agentListOf([
  definitionOf(),
  definitionOf({ id: "coder", name: "编程 Agent", modelId: "m2" }),
]);

describe("listAgentChoices：选择器的行", () => {
  it("只列主助手（子 Agent 不是入口），带上它会用的模型名", () => {
    const list = agentListOf([
      definitionOf(),
      definitionOf({ id: "coder", name: "编程 Agent", modelId: "m2" }),
      // 有 `function` 的就是子 Agent
      definitionOf({
        id: "helper",
        name: "子助手",
        function: { name: "helper", description: "子", parameters: { type: "object" } },
      }),
    ]);

    const choices = listAgentChoices(configOf(), list);

    expect(choices.map((choice) => choice.id)).toEqual(["default", "coder"]);
    expect(choices[1]).toMatchObject({
      name: "编程 Agent",
      modelId: "m2",
      modelName: "模型二",
    });
  });

  it("助手定义没绑模型时，显示全局兜底那一级的模型（只是显示）", () => {
    const bare = agentListOf([definitionOf({ modelId: undefined })]);

    expect(listAgentChoices(configOf({ defaultModel: "m2" }), bare)[0]).toMatchObject({
      modelId: "m2",
      modelName: "模型二",
    });
  });

  it("模型已经被删掉时回落成 id（不编一个名字）", () => {
    const list = agentListOf([definitionOf({ modelId: "gone" })]);

    expect(listAgentChoices(configOf(), list)[0]).toMatchObject({
      modelId: "gone",
      modelName: "gone",
    });
  });

  it("name 缺失时回落 id", () => {
    const choices = listAgentChoices(configOf(), agentListOf([definitionOf({ name: "" })]));
    expect(choices[0]!.name).toBe("default");
  });
});

describe("checkAgentSwitch：只校验、不写配置", () => {
  it("可行时给一句能给用户看的结果，且不改入参（纯函数）", () => {
    const config = configOf();
    const before = JSON.parse(JSON.stringify(config));

    const check = checkAgentSwitch({ config, list: AGENTS, targetAgentId: "coder" });

    expect(check).toEqual({
      ok: true,
      summary: t("agentSwitch.summary", {
        name: "编程 Agent",
        id: "coder",
        model: "模型二",
        modelId: "m2",
      }),
    });
    // 不返回、也不改动配置：写 `defaultAgent` 是 `config.defaults.update` 的事
    expect(config).toEqual(before);
  });

  it("助手不存在时回一句原因（而不是抛错让上层去猜）", () => {
    const check = checkAgentSwitch({
      config: configOf(),
      list: AGENTS,
      targetAgentId: "ghost",
    });

    expect(check).toEqual({
      ok: false,
      name: "ghost",
      reason: t("agentSwitch.err.agentMissing", { id: "ghost" }),
    });
  });

  it("子 Agent 不是主助手：选不到它", () => {
    const list = agentListOf([
      definitionOf(),
      definitionOf({
        id: "helper",
        function: { name: "helper", description: "子", parameters: { type: "object" } },
      }),
    ]);

    const check = checkAgentSwitch({ config: configOf(), list, targetAgentId: "helper" });

    expect(check.ok).toBe(false);
  });
});
