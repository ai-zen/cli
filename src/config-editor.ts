/**
 * 配置中心 / 凭据屏要的**纯函数**：挑字段、派生 id、把用户的输入文本变成契约里的值。
 *
 * ## 这里不写配置
 *
 * 写入全部走 procedure，而且**一次改动一次调用**：默认项走 `config.defaults.update`，上限与中断策略
 * 走 `config.update`，端点 / 模型 / 图片模型各走 `config.endpoints.*` / `config.models.*` /
 * `config.imageModels.*`，AgentDefinition 走 `agentDefinition.*`，MCP 走 `mcp.save` / `mcp.remove`。而且每个
 * 写口都回**整份** `AppConfig`，所以这一层连「改完拼一份新的」都不需要：宿主已经是那个落点。
 *
 * 于是剩下来的都是**不碰真相**的事：
 *   - 在宿主给的形状上挑字段（`AppConfig` / `AgentDefinition` 里找一条）；
 *   - 由名称派生 id（`config.models.create` / `config.endpoints.create` 的 id 由客户端定，宿主只负责落盘）；
 *   - 把用户敲进去的文本解析成契约里的值（argv、`KEY=VALUE`、权限策略、函数参数 schema）；
 *   - 把「改了这一处」拼成一次 procedure 的入参（如提示词 → `agentDefinition.update` 的 `messages`）。
 *
 * 一条底线：**不在这里推导业务判断**。MCP 层谁盖住谁、现在第几档思考 —— 宿主已经算好放在形状里
 * （或由档位表现查，见 `reasoning-effort.ts`），这里只显示。
 */

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig, EndpointDefinition, ModelDefinition } from "./config.js";
import { t } from "./i18n/index.js";

/**
 * 工具输出上限的**缺省值**（SDK `AppConfig.maxToolOutput` 的缺省：32768 字符）。
 *
 * 配置里没写这一格时，屏上要有个能读能改的起点；「没写」不等于 0，而这一格只有客户端看得见
 * （宿主读它的时候自己也有同样的缺省）。想改成别的数就在这里改一处。
 */
export const DEFAULT_MAX_TOOL_OUTPUT = 32768;

// ==================== 查询（在宿主给的形状上挑）====================

/** 按 id 查找模型（只要给得出模型表就够 —— 档位派生那一层手上没有整份配置） */
export function findModel(
  config: Pick<AppConfig, "models">,
  modelId: string | undefined,
): ModelDefinition | undefined {
  if (!modelId) return undefined;
  return config.models.find((model) => model.id === modelId);
}

/** 按 id 查找端点 */
export function findEndpoint(
  config: AppConfig,
  endpointId: string | undefined,
): EndpointDefinition | undefined {
  if (!endpointId) return undefined;
  return config.endpoints.find((endpoint) => endpoint.id === endpointId);
}

/** 引用某端点的模型清单（用于提示改动波及范围） */
export function modelsUsingEndpoint(config: AppConfig, endpointId: string): ModelDefinition[] {
  return config.models.filter((model) => model.endpointId === endpointId);
}

/**
 * 一串密钥的**掩码**：只留头三尾四，中间一个省略号（`sk-…9f3a`）。
 *
 * `config.get` 回的是**明文** `apiKey`（宿主不再掩码），于是「显示时掩码」这件事落在客户端：
 * 明文可以显示在屏上，但它不该整串留在一个人正对着的终端里，也不该出现在任何一条日志里。
 * 少了中间那几个字符，用户仍然认得出「是不是我上个月那把」；要核对就整串重填一次。
 *
 * 太短的串（≤ 8 位）连头尾都不留 —— 3 + 4 就等于把它印出来了。
 */
export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "…";
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

/**
 * 一次「凭据检查」的结果：某模型绑定的端点及其密钥状态。
 *
 * 密钥在配置里是**明文**（宿主这一版不再掩码）：`configured` = 「这一格非空」，
 * `apiKeyMasked` 是 {@link maskSecret} 现算的显示值。掩码只用于显示 —— 回写掩码会把掩码
 * 当成密钥存下来，所以「换密钥」只能在用户真的改了输入框时发出（`update` 省略 `apiKey`
 * = 保留原值）。
 */
export interface CredentialInfo {
  modelId: string;
  modelName: string;
  endpointId: string;
  endpointName: string;
  baseUrl: string;
  /** 掩码，如 `sk-…9f3a` */
  apiKeyMasked: string;
  /** 密钥是否已配置（宿主算的） */
  configured: boolean;
}

/**
 * 解析某模型对应的端点凭据。
 *
 * 模型缺失或端点缺失时返回 `undefined`（此时无法给出「输入 Key」的引导，
 * 属于配置本身残缺，交由调用方报错）。
 */
