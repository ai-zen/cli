import { describe, it, expect, beforeEach } from "vitest";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { checkAgentSwitch, listAgentChoices } from "./agent-switch.js";
import { setLocale } from "./i18n/index.js";

// 切换结果与不可用原因已 i18n 化：这些用例断言中文，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

/**
 * `/agent` 的唯一写入目标是 `config.defaultAgent`：
 * 「主 Agent」在配置层只有这一个字段，切换不该顺手改 Agent 定义本身。
 *
 * 另一半断言是关于**可用性预检**的：切换会重挂载对话屏，切到一个跑不起来的
 * Agent（没绑模型 / 端点没 Key）会让用户直接卡在启动错误屏，连 `/config` 都得
 * 重启才能进。所以这里把「切不过去」的每种原因都钉死。
 */

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoints: [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-real" },
      { id: "bigmodelcn", name: "BigModel", baseUrl: "https://open.bigmodel.cn", apiKey: "" },
    ],
    models: [
      {
        id: "deepseek-flash",
        name: "DeepSeek-V4.1-Flash",
        endpointId: "deepseek",
        tokenThresholds: { handoff: 250_000, guard: 375_000 },
      },
      {
        id: "glm-5.3",
        name: "GLM-5.3",
        endpointId: "bigmodelcn",
        tokenThresholds: { handoff: 250_000, guard: 375_000 },
      },
    ],
    defaultAgent: "default",
    ...overrides,
  } as AppConfig;
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "default",
    name: "默认 Agent",
    modelId: "deepseek-flash",
    messages: [{ role: "system", content: "你是助手" }] as AgentDefinition["messages"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const agents = [
  makeAgent(),
  makeAgent({
    id: "coder",
    name: "编程 Agent",
    modelId: "deepseek-flash",
    modelParams: { temperature: 0.2 },
  }),
];

describe("checkAgentSwitch：只校验、不写配置", () => {
  it("回一句能给用户看的结果，且不改入参（纯函数）", () => {
    const config = makeConfig();
    const result = checkAgentSwitch({ config, agents, targetAgentId: "coder" });

    // 不返回、也不改动配置：写 `defaultAgent` 是服务端那条窄方法的事
    expect(config.defaultAgent).toBe("default");
    expect(result).toEqual({ summary: expect.stringContaining("编程 Agent") });
    expect(result.summary).toContain("DeepSeek-V4.1-Flash");
  });

  it("不改 Agent 定义本身（切的是「用哪个」，不是「它长什么样」）", () => {
    const coder = agents[1]!;
    const before = JSON.parse(JSON.stringify(coder));
    checkAgentSwitch({ config: makeConfig(), agents, targetAgentId: "coder" });
    expect(coder).toEqual(before);
  });

  it("Agent 不存在时抛错", () => {
    expect(() =>
      checkAgentSwitch({ config: makeConfig(), agents, targetAgentId: "ghost" }),
    ).toThrow(/不存在/);
  });

  it("未绑定模型的 Agent 不给切（切过去就是启动错误屏）", () => {
    const broken = [...agents, makeAgent({ id: "bare", name: "裸 Agent", modelId: undefined })];
    expect(() =>
      checkAgentSwitch({ config: makeConfig(), agents: broken, targetAgentId: "bare" }),
    ).toThrow(/未绑定模型/);
  });

  it("定义没绑模型但配了全局兜底：可以切（用兜底那个模型）", () => {
    // 三级解析：定义没绑 → 落 `config.defaultModel`；预检要跟着它，否则界面说
    // 「不可用」而服务端其实能跑（用户就再也切不过去了）
    const bare = [...agents, makeAgent({ id: "bare", name: "裸 Agent", modelId: undefined })];
    const config = makeConfig({ defaultModel: "deepseek-flash" });

    expect(() => checkAgentSwitch({ config, agents: bare, targetAgentId: "bare" })).not.toThrow();

    // 兜底模型也不可用（这里换成缺 Key 的那个）时照样拦住
    expect(() =>
      checkAgentSwitch({
        config: makeConfig({ defaultModel: "glm-5.3" }),
        agents: bare,
        targetAgentId: "bare",
      }),
    ).toThrow(/API Key/);
  });

  it("绑定的模型已从配置里删掉时抛错", () => {
    const orphan = [...agents, makeAgent({ id: "orphan", name: "孤儿", modelId: "gone" })];
    expect(() =>
      checkAgentSwitch({ config: makeConfig(), agents: orphan, targetAgentId: "orphan" }),
    ).toThrow(/已不在配置中/);
  });

  it("端点缺 API Key 时抛错（不让人切完才发现发不出请求）", () => {
    const noKey = [...agents, makeAgent({ id: "nokey", name: "缺 Key", modelId: "glm-5.3" })];
    expect(() =>
      checkAgentSwitch({ config: makeConfig(), agents: noKey, targetAgentId: "nokey" }),
    ).toThrow(/API Key/);
  });

  it("只有空白的 Key 仍算未设置", () => {
    const blank = makeConfig({
      endpoints: [
        { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "   " },
      ],
    } as Partial<AppConfig>);
    expect(() => checkAgentSwitch({ config: blank, agents, targetAgentId: "coder" })).toThrow(
      /API Key/,
    );
  });
});

describe("listAgentChoices：选择器的行与可用性", () => {
  it("列出全部主 Agent，可用的带上模型名", () => {
    const choices = listAgentChoices(makeConfig(), agents);
    expect(choices.map((choice) => choice.id)).toEqual(["default", "coder"]);
    expect(choices[0]).toMatchObject({
      name: "默认 Agent",
      modelName: "DeepSeek-V4.1-Flash",
      selectable: true,
    });
    expect(choices[0]!.reason).toBeUndefined();
  });

  it("不可用的也列出来，并给出原因（而不是凭空少一行）", () => {
    const list = [
      makeAgent({ id: "bare", name: "裸 Agent", modelId: undefined }),
      makeAgent({ id: "orphan", name: "孤儿", modelId: "gone" }),
      makeAgent({ id: "nokey", name: "缺 Key", modelId: "glm-5.3" }),
    ];
    const choices = listAgentChoices(makeConfig(), list);
    expect(choices).toHaveLength(3);
    expect(choices[0]).toMatchObject({ selectable: false, reason: "未绑定模型" });
    expect(choices[1]).toMatchObject({ selectable: false, reason: "模型 gone 不存在" });
    expect(choices[2]).toMatchObject({ selectable: false });
    expect(choices[2]!.reason).toContain("API Key");
  });

  it("定义没绑模型时用全局兜底那个模型的凭据判断可用性", () => {
    const bare = [makeAgent({ id: "bare", name: "裸 Agent", modelId: undefined })];

    expect(listAgentChoices(makeConfig({ defaultModel: "deepseek-flash" }), bare)[0]).toMatchObject(
      {
        selectable: true,
        modelName: "DeepSeek-V4.1-Flash",
      },
    );
    expect(listAgentChoices(makeConfig({ defaultModel: "glm-5.3" }), bare)[0]).toMatchObject({
      selectable: false,
    });
  });

  it("name 缺失时回落 id", () => {
    const choices = listAgentChoices(makeConfig(), [makeAgent({ id: "mini", name: "" })]);
    expect(choices[0]!.name).toBe("mini");
  });
});
