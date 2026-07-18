# @ai-zen/cli

AI Agent 命令行界面，基于 `@ai-zen/agents-sdk` 和 `@ai-zen/agents-core` 构建。提供交互式对话终端，内置文件系统操作工具，支持 MCP 协议集成外部工具、子 Agent 编排和 Skill 管理。

## 安装

### 全局安装

```bash
npm install -g @ai-zen/cli
```

### 从源码构建

```bash
git clone git@github.com:ai-zen/cli.git
cd cli
pnpm install
pnpm build
npm install -g .
```

## 快速使用

```bash
# 交互式主菜单
zen

# 快速对话（参数作为初始消息）
zen 你好，请介绍一下你自己。
```

## 主菜单

运行 `zen` 进入主菜单：

```
🤖 欢迎使用 AI-Zen CLI

? 请选择操作:
  ▶️  继续上次未完成的对话  （如有草稿）
  💬 开始新对话
  📂 继续已保存的对话
  📋 管理已保存的对话
  🤖 管理 Agents
  ⚙️  配置管理
  ❌ 退出
```

### 草稿恢复

如果退出对话时没有保存（或进程被强制杀死），对话内容会**自动保存为草稿**。下次启动 `zen` 时会看到：

```
▶️  继续上次未完成的对话 (12 条消息, 2025/1/1 12:00:00)
💬 开始新对话（放弃草稿）
```

### 对话命令

对话中输入的所有命令以 `/` 开头：

| 命令 | 说明 |
|------|------|
| `/exit` `/quit` | 退出对话（会提示是否保存） |
| `/save` | 保存当前对话 |
| `/new` | 重置会话（清空历史） |
| `/back` | 撤回消息（回退到指定位置并可编辑后重发） |
| `/editor` | 使用系统编辑器（vim/nano）输入长消息 |
| `/clear` | 清屏 |
| `/help` | 显示可用命令 |

### 任务迁移

当 API 响应中的 `usage.prompt_tokens` 超过模型的 `maxContextTokens` 时，系统会自动生成**交接文档**，汇总已完成任务、待办事项和关键决策，然后创建新会话并将交接文档注入为上下文，实现无缝衔接。

迁移提示词模板包含：
- **对话断点** — 最后一段对话原文引用
- **已完成的任务** — 任务标题和产出路径
- **未完成的任务** — 描述、进度、下一步
- **重要记忆** — 技术偏好、踩坑记录、架构决策
- **文件索引** — 关键文件及用途说明
- **接手指令** — 先读文件验真、再对状态、后行动的 SOP

### Shell 兜底钩子

当你在终端输入一个不存在的命令时，自动转发给 AI 处理：

```bash
# 安装钩子
zen hook install

# 之后随便输入点什么：
> 今天天气怎么样？
# 这条消息会被转发给 AI，而不是显示 "command not found"

# 卸载钩子
zen hook uninstall
```

## 配置管理

配置文件存储在 `~/.ai-zen/cli/config.json`（或 `$AI_ZEN_DIR/cli/config.json`）。其中 `maxContextTokens` 是迁移触发阈值（通常设为模型实际上下文窗口的约 25%，例如 1M tokens 的模型设为 250,000）。

```jsonc
{
  "endpoints": [
    {
      "id": "openai",
      "name": "OpenAI",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "models": [
    {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "endpointId": "openai",
      "modelName": "gpt-5.5",
      "maxContextTokens": 250000
    }
  ],
  "imageModels": [
    {
      "id": "cogview-3",
      "name": "CogView-3",
      "endpointId": "bigmodelcn",
      "modelName": "cogview-3",
      "defaultSize": "1024x1024"
    }
  ],
  "defaultModel": "deepseek-v4-flash",
  "defaultImageModel": "cogview-3",
  "defaultAgent": "default",
  "defaultMigrationModel": "deepseek-v4-flash"
}
```

### 环境变量

- `AI_ZEN_DIR` — 覆盖共享根目录（默认 `~/.ai-zen`）。CLI 运行时数据在 `$AI_ZEN_DIR/cli/`，共享资源（agents、skills、tools、MCP 等）在 `$AI_ZEN_DIR/`。

## 文件系统布局

```
~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
├── cli/                      ← CLI 运行时数据
│   ├── config.json           ← CLI 的端点、模型配置
│   ├── conversations/        ← CLI 对话记录
│   └── drafts/               ← CLI 草稿
├── agents/                   ← Agent 定义（共享）
│   ├── default.json          ← 默认 Agent（首次运行自动创建）
│   └── my-custom-agent.json
├── sub-agents/               ← SubAgent 定义（共享）
│   ├── general-assistant.json ← 默认 SubAgent（首次运行自动创建）
│   └── my-coder.json
├── skills/                   ← Skill 目录（共享）
│   └── my-skill/
│       └── SKILL.md
├── tools/                    ← 用户自定义工具（共享）
│   └── my-tool.js
├── mcp.json                  ← MCP 配置（共享）
└── mcp-oauth/                ← MCP OAuth 令牌（共享）

/path/to/project/
├── .mcp.json                 ← 项目共享 MCP 配置（可提交 git）
└── .ai-zen/
    ├── mcp.json              ← 项目个人 MCP 配置（不提交）
    ├── skills/               ← 项目 Skill 目录
    │   └── my-skill/
    │       └── SKILL.md
    ├── tools/                ← 项目工具目录
    │   └── my-tool.js
    ├── sub-agents/           ← 项目 SubAgent 目录
    │   └── project-helper.json
    └── agents/               ← 项目 Agent 目录（覆盖用户级）
        └── project-agent.json
```

