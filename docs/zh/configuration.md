---
title: 配置
description: @ai-zen/cli 的配置文件路径、目录布局、环境变量、预设端点与模型，以及交互式配置管理。
outline: deep
---

# 配置

## 配置文件路径

配置存储在共享根目录下（由 `AI_ZEN_DIR` 决定）：

- **全局配置**：`$AI_ZEN_DIR/config.json`（默认 `~/.ai-zen/config.json`，当未设置 `AI_ZEN_DIR` 时为 `~/.ai-zen/config.json`）。

> 配置目录与 CLI/Desktop **共享**：配置文件在共享根目录（`src/config.ts` 的 `CONFIG_FILE = join(AI_ZEN_DIR, "config.json")`），而 `~/.ai-zen/cli/` 下存放的是 `conversations/` 与 `last-session.json`（「上一轮会话 id」指针）这类 CLI 运行时数据。

`src/config.ts` 定义的关键路径：

| 常量 | 路径 | 说明 |
|------|------|------|
| `AI_ZEN_DIR` | `~/.ai-zen`（或 `$AI_ZEN_DIR`） | 共享根目录 |
| `CLI_DIR` | `$AI_ZEN_DIR/cli` | CLI 运行时目录 |
| `CONFIG_FILE` | `$AI_ZEN_DIR/config.json` | 全局配置（CLI/Desktop 共享） |
| `CONVERSATIONS_DIR` | `$AI_ZEN_DIR/cli/conversations` | 对话记录 |
| `AGENTS_DIR` | `$AI_ZEN_DIR/agents` | Agent 定义（共享） |
| `SUB_AGENTS_DIR` | `$AI_ZEN_DIR/sub-agents` | SubAgent 定义（共享） |
| `SKILLS_DIR` | `$AI_ZEN_DIR/skills` | Skill 目录（共享） |
| `TOOLS_DIR` | `$AI_ZEN_DIR/tools` | 用户工具（共享） |
| `MCP_CONFIG_FILE` | `$AI_ZEN_DIR/mcp.json` | MCP 配置（共享） |

### 环境变量

- **`AI_ZEN_DIR`**：覆盖共享根目录（默认 `~/.ai-zen`）。CLI 运行时数据写入 `$AI_ZEN_DIR/cli/`，共享资源（agents、skills、tools、mcp 等）写入 `$AI_ZEN_DIR/`。

## config.json 结构

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

字段（与 SDK 的 `AppConfig` 类型对齐）：

- `endpoints`：API 端点列表（`id`、`name`、`baseUrl`、`apiKey`、`description`）。
- `models`：对话模型列表。其中 `maxContextTokens` 设定**迁移阈值**（README 建议约为模型实际上下文窗口的 25%）。`vision` 表示是否支持图片输入（决定 `viewImage` 是否启用）。
- `imageModels`：图片生成模型列表（`id`、`name`、`endpointId`、`modelName`、`defaultSize`、`defaultQuality`）。
- `models` / `imageModels` 中未标 `custom: true` 的条目属于**出厂托管**：每次启动会与 SDK 出厂清单对齐并被替换为最新定义；自建条目请加 `"custom": true`（悬空的 `defaultModel` / `defaultMigrationModel` 会回退到出厂默认）。`endpoints` 始终保留用户配置。
- `defaultModel` / `defaultImageModel` / `defaultAgent` / `defaultMigrationModel`：各默认项。

## 文件系统布局

```
~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
├── cli/                      ← CLI 运行时数据
│   ├── conversations/        ← CLI 对话
│   └── last-session.json     ← 「上一轮会话 id」指针
├── config.json               ← 全局配置（端点、模型等，CLI/Desktop 共享）
├── agents/                   ← Agent 定义（共享）
│   ├── default.json
│   └── my-custom-agent.json
├── sub-agents/               ← SubAgent 定义（共享）
│   ├── general-assistant.json
│   └── my-coder.json
├── skills/                   ← Skill 目录（共享）
│   └── my-skill/SKILL.md
├── tools/                    ← 用户工具（共享）
│   └── my-tool.js
├── mcp.json                  ← MCP 配置（共享）
└── mcp-oauth/                ← MCP OAuth token（共享，暂未实现）

/path/to/project/
├── .mcp.json                 ← 项目共享 MCP 配置（可提交）
└── .ai-zen/
    ├── mcp.json              ← 项目个人 MCP 配置（不提交）
    ├── skills/               ← 项目 Skill 目录
    ├── tools/                ← 项目工具目录
    ├── sub-agents/           ← 项目 SubAgent 目录
    └── agents/               ← 项目 Agent 目录（覆盖用户级）
```

业界通用规范目录：`~/.agents/` 与 `<project>/.agents/`（`skills/`、`mcp.json`）。

## 预设端点

| ID | 名称 | 默认 Base URL |
|----|------|---------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (ZhipuAI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## 预设模型

| ID | 名称 | 端点 |
|----|------|------|
| `gpt-6-astra` | GPT-6 Astra | OpenAI |
| `gpt-6.1-sol` | GPT-6.1 Sol | OpenAI |
| `gpt-6-luna` | GPT-6 Luna | OpenAI |
| `glm-5.3` | GLM-5.3 | ZhipuAI |
| `glm-5.3-flash` | GLM-5.3-Flash（视觉） | ZhipuAI |
| `glm-5.3-flashx` | GLM-5.3-FlashX（视觉） | ZhipuAI |
| `glm-4.7-flash` | GLM-4.7-Flash | ZhipuAI |
| `deepseek-flash` | DeepSeek-V4.1-Flash（视觉） | DeepSeek（**默认**） |

> 预设端点/模型来自 SDK（`@ai-zen/agents-sdk`）的 `config/constants`；CLI 不维护自己的预置列表（`src/config.ts` 直接复用 SDK 的出厂默认）。上表与 README 的「预置模型」表一致。

## 配置管理

TUI 内可用 `/config` 打开**配置中心**交互式编辑常用项，无需手改 JSON：

- 配置文件路径：`~/.ai-zen/config.json`（或 `$AI_ZEN_DIR/config.json`）。
- 可设置：API 端点（名称、Base URL、API Key）、默认对话模型、新建端点（自定义 OpenAI 兼容服务）——「端点管理」列表 = [新建端点] + 各端点，选中端点后就地编辑其 API Key / Base URL。
- 首次启动若模型绑定的端点缺 API Key，会先弹出凭据设置屏；对话内 `/key` 可改当前端点的 Key（保存后自动重建会话）。
- 模型的增删改、图片模型、MCP 服务器等高级项暂时仍需手动编辑配置文件。

> 说明：CLI 入口只实现了 `hook` 子命令（`ai hook install|uninstall`）；**没有 `config` 子命令**。若端点缺少 API Key，纯 stdio 模式会直接报错退出（非 0），TUI 模式会在启动对话时提示。
