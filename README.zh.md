# @ai-zen/cli

AI Agent 命令行界面，基于 `@ai-zen/agents-sdk` 和 `@ai-zen/agents-core` 构建。提供**双模式**运行：交互式终端（TUI）用于人与 AI 对话，纯 stdio 模式用于脚本、管道与 shell 兜底钩子。内置文件系统操作工具，支持 MCP 协议集成外部工具、子 Agent 编排和 Skill 管理。

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

## 运行模式

CLI 有两种**互不混合**的运行模式，由启动参数与终端环境自动判定：

| 模式 | 触发条件 | 面向对象 | 核心行为 |
|------|----------|----------|----------|
| **纯 stdio** | 带参数，**或** stdin/stdout 非 TTY（管道、重定向、CI） | 脚本、管道、shell 兜底钩子 | 无任何额外交互；读入文本，把**最终回答以纯文本写入 stdout** |
| **TUI** | 无参数且 stdin/stdout 均为 TTY | 人类用户 | 交互式对话界面 |

纯 stdio 模式下，日志 / 进度 / 工具过程 / 错误摘要一律走 **stderr**，stdout 只有结果本身（零 ANSI、零 emoji 前缀、零 spinner）；成功退出码 `0`，失败非 `0`。默认**不落盘**（不写对话存档）。

## 快速使用

```bash
# TUI：无参数且处于交互终端
ai

# 纯 stdio：参数即提示词，结果写入 stdout
ai 你好，请介绍一下你自己。

# 管道：stdin 作为内容，参数作为指令
cat README.md | ai "用三句话总结"

# 落盘：默认不保存，需要时显式 --save
ai --save "帮我给这个函数起个名字"

# 帮助 / 版本
ai --help
ai --version
```

> 旧命令名 `aiz` / `zen` 作为过渡别名在当前版本仍可用，未来版本会移除。

## 界面（TUI）

无参数且处于交互终端时，进入由 **Ink（React）** 打造的全屏界面。启动先呈现动画渐变的 ASCII 启动界面：

```
 █████╗ ██╗    ███████╗███████╗███╗   ██╗
██╔══██╗██║    ╚══███╔╝██╔════╝████╗  ██║
███████║██║      ███╔╝ █████╗  ██╔██╗ ██║
██╔══██║██║     ███╔╝  ██╔══╝  ██║╚██╗██║
██║  ██║██║    ███████╗███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝    ╚══════╝╚══════╝╚═╝  ╚═══╝

              终端里的 AI 协作台
              v1.0.0-alpha.1 · sdk x · core y
```

启动界面结束后**直接进入对话界面**（若存在「上一轮会话」则自动续接，否则新建对话）。对话界面采用**底部固定**布局：分隔线、输入行与状态栏（模型 · Agent · token 用量 · 生成状态）始终贴在终端底部，对话内容在其上方滚动；生成中时输入行位置显示进度指示。

对话界面包含：流式输出区（思考过程 / 回答正文 / 工具调用分行展示）、多行输入（`Enter` 发送、`Ctrl+N` 换行、`← →` 移动光标、`Ctrl+← →` 跨词）与内联 `/` 命令菜单（↑↓ 选择、`Tab` 补全）。`Ctrl+C` 在生成中取消本轮请求、空闲时退出。

### 首次配置（API Key）

首次启动时若所选模型绑定的端点还没有 API Key，会**先弹出凭据设置屏**，而不是报错退出：

```
 ? 首次配置 · 设置 DeepSeek 的 API Key
 端点：DeepSeek · https://api.deepseek.com/v1
 当前：未设置
 DeepSeek 申请地址：https://platform.deepseek.com/api_keys
 保存后立即进入对话（Esc 放弃并退出）。
 ❯ ▏
```

`Enter` 保存并直接进入对话（写入 `~/.ai-zen/config.json`），`Tab` 切明文核对，`Esc` 放弃。进入对话后仍可用 `/key` 修改**当前端点**的 Key（保存后自动重建会话，立即生效）、用 `/config` 打开配置中心（默认模型 / 端点管理：列表含「＋ 新建端点」与各端点，选中端点后可就地编辑 API Key / Base URL）。

### 会话恢复

每个会话都会在对话过程中**直接落盘为独立文件**（`cli/conversations/<id>.json`），不再有单独的草稿存储。一个指针文件（`cli/last-session.json`）记录**上一轮会话 id**；下次启动 `ai` 会**自动续接该会话**，接着上次继续。

### 对话命令

