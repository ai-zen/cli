/**
 * CLI 类型定义
 *
 * 配置/Agent 等共享实体类型委托给 @ai-zen/agents-sdk。
 * 会话（Conversation）/草稿（Draft）是 CLI 的产品数据，定义在 conversation-repository.ts / draft-repository.ts。
 */

export type {
  AppConfig,
  Endpoint,
  Model,
  ImageModel,
  AgentDefinition,
  AgentPermissions,
  McpServerConfig,
  McpServerManifest,
} from "@ai-zen/agents-sdk";

export type { Conversation } from "./conversation-repository.js";
export type { Draft } from "./draft-repository.js";

import { AgentNS } from "@ai-zen/agents-core";
import type { SdkAgent } from "@ai-zen/agents-sdk";

export interface ConversationContext {
  agent: SdkAgent;
  input: string;
  currentName: string;
  modelId: string;
  currentId: string | undefined;
  agentId: string | undefined;
  running: boolean;
  shouldSend?: boolean;
}

export type CommandHandler = (ctx: ConversationContext) => Promise<void>;