### MCP 配置合并优先级

MCP 服务器配置从多个来源合并（优先级从高到低）：

1. 项目个人 `.ai-zen/mcp.json`（从 cwd 向上到 git root 沿途收集）
2. 项目共享 `.mcp.json`（同上）
3. 用户级 `~/.ai-zen/mcp.json`

同名 server 高优先级覆盖低优先级。

## 内置工具

CLI 提供 16 个内置文件系统工具，由 `@ai-zen/agents-sdk` 实现：

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录 |
| `readFile` | 读取文件内容 |
| `writeFile` | 写入文件 |
| `edit` | 替换文件中的文本（单次替换） |
| `batchEdit` | 批量编辑文本 |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 通配符扫描文件 |
| `ls` | 列出目录 |
| `exist` | 检查路径是否存在 |
| `exec` | 执行 shell 命令 |
| `findText` | 在文件中查找文本 |
| `downloadFile` | 从 URL 下载文件 |
| `generateImage` | 根据描述生成图片 |
| `rename` | 重命名或移动文件 |
| `copy` | 复制文件或目录 |

### 动态工具

除内置工具外，SDK 还提供 5 个动态加载工具，根据可用资源和权限按需注册：

| 工具 | 用途 |
|------|------|
| `load_skill` | 加载 Skill 文档到上下文（幂等，重复加载不重复注入） |
| `call_skill_sub_agent` | 将任务委派给 Skill 子 Agent（仅对 frontmatter 声明了 `sub-agent: true` 的 Skill 有效） |
| `load_mcp` | 连接 MCP 服务器并列出其工具（幂等，重复连接不重建） |
| `call_mcp_tool` | 调用已连接 MCP 服务器上的工具 |
| `read_mcp_resource` | 读取已连接 MCP 服务器上的资源 |

## 工具装配流程

工具装配由 SDK 的 `Capabilities` 类管理，分为三个阶段：

1. **发现** — 扫描文件系统获取内置工具、用户工具、SubAgent、Skill 和 MCP 服务器
2. **过滤** — 应用权限（`allow`/`deny`）和安全排除（递归保护）
3. **实例化** — 将过滤后的名称映射为 `Tool` 实例，注册动态加载器

每个 Agent 拥有独立的权限配置，父 Agent 与 SubAgent 之间不继承权限。唯一的例外是 `call_skill_sub_agent` 创建的临时 Skill 子 Agent——它是临时的对话分身而非独立实体，因此继承调用者的权限。

## 权限模型

```typescript
interface AgentPermissions {
  tools?: { allow: string[] } | { deny: string[] };
  skills?: { allow: string[] } | { deny: string[] };
  mcps?: { allow: string[] } | { deny: string[] };
  subagents?: { allow: string[] } | { deny: string[] };
}
```

- 缺少 `permissions` 字段 = 所有维度拒绝（`deny: ["*"]`）
- 每个维度使用 `allow`（白名单）或 `deny`（黑名单），互斥
- `"*"` 通配符匹配任意名称
- 被拒绝的资源对 LLM 完全不可见（不仅执行阻断）

## MCP 服务器支持

MCP 服务器配置在 `mcp.json` 文件中：

```json
{
  "servers": {
    "my-server": {
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "xxx"
      }
    }
  }
}
```

连接生命周期（连接、指数退避重连、空闲超时断开）由 SDK 的 `McpConnectionManager` 全权管理。

### OAuth（仅 HTTP 传输类型）— 暂不支持

OAuth 2.0 授权流程（`mcp.json` 中的 `oauth` 字段）已定义类型和预留 `mcp-oauth/` 存储目录，但尚未实现。目前配置了 `oauth` 的 HTTP MCP 服务器将因缺少 token 而连接失败。

## 预置端点

| ID | 名称 | 默认 Base URL |
|----|------|--------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (智谱AI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## 预置模型

| ID | 名称 | 端点 |
|----|------|------|
| `gpt-5.5` | GPT-5.5 | OpenAI |
| `glm-5.2` | GLM-5.2 | 智谱AI |
| `glm-5.1` | GLM-5.1 | 智谱AI |
| `glm-5` | GLM-5 | 智谱AI |
| `glm-5-turbo` | GLM-5-Turbo | 智谱AI |
| `glm-5v-turbo` | GLM-5V-Turbo | 智谱AI |
| `glm-4.7-flash` | GLM-4.7-Flash | 智谱AI |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek（**默认模型**） |

## 开发

```bash
pnpm install
pnpm build
pnpm start
```

## 测试

```bash
# 单元测试
pnpm test

# 端到端测试（需在 .env.local 中配置 API Key）
pnpm test -- src/__tests__/e2e.test.ts
```

## 许可

ISC
