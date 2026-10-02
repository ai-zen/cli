/**
 * 配置编辑 —— 纯函数层
 *
 * TUI 的「凭据设置屏」与「配置中心」只做渲染与键盘分发，所有对 `AppConfig` 的
 * 读取与不可变改写集中在本模块，以便脱离 Ink 单测。
 *
 * 设计原则：
 *   - 每个改写函数都返回**新对象**，调用方负责持久化（`saveConfig()`）；
 *   - 不抛异常、不写盘、不读盘，纯输入 → 输出。
 */

import type { AppConfig, Endpoint, ImageModel, Model } from "@ai-zen/agents-sdk";

// ==================== 查询 ====================

/** 按 id 查找模型 */
export function findModel(config: AppConfig, modelId: string | undefined): Model | undefined {
  if (!modelId) return undefined;
  return config.models.find((model) => model.id === modelId);
}

/** 按 id 查找端点 */
export function findEndpoint(config: AppConfig, endpointId: string | undefined): Endpoint | undefined {
  if (!endpointId) return undefined;
  return config.endpoints.find((endpoint) => endpoint.id === endpointId);
}

/** 引用某端点的模型清单（用于提示改动波及范围） */
export function modelsUsingEndpoint(config: AppConfig, endpointId: string): Model[] {
  return config.models.filter((model) => model.endpointId === endpointId);
}

/** API Key 是否已设置（空白视为未设置） */
export function isApiKeySet(apiKey: string | undefined): boolean {
  return Boolean(apiKey && apiKey.trim());
}

/** 一次「凭据检查」的结果：某模型绑定的端点及其密钥状态 */
export interface CredentialInfo {
  modelId: string;
  modelName: string;
  endpointId: string;
  endpointName: string;
  baseUrl: string;
  apiKey: string;
  /** 密钥是否已设置 */
  configured: boolean;
}

/**
 * 解析某模型对应的端点凭据。
 *
 * 模型缺失或端点缺失时返回 `undefined`（此时无法给出「输入 Key」的引导，
 * 属于配置本身残缺，交由调用方报错）。
 */
export function resolveCredential(config: AppConfig, modelId: string | undefined): CredentialInfo | undefined {
  const model = findModel(config, modelId);
  if (!model) return undefined;
  const endpoint = findEndpoint(config, model.endpointId);
  if (!endpoint) return undefined;
  return {
    modelId: model.id,
    modelName: model.name || model.id,
    endpointId: endpoint.id,
    endpointName: endpoint.name || endpoint.id,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey ?? "",
    configured: isApiKeySet(endpoint.apiKey),
  };
}

/** 端点清单的一行摘要，如 `OpenAI ✗ · DeepSeek ✓` */
export function summarizeEndpoints(config: AppConfig): string {
  if (config.endpoints.length === 0) return "无端点";
  return config.endpoints
    .map((endpoint) => `${endpoint.name || endpoint.id} ${isApiKeySet(endpoint.apiKey) ? "✓" : "✗"}`)
    .join(" · ");
}

/**
 * 密钥掩码：保留首 4 / 末 4 位，中间省略。未设置时返回 `未设置`。
 * 已知密钥（如 `sk-` 开头）同样按此规则裁剪，避免整串回显到屏幕。
 */