export function resolveCredential(
  config: AppConfig,
  modelId: string | undefined,
): CredentialInfo | undefined {
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
    apiKeyMasked: maskSecret(endpoint.apiKey),
    configured: endpoint.apiKey !== "",
  };
}

/** 端点清单的一行摘要，如 `OpenAI ✗ · DeepSeek ✓`（✓/✗ 这一格非空：`update` 省略 = 不动它） */
export function summarizeEndpoints(config: AppConfig): string {
  if (config.endpoints.length === 0) return t("common.noEndpoints");
  return config.endpoints
    .map((endpoint) => `${endpoint.name || endpoint.id} ${endpoint.apiKey ? "✓" : "✗"}`)
    .join(" · ");
}

/**
 * 某模型的端点密钥状态（给「这个模型现在能不能真的跑」那一格提示用）。
 *
 * 它是**配置里两格的事实**（模型的 `endpointId` + 那端点的 `apiKey` 空不空），不是宿主的
 * 「可用性」判断：旧契约曾把 `available` / `unavailableReason` 算好放在模型与 AgentDefinition 上，这一版
 * 没有了。所以这里只说得出「端点还在不在、密钥填没填」—— 而这也正是用户当下能改的那两件事。
 */
export interface EndpointKeyState {
  /** 端点显示名；端点不在配置里时是 `null`（模型指着一个不存在的端点） */
  endpointName: string | null;
  /** 密钥填没填（端点不存在时为 `false`：那条路一定跑不起来） */
  ready: boolean;
}

export function endpointKeyState(config: AppConfig, model: ModelDefinition): EndpointKeyState {
  const endpoint = findEndpoint(config, model.endpointId);
  if (!endpoint) return { endpointName: null, ready: false };
  return { endpointName: endpoint.name || endpoint.id, ready: endpoint.apiKey !== "" };
}

/** 凭据申请指引：按 baseUrl 识别厂商 */
export interface ApiKeyGuide {
  vendor: string;
  /** 申请页面（未识别厂商时为 undefined，只给通用提示） */
  url?: string;
}

const VENDOR_GUIDES: ReadonlyArray<{ match: string; vendorKey: string; url: string }> = [
  {
    match: "bigmodel.cn",
    vendorKey: "vendor.zhipu",
    url: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    match: "deepseek.com",
    vendorKey: "vendor.deepseek",
    url: "https://platform.deepseek.com/api_keys",
  },
  { match: "openai.com", vendorKey: "vendor.openai", url: "https://platform.openai.com/api-keys" },
  {
    match: "moonshot",
    vendorKey: "vendor.moonshot",
    url: "https://platform.moonshot.cn/console/api-keys",
  },
  { match: "dashscope", vendorKey: "vendor.dashscope", url: "https://bailian.console.aliyun.com/" },
];

export function apiKeyGuide(baseUrl: string | undefined): ApiKeyGuide {
  const url = (baseUrl ?? "").toLowerCase();
  for (const guide of VENDOR_GUIDES) {
    if (url.includes(guide.match)) return { vendor: t(guide.vendorKey), url: guide.url };
  }
  return { vendor: t("vendor.openaiCompatible") };
}

// ==================== 由名称派生 id ====================

/** 由名称派生唯一 id：小写、非字母数字折叠为 `-`，冲突时追加序号 */
function deriveUniqueId(taken: Set<string>, name: string, fallback: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || fallback;
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
  return deriveUniqueId(
    new Set((config.imageModels ?? []).map((model) => model.id)),
    name,
    "image",
  );
}

/** 由 AgentDefinition 名派生唯一 id（在既有 id 集合内避让） */
export function uniqueAgentId(taken: Iterable<string>, name: string, fallback = "agent"): string {
  return deriveUniqueId(new Set(taken), name, fallback);
}

// ==================== argv / KEY=VALUE 文本 ====================

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
    .map((arg) =>
      arg === "" || /[\s"'\\]/.test(arg)
        ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : arg,
    )
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
export function kvEntries(
  map: Record<string, string> | undefined,
): { key: string; value: string }[] {
  return Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
}

/** 键值映射的展示摘要，如 `2 项（PATH, HOME）` / `（空）` */
export function kvSummary(map: Record<string, string> | undefined): string {
  const keys = Object.keys(map ?? {});
  if (keys.length === 0) return t("common.empty");
  return t("common.kvSummary", { n: keys.length, keys: keys.join(", ") });
}

// ==================== 权限四维 ====================

/** Agent 四维权限的维度顺序 */
export const PERMISSION_DIMENSIONS = ["tools", "skills", "mcps", "subagents"] as const;
export type PermissionDimension = (typeof PERMISSION_DIMENSIONS)[number];
/** 一条权限策略（`allow: [...]` 或 `deny: [...]`） */
export type PermissionPolicy = NonNullable<
  NonNullable<AgentDefinition["permissions"]>[PermissionDimension]
>;

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
  if (!match) return t("err.permissionFormat");
  const mode = match[1]!.toLowerCase();
  const list = match[2]!
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (list.length === 0) return t("err.permissionNeedsPattern");
  return mode === "allow" ? { allow: list } : { deny: list };
}

