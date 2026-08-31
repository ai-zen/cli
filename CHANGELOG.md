# Changelog

## [0.6.2] - 2026-08-31

### 🎯 优化

- **启动版本 banner 增强** — 新增 `src/version.ts`，统一从实际安装包读取版本号（而非依赖声明中的版本范围）；主菜单版本行由仅打印 CLI 版本扩展为同时展示 CLI / SDK / Core 三版本，例如 `AI-Zen CLI v0.6.2 · SDK 0.9.2 · Core 4.1.0`
- **适配 `@ai-zen/agents-core` 4.1.0 类型变更** — 上游将 `AgentNS.Message.id` 由可选改为**强制必填**（构造时自动生成）。`src/menus/agents.ts` 与 `src/conversation-commands/back.test.ts` 中直接构造的裸消息对象改用 `Message` 内置工厂方法创建（`Message.System` / `Message.User` / `Message.Assistant`，以及 `new Message(...)`），由 core 统一生成消息 `id`
- **依赖跟随升级** — `@ai-zen/agents-sdk` 至 `0.9.2`、`@ai-zen/agents-core` 至 `4.1.0`（借助 caret 范围自动解析）

### ✅ 测试

- 依赖升级后 `tsc` 类型检查与全量单测通过（37 passed / 5 files），`npm run build` 成功

## [0.6.1] - 2026-08-28

### 🎯 优化

- **升级 `@ai-zen/agents-sdk` 到 0.9.0** — 迁移服务新增 `strategy` 开关：
  - **`omit`（默认）**：历史消息标记 `omit: true` 保留可审计，追加「对话断点」消息为新上下文起点
  - **`prune`（CLI 采用）**：物理剔除历史，仅保留系统提示 + 交接断点（即先前替换行为）
  - CLI `migration-service.ts` 显式启用 `strategy: "prune"`，与端侧「迁移后开启新会话」的产品语义一致，**对外使用无差异**

### ✅ 测试

- 依赖升级后单测全量通过（37 passed），`tsc --noEmit` 零错误

## [0.6.0] - 2026-08-24

### 💥 破坏性变更

- **升级 `@ai-zen/agents-sdk` 到 0.8.0** — 任务迁移能力在 SDK 内完成重构（详见 SDK CHANGELOG）：
  - **`TaskMigrationService` 变为实例化、自包含迁移服务** —— 构造仅接收 `{ onBeforeMigrate?, onMigrated?, logger? }`（钩子平铺，无 `hooks` 包装），`migrate({ agent })` 直接复用传入 `agent` 的 `client`/`model`/`modelConfig` 生成交接文档，无需 Provider、无需独立迁移 Agent；暴露结构化 `MigrationContext`
  - **`AutoMigratePlugin` 收敛为仅触发角色** —— 构造注入 `{ service, maxTokens }`，只检测 token 超限并委托 `service.migrate`
  - **CLI 移除 `createMigrationAgent`** —— 删除 `src/agent-creator.ts` 中依赖已删除 `TaskMigrationService.createAgentDefinition` 的迁移 Agent 构建；手动迁移命令与自动迁移回调统一改为使用 SDK 迁移服务实例，钩子平铺在服务构造上

### 🚀 新功能

- **手动任务迁移命令 `/migrate`** — 对话中随时输入 `/migrate` 即可主动触发任务迁移，无需等待 token 超限：
  - 迁移动作：保存当前对话 → 生成交接文档 → 开启新会话（注入交接文档为上下文）→ 新对话落盘为草稿（`_current.json`）
  - 与自动迁移联动复用 SDK 的 `TaskMigrationService.migrate`，通过 `onMigrated` 钩子处理后保存
  - 非破坏性：旧对话已保存到 `conversations/`，生成失败时可重试或继续当前对话

### 🎯 优化

- **迁移服务单实例收敛** — 将 `TaskMigrationService` 实例挂载到 `ConversationContext.migrationService`，自动迁移（`AutoMigratePlugin` 触发）与手动迁移（`/migrate` 命令）共用**同一个实例**；迁移前后处理（保存旧对话 / 开启新会话 / 落盘草稿）统一收敛到该服务钩子，消除自动与手动两侧各自 `new TaskMigrationService` 及重复的后处理实现
- **迁移服务抽离为独立模块** — 新增 `src/migration-service.ts`，由 `createMigrationService(ctx)` 统一构建迁移服务实例（含迁移前后钩子）；`saveCurrentConversation` 提升为 `conversation-repository.ts` 的共享 `saveConversation`，供迁移钩子与错误保存共用

