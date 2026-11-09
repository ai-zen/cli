/**
 * CLI 类型定义
 *
 * 配置/Agent 等共享实体类型委托给 @ai-zen/agents-sdk。
 *
 * ## 会话存档的类型为什么不在这里
 *
 * 会话（`SessionRecord` / `SessionRef` / `SessionPointer`）是**服务端**的产品数据：定义在
 * `@ai-zen/agents-server` 的 `SessionStore` 端口里，客户端经协议只看到 `sessionId` 与
 * `session.listSaved` 的返回值。这里曾经再导出一份 `SessionRecord`，还有一个
 * `SessionContext`（`agent` + `currentId` + `currentName` 的打包），它们随「会话搬上服务端」
 * 一起删掉了 —— 留着等于给「客户端本地也有一份会话、会话还有一个独立于 id 的名字」这个
 * 已经不存在的事实保留一条类型通道。
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
