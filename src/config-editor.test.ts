import { describe, it, expect } from "vitest";
import type { AppConfig } from "@ai-zen/agents-sdk";
import {
  addEndpoint,
  apiKeyGuide,
  findEndpoint,
  findModel,
  isApiKeySet,
  maskApiKey,
  modelsUsingEndpoint,
  resolveCredential,
  setDefaultModel,
  setEndpointApiKey,
  setEndpointBaseUrl,
  summarizeEndpoints,
  uniqueEndpointId,
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