### ✅ 测试

- SDK 侧：`TaskMigrationService`（含 `migrate` / 序列化 / 钩子上下文）、`AutoMigratePlugin`（触发委托断言）全量通过（447 passed / 2 skipped）
- CLI 侧：`pretest` 类型检查与全量单测通过（37 passed），`npm run build` 成功

## [0.5.0] - 2026-08-23

### 💥 破坏性变更

- **升级 `@ai-zen/agents-core` 到 4.0.0、`@ai-zen/agents-sdk` 到 0.7.0** — 随底层核心重构（官方 OpenAI SDK + 插件化 Agent 驱动层）：
  - **`createModel()` 返回结构变化** — 从返回旧 `ChatCompletionModel` 实例改为 `{ client, model, modelConfig }`（openai SDK client + 模型名 + 模型参数）；`createMigrationAgent` 相应解构后传入 `SdkAgent` 新构造签名
  - **`SdkAgent` 构造签名变化** — 由 `{ ..., model }`（模型对象）改为 `{ client, model, modelConfig }`
  - **CLI 其余部分完全兼容** — 流式事件（`open`/`chunk`/`error`/`sub-agent`/`sub-agent-end`）、插件（`AutoMigratePlugin`/`AutoRefreshToolsPlugin`/`ContextGuardPlugin`）、`AgentNS` 类型（`Delta`/`StreamResponseData`/`Message`）在 core 4.0.0 / sdk 0.7.0 中原样保留，`AgentPlugin`/`SendContext` 由 sdk 重新导出，无破坏

### ✅ 测试

- 依赖升级后单测全量通过（37 passed / 0 failed），`tsc --noEmit` 零错误

### 🎯 优化

- **`test:all` / `test:e2e` 前置构建** — e2e 测试运行 `dist/index.js`，此前若 `dist` 缺失或为旧构建会导致 e2e 失败（升级后曾因旧 `dist` 报 `AgentContext must have a client`）。现于 e2e 前自动 `npm run build`，干净环境（CI clone 后）可开箱运行

## [0.4.0] - 2026-08-05

### 🚀 新功能

- **升级 `@ai-zen/agents-core` 到 3.4.0、`@ai-zen/agents-sdk` 到 0.6.0** — 随底层升级带来开箱即用的增强能力：
  - **内置工具中断信号（abort）支持** — `sleep`/`exec`/`downloadFile`/`generateImage`/`glob`/`findText` 及 subAgent 体系监听 `abort` 信号，CLI 终止对话时超长耗时操作可及时中断，避免资源滞留（`exec` 可区分 `aborted` 与 `timeout` 终止原因）
  - **工具定义内聚重构** — `Tool` 基类瘦身（不再强制传 `type`/`function`），定义与实现同处一类，回调签名由 `this` 注入改为显式 `(parsed_args, ctx)` 传参，`SdkCallbackTool` 构造改为 `{env}` 容器并透传完整 `ToolCallContext`
  - **MCP 工具 signal 透传** — `call_mcp_tool` / `read_mcp_resource` 支持中断
  - cli 层未直接使用上述受影响 API，升级为无破坏性平滑升级，功能不受影响

### ✅ 测试

- 依赖升级后单测全量通过（37 passed / 0 failed）

## [0.3.5] - 2026-08-13

### 🎯 优化

- **升级 `@ai-zen/agents-core` 到 3.3.1、`@ai-zen/agents-sdk` 到 0.5.7** — 跟随上游内部重构，开箱即用，CLI 无代码改动：
  - **`innerLoopTasks` 拆分为双集合语义** — Core 3.3.1 新增 `innerLoopsTasks`（整组任务记录）与 `innerLoopTasks`（当前轮活跃任务）；`abort()` 只中止当前轮活跃任务，不再误标已完成的轮次
  - **内循环开头统一追加 Assistant 占位** — `send()` / `AgentTool` 不再手动追加 Assistant，由 `run()` 每次内循环开头统一处理，多轮工具调用同样收敛到该处
  - **SDK 0.5.7 同步升级** — 依赖 core 3.3.1，全部 426 个测试（含真实 DeepSeek e2e）通过，完全兼容

## [0.3.4] - 2026-08-14

### 🎯 优化