对话中输入的所有命令以 `/` 开头。输入 `/` 会在输入行下方实时列出可用命令及说明，继续输入即按前缀收敛候选：

```
💬 你: /b
  /back         撤回消息（可修改后重发）
```

> 输入 `/` 会在输入行下方实时列出候选命令（↑↓ 选择、`Tab` 补全、`Enter` 提交/执行）；命令按完整名称匹配，输入未识别的 `/xxx` 会提示「未知命令」。

| 命令 | 说明 |
|------|------|
| `/exit` `/quit` | 退出对话 |
| `/save` | 保存当前对话（会话本就每轮实时落盘） |
| `/load` | 加载已保存的对话（替换当前会话） |
| `/new` | 重置会话（清空历史） |
| `/back` | 撤回消息（回退到指定位置并可编辑后重发） |
| `/editor` | 使用系统编辑器（vim/nano）输入长消息 |
| `/clear` | 清屏 |
| `/config` | 打开配置中心（默认模型 / 端点管理） |
| `/key` | 设置当前端点的 API Key（保存后自动重建会话） |
| `/migrate` | 手动任务迁移（生成交接文档并开启新会话） |
| `/help` | 显示可用命令 |

### 任务迁移

当 API 响应中的 `usage.prompt_tokens` 超过模型的 `maxContextTokens` 时，系统会先**二次确认**（展示当前用量与阈值，默认「是」；选择「否」则跳过本次迁移、当前对话不受影响），确认后生成**交接文档**，汇总已完成任务、待办事项和关键决策，然后创建新会话并将交接文档注入为上下文，实现无缝衔接。确认框仅在 stdin/stdout 均为 TTY 时出现；管道、重定向等非交互场景无确认通道，保持既有自动迁移行为。

你也可以在对话中随时输入 `/migrate` 手动触发迁移，而无需等待 token 超限。手动与自动迁移均委托给 SDK 的 `TaskMigrationService`，交接文档生成始终一致。

同样的上下文护栏也作用于**子 Agent**：每次委派边界（`onSubAgentStart`）CLI 都会把同一个 `ContextGuardPlugin`（同一 `maxTokens`）安插到新建的子 Agent 上，因此被委派的子 Agent（含 `call_skill_sub_agent` 创建的技能子 Agent）在上下文超出硬上限时同样会被中断。该过程是透明的，正常运行的子 Agent 不受影响。

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
ai hook install

# 之后随便输入点什么：
> 今天天气怎么样？
# 这条消息会被转发给 AI，而不是显示 "command not found"

