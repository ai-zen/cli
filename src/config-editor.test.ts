import { describe, it, expect } from "vitest";
import type { AppConfig } from "@ai-zen/agents-sdk";
import type { McpConfig } from "./config.js";
import {
  addEndpoint,
  addImageModel,
  addMcpServer,
  addModel,
  apiKeyGuide,
  createAgentDefinition,
  createSubAgentDefinition,
  findEndpoint,
  findMcpServer,
  findModel,
  formatArgs,
  formatFunctionParameters,
  formatPermission,
  getAgentPrompt,
  isApiKeySet,
  kvEntries,
  kvSummary,
  maskApiKey,
  mcpServerIdTaken,
  modelsUsingEndpoint,
  parseArgs,
  parseKvInput,
  parseFunctionParameters,
  parsePermission,
  removeEndpoint,
  removeImageModel,
  removeMcpServer,
  removeModel,
  renameMcpServer,
  resolveCredential,
  setAgentPermission,
  setAgentPrompt,
  setDefaultAgent,
  setDefaultImageModel,
  setDefaultMigrationModel,
  setDefaultModel,
  setEndpointApiKey,
  setEndpointBaseUrl,
  setMaxToolOutput,
  summarizeEndpoints,
  summarizePermissions,
  uniqueAgentId,
  uniqueEndpointId,
  uniqueImageModelId,
  uniqueMcpServerId,
  uniqueModelId,
  updateEndpoint,
  updateAgentDefinition,
  updateAgentFunction,
  updateImageModel,
  updateMcpServer,
  updateModel,
} from "./config-editor.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoints: [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "" },
      { id: "bigmodelcn", name: "BigModelCN (智谱AI)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: " ea8c98b6-key " },
    ],
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", endpointId: "deepseek", maxContextTokens: 250_000 },
      { id: "glm-5.1", name: "GLM-5.1", endpointId: "bigmodelcn", maxContextTokens: 250_000 },
    ],
    defaultModel: "deepseek-v4-flash",
    ...overrides,
  };
}