- **升级 `@ai-zen/agents-core` 到 3.3.0、`@ai-zen/agents-sdk` 到 0.5.6** — 跟随上游统一重构，开箱即用，CLI 无代码改动：
  - **`ToolCallContext` 统一贯穿「拦截决策 → 执行」** — Core 3.3.0 将 `FunctionCallContext` 统一为 `ToolCallContext`：`onToolCall` 钩子与 `Tool.exec(ctx)` 收同一个实例；新增 `tool_call`（统一形状）、`tool`（匹配到的工具）、`signal`（中止信号）字段，`toolCall` 改名为 `tool_call`。保留 `@deprecated FunctionCallContext` 兼容别名，旧代码无需改动
  - **新增 `onToolCall` 拦截钩子** — Core 3.3.0 与 SDK 0.5.6 同时提供：每个工具调用执行前可**拒绝**（返回字符串 = 拒绝原因作为工具结果回给 LLM、工具不执行、继续下一轮）；SDK 侧 `AgentPlugin` 支持该钩子（多插件按注册顺序调用，任一返回字符串即拒绝）

## [0.3.3] - 2026-08-05

### 🎯 优化

- **依赖声明统一为版本范围** — `@ai-zen/agents-core` 与 `@ai-zen/agents-sdk` 由精确版本（`3.2.0` / `0.5.3`）改为 caret 范围（`^3.2.0` / `^0.5.3`），与 SDK 侧对 core 的 `workspace:^`（发布为 `^3.x`）语义对齐。允许各自主版本范围内的兼容升级，避免升级版本时反复改动依赖声明；实际解析版本保持 `3.2.0` / `0.5.3`（当前 latest），功能不受影响

## [0.3.2] - 2026-08-05

### 🚀 新功能

- **接入 `ContextGuardPlugin` 上下文安全护栏** — 在 `conversation-runner.ts` 的插件装配中注册 SDK 0.5.3 提供的 `ContextGuardPlugin`（置于 `AutoMigratePlugin` 之前，复用同一 `maxTokens`）。每次内循环发请求前检测用量，超过 `maxTokens×1.2`（超阈 20%）即抛出 `ContextOverflowError` 中断对话，防止读入超大文件等突发超限撑爆上下文；与迁移插件区间互补：正常超限走交接迁移，严重超限由护栏直接中断报错

### ✨ 优化

- **修正 `conversation-runner.ts` 插件注册注释编号** — 统一连续编号（1 cwdTracker / 2 autoRefreshTools / 3 draftPlugin / 4 contextGuard / 5 autoMigrate），消除此前重复编号

## [0.3.1] - 2026-08-05

### 🚀 新功能

- **升级 `@ai-zen/agents-sdk` 到 0.5.3** — 随 SDK 新能力开箱即用：
  - **初始化默认释放 socket-pty MCP 配置** — SDK `bootstrap()` 新增 `ensureDefaultMcpConfig()`，CLI 首启在 `~/.ai-zen/mcp.json` 自动写入含 `socket-pty` 终端的默认 MCP 配置（`npx -y @ai-zen/socket-pty mcp`），文件已存在则幂等不覆盖
  - **`load_mcp` 透传 server description** — 枚举各 MCP 服务器描述供 LLM 参考（对齐 `load_skill`）
  - **新增 `ContextGuardPlugin` 上下文安全护栏** — 在发请求前检测用量，超过 `maxTokens×1.2`（超阈 20%）时抛出 `ContextOverflowError` 中断对话，防止读入超大文件导致上下文失控；与 `AutoMigratePlugin` 职责分离、区间互补

### 🔧 修复

- **自动迁移后未立即保存新对话为草稿** — `AutoMigratePlugin` 的迁移发生在 `onAfterSend`（所有内循环已结束、`DraftPlugin` 的 `onInnerLoopEnd` 不再触发），迁移替换 `agent.messages` 后的新开场白未被及时落盘，用户在中途退出会丢失迁移后的开场白。现于 `onMigrated` 回调中迁移完成后立即将新消息写入草稿（`_current.json`），与「原对话先保存为 `conversations/`」形成完整闭环

### 🎯 优化

- **MCP 配置结构统一为业界标准 `mcpServers`** — 以 SDK（`discoverMcpServers`）为准，CLI 的 `McpConfig` 顶层字段由 `servers` 改为 `mcpServers`、server 传输字段由 `transport` 改为 `type`。消除格式漂移，CLI 管理界面（`zen config`）与 SDK 默认释放的 mcp.json 完全对齐，socket-pty 默认配置可被正确显示与管理