# 卸载钩子
ai hook uninstall
```

钩子函数体调用的是 `ai "$@"`（纯 stdio 模式），答案就地写入当前 shell 会话。若此前安装过旧版 `aiz` 钩子，重新执行 `ai hook install` 会自动升级；也可先 `ai hook uninstall` 再安装。

## 配置管理

配置文件存储在 `~/.ai-zen/config.json`（或 `$AI_ZEN_DIR/config.json`），与其他 AI-Zen 客户端共享，是**唯一数据源**。常用项可在 TUI 内直接编辑，无需手改 JSON：

| 场景 | 做法 |
|------|------|
| 首次启动、端点缺 Key | 启动时自动弹出**凭据设置屏** |
| 修改当前模型所用端点的 Key | 对话内 `/key`（保存后自动重建会话） |
| 端点 / 模型 / 图片模型、默认项、工具输出上限 | 对话内 `/config`（配置中心，全面管理） |
| MCP 服务器、Agent 定义等 | 手动编辑 `mcp.json` / `agents/*.json` |

其中 `maxContextTokens` 是迁移触发阈值（通常设为模型实际上下文窗口的约 25%，例如 1M tokens 的模型设为 250,000）。

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
      "id": "gpt-6.1-sol",
      "name": "GPT-6.1 Sol",
      "endpointId": "openai",
      "modelName": "gpt-6.1-sol",
      "maxContextTokens": 250000,
      "custom": true
    }
  ],
  "imageModels": [
    {
      "id": "cogview-4",
      "name": "CogView-4",
      "endpointId": "bigmodelcn",
      "modelName": "cogview-4",
      "defaultSize": "1024x1024"
    }
  ],
  "defaultModel": "deepseek-flash",
  "defaultImageModel": "cogview-4",
  "defaultAgent": "default",
  "defaultMigrationModel": "deepseek-flash"
}
```

> 说明：`models` / `imageModels` 中**未标 `custom: true`** 的条目属于**出厂托管**——每次启动会与 SDK 出厂清单对齐、被替换为最新定义；自建模型请加 `"custom": true`。`endpoints` 始终保留用户配置，不受影响。

### 环境变量

- `AI_ZEN_DIR` — 覆盖共享根目录（默认 `~/.ai-zen`）。CLI 运行时数据在 `$AI_ZEN_DIR/cli/`，共享资源（agents、skills、tools、MCP 等）在 `$AI_ZEN_DIR/`。

## 文件系统布局

```
~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
├── config.json               ← 端点与模型配置（与其他 AI-Zen 客户端共享）
├── cli/                      ← CLI 运行时数据
│   ├── conversations/        ← CLI 对话记录
│   └── last-session.json     ← 「上一轮会话 id」指针
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

1. 项目共享 `./.mcp.json`（从 cwd 向上到 git root 沿途收集）
2. 项目个人 `./.ai-zen/mcp.json`（同上）
3. 项目规范 `./.agents/mcp.json`
4. 用户级 `~/.ai-zen/mcp.json`
5. 用户规范 `~/.agents/mcp.json`

同名 server 高优先级覆盖低优先级。

## 内置工具

CLI 提供 20 个内置工具，由 `@ai-zen/agents-sdk` 实现。工具可用性由各工具在构建阶段（模型已知时）通过 `isAvailable(config, definition)` 自声明：

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录 |
| `readFile` | 读取文件内容（支持 `range` 分批读取） |
| `inspectFile` | 勘察文件结构概况（行数、字符数、列宽分布、行尾风格），不读取内容 |
| `writeFile` | 写入文件 |
| `edit` | 替换文件中的文本（单次替换） |
| `batchEdit` | 批量编辑文本 |
| `exec` | 执行 shell 命令 |
| `exec_async` | 异步执行 shell 命令（立即返回，不等待结果） |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 通配符扫描文件 |
| `ls` | 列出目录 |
| `exist` | 检查路径是否存在 |
| `findText` | 在文件中查找文本 |
| `downloadFile` | 从 URL 下载文件 |
| `rename` | 重命名或移动文件 |
| `copy` | 复制文件或目录 |
| `sleep` | 等待指定毫秒数 |
| `viewImage` | 查看/分析图片 — 仅视觉模型可用（`Model.vision`）。网络图片直接以 `image_url` 内容块返回；本地图片经 Files API 自动上传后以 `file` 内容块返回 |
| `generateImage` | 根据描述生成图片 — 需配置 `defaultImageModel`；统一返回字符串（含图片 URL 列表与 `viewImage` / `downloadFile` 提示的 JSON），不再强制返回图片内容块 |

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

工具装配由 SDK 的 `Scope` 能力管线管理，分为三个阶段：

1. **发现** — 扫描文件系统获取内置工具、用户工具、SubAgent、Skill 和 MCP 服务器。20 个内置工具全部无条件发现（此阶段不做过滤）
2. **过滤** — 应用权限（`allow`/`deny`）、安全排除（递归保护），以及各工具自声明的 `isAvailable(config, definition)`（在模型已知的构建阶段判断可用性；如 `viewImage` 仅视觉模型、`generateImage` 需配置 `defaultImageModel`）
3. **实例化** — 将过滤后的名称映射为 `Tool` 实例，注册动态加载器

每个 Agent 拥有独立的权限配置，父 Agent 与 SubAgent 之间不继承权限。唯一的例外是 `call_skill_sub_agent` 创建的临时 Skill 子 Agent——它是临时的对话分身而非独立实体，因此沿用调用者的工具能力（不再走第二遍权限过滤）。

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
  "mcpServers": {
    "my-server": {
      "type": "stdio",
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
| `gpt-6-astra` | GPT-6 Astra | OpenAI |
| `gpt-6.1-sol` | GPT-6.1 Sol | OpenAI |
| `gpt-6-luna` | GPT-6 Luna | OpenAI |
| `glm-5.3` | GLM-5.3 | 智谱AI |
| `glm-5.3-flash` | GLM-5.3-Flash（视觉） | 智谱AI |
| `glm-5.3-flashx` | GLM-5.3-FlashX（视觉） | 智谱AI |
| `glm-4.7-flash` | GLM-4.7-Flash | 智谱AI |
| `deepseek-flash` | DeepSeek-V4.1-Flash（视觉） | DeepSeek（**默认模型**） |

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
pnpm test:e2e
```

## 许可

MIT
