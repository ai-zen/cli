// 配置向导的步骤机与对外契约 —— 形状全部取自契约（`src/config.ts` 的 SDK 词汇）
import type {
  AgentDefinition,
  AppConfig,
  EndpointDefinition,
  ImageModelDefinition,
  ModelDefinition,
  ReasoningPresets,
} from "../../config.js";
import type { McpEditableScope, McpEntry, McpServerDefinition } from "../../config.js";
import type { HostClient } from "../../server-client/index.js";
import type { OpenEditor } from "./prompt-editor.js";

/**
 * 向导眼里那条连接 —— 就是 tRPC 客户端本身（`api`）。
 *
 * 每一条读写都是一次 procedure 调用（`api.config.get.query()` / `api.config.models.create.mutate(…)`
 * / `api.config.agents.update.mutate(…)` / `api.config.mcp.update.mutate(…)`），所以这里收窄成
 * 「一个有 `api` 的对象」：屏幕与用例都只认这一面，不必认识 `HostConnection` 上别的格子。
 */
export interface WizardHost {
  readonly api: HostClient["api"];
}

/**
 * `agentDefinition.create` 的写入形状（SDK 的 `AgentDefinition` 去掉宿主自己盖的那两个时间戳）。
 *
 * `messages` 必须是**一整串**且至少一条 system（宿主的写前校验）；`function` 有则视为子 Agent。
 */
export type AgentDefinitionInput = Omit<AgentDefinition, "createdAt" | "updatedAt">;
/** `agentDefinition.update` 的局部改动（合并语义：`undefined` = 这一项不动） */
export type AgentChange = Partial<Omit<AgentDefinition, "id" | "createdAt">>;
/** `config.models.update` 的局部改动 */
export type ModelChange = Partial<Omit<ModelDefinition, "id">>;
/** `config.endpoints.update` 的局部改动（`apiKey` 省略 = 保留原密钥） */
export type EndpointChange = Partial<Omit<EndpointDefinition, "id">>;
/** `config.imageModels.update` 的局部改动 */
export type ImageModelChange = Partial<Omit<ImageModelDefinition, "id">>;

/** `config.defaults.update` 的五个格子（`null` = 清空这一项） */
export interface DefaultsChange {
  defaultAgent?: string | null;
  defaultModel?: string | null;
  defaultMigrationModel?: string | null;
  defaultImageModel?: string | null;
  namingModel?: string | null;
}

/**
 * `config.update` 的四格：工具输出上限 + 中断策略两项 + 自动命名开关。
 *
 * `autoTitle` 只认布尔：这一格关掉只省下每段新会话那一次起名请求，手工改名（`/rename`）照旧。
 * 契约里没有「清回缺省」那一档，所以屏上只给两档，没有「不设置」。
 */
export interface GlobalChange {
  maxToolOutput?: number;
  abortedMessageStrategy?: AppConfig["abortedMessageStrategy"];
  abortedToolRoundStrategy?: AppConfig["abortedToolRoundStrategy"];
  autoTitle?: boolean;
}

// ==================== 步骤 ====================

/** 可编辑的端点字段（首启引导 / `/key` 的直达编辑步骤用） */
export type EndpointField = "apiKey" | "baseUrl";

/**
 * AgentDefinition 详情里那三段**多行文本**（都进同一个 `$EDITOR` 屏）。
 *
 * 它们是三种不同的写入形状：提示词落在 `messages` 上、另外两段落在一个 `function` 对象
 * 的两个字段上。判别值取「字段名」而不是数组下标，是因为 `step-agents` 要按它决定读哪段
 * 文本、写哪个补丁。
 */
export type AgentTextField = "prompt" | "function-description" | "function-parameters";

/**
 * 「默认项」的可选目标。
 *
 * 前五个是 id 型默认值（从列表里挑一个，或选「不设置」），之后是中断策略的固定几档，
 * 最后是自动命名开关（两档布尔，`dev-docs/prd/01-decisions.md` 1.5 那条注：它是配置项，
 * 不占会话行的 11 格）。一次改动一次调用：id 型走 `config.defaults.update`，其余走 `config.update`。
 */