/** 读某维权限的紧凑文本 */
export function formatAgentPermission(
  permissions: AgentDefinition["permissions"] | null,
  dim: PermissionDimension,
): string {
  return formatPermission(permissions?.[dim]);
}

/** 权限总览：列出已配置的维度（如 `4 维（tools, skills, mcps, subagents）`） */
export function summarizePermissions(permissions: AgentDefinition["permissions"] | null): string {
  const set = PERMISSION_DIMENSIONS.filter((dim) => permissions?.[dim]);
  if (set.length === 0) return t("common.unset");
  return t("common.permissionSummary", { n: set.length, dims: set.join(", ") });
}

/**
 * 改写某一维权限（`policy` 为 null 时删掉该维），返回**要交给 `agent.update` 的那份**。
 *
 * 浅合并的活归宿主：这里给出的是「这一版权限四维应该长成的样子」，而 `agent.update` 收的
 * 就是 `permissions` 的完整值。
 */
export function patchPermission(
  permissions: AgentDefinition["permissions"] | null,
  dim: PermissionDimension,
  policy: PermissionPolicy | null,
): NonNullable<AgentDefinition["permissions"]> {
  const next = { ...(permissions ?? {}) };
  if (policy) next[dim] = policy;
  else delete next[dim];
  return next;
}

// ==================== AgentDefinition 提示词 / 函数定义 ====================

/**
 * 一条 AgentDefinition 的函数定义。
 *
 * 只有子 Agent 才有（`AgentDefinition.function` 不在 = 不是子 Agent）。
 */
export type AgentFunction = NonNullable<AgentDefinition["function"]>;

/** 函数参数 schema（SDK 那边是 JSON Schema）。客户端只当「一个 JSON 对象」搬运，不解释语义 */
export type AgentParameters = AgentFunction["parameters"];

/**
 * 读提示词：首条 system 消息的纯文本。
 *
 * 只认 `content` 是字符串的那一种。分段内容（`MessageContentSection[]`）没法用一段纯文本
 * 表示 —— 拼成字符串再写回去等于悄悄把用户的分段结构换成纯文本；读不到（`messages` 为
 * `null` / 没有 system 消息 / 内容是分段）时就当空，屏上显示为「空」，改不改由用户决定。
 */
export function agentPromptText(messages: AgentDefinition["messages"] | null | undefined): string {
  const system = (messages ?? []).find((message) => message.role === AgentNS.Role.System);
  return typeof system?.content === "string" ? system.content : "";
}

/**
 * 编辑后的文本 → `agent.update` 的 `messages` 补丁（**整串**）。
 *
 * 宿主对 `messages` 是整份替换（`requireMessages`：非空且至少一条 system），所以每次都要给
 * 全串：换掉首条 system 的 `content`，其余消息连同它们自己的 id 原样带上；没有 system 时在
 * 前面补一条。构造出来的这一串天然满足「非空 + 有 system」，于是「清空提示词」（content 为空
 * 串）也是一次合法的写入 —— 客户端不替用户补任何默认值。
 */
export function withAgentPrompt(
  messages: AgentDefinition["messages"] | null | undefined,
  text: string,
): NonNullable<AgentDefinition["messages"]> {
  const list = [...(messages ?? [])];
  const index = list.findIndex((message) => message.role === AgentNS.Role.System);
  if (index < 0) return [Message.System(text), ...list];
  list[index] = { ...list[index], content: text };
  return list;
}

/**
 * 改写函数定义的若干项。
 *
 * 宿主对 `function` 是**整份替换**（`definedOnly` 只把 `undefined` 当「这一项不改」，不做深
 * 合并），所以每次都在这条定义现有的那份上盖一项 —— 只发 `{ description }` 会把
 * `parameters` 一起冲掉，反过来也一样。
 */
export function withAgentFunction(fn: AgentFunction, patch: Partial<AgentFunction>): AgentFunction {
  return { ...fn, ...patch };
}

/**
 * 参数 schema 文本 → 契约里的 JSON 对象；有格式问题就返回**一句人话**。
 *
 * 与 `parsePermission` 同一个口径：能当场判的格式（空 / 不是 JSON / 不是对象）在客户端判，
 * 「这份 schema 语义上是否成立」归宿主 —— 这里再实现一套只会漂的规则。
 */
export function parseFunctionParameters(raw: string): AgentParameters | string {
  const text = raw.trim();
  if (!text) return t("err.paramsSchemaEmpty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause: unknown) {
    return t("err.jsonParseFailed", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return t("err.paramsSchemaNotObject");
  }
  return parsed as AgentParameters;
}
