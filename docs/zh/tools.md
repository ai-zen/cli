---
title: 内置工具
description: @ai-zen/cli 的 19 种内置工具、5 种动态加载工具，以及工具装配流水线与权限模型。
outline: deep
---

# 内置工具

工具能力全部来自 `@ai-zen/agents-sdk`（`BUILTIN_TOOL_CLASSES`，共 19 种）与 SDK 的动态加载机制。CLI 本身**不新增**工具类，只负责组装路径、构建 `Provider` 单例，并把工具目录与 MCP/Skill 相关路径传给 SDK。

## 19 种内置工具

这些工具由 SDK 静态注册表 `discoverBuiltinTools` 实例化，装配时**不做任何过滤**（发现阶段无条件注册全部），其可用性由各工具自行声明（`isAvailable`）。

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录 |
| `readFile` | 读取文件内容 |
| `writeFile` | 写入文件内容 |
| `edit` | 在文件中替换文本（单次替换） |
| `batchEdit` | 批量替换文件中的文本 |
| `exec` | 执行 Shell 命令 |
| `exec_async` | 异步执行 Shell 命令（立即返回） |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 用 glob 模式扫描文件 |
| `ls` | 列出目录内容 |
| `exist` | 检查路径是否存在 |
| `findText` | 在文件中检索文本 |
| `downloadFile` | 从 URL 下载文件 |
| `rename` | 重命名或移动文件/目录 |
| `copy` | 复制文件或目录 |
| `sleep` | 等待指定毫秒数 |
| `viewImage` | 查看/分析图片（仅视觉模型可用） |
| `generateImage` | 根据文字描述生成图片 |

### 视觉与图片工具的可用性

- **`viewImage`**：仅对视觉模型启用。`isAvailable(config, definition)` 从 `definition.modelId` 解析当前模型并检查 `Model.vision`，因此**非视觉模型不会拿到该工具**（无需运行时重复校验）。
  - 输入 `path_or_url`：`http(s)` URL 直接以 `image_url` 内容块返回；本地路径自动通过 Files API（DeepSeek）上传，以 `file` 内容块（`file_id`）返回。不使用 base64 内联。
- **`generateImage`**：依赖配置中的 `imageModels` 与 `defaultImageModel`，未配置时由 `isAvailable` 过滤掉。**统一返回字符串**（JSON，含图片 URL 列表 + `viewImage`/`downloadFile` 提示），而不是强制返回图片内容块。

> 具体字段名、声明与返回类型均以 SDK 的 `.d.ts` 为准（如 `ViewImageTool` / `GenerateImageTool`）。

## 5 种动态加载工具

除内置工具外，SDK 还提供**动态加载工具**，依据可用资源与权限按需注册：

| 工具 | 用途 |
|------|------|
| `load_skill` | 加载 Skill 文档到上下文（幂等，重复调用跳过重复注入） |
| `call_skill_sub_agent` | 将任务委托给 Skill 子 Agent（仅对 frontmatter 含 `sub-agent: true` 的 Skill 生效） |
| `load_mcp` | 连接 MCP 服务器并列出其工具（幂等，重复调用跳过重复连接） |
| `call_mcp_tool` | 在已连接的 MCP 服务器上调用某个工具 |
| `read_mcp_resource` | 读取已连接 MCP 服务器的资源 |

> 这些工具分别由 SDK 的 `createLoadSkillTool` / `createCallSkillSubAgentTool`、`createLoadMcpTool` / `createCallMcpTool` / `createReadMcpResourceTool` 创建。

## 子 Agent 工具

SDK 的 `createSubAgentTool` 会把**带 `function` 字段的 Agent** 注册为可被其他 Agent 调用的工具（SubAgent）。它使用延迟构建（`AgentToolLazy`）以避免工具列表构建阶段的递归创建问题。子 Agent 拥有**独立的权限**，不与父 Agent 继承权限。

## 工具装配流水线

工具通过 SDK `Provider` 的能力流水线分三个阶段装配：

1. **发现（Discovery）**：扫描文件系统，发现内置工具、用户工具、SubAgent、Skill 与 MCP 服务器。19 种内置工具无条件注册（本阶段不过滤）。
2. **过滤（Filtering）**：应用权限（`allow`/`deny`）、安全排除（递归保护）以及每个工具自行声明的 `isAvailable(config, definition)`。可用性在**模型已知的构建期**决定，例如 `viewImage` 仅视觉模型可用、`generateImage` 需配置 `defaultImageModel`。
3. **实例化（Instantiation）**：将过滤后的名称映射到 `Tool` 实例，并注册动态加载器。

## 权限模型

`AgentPermissions` 定义了四个维度的权限（来自 SDK 类型）：

```typescript
interface AgentPermissions {
  tools?: { allow: string[] } | { deny: string[] };
  skills?: { allow: string[] } | { deny: string[] };
  mcps?: { allow: string[] } | { deny: string[] };
  subagents?: { allow: string[] } | { deny: string[] };
}
```

规则要点：

- 缺失 `permissions` 字段 = 所有维度全部拒绝（`deny: ["*"]`）。
- 每个维度要么用 `allow`（白名单），要么用 `deny`（黑名单），二者互斥。
- `"*"` 通配符匹配任意名称。
- 被拒绝的资源对 LLM **完全不可见**（不仅是调用被阻断）。
- 每个 Agent 拥有**独立的权限**，父子 Agent 之间不继承。
- **唯一例外**：`call_skill_sub_agent` 创建的临时 Skill 子 Agent，作为一次性的对话代理**继承调用者的权限**，而不是独立实体。