describe("config-editor / 查询", () => {
  it("findModel / findEndpoint 命中与未命中", () => {
    const config = makeConfig();
    expect(findModel(config, "glm-5.1")?.name).toBe("GLM-5.1");
    expect(findModel(config, "nope")).toBeUndefined();
    expect(findModel(config, undefined)).toBeUndefined();
    expect(findEndpoint(config, "deepseek")?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(findEndpoint(config, "nope")).toBeUndefined();
  });

  it("isApiKeySet 把空白视为未设置", () => {
    expect(isApiKeySet("sk-1")).toBe(true);
    expect(isApiKeySet("   ")).toBe(false);
    expect(isApiKeySet("")).toBe(false);
    expect(isApiKeySet(undefined)).toBe(false);
  });

  it("modelsUsingEndpoint 列出引用该端点的模型", () => {
    const config = makeConfig();
    expect(modelsUsingEndpoint(config, "bigmodelcn").map((m) => m.id)).toEqual(["glm-5.1"]);
    expect(modelsUsingEndpoint(config, "nope")).toEqual([]);
  });

  it("resolveCredential 汇总模型 → 端点凭据", () => {
    const config = makeConfig();
    expect(resolveCredential(config, "glm-5.1")).toEqual({
      modelId: "glm-5.1",
      modelName: "GLM-5.1",
      endpointId: "bigmodelcn",
      endpointName: "BigModelCN (智谱AI)",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: " ea8c98b6-key ",
      configured: true,
    });
    expect(resolveCredential(config, "deepseek-v4-flash")?.configured).toBe(false);
  });

  it("resolveCredential 在模型 / 端点缺失时返回 undefined", () => {
    const config = makeConfig({ endpoints: [] });
    expect(resolveCredential(config, "glm-5.1")).toBeUndefined();
    expect(resolveCredential(config, "nope")).toBeUndefined();
  });

  it("summarizeEndpoints 用 ✓ / ✗ 标注密钥状态", () => {
    expect(summarizeEndpoints(makeConfig())).toBe("DeepSeek ✗ · BigModelCN (智谱AI) ✓");
    expect(summarizeEndpoints(makeConfig({ endpoints: [] }))).toBe("无端点");
  });
});

describe("config-editor / 密钥掩码与厂商指引", () => {
  it("maskApiKey 保留首尾、隐藏中间", () => {
    expect(maskApiKey("")).toBe("未设置");
    expect(maskApiKey(undefined)).toBe("未设置");
    expect(maskApiKey("   ")).toBe("未设置");
    // 短密钥整体打码（len ≤ 8）
    expect(maskApiKey("sk-1234")).toBe("*".repeat(7));
    expect(maskApiKey("sk-54138a00b00c411d922007e0d9a429ce")).toBe("sk-5…29ce");
  });

  it("apiKeyGuide 按 baseUrl 识别厂商", () => {
    expect(apiKeyGuide("https://open.bigmodel.cn/api/paas/v4").vendor).toBe("智谱 AI（BigModelCN）");
    expect(apiKeyGuide("https://api.deepseek.com/v1").url).toBe("https://platform.deepseek.com/api_keys");
    expect(apiKeyGuide("https://api.openai.com/v1").url).toBe("https://platform.openai.com/api-keys");
    expect(apiKeyGuide("https://my-gateway.example.com/v1")).toEqual({ vendor: "OpenAI 兼容端点" });
    expect(apiKeyGuide(undefined).vendor).toBe("OpenAI 兼容端点");
  });
});

describe("config-editor / 不可变改写", () => {
  it("setEndpointApiKey 只改目标端点，且不改动原对象", () => {
    const before = makeConfig();
    const after = setEndpointApiKey(before, "deepseek", "  sk-new-key  ");
    expect(after.endpoints[0].apiKey).toBe("sk-new-key");
    expect(after.endpoints[1]).toBe(before.endpoints[1]);
    expect(before.endpoints[0].apiKey).toBe("");
    expect(after).not.toBe(before);
  });

  it("setEndpointBaseUrl 只改目标端点", () => {
    const after = setEndpointBaseUrl(makeConfig(), "deepseek", " https://proxy.local/v1 ");
    expect(after.endpoints[0].baseUrl).toBe("https://proxy.local/v1");
    expect(after.endpoints[1].baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
  });

  it("setDefaultModel 写入 defaultModel", () => {
    expect(setDefaultModel(makeConfig(), "glm-5.1").defaultModel).toBe("glm-5.1");
  });

  it("uniqueEndpointId 派生合法 id 并避让冲突", () => {
    const config = makeConfig();
    expect(uniqueEndpointId(config, "My Gateway")).toBe("my-gateway");
    expect(uniqueEndpointId(config, "DeepSeek")).toBe("deepseek-2");
    expect(uniqueEndpointId(config, "!!!")).toBe("endpoint");
  });

  it("addEndpoint 追加端点并返回新端点", () => {
    const { config, endpoint } = addEndpoint(makeConfig(), {
      name: "My Gateway",
      baseUrl: " https://gw.local/v1 ",
      apiKey: " sk-x ",
    });
    expect(endpoint).toEqual({
      id: "my-gateway",
      name: "My Gateway",
      baseUrl: "https://gw.local/v1",
      apiKey: "sk-x",
    });
    expect(config.endpoints).toHaveLength(3);
    expect(config.endpoints[2]).toEqual(endpoint);
  });
});

describe("config-editor / 通用改写（配置中心）", () => {
  it("updateEndpoint / removeEndpoint", () => {
    const before = makeConfig();
    expect(updateEndpoint(before, "deepseek", { name: "DS", description: "x" }).endpoints[0]).toMatchObject({
      name: "DS",
      description: "x",
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(removeEndpoint(before, "deepseek").endpoints.map((e) => e.id)).toEqual(["bigmodelcn"]);
    expect(before.endpoints).toHaveLength(2);
  });

  it("updateModel 只改目标模型", () => {
    const after = updateModel(makeConfig(), "glm-5.1", { maxContextTokens: 100_000, custom: true });
    expect(after.models[1]).toMatchObject({ maxContextTokens: 100_000, custom: true });
    expect(after.models[0].maxContextTokens).toBe(250_000);
  });

  it("removeModel 修正悬空的默认引用", () => {
    const after = removeModel(makeConfig(), "deepseek-v4-flash");
    expect(after.models.map((m) => m.id)).toEqual(["glm-5.1"]);
    expect(after.defaultModel).toBe("glm-5.1");
  });

  it("addModel 派生 id 并标记 custom", () => {
    const { config, model } = addModel(makeConfig(), { name: "My GPT", endpointId: "deepseek" });
    expect(model).toMatchObject({ id: "my-gpt", name: "My GPT", endpointId: "deepseek", custom: true });
    expect(model.maxContextTokens).toBeGreaterThan(0);
    expect(config.models).toHaveLength(3);
  });

  it("uniqueModelId / uniqueImageModelId 派生合法 id", () => {
    expect(uniqueModelId(makeConfig(), "GLM-5.1")).toBe("glm-5-1");
    expect(uniqueImageModelId(makeConfig(), "CogView")).toBe("cogview");
  });

  it("addImageModel / removeImageModel 维护 defaultImageModel", () => {
    const base = makeConfig({
      imageModels: [{ id: "cogview-4", name: "CogView-4", endpointId: "bigmodelcn", modelName: "cogview-4" }],
      defaultImageModel: "cogview-4",
    });
    const added = addImageModel(base, { name: "My Image", endpointId: "bigmodelcn" });
    expect(added.model).toMatchObject({ id: "my-image", custom: true });
    const removed = removeImageModel(base, "cogview-4");
    expect(removed.imageModels).toEqual([]);
    expect(removed.defaultImageModel).toBeUndefined();
  });

  it("setDefault* / setMaxToolOutput 写入对应字段", () => {
    const config = makeConfig();
    expect(setDefaultAgent(config, "coder").defaultAgent).toBe("coder");
    expect(setDefaultImageModel(config, undefined).defaultImageModel).toBeUndefined();
    expect(setDefaultMigrationModel(config, "glm-5.1").defaultMigrationModel).toBe("glm-5.1");
    expect(setMaxToolOutput(config, 4096).maxToolOutput).toBe(4096);
  });
});

// ==================== MCP 配置改写 ====================

function makeMcp(): McpConfig {
  return {
    mcpServers: {
      "socket-pty": { type: "stdio", command: "npx", args: ["-y", "@ai-zen/socket-pty", "mcp"] },
      slack: { type: "http", url: "https://slack.example.com", headers: { Authorization: "Bearer x" } },
    },
  };
}

describe("parseArgs / formatArgs", () => {
  it("按空白切分，支持引号包裹与转义空格", () => {
    expect(parseArgs("-y chrome-devtools-mcp@latest")).toEqual(["-y", "chrome-devtools-mcp@latest"]);
    expect(parseArgs('"a b" c')).toEqual(["a b", "c"]);
    expect(parseArgs("a\\ b c")).toEqual(["a b", "c"]);
    expect(parseArgs("")).toEqual([]);
    expect(parseArgs("   ")).toEqual([]);
  });

  it("formatArgs 与 parseArgs 互逆（含空白的参数加引号）", () => {
    const args = ["-y", "a b", 'q"x'];
    expect(parseArgs(formatArgs(args))).toEqual(args);
    expect(formatArgs([])).toBe("");
    expect(formatArgs(undefined)).toBe("");
  });
});

describe("parseKvInput / kvSummary", () => {
  it("以首个 = 分割，KEY 去空白", () => {
    expect(parseKvInput("PATH=/usr/bin")).toEqual({ key: "PATH", value: "/usr/bin" });
    expect(parseKvInput("A=b=c")).toEqual({ key: "A", value: "b=c" });
    expect(parseKvInput("noequals")).toBeNull();
    expect(parseKvInput("=v")).toBeNull();
  });

  it("kvSummary 展示项数与键名", () => {
    expect(kvSummary(undefined)).toBe("（空）");
    expect(kvSummary({ PATH: "/x", HOME: "/y" })).toBe("2 项（PATH, HOME）");
  });
});

describe("MCP 服务器增删改", () => {
  it("addMcpServer 由名称派生唯一 id，默认 stdio 且启用", () => {
    const { mcp, id } = addMcpServer(makeMcp(), "My Server");
    expect(id).toBe("my-server");
    expect(mcp.mcpServers["my-server"]).toEqual({ type: "stdio", disabled: false });
    expect(uniqueMcpServerId(makeMcp(), "Slack")).toBe("slack-2");
  });

  it("updateMcpServer 不可变改写且保留未列出的字段", () => {
    const base = makeMcp();
    const next = updateMcpServer(base, "slack", { disabled: true });
    expect(base.mcpServers.slack!.disabled).toBeUndefined();
    expect(next.mcpServers.slack).toEqual({ ...base.mcpServers.slack, disabled: true });
  });

  it("removeMcpServer 删除指定项且不改动其它项", () => {
    const next = removeMcpServer(makeMcp(), "slack");
    expect(Object.keys(next.mcpServers)).toEqual(["socket-pty"]);
  });

  it("renameMcpServer 改 key 且保持顺序", () => {
    const next = renameMcpServer(makeMcp(), "slack", "slack-http");
    expect(Object.keys(next.mcpServers)).toEqual(["socket-pty", "slack-http"]);
    expect(findMcpServer(next, "slack-http")!.url).toBe("https://slack.example.com");
  });

  it("mcpServerIdTaken 支持排除自身", () => {
    const mcp = makeMcp();
    expect(mcpServerIdTaken(mcp, "slack")).toBe(true);
    expect(mcpServerIdTaken(mcp, "slack", "slack")).toBe(false);
    expect(mcpServerIdTaken(mcp, "new")).toBe(false);
  });

  it("kvEntries 保持插入顺序", () => {
    expect(kvEntries({ B: "2", A: "1" })).toEqual([
      { key: "B", value: "2" },
      { key: "A", value: "1" },
    ]);
  });
});

// ==================== Agent / Sub-agent 定义改写 ====================

describe("Agent 定义改写", () => {
  it("createAgentDefinition / createSubAgentDefinition 结构", () => {
    const agent = createAgentDefinition({ id: "coder", name: "Coder" });
    expect(agent.id).toBe("coder");
    expect(agent.custom).toBe(true);
    expect(agent.messages[0]!.role).toBe("system");
    expect(agent.permissions!.tools).toEqual({ allow: ["*"] });

    const sub = createSubAgentDefinition({ id: "helper", name: "Helper" });
    expect(sub.function?.name).toBe("sub_agent_helper");
    expect(sub.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(sub.permissions!.subagents).toEqual({ deny: ["*"] });
  });

  it("getAgentPrompt / setAgentPrompt 不可变往返", () => {
    const agent = createAgentDefinition({ id: "x", name: "X", prompt: "你好" });
    expect(getAgentPrompt(agent)).toBe("你好");
    const next = setAgentPrompt(agent, "改了");
    expect(getAgentPrompt(next)).toBe("改了");
    expect(agent.messages[0]!.content).toBe("你好"); // 原对象不被修改
  });

  it("parsePermission / formatPermission 往返与校验", () => {
    expect(parsePermission("")).toBeNull();
    expect(parsePermission("allow: a, b")).toEqual({ allow: ["a", "b"] });
    expect(parsePermission("deny:*")).toEqual({ deny: ["*"] });
    expect(typeof parsePermission("nope")).toBe("string");
    expect(formatPermission({ allow: ["a", "b"] })).toBe("allow: a, b");
    expect(formatPermission(undefined)).toBe("");
  });

  it("setAgentPermission 可写可删", () => {
    const agent = createAgentDefinition({ id: "x", name: "X" });
    const denied = setAgentPermission(agent, "tools", { deny: ["exec"] });
    expect(denied.permissions!.tools).toEqual({ deny: ["exec"] });
    const cleared = setAgentPermission(denied, "tools", null);
    expect(cleared.permissions!.tools).toBeUndefined();
    expect(denied.permissions!.tools).toEqual({ deny: ["exec"] }); // 不可变
  });

  it("summarizePermissions 概览", () => {
    expect(summarizePermissions(undefined)).toBe("（未设置）");
    expect(summarizePermissions({ tools: { allow: ["*"] } })).toBe("1 维（tools）");
  });

  it("parseFunctionParameters 校验", () => {
    expect(parseFunctionParameters('{"type":"object"}')).toEqual({ type: "object" });
    expect(typeof parseFunctionParameters("{ bad")).toBe("string");
    expect(typeof parseFunctionParameters("[1]")).toBe("string");
  });

  it("updateAgentFunction 补骨架并合并字段", () => {
    const sub = createSubAgentDefinition({ id: "helper", name: "Helper" });
    const next = updateAgentFunction(sub, { description: "新的" });
    expect(next.function?.description).toBe("新的");
    expect(next.function?.name).toBe("sub_agent_helper");
  });

  it("formatFunctionParameters 紧凑 JSON", () => {
    expect(formatFunctionParameters({ name: "f", description: "", parameters: { type: "object" } })).toBe(
      '{"type":"object"}',
    );
    expect(formatFunctionParameters(undefined)).toBe("{}");
  });

  it("uniqueAgentId 避让", () => {
    expect(uniqueAgentId([], "Coder")).toBe("coder");
    expect(uniqueAgentId(["coder"], "Coder")).toBe("coder-2");
    expect(uniqueAgentId([], "My Agent")).toBe("my-agent");
  });
});
