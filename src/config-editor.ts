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

import type {
  AgentDefinition,
  AgentPermissions,
  AppConfig,
  Endpoint,
  ImageModel,
  Model,
  PermissionPolicy,
} from "@ai-zen/agents-sdk";
import type { AgentNS } from "@ai-zen/agents-core";
import { Message } from "@ai-zen/agents-core";
import type { McpConfig, McpServerEntry, McpServersMap } from "./config.js";

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

// ==================== MCP 配置改写 ====================

/**
 * 解析参数串为 argv：支持单 / 双引号包裹，以及反斜杠转义空白。
 * 例如 `-y chrome-devtools-mcp@latest` → `["-y", "chrome-devtools-mcp@latest"]`。
 */
export function parseArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
        cur += raw[i + 1];
        i += 1;
      } else cur += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length && /\s/.test(raw[i + 1]!)) {
      cur += raw[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** argv → 单行文本（含空白 / 引号 / 反斜杠的参数用双引号包裹并转义） */
export function formatArgs(args: string[] | undefined): string {
  if (!args || args.length === 0) return "";
  return args
    .map((arg) => (arg === "" || /[\s"'\\]/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg))
    .join(" ");
}

/** 解析 `KEY=VALUE`（以首个 `=` 分割；KEY 去空白，VALUE 原样保留）；不含 `=` 或 KEY 为空返回 null */
export function parseKvInput(raw: string): { key: string; value: string } | null {
  const at = raw.indexOf("=");
  if (at < 0) return null;
  const key = raw.slice(0, at).trim();
  if (!key) return null;
  return { key, value: raw.slice(at + 1) };
}

/** 键值映射 → 有序数组（保持插入顺序） */
export function kvEntries(map: Record<string, string> | undefined): { key: string; value: string }[] {
  return Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
}

/** 键值映射的展示摘要，如 `2 项（PATH, HOME）` / `（空）` */
export function kvSummary(map: Record<string, string> | undefined): string {
  const keys = Object.keys(map ?? {});
  if (keys.length === 0) return "（空）";
  return `${keys.length} 项（${keys.join(", ")}）`;
}

/** 按 id 查找 MCP 服务器 */
export function findMcpServer(mcp: McpConfig, id: string | undefined): McpServerEntry | undefined {
  if (!id) return undefined;
  return mcp.mcpServers[id];
}

/** id 是否已被占用（`except` 用于重命名时排除自身） */
export function mcpServerIdTaken(mcp: McpConfig, id: string, except?: string): boolean {
  return id !== except && Object.prototype.hasOwnProperty.call(mcp.mcpServers, id);
}

/** 由名称派生唯一的 MCP 服务器 id */
export function uniqueMcpServerId(mcp: McpConfig, name: string): string {
  return deriveUniqueId(new Set(Object.keys(mcp.mcpServers)), name, "server");
}

/** 新增 MCP 服务器（id 由名称派生；默认 stdio、启用） */
export function addMcpServer(mcp: McpConfig, name: string): { mcp: McpConfig; id: string } {
  const id = uniqueMcpServerId(mcp, name);
  const entry: McpServerEntry = { type: "stdio", disabled: false };
  return { mcp: { ...mcp, mcpServers: { ...mcp.mcpServers, [id]: entry } }, id };
}

/** 改写某 MCP 服务器的字段（不可变；未列出的字段原样保留） */
export function updateMcpServer(mcp: McpConfig, id: string, patch: Partial<McpServerEntry>): McpConfig {
  const current = mcp.mcpServers[id];
  if (!current) return mcp;
  return { ...mcp, mcpServers: { ...mcp.mcpServers, [id]: { ...current, ...patch } } };
}

/** 删除 MCP 服务器 */
export function removeMcpServer(mcp: McpConfig, id: string): McpConfig {
  if (!Object.prototype.hasOwnProperty.call(mcp.mcpServers, id)) return mcp;
  const mcpServers: McpServersMap = { ...mcp.mcpServers };
  delete mcpServers[id];
  return { ...mcp, mcpServers };
}

/** 重命名 MCP 服务器（改 key；保持原有顺序；假定新名已通过唯一性校验） */
export function renameMcpServer(mcp: McpConfig, oldId: string, newId: string): McpConfig {
  const mcpServers: McpServersMap = {};
  for (const [key, value] of Object.entries(mcp.mcpServers)) {
    mcpServers[key === oldId ? newId : key] = value;
  }
  return { ...mcp, mcpServers };
}

// ==================== Agent / Sub-agent 定义改写 ====================

/** Agent 四维权限的维度顺序 */
export const PERMISSION_DIMENSIONS = ["tools", "skills", "mcps", "subagents"] as const;
export type PermissionDimension = (typeof PERMISSION_DIMENSIONS)[number];

/** 由名称派生唯一的 Agent id（在既有 id 集合内避让） */
export function uniqueAgentId(taken: Iterable<string>, name: string, fallback = "agent"): string {
  return deriveUniqueId(new Set(taken), name, fallback);
}

/** 提示词 = 首条 system 消息的文本内容（无则空串） */
export function getAgentPrompt(def: AgentDefinition): string {
  const sys = (def.messages ?? []).find((m) => m.role === "system" && typeof m.content === "string");
  return typeof sys?.content === "string" ? sys.content : "";
}

/** 写入提示词：替换首条 system 消息；不存在则前插一条 */
export function setAgentPrompt(def: AgentDefinition, text: string): AgentDefinition {
  const messages = [...(def.messages ?? [])];
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) messages[index] = { ...messages[index], content: text };
  else messages.unshift(Message.System(text));
  return { ...def, messages };
}

/** 权限策略 → 紧凑文本（`allow: a, b` / `deny: *`）；未设置 → 空串 */
export function formatPermission(policy: PermissionPolicy | undefined): string {
  if (!policy) return "";
  if ("allow" in policy) return `allow: ${policy.allow.join(", ")}`;
  return `deny: ${policy.deny.join(", ")}`;
}

/**
 * 紧凑文本 → 权限策略：
 *   - 空串 → `null`（未设置）
 *   - 非法 → 返回错误文本（string）
 *   - 合法 → 返回 `PermissionPolicy`
 */
export function parsePermission(raw: string): PermissionPolicy | null | string {
  const text = raw.trim();
  if (!text) return null;
  const match = /^(allow|deny)\s*:\s*(.*)$/i.exec(text);
  if (!match) return "格式应为「allow: a, b」或「deny: x」";
  const mode = match[1]!.toLowerCase();
  const list = match[2]!
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (list.length === 0) return "至少需要一个模式（如 `*`）";
  return mode === "allow" ? { allow: list } : { deny: list };
}

/** 读某维权限的紧凑文本 */
export function formatAgentPermission(
  permissions: AgentPermissions | undefined,
  dim: PermissionDimension,
): string {
  return formatPermission(permissions?.[dim]);
}

/** 权限总览：列出已配置的维度（如 `4 维（tools, skills, mcps, subagents）`） */
export function summarizePermissions(permissions: AgentPermissions | undefined): string {
  const set = PERMISSION_DIMENSIONS.filter((dim) => permissions?.[dim]);
  if (set.length === 0) return "（未设置）";
  return `${set.length} 维（${set.join(", ")}）`;
}

/** 写入某一维权限（`policy` 为 null 时删除该维） */
export function setAgentPermission(
  def: AgentDefinition,
  dim: PermissionDimension,
  policy: PermissionPolicy | null,
): AgentDefinition {
  const permissions: AgentPermissions = { ...(def.permissions ?? {}) };
  if (policy) permissions[dim] = policy;
  else delete permissions[dim];
  return { ...def, permissions };
}

/** 通用 Agent 字段改写（纯合并；`updatedAt` 由写盘侧统一刷新） */
export function updateAgentDefinition(def: AgentDefinition, patch: Partial<AgentDefinition>): AgentDefinition {
  return { ...def, ...patch };
}

/** 函数参数 schema → 紧凑 JSON 文本 */
export function formatFunctionParameters(fn: AgentNS.FunctionDefine | undefined): string {
  return fn?.parameters ? JSON.stringify(fn.parameters) : "{}";
}

/** 解析函数参数 JSON；合法返回对象，非法返回错误文本 */
export function parseFunctionParameters(raw: string): Record<string, unknown> | string {
  const text = raw.trim();
  if (!text) return "参数 schema 不能为空（至少为 {}）";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause: any) {
    return `JSON 解析失败：${cause?.message ?? cause}`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "参数需为 JSON 对象";
  return parsed as Record<string, unknown>;
}

/** 改写 Sub-agent 的 `function`（缺省时补一个骨架） */
export function updateAgentFunction(
  def: AgentDefinition,
  patch: { name?: string; description?: string; parameters?: Record<string, unknown> },
): AgentDefinition {
  const fn: AgentNS.FunctionDefine =
    def.function ?? { name: `sub_agent_${def.id.replace(/-/g, "_")}`, description: "", parameters: {} };
  return { ...def, function: { ...fn, ...patch } };
}

/** 新建顶层 Agent 定义 */
export function createAgentDefinition(input: {
  id: string;
  name: string;
  prompt?: string;
  now?: string;
}): AgentDefinition {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    description: "",
    messages: [Message.System(input.prompt ?? "")],
    permissions: {
      tools: { allow: ["*"] },
      skills: { allow: ["*"] },
      mcps: { allow: ["*"] },
      subagents: { allow: ["*"] },
    },
    custom: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** 新建 Sub-agent 定义（带 function 骨架，尾部保留 `{{task}}` 用户消息） */
export function createSubAgentDefinition(input: {
  id: string;
  name: string;
  prompt?: string;
  now?: string;
}): AgentDefinition {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    description: "",
    messages: [Message.System(input.prompt ?? ""), Message.User("{{task}}")],
    permissions: {
      tools: { allow: ["*"] },
      skills: { allow: ["*"] },
      mcps: { allow: ["*"] },
      subagents: { deny: ["*"] },
    },
    function: {
      name: `sub_agent_${input.id.replace(/-/g, "_")}`,
      description: input.name,
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "完整的任务描述" } },
        required: ["task"],
        additionalProperties: false,
      },
    },
    custom: true,
    createdAt: now,
    updatedAt: now,
  };
}
