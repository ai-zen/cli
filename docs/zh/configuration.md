---
title: 配置
description: @ai-zen/cli 的配置文件路径、目录布局、环境变量、预设端点与模型，以及交互式配置管理。
outline: deep
---

# 配置

## 配置文件路径

配置存储在共享根目录下（由 `AI_ZEN_DIR` 决定）：

- **全局配置**：`$AI_ZEN_DIR/config.json`（默认 `~/.ai-zen/config.json`，当未设置 `AI_ZEN_DIR` 时为 `~/.ai-zen/config.json`）。

> ⚠️ README 声称配置位于 `~/.ai-zen/cli/config.json`，但**源码**中 `src/config.ts` 的 `CONFIG_FILE = join(AI_ZEN_DIR, "config.json")`，即配置在 `~/.ai-zen/config.json`，与 CLI/Desktop **共享**。以上以源码为准。`~/.ai-zen/cli/` 目录下存放的是 `conversations/` 与 `drafts/` 这类 CLI 运行时数据。

`src/config.ts` 定义的关键路径：

| 常量 | 路径 | 说明 |
|------|------|------|
| `AI_ZEN_DIR` | `~/.ai-zen`（或 `$AI_ZEN_DIR`） | 共享根目录 |
| `CLI_DIR` | `$AI_ZEN_DIR/cli` | CLI 运行时目录 |
| `CONFIG_FILE` | `$AI_ZEN_DIR/config.json` | 全局配置（CLI/Desktop 共享） |
| `CONVERSATIONS_DIR` | `$AI_ZEN_DIR/cli/conversations` | 对话记录 |
| `DRAFTS_DIR` | `$AI_ZEN_DIR/cli/drafts` | 草稿 |
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

字段（与 SDK 的 `AppConfig` 类型对齐）：

- `endpoints`：API 端点列表（`id`、`name`、`baseUrl`、`apiKey`、`description`）。
- `models`：对话模型列表。其中 `maxContextTokens` 设定**迁移阈值**（README 建议约为模型实际上下文窗口的 25%）。`vision` 表示是否支持图片输入（决定 `viewImage` 是否启用）。
- `imageModels`：图片生成模型列表（`id`、`name`、`endpointId`、`modelName`、`defaultSize`、`defaultQuality`）。
- `defaultModel` / `defaultImageModel` / `defaultAgent` / `defaultMigrationModel`：各默认项。

## 文件系统布局

```
~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
├── cli/                      ← CLI 运行时数据
│   ├── conversations/        ← CLI 对话
│   └── drafts/               ← CLI 草稿
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
| `gpt-5.5` | GPT-5.5 | OpenAI |
| `glm-5.2` | GLM-5.2 | ZhipuAI |
| `glm-5.1` | GLM-5.1 | ZhipuAI |
| `glm-5` | GLM-5 | ZhipuAI |
| `glm-5-turbo` | GLM-5-Turbo | ZhipuAI |
| `glm-5v-turbo` | GLM-5V-Turbo | ZhipuAI |
| `glm-4.7-flash` | GLM-4.7-Flash | ZhipuAI |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek（**默认**） |

> 预设端点/模型列表来源于 `src/config-wizard.ts` 与 SDK 常量。**注意**：`package.json`/README 未明确列出这些预设值，实际数据以 SDK (`@ai-zen/agents-sdk`) 的常量为准——如需精确核对，请查阅 SDK 的 `config/constants`。

## 交互式配置管理

在主菜单选择 **配置管理**，可进行：

- 查看当前配置总览（端点、默认模型、默认图片模型、默认 Agent、MCP 服务器、配置文件路径）。
- 设置默认对话模型 / 默认图片生成模型。
- 设置 API Key（交互式密码输入）。
- 编辑 API 端点（名称、Base URL、API Key、描述）。
- 查看所有 API、对话模型、图片生成模型。
- 管理 MCP 服务器（新增/编辑/删除）。

> 注意：CLI 的入口（`src/index.ts`）只实现了 `hook` 子命令；**没有 `config` 子命令**。源码中的一句提示文案引用了 `aiz config set-key`，当前并未实现，请使用交互式主菜单完成配置。首次遇到未设置 API Key 的端点也会弹出交互式输入向导。