export type DefaultTarget =
  | "defaultAgent"
  | "defaultModel"
  | "defaultMigrationModel"
  | "defaultImageModel"
  | "namingModel"
  | "abortedMessageStrategy"
  | "abortedToolRoundStrategy"
  | "autoTitle";

/** 向导步骤（判别联合，逐步收敛） */
export type WizardStep =
  | { kind: "menu" }
  /**
   * 首启引导的第一步：**选服务商**。
   *
   * 为什么不直接跳「填密钥」：一上来就要求某个厂商的密钥，等于替用户挑了他只能改的那一家
   * （旧版就是拿默认模型反推端点）。这一屏把「哪一家」先交给用户，选完才问密钥。
   */
  | { kind: "onboarding" }
  /** 首启引导的第二步：那一家服务商的密钥（保存后定首要模型并关闭） */
  | { kind: "onboarding-key"; endpointId: string }
  | { kind: "defaults" }
  | { kind: "pick-default"; target: DefaultTarget }
  | { kind: "endpoints" }
  | { kind: "endpoint"; endpointId: string }
  | { kind: "models" }
  /**
   * 某一家的模型清单（模型管理的第二级）。
   *
   * 一层平铺的问题是「一长串、同名的只靠 id 分」—— 订阅式端点一家就带进来十几条。所以先选
   * 供应商、再看那一家底下的模型；新建模型也在这一层（建出来就属于这家，不再默认绑第一个端点）。
   */
  | { kind: "models-of-endpoint"; endpointId: string }
  | { kind: "model"; modelId: string }
  | { kind: "image-models" }
  | { kind: "image-model"; modelId: string }
  | { kind: "max-tool-output" }
  | { kind: "new-endpoint"; field: "name" | "baseUrl" | "apiKey"; draft: NewEndpointDraft }
  /** 新建模型：`endpointId` 是「在哪一家下面建的」（从第二级进来） */
  | { kind: "new-model"; endpointId: string }
  | { kind: "new-image-model" }
  | { kind: "mcp"; scope: McpEditableScope }
  | { kind: "mcp-server"; scope: McpEditableScope; serverName: string }
  | { kind: "mcp-new"; scope: McpEditableScope }
  | { kind: "mcp-kv"; scope: McpEditableScope; serverName: string; field: "env" | "headers" }
  | { kind: "agents" }
  | { kind: "agent"; agentId: string }
  | { kind: "agent-perms"; agentId: string }
  /** AgentDefinition 的多行文本子屏（提示词 / 函数说明 / 参数 schema），内容交给 `$EDITOR` */
  | { kind: "agent-text"; agentId: string; field: AgentTextField }
  | { kind: "agent-new" }
  | { kind: "edit"; field: EndpointField; endpointId: string };

/** 列表里「新建…」哨兵值（实例 id 由名称派生、不含下划线，故不会冲突） */
export const NEW_ENDPOINT = "__new_endpoint__";
export const NEW_MODEL = "__new_model__";
export const NEW_IMAGE_MODEL = "__new_image_model__";
/** MCP 屏的「切换作用域」哨兵值 */
export const SWITCH_SCOPE = "__mcp_switch_scope__";
/** MCP 屏的「新建服务器」哨兵值 */
export const NEW_MCP_SERVER = "__new_mcp_server__";
/** Agent 屏的「新建 Agent」哨兵值 */
export const NEW_AGENT = "__new_agent__";

export interface NewEndpointDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
}

// ==================== 关闭时回传的结果 ====================

