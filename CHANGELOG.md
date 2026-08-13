# Changelog

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
