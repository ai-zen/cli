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
import type { SdkAgent, TaskMigrationService } from "@ai-zen/agents-sdk";

export interface ConversationContext {
  agent: SdkAgent;
  input: string;
  currentName: string;
  modelId: string;
  currentId: string | undefined;
  agentId: string | undefined;
  running: boolean;
  shouldSend?: boolean;
  /** 迁移服务实例：自动迁移（AutoMigratePlugin）与手动迁移（/migrate 命令）共用同一实例。先建 ctx 再回填（migrate 前必已赋值） */
  migrationService?: TaskMigrationService;
}

export type CommandHandler = (ctx: ConversationContext) => Promise<void>;