export function maskApiKey(apiKey: string | undefined): string {
  const key = (apiKey ?? "").trim();
  if (!key) return "未设置";
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** 凭据申请指引：按 baseUrl 识别厂商 */
export interface ApiKeyGuide {
  vendor: string;
  /** 申请页面（未识别厂商时为 undefined，只给通用提示） */
  url?: string;
}

const VENDOR_GUIDES: ReadonlyArray<{ match: string; vendor: string; url: string }> = [
  { match: "bigmodel.cn", vendor: "智谱 AI（BigModelCN）", url: "https://open.bigmodel.cn/usercenter/apikeys" },
  { match: "deepseek.com", vendor: "DeepSeek", url: "https://platform.deepseek.com/api_keys" },
  { match: "openai.com", vendor: "OpenAI", url: "https://platform.openai.com/api-keys" },
  { match: "moonshot", vendor: "Moonshot（Kimi）", url: "https://platform.moonshot.cn/console/api-keys" },
  { match: "dashscope", vendor: "阿里云百炼（DashScope）", url: "https://bailian.console.aliyun.com/" },
];

export function apiKeyGuide(baseUrl: string | undefined): ApiKeyGuide {
  const url = (baseUrl ?? "").toLowerCase();
  for (const guide of VENDOR_GUIDES) {
    if (url.includes(guide.match)) return { vendor: guide.vendor, url: guide.url };
  }
  return { vendor: "OpenAI 兼容端点" };
}

// ==================== 不可变改写 ====================

/** 写入某端点的 API Key（去除首尾空白） */
export function setEndpointApiKey(config: AppConfig, endpointId: string, apiKey: string): AppConfig {
  return {
    ...config,
    endpoints: config.endpoints.map((endpoint) =>
      endpoint.id === endpointId ? { ...endpoint, apiKey: apiKey.trim() } : endpoint,
    ),
  };
}

/** 写入某端点的 Base URL（去除首尾空白） */
export function setEndpointBaseUrl(config: AppConfig, endpointId: string, baseUrl: string): AppConfig {
  return {
    ...config,
    endpoints: config.endpoints.map((endpoint) =>
      endpoint.id === endpointId ? { ...endpoint, baseUrl: baseUrl.trim() } : endpoint,
    ),
  };
}

/** 设置默认模型（传 `undefined` 表示清空，交由 SDK 回退出厂默认） */
export function setDefaultModel(config: AppConfig, modelId: string | undefined): AppConfig {
  return { ...config, defaultModel: modelId };
}

/** 由名称派生唯一 id：小写、非字母数字折叠为 `-`，冲突时追加序号 */
function deriveUniqueId(taken: Set<string>, name: string, fallback: string): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || fallback;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 由端点名派生唯一的端点 id */
export function uniqueEndpointId(config: AppConfig, name: string): string {
  return deriveUniqueId(new Set(config.endpoints.map((endpoint) => endpoint.id)), name, "endpoint");
}

/** 由模型名派生唯一的模型 id */
export function uniqueModelId(config: AppConfig, name: string): string {
  return deriveUniqueId(new Set(config.models.map((model) => model.id)), name, "model");
}

/** 由图片模型名派生唯一的图片模型 id */
export function uniqueImageModelId(config: AppConfig, name: string): string {
  return deriveUniqueId(new Set((config.imageModels ?? []).map((model) => model.id)), name, "image");
}

/** 新增端点（id 由名称派生） */
export function addEndpoint(
  config: AppConfig,
  input: { name: string; baseUrl: string; apiKey: string },
): { config: AppConfig; endpoint: Endpoint } {
  const id = uniqueEndpointId(config, input.name);
  const endpoint: Endpoint = {
    id,
    name: input.name.trim() || id,
    baseUrl: input.baseUrl.trim(),
    apiKey: input.apiKey.trim(),
  };
  return { config: { ...config, endpoints: [...config.endpoints, endpoint] }, endpoint };
}

// ==================== 通用改写（配置中心）====================

/** 通用端点字段改写（不可变） */
export function updateEndpoint(config: AppConfig, endpointId: string, patch: Partial<Endpoint>): AppConfig {
  return {
    ...config,
    endpoints: config.endpoints.map((endpoint) =>
      endpoint.id === endpointId ? { ...endpoint, ...patch } : endpoint,
    ),
  };
}

/** 删除端点（调用方负责确认它不再被任何模型引用） */
export function removeEndpoint(config: AppConfig, endpointId: string): AppConfig {
  return { ...config, endpoints: config.endpoints.filter((endpoint) => endpoint.id !== endpointId) };
}

/** 通用模型字段改写（不可变） */
export function updateModel(config: AppConfig, modelId: string, patch: Partial<Model>): AppConfig {
  return {
    ...config,
    models: config.models.map((model) => (model.id === modelId ? { ...model, ...patch } : model)),
  };
}

/**
 * 删除模型；若 `defaultModel` / `defaultMigrationModel` 指向它，
 * 则改指剩余的第一个模型（无剩余模型则清空）。
 */
export function removeModel(config: AppConfig, modelId: string): AppConfig {
  const models = config.models.filter((model) => model.id !== modelId);
  const ids = new Set(models.map((model) => model.id));
  const fallback = models[0]?.id;
  return {
    ...config,
    models,
    defaultModel: config.defaultModel && ids.has(config.defaultModel) ? config.defaultModel : fallback,
    defaultMigrationModel:
      config.defaultMigrationModel && ids.has(config.defaultMigrationModel)
        ? config.defaultMigrationModel
        : fallback,
  };
}

/** 新增模型（id 由名称派生；默认 `custom: true`，避免被 SDK 出厂清单托管覆盖） */
export function addModel(
  config: AppConfig,
  input: { name: string; endpointId: string; modelName?: string },
): { config: AppConfig; model: Model } {
  const id = uniqueModelId(config, input.name);
  const model: Model = {
    id,
    name: input.name.trim() || id,
    endpointId: input.endpointId,
    modelName: input.modelName?.trim() || id,
    maxContextTokens: 128_000,
    custom: true,
  };
  return { config: { ...config, models: [...config.models, model] }, model };
}

/** 通用图片模型字段改写（不可变） */
export function updateImageModel(config: AppConfig, modelId: string, patch: Partial<ImageModel>): AppConfig {
  return {
    ...config,
    imageModels: (config.imageModels ?? []).map((model) =>
      model.id === modelId ? { ...model, ...patch } : model,
    ),
  };
}

/** 删除图片模型；若 `defaultImageModel` 指向它，则改指剩余的第一个（无剩余则清空） */
export function removeImageModel(config: AppConfig, modelId: string): AppConfig {
  const imageModels = (config.imageModels ?? []).filter((model) => model.id !== modelId);
  const ids = new Set(imageModels.map((model) => model.id));
  return {
    ...config,
    imageModels,
    defaultImageModel:
      config.defaultImageModel && ids.has(config.defaultImageModel)
        ? config.defaultImageModel
        : imageModels[0]?.id,
  };
}

/** 新增图片模型（id 由名称派生；默认 `custom: true`） */
export function addImageModel(
  config: AppConfig,
  input: { name: string; endpointId: string },
): { config: AppConfig; model: ImageModel } {
  const id = uniqueImageModelId(config, input.name);
  const model: ImageModel = {
    id,
    name: input.name.trim() || id,
    endpointId: input.endpointId,
    modelName: id,
    custom: true,
  };
  return { config: { ...config, imageModels: [...(config.imageModels ?? []), model] }, model };
}

/** 设置默认图片模型（传 `undefined` 表示清空） */
export function setDefaultImageModel(config: AppConfig, modelId: string | undefined): AppConfig {
  return { ...config, defaultImageModel: modelId };
}

/** 设置默认 Agent（传 `undefined` 表示清空，交给 SDK 选第一个 Agent） */
export function setDefaultAgent(config: AppConfig, agentId: string | undefined): AppConfig {
  return { ...config, defaultAgent: agentId };
}

/** 设置默认迁移模型（传 `undefined` 表示清空，交由 SDK 回退出厂默认） */
export function setDefaultMigrationModel(config: AppConfig, modelId: string | undefined): AppConfig {
  return { ...config, defaultMigrationModel: modelId };
}

/** 设置工具输出上限（字符数） */
export function setMaxToolOutput(config: AppConfig, value: number): AppConfig {
  return { ...config, maxToolOutput: value };
}
