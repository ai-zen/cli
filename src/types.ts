/**
 * CLI 类型定义
 *
 * 业务实体类型委托给 @ai-zen/agents-sdk。
 * 此处只保留 CLI 独有的对话上下文、命令处理等类型。
 */

export type {
  AppConfig,
  Endpoint,
  Model,
  ImageModel,
  AgentDefinition,
  AgentPermissions,
  Conversation,
  Draft,
  McpServerConfig,
  McpServerManifest,
} from "@ai-zen/agents-sdk";

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
