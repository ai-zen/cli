// 由 src/tui/config-wizard.tsx 拆分而来 —— 共享类型与步骤常量
import { AppConfig } from "@ai-zen/agents-sdk";
import { McpConfig, McpScope } from "../../config.js";
import { AgentKind, AgentStore } from "../../agents-store.js";

// ==================== 类型 ====================

/** 可编辑的端点字段（首启引导 / `/key` 的直达编辑步骤用） */
export type EndpointField = "apiKey" | "baseUrl";

/** 「默认项」的四类目标 */
export type DefaultTarget = "defaultModel" | "defaultImageModel" | "defaultAgent" | "defaultMigrationModel";

/** 向导步骤（判别联合，逐步收敛） */
export type WizardStep =
  | { kind: "menu" }
  | { kind: "defaults" }
  | { kind: "pick-default"; target: DefaultTarget }
  | { kind: "endpoints" }
  | { kind: "endpoint"; endpointId: string }
  | { kind: "models" }
  | { kind: "model"; modelId: string }
  | { kind: "image-models" }
  | { kind: "image-model"; modelId: string }
  | { kind: "max-tool-output" }
  | { kind: "new-endpoint"; field: "name" | "baseUrl" | "apiKey"; draft: NewEndpointDraft }
  | { kind: "new-model" }
  | { kind: "new-image-model" }
  | { kind: "mcp"; scope: McpScope }
  | { kind: "mcp-server"; scope: McpScope; serverId: string }
  | { kind: "mcp-new"; scope: McpScope }
  | { kind: "mcp-kv"; scope: McpScope; serverId: string; field: "env" | "headers" }
  | { kind: "agents" }
  | { kind: "agent"; agentKind: AgentKind; agentId: string }
  | { kind: "agent-perms"; agentKind: AgentKind; agentId: string }
  | { kind: "agent-text"; agentKind: AgentKind; agentId: string; field: "prompt" | "fnParams" | "fnDesc" }
  | { kind: "agent-new"; agentKind: AgentKind }
  | { kind: "edit"; field: EndpointField; endpointId: string };

/** 列表里「新建…」哨兵值（实例 id 由名称派生、不含下划线，故不会冲突） */
export const NEW_ENDPOINT = "__new_endpoint__";
export const NEW_MODEL = "__new_model__";
export const NEW_IMAGE_MODEL = "__new_image_model__";
/** MCP 屏的「切换作用域」哨兵值 */
export const SWITCH_SCOPE = "__mcp_switch_scope__";
/** MCP 屏的「新建服务器」哨兵值 */
export const NEW_MCP_SERVER = "__new_mcp_server__";
/** Agent 屏的「新建 Agent / Sub-agent」哨兵值 */
export const NEW_AGENT = "__new_agent__";
export const NEW_SUBAGENT = "__new_subagent__";

export interface NewEndpointDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 向导关闭时回传的变更结果 */
export interface WizardCloseResult {
  /** 是否有改动写入磁盘 */
  dirty: boolean;
  /** 人话变更摘要（宿主渲染为对话区提示） */
  summary: string[];
  /** 被改动的端点 id（宿主据此判断是否需要重建 Agent） */
  changedEndpointIds: string[];
  /** 是否有 MCP 配置改动（宿主据此重建会话，让新工具生效） */
  mcpChanged?: boolean;
  /** 是否有 Agent 定义改动（宿主据此重建会话，让新定义生效） */
  agentsChanged?: boolean;
}

/** MCP 配置快照：全局 + 项目两个作用域 */
export interface McpSnapshot {
  global: McpConfig;
  project: McpConfig;
}

export interface ConfigWizardProps {
  /** 打开向导时的配置快照 */
  config: AppConfig;
  /** 起始步骤（默认配置中心菜单） */
  initialStep?: WizardStep;
  /** 首启引导模式：文案更完整，Esc 语义为「放弃」 */
  onboarding?: boolean;
  /** 保存成功后直接关闭（首启引导 / `/key`），否则回到配置中心菜单 */
  closeOnSave?: boolean;
  /** 可用于「默认 Agent」选择的 Agent 清单（可选） */
  agents?: { id: string; name: string }[];
  /** MCP 配置初始快照（全局 + 项目）；缺省视为两个空配置 */
  mcp?: McpSnapshot;
  /** Agent / Sub-agent 定义仓储（缺省为空快照 + 真实文件读写） */
  agentStore?: AgentStore;
  /** 持久化配置（通常是 `saveConfig`） */
  onSave: (config: AppConfig) => Promise<void>;
  /** 持久化 MCP 配置（缺省写入 scope 对应的 mcp.json） */
  onSaveMcp?: (scope: McpScope, config: McpConfig) => Promise<void>;
  /** 关闭向导 */
  onClose: (result: WizardCloseResult) => void;
}

