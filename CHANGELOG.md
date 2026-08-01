# Changelog

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