/**
 * 向导关闭时回传的变更结果。
 *
 * 全是**事实**，没有判断：每一次写都成功了（宿主那边改完即生效，回的就是新的那一份
 * `AppConfig`），所以「要不要重建会话」不再由客户端猜。这里只说两件事：
 *   - 有没有改动落下去（`dirty`）；
 *   - 每一处改动的句子（`summary`，由宿主/屏幕渲染成会话区的一条通知）。
 *
 * 旧版还有一个 `restartRequired`（来自 `ConfigApplyReport.restartRequired`）：新契约的写口
 * 只回 `{ config }`，没有「这份改动要重启才生效」这一格，所以它随报告一起退场 ——
 * 「会话还没建好就先重启一次」那条判据留在 `use-wizard-host.ts` 里（那是本地事实：草稿会话
 * 之前改配置只能重来一遍）。
 */
export interface WizardCloseResult {
  dirty: boolean;
  summary: string[];
  /**
   * 首启引导选定并**已经写进配置**的那个模型（那家服务商的首要模型）。
   *
   * 为什么不在向导里直接落到会话上：向导只拿得到 `api`（配置那一面），碰不到会话。而首启那一段
   * 会话的模型在建行那一刻就写定了（`session.create` 把三级解析的结果落进会话行），全局兜底的
   * `defaultModel` 盖不住它 —— 于是「用户改了服务商」这件事必须由持有会话的调用方补一手，
   * 这里只回答「该落到哪个模型上」。
   *
   * `undefined` = 没选（用户没走完引导，或那家端点没有标记首要模型）。
   */
  onboardedModelId?: string;
}

// ==================== 组件入参 ====================

export interface ConfigWizardProps {
  /** 调 procedure 的那一面（读、写都走它） */
  host: WizardHost;
  /** 这一段会话属于哪个项目：`mcp.list` / `mcp.save` / `mcp.remove` 都要它 */
  workspaceId: string;
  /** 打开向导时 `api.config.get.query()` 的那份配置 */
  config: AppConfig;
  /** 同一份出参里的档位表（模型上的 `reasoningPreset` 指它的键） */
  presets: ReasoningPresets;
  /** 打开向导时 `api.config.agents.list.query()` 的定义清单 */
  agents: AgentDefinition[];
  /** 打开向导时 `api.config.mcp.list.query({ workspaceId })` 的服务器清单（每条带 `scope`） */
  servers: McpEntry[];
  /**
   * 每个 AgentDefinition 上挂着几段会话（`workspace.list` + 逐个 `session.list` 数出来的，向导宿主数）。
   *
   * 只给「删 AgentDefinition」那一处摆代价用：数得出来就说几段，数不出来（`null` / 缺省）就只说一句人话
   * —— **不编数字**。它是读出来的事实，不是第二份状态：数字在向导打开那一刻定下，随后不变。
   */
  sessionsByAgent?: Record<string, number> | null;
  /** 起始步骤（默认配置中心菜单） */
  initialStep?: WizardStep;
  /**
   * 打开系统编辑器的实现（缺省 `openInSystemEditor`）。
   *
   * 只有 `agent-text` 屏（提示词 / 函数说明 / 参数 schema）用它。用例注入假实现是为了**不必**
   * `vi.mock("child_process")` —— 本仓不隔离模块图，按说明符注册的 mock 会串到别的文件。
   */
  openEditor?: OpenEditor;
  /**
   * 终端尺寸覆盖（供测试固定帧高用）。
   * 缺省时按真实窗口尺寸（`useWindowSize`），再退默认 80×24。
   */
  terminalSize?: { columns: number; rows: number };
  /** 首启引导模式：文案更完整，Esc 语义为「放弃」 */
  onboarding?: boolean;
  /** 保存成功后直接关闭（首启引导 / `/key`），否则回到配置中心菜单 */
  closeOnSave?: boolean;
  /** 关闭向导（带回变更事实） */
  onClose: (result: WizardCloseResult) => void;
}

/** 一条 MCP 服务器在某个作用域下的写入入参（`mcp.save` 的 `server` 就是它） */
export type McpServerInput = McpServerDefinition;