### ✅ 测试

- 更新 `config.test.ts` 中 MCP 读写相关断言以匹配新的 `mcpServers` 结构与 `type` 字段

## [0.3.0] - 2026-08-01

### 💥 破坏性变更

- **会话/草稿持久化下放 CLI** — SDK 0.5.0 移除了会话/草稿产品层（`ConversationRepository` / `DraftRepository` / `AutoDraftPlugin`）。CLI 自建本地存储：
  - 新增 `src/conversation-repository.ts` — `conversationRepository`（复用 SDK `EntityRepository`）
  - 新增 `src/draft-repository.ts` — `DraftRepository` + `draftRepository` 单例（草稿无 id 字段，单独实现）
  - 新增 `src/draft-plugin.ts` — CLI 草稿插件 `DraftPlugin`（替代被移除的 `AutoDraftPlugin`，`onInnerLoopEnd` 自动保存）
- **更新 `@ai-zen/agents-sdk` 到 0.5.0** — 内置工具类化（`SdkCallbackTool` + `ToolEnv` 注入）、`Provider` 支持 `cwd`/`env`、`generateImage` 类化为 `GenerateImageTool`

### 🎯 优化

- **依赖同步线上版本** — `@ai-zen/agents-core` `3.0.1`、`@ai-zen/agents-sdk` `0.5.0`（开发期曾使用本地 `link:` 调试，已还原为 npm 版本号）

## [0.2.3] - 2026-07-29

### 🎯 优化

- **更新 `@ai-zen/agents-sdk` 到 0.4.0** — load_mcp 返回值改为结构化 JSON（含完整 inputSchema），日志 API 改为全局单例 `getLogger()`/`setLogger()`

## [0.2.2] - 2026-07-27

### 🎯 优化

- **更新 `@ai-zen/agents-sdk` 到 0.3.4** — 包含 AutoMigratePlugin 钩子重命名（`onHandoff` → `onMigrated`）
- **保存旧对话的时机修正** — 从 `onMigrated`（原 `onHandoff`）移至 `onBeforeMigrate`，确保保存的是完整的旧对话历史

## [0.2.1] - 2026-07-27

### 🎯 优化

- **更新 `@ai-zen/agents-sdk` 到 0.3.3** — 包含默认 Agent/SubAgent 提示词优化（信息明确性要求、矛盾检测）

## [0.2.0] - 2026-07-26

### 💥 破坏性变更

- **同步 SDK 0.3.2 异步 API** — `@ai-zen/agents-sdk` 从 `0.3.1` → `0.3.2`
- **`readConfig()` / `saveConfig()` 改为 async** — 因 SDK `ConfigManager` 全面异步化
- **`createAgent()` 恢复为 async** — 因 SDK `createAgent()` 改回异步
- **`installHook()` / `uninstallHook()` 改为 async** — Shell hook 安装/卸载使用 `fs.promises`

### 🎯 优化

- **全面消除同步文件 IO** — `config.ts`、`hook.ts`、`conversations.ts`、`config-display.ts` 中所有 `existsSync`、`readFileSync`、`writeFileSync`、`readdirSync`、`statSync`、`renameSync`、`appendFileSync`、`mkdirSync`、`unlinkSync` 替换为 `fs.promises` 异步 API
- **`getConversationsList()` 改为 async** — 对话列表读取使用异步文件 API
- **MCP 配置读写异步化** — `readMcpConfig()`、`writeMcpConfig()`、`readProjectMcpConfig()` 均改为 async

### ✅ 测试

- 同步更新 `config.test.ts` 为 `async`/`await`，全部 43 个测试通过（含 6 个 E2E）

## [0.1.7] - 2026-07-21

### 🔧 修复

- **更新依赖**: `@ai-zen/agents-core` → `3.0.0-alpha.4`, `@ai-zen/agents-sdk` → `0.2.7`

## [0.1.6] - 2026-07-20

### 🔧 修复

- **更新 `@ai-zen/agents-sdk` 到 0.2.6** — 包含默认 SubAgent 函数名和描述修复，LLM 现在能正确识别子 Agent

## [0.1.5] - 2026-07-20

### 🔧 修复

- **更新 `@ai-zen/agents-sdk` 到 0.2.5** — 包含默认 SubAgent 权限修复，`general-assistant` 现在能正常使用工具
