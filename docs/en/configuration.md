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

Fields (aligned with the SDK's `AppConfig` type):

- `endpoints`: the list of API endpoints (`id`, `name`, `baseUrl`, `apiKey`, `description`).
- `models`: the list of conversation models. Among these, `maxContextTokens` sets the **migration threshold** (the README suggests roughly 25% of the model's actual context window). `vision` indicates whether image input is supported (which determines whether `viewImage` is enabled).
- `imageModels`: the list of image-generation models (`id`, `name`, `endpointId`, `modelName`, `defaultSize`, `defaultQuality`).
- Entries in `models` / `imageModels` without `custom: true` are **factory-managed**: on every launch they are reconciled with (and replaced by) the SDK factory catalog; add `"custom": true` for your own entries (a dangling `defaultModel` / `defaultMigrationModel` falls back to the factory default). `endpoints` are never managed and always keep your configuration.
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
| `gpt-6-astra` | GPT-6 Astra | OpenAI |
| `gpt-6.1-sol` | GPT-6.1 Sol | OpenAI |
| `gpt-6-luna` | GPT-6 Luna | OpenAI |
| `glm-5.3` | GLM-5.3 | ZhipuAI |
| `glm-5.3-flash` | GLM-5.3-Flash (vision) | ZhipuAI |
| `glm-5.3-flashx` | GLM-5.3-FlashX (vision) | ZhipuAI |
| `glm-4.7-flash` | GLM-4.7-Flash | ZhipuAI |
| `deepseek-flash` | DeepSeek-V4.1-Flash (vision) | DeepSeek (**default**) |

> The preset endpoints/models come from the SDK (`@ai-zen/agents-sdk`) `config/constants`; the CLI keeps no preset list of its own (`src/config.ts` reuses the SDK factory defaults). This table matches the README's "Preset Models" table.

## Configuration management

In the TUI, `/config` opens the **configuration center** for editing the common fields interactively — no need to hand-edit the JSON:

- Config file path: `~/.ai-zen/config.json` (or `$AI_ZEN_DIR/config.json`).
- What you can set: **endpoints** (name / Base URL / API Key / description — add, edit, delete), **models** (name / endpoint / model name / migration threshold / vision / description / custom — add, edit, delete), **image models** (name / endpoint / model name / size / quality / custom — add, edit, delete), **MCP servers** (scope switchable in-screen: global `~/.ai-zen/mcp.json` / project `<cwd>/.ai-zen/mcp.json`; name / transport stdio·http·sse / enable·disable / description / command / args / env / URL / headers — add, edit, delete), **agent definitions** (top-level `agents/*.json` and `sub-agents/*.json`; name / id / description / model / prompt [system editor] / four-dimension permissions `tools`·`skills`·`mcps`·`subagents` / custom, plus `function` for sub-agents — add, edit, delete), **defaults** (default model / image model / agent / migration model), and the **tool-output cap**.
- Each list is [add …] + its entries; selecting an entry opens a **detail screen** for in-place editing (`↑ ↓` to move, `Enter` to edit / toggle / choose, with confirmation for destructive actions). Editing a "factory-managed" model automatically marks it `custom: true`; deleting an endpoint first checks whether any model still references it.
- **MCP servers**: transport is a choice (stdio / http / sse), enable/disable toggles in place; args are split shell-style (quotes / escapes) into argv; env and headers open a **key-value editor sub-screen** (`KEY=VALUE`, add / edit / delete). Changes are written to the matching `mcp.json` immediately; closing the center rebuilds the session so new servers / tools take effect.
- **Agent definitions**: the list separates top-level agents from sub-agents (each with an "add" entry); the detail screen edits name / id (renaming the file) / description / model (enum) / four-dimension permissions (compact syntax `allow: a, b` or `deny: x`; empty clears the dimension) / the custom toggle. Sub-agents also carry a `function` (name / description / parameters JSON schema). **Multi-line fields** (prompt / function description / parameters schema) open the **system editor** (`$EDITOR`; `notepad` on Windows) on Enter: the prompt writes back the first system message; the parameters schema opens as `.json` and is validated on save (invalid JSON is rejected while **keeping your edits** for retry); unchanged content is not written. Editing the factory-managed `default` agent auto-marks it `custom: true` so your change survives the SDK's sync.
- On first launch, if the endpoint bound to the model has no API Key, a credential screen appears first; `/key` in the chat changes the current endpoint's key (the session is rebuilt on save).
- Skills (`skills/SKILL.md`) and user tools (`tools/*.js`) still require editing the files by hand.

> Note: the CLI entry only implements the `hook` subcommand (`ai hook install|uninstall`); there is **no `config` subcommand**. If an endpoint has no API Key, pure stdio mode fails fast with a non-zero exit code, and TUI mode reports it when starting a conversation.
