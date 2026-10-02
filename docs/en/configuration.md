---
title: Configuration
description: Config file paths, directory layout, environment variables, preset endpoints and models, and interactive configuration management in @ai-zen/cli.
outline: deep
---

# Configuration

## Config file paths

Configuration is stored under the shared root directory (determined by `AI_ZEN_DIR`):

- **Global config**: `$AI_ZEN_DIR/config.json` (default `~/.ai-zen/config.json` when `AI_ZEN_DIR` is not set).

> The config directory is **shared** with other AI-Zen clients: the config file lives in the shared root (`CONFIG_FILE = join(AI_ZEN_DIR, "config.json")` in `src/config.ts`), while `~/.ai-zen/cli/` holds CLI runtime data such as `conversations/` and `last-session.json` (the "last session id" pointer).

Key paths defined in `src/config.ts`:

| Constant | Path | Description |
|----------|------|-------------|
| `AI_ZEN_DIR` | `~/.ai-zen` (or `$AI_ZEN_DIR`) | Shared root directory |
| `CLI_DIR` | `$AI_ZEN_DIR/cli` | CLI runtime directory |
| `CONFIG_FILE` | `$AI_ZEN_DIR/config.json` | Global config (shared by CLI/Desktop) |
| `CONVERSATIONS_DIR` | `$AI_ZEN_DIR/cli/conversations` | Conversation records |
| `AGENTS_DIR` | `$AI_ZEN_DIR/agents` | Agent definitions (shared) |
| `SUB_AGENTS_DIR` | `$AI_ZEN_DIR/sub-agents` | SubAgent definitions (shared) |
| `SKILLS_DIR` | `$AI_ZEN_DIR/skills` | Skill directory (shared) |
| `TOOLS_DIR` | `$AI_ZEN_DIR/tools` | User tools (shared) |
| `MCP_CONFIG_FILE` | `$AI_ZEN_DIR/mcp.json` | MCP config (shared) |

### Environment variables

- **`AI_ZEN_DIR`**: overrides the shared root directory (default `~/.ai-zen`). CLI runtime data is written to `$AI_ZEN_DIR/cli/`, and shared resources (agents, skills, tools, MCP, etc.) are written to `$AI_ZEN_DIR/`.

## config.json structure

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
      "id": "cogview-4",
      "name": "CogView-4",
      "endpointId": "bigmodelcn",
      "modelName": "cogview-4",
      "defaultSize": "1024x1024"
    }
  ],
  "defaultModel": "deepseek-v4-flash",
  "defaultImageModel": "cogview-4",
  "defaultAgent": "default",
  "defaultMigrationModel": "deepseek-v4-flash"
}
```

Fields (aligned with the SDK's `AppConfig` type):

- `endpoints`: the list of API endpoints (`id`, `name`, `baseUrl`, `apiKey`, `description`).
- `models`: the list of conversation models. Among these, `maxContextTokens` sets the **migration threshold** (the README suggests roughly 25% of the model's actual context window). `vision` indicates whether image input is supported (which determines whether `viewImage` is enabled).
- `imageModels`: the list of image-generation models (`id`, `name`, `endpointId`, `modelName`, `defaultSize`, `defaultQuality`).
- `defaultModel` / `defaultImageModel` / `defaultAgent` / `defaultMigrationModel`: the various defaults.

## Filesystem layout

```
~/.ai-zen/                    ← Shared root (AI_ZEN_DIR)
├── cli/                      ← CLI runtime data
│   ├── conversations/        ← CLI conversations
│   └── last-session.json     ← Pointer to the last session id
├── config.json               ← Global config (endpoints, models, etc., shared by CLI/Desktop)
├── agents/                   ← Agent definitions (shared)
│   ├── default.json
│   └── my-custom-agent.json
├── sub-agents/               ← SubAgent definitions (shared)
│   ├── general-assistant.json
│   └── my-coder.json
├── skills/                   ← Skill directory (shared)
│   └── my-skill/SKILL.md
├── tools/                    ← User tools (shared)
│   └── my-tool.js
├── mcp.json                  ← MCP config (shared)
└── mcp-oauth/                ← MCP OAuth tokens (shared, not yet implemented)

/path/to/project/
├── .mcp.json                 ← Project-shared MCP config (committable)
└── .ai-zen/
    ├── mcp.json              ← Project-personal MCP config (not committed)
    ├── skills/               ← Project Skill directory
    ├── tools/                ← Project tool directory
    ├── sub-agents/           ← Project SubAgent directory
    └── agents/               ← Project Agent directory (overrides user-level)
```

Industry-convention directories: `~/.agents/` and `<project>/.agents/` (`skills/`, `mcp.json`).

## Preset endpoints

| ID | Name | Default Base URL |
|----|------|-----------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (ZhipuAI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## Preset models

| ID | Name | Endpoint |
|----|------|----------|
| `gpt-5.5` | GPT-5.5 | OpenAI |
| `glm-5.1` | GLM-5.1 | ZhipuAI |
| `glm-5v-turbo` | GLM-5V-Turbo (vision) | ZhipuAI |
| `glm-4.7-flash` | GLM-4.7-Flash | ZhipuAI |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek (**default**) |
| `deepseek-v4-flash-vision-exp` | DeepSeek-V4-Flash-Vision-Exp (vision) | DeepSeek |

> The preset endpoints/models come from the SDK (`@ai-zen/agents-sdk`) `config/constants`; the CLI keeps no preset list of its own (`src/config.ts` reuses the SDK factory defaults). This table matches the README's "Preset Models" table.

## Configuration management

The in-TUI **interactive configuration screen has been removed** (tracked as a P1 TODO and to be reimplemented with native Ink components). For now, edit the config file directly:

- Config file path: `~/.ai-zen/config.json` (or `$AI_ZEN_DIR/config.json`).
- What you can set: API endpoints (name, Base URL, API Key, description), the default conversation / image-generation model, the default Agent, MCP servers, etc.
- MCP servers can also be maintained separately in `~/.ai-zen/mcp.json` (see [MCP Support](./mcp.md)).

> Note: the CLI entry only implements the `hook` subcommand (`ai hook install|uninstall`); there is **no `config` subcommand**. If an endpoint has no API Key, pure stdio mode fails fast with a non-zero exit code, and TUI mode reports it when starting a conversation.
