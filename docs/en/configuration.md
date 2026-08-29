---
title: Configuration
description: Config file paths, directory layout, environment variables, preset endpoints and models, and interactive configuration management in @ai-zen/cli.
outline: deep
---

# Configuration

## Config file paths

Configuration is stored under the shared root directory (determined by `AI_ZEN_DIR`):

- **Global config**: `$AI_ZEN_DIR/config.json` (default `~/.ai-zen/config.json` when `AI_ZEN_DIR` is not set).

> ⚠️ The README claims configuration is at `~/.ai-zen/cli/config.json`, but in the **source**, `CONFIG_FILE = join(AI_ZEN_DIR, "config.json")` in `src/config.ts`, i.e. configuration is at `~/.ai-zen/config.json`, **shared** with the CLI/Desktop. The source is authoritative. The `~/.ai-zen/cli/` directory holds CLI runtime data such as `conversations/` and `drafts/`.

Key paths defined in `src/config.ts`:

| Constant | Path | Description |
|----------|------|-------------|
| `AI_ZEN_DIR` | `~/.ai-zen` (or `$AI_ZEN_DIR`) | Shared root directory |
| `CLI_DIR` | `$AI_ZEN_DIR/cli` | CLI runtime directory |
| `CONFIG_FILE` | `$AI_ZEN_DIR/config.json` | Global config (shared by CLI/Desktop) |
| `CONVERSATIONS_DIR` | `$AI_ZEN_DIR/cli/conversations` | Conversation records |
| `DRAFTS_DIR` | `$AI_ZEN_DIR/cli/drafts` | Drafts |
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
│   └── drafts/               ← CLI drafts
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
| `glm-5.2` | GLM-5.2 | ZhipuAI |
| `glm-5.1` | GLM-5.1 | ZhipuAI |
| `glm-5` | GLM-5 | ZhipuAI |
| `glm-5-turbo` | GLM-5-Turbo | ZhipuAI |
| `glm-5v-turbo` | GLM-5V-Turbo | ZhipuAI |
| `glm-4.7-flash` | GLM-4.7-Flash | ZhipuAI |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek (**default**) |

> The preset endpoints/models come from `src/config-wizard.ts` and SDK constants. **Note**: `package.json`/README do not explicitly list these preset values; the actual data follows the SDK (`@ai-zen/agents-sdk`) constants — to confirm precisely, consult the SDK's `config/constants`.

## Interactive configuration management

At the main menu, choose **Configuration** to:

- View the current configuration overview (endpoints, default model, default image model, default Agent, MCP servers, config file path).
- Set the default conversation model / default image-generation model.
- Set the API Key (interactive password input).
- Edit API endpoints (name, Base URL, API Key, description).
- View all API, conversation, and image-generation models.
- Manage MCP servers (add/edit/delete).

> Note: the CLI entry (`src/index.ts`) only implements the `hook` subcommand; there is **no `config` subcommand**. A hint text in the source refers to `aiz config set-key`, which is currently not implemented — use the interactive main menu for configuration. When you first encounter an endpoint without an API Key set, an interactive input wizard will appear.
