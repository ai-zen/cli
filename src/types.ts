/**
 * CLI 类型定义
 *
 * 配置/Agent 等共享实体类型委托给 @ai-zen/agents-sdk。
 * 会话（SessionRecord）是 CLI 的产品数据，定义在 session-store.ts。
 *
 * ## 命名规约（`*Context` 曾经一窝蜂，故定三条判据）
 *
 * | 后缀 | 只用于 | 例子 |
 * |------|--------|------|
 * | `Context` | **一次调用内**有效的钩子/处理器载荷，不该被存下来 | core 的 `SendContext` / `ToolCallContext`、命令层的 `CommandContext` |
 * | `Deps`    | 注入进来的协作者或状态容器（`useRef` 那种也算） | `ChatDeps`、`ToolEnvDeps`、`FieldBuilderDeps` |
 * | `Props`   | React 组件的入参 | 组件里的 `XxxProps` |
 *
 * 不是一个命名笑话：`ScrollKeyContext` / `FieldBuilderContext` 一度都是 React 侧的注入点，
 * 与「钩子载荷」共用同一个词，于是「这个 ctx 能不能存下来」每次都得点回去看定义。
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

export type { SessionRecord } from "./session-store.js";

import type { SdkAgent, HandoffService } from "@ai-zen/agents-sdk";

export interface SessionContext {
  agent: SdkAgent;
  currentName: string;
  currentId: string;
  agentId: string | undefined;
  /**
   * 交接服务实例：自动迁移、`/migrate`、`/handoff` 共用同一实例。
   * 先建 ctx 再回填（交接前必已赋值）。
   */
  handoffService?: HandoffService;
}
