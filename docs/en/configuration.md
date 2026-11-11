---
title: Configuration
description: Config file paths, directory layout, environment variables, preset endpoints and models, and interactive configuration management in @ai-zen/cli.
outline: deep
---

# Configuration

## Config file paths

Configuration is stored under the shared root directory (determined by `AI_ZEN_DIR`):

- **Global config**: `$AI_ZEN_DIR/config.json` (default `~/.ai-zen/config.json` when `AI_ZEN_DIR` is not set).

> The config directory is **shared** with other AI-Zen clients: every file lives under the shared root `~/.ai-zen/`, while `~/.ai-zen/cli/` holds only CLI-local preferences such as `preferences.json` (the interface language). **Sessions belong to a workspace** and live under `~/.ai-zen/workspaces/<workspaceId>/`.

`src/config.ts` keeps only the paths **this process** needs (reading, writing and bootstrapping configuration all belong to the server, reached through `ConfigPort` via `config.*` / `agent.*`):

| Name | Path | Description |
|------|------|-------------|
| `AI_ZEN_DIR` | `~/.ai-zen` (or `$AI_ZEN_DIR`) | Shared root directory |
| `projectDirs().root` | `<cwd>/.ai-zen` | Project-level config and artifacts (cwd is a parameter, not a process global) |

Everything else (`config.json`, `agents/`, `sub-agents/`, `skills/`, `tools/`, `mcp.json`, `workspaces/`) is decided by the server and the SDK; this process holds no constants for them.

"Which server / which key" comes in **three layers**, each with its own owner:

| Layer | Who supplies it | Remembered? |
|-------|-----------------|-------------|
| `--server` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN` | this run's command line / environment | no (a one-off statement) |
| `$AI_ZEN_DIR/cli/connection.json` | what the user picked on the connection screen | yes (the only layer that writes to disk) |
| `$AI_ZEN_DIR/run/server.json` + `run/token` | the server running on that machine | not the CLI's business (the client reads it) |

There is exactly one place that resolves them (`readConnectPlan` in `src/connection.ts`) and one place that writes them (`saveConnectPlan` → `connection-settings.ts` in `@ai-zen/agents-client`, `0600` + atomic write). Address/credential precedence, the default route and the `unauthorized` wording all belong to `resolve-target.ts` in the same package. The server listens on loopback only; reaching it from another machine takes a tunnel or a reverse proxy — see `agents/docs/en/deploy.md`.

### Connection screen and "remember the last server"

`ai` (the interactive UI) first checks where it connected last time:

- **reachable** → straight into the conversation (no screen);
- **unreachable / very first run** → the connection screen: `This machine` (start a server here) / `Remote` (address + token) / `Retry` / `Quit`. Submitting **verifies before it persists**: a failed attempt writes nothing, so a known-bad config never lands on disk.
- `--server` / `AI_ZEN_SERVER_URL` **override** the saved entry and are **never remembered** (trying a colleague's machine once should not change your default).

`ai "…"` (pipes / one-shot) **has nobody to ask**: with no configuration it **fails immediately** (exit code 2, one line telling you what to do) and will **never** start a local server on your behalf. Once you have picked `This machine`, one-shot calls work as before (starting the local server when needed).

### Environment variables

- **`AI_ZEN_DIR`**: overrides the shared root directory (default `~/.ai-zen`). CLI runtime data is written to `$AI_ZEN_DIR/cli/`, and shared resources (agents, skills, tools, MCP, etc.) are written to `$AI_ZEN_DIR/`.
- **`AI_ZEN_SERVER_URL`**: explicit server address, the same as `--server <url>` (`--server` wins when both are given); without it the discovery file `$AI_ZEN_DIR/run/server.json` is used.
- **`AI_ZEN_SERVER_TOKEN`**: credential for an explicit server, taking precedence over `$AI_ZEN_DIR/run/token`. There is deliberately **no** `--token` flag: argv ends up in `ps` and in your shell history.

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
      "tokenThresholds": { "handoff": 250000, "guard": 375000 },
      "reasoningPreset": "openai",
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
  "defaultImageModel": "cogview-4",
  "defaultAgent": "default",
  "defaultMigrationModel": "deepseek-flash",
  "maxToolOutput": 32768,
  "abortedMessageStrategy": "keep",
  "abortedToolRoundStrategy": "fill",
  "autoRefreshTools": "inner-loop-start"
}
```

Fields (aligned with the SDK's `AppConfig` type):

- `endpoints`: the list of API endpoints (`id`, `name`, `baseUrl`, `apiKey`, `description`).
- `models`: the list of conversation models. `tokenThresholds` sets two usage lines: `handoff` (soft line — `prompt_tokens` above it triggers a task handoff) and `guard` (hard line — aborts the round when exceeded before a request); both are **absolute values**, `guard ≈ handoff × 1.5` is recommended. `reasoningPreset` references a preset name in `reasoning-presets.json` (it decides which levels `/think` offers); absent = not adjustable. `vision` indicates whether image input is supported (which determines whether `view_image` is enabled).
- `imageModels`: the list of image-generation models (`id`, `name`, `endpointId`, `modelName`, `defaultSize`, `defaultQuality`).
- Entries in `models` / `imageModels` without `custom: true` are **factory-managed**: on every launch they are reconciled with (and replaced by) the SDK factory catalog; add `"custom": true` for your own entries (a dangling `defaultMigrationModel` falls back to the factory default). `endpoints` are never managed and always keep your configuration.
- Legacy fields `maxContextTokens` / `maxContextChars` / `reasoning` are migrated automatically on launch (the first two fold into `tokenThresholds`, `reasoning` becomes `reasoningPreset`); no manual edit is needed, and the file is written only once when a difference is detected.
- `defaultImageModel` / `defaultAgent` / `defaultMigrationModel`: the remaining defaults.
- `abortedMessageStrategy` (`keep` / `drop`) and `abortedToolRoundStrategy` (`fill` / `drop`): the **interrupt strategies**. The first decides whether the reasoning/content already produced is kept in the context after an interrupt (factory `keep`: the next turn continues the half-finished sentence; `drop` never sends it); the second decides how an interrupted or incomplete tool round is reconciled (factory `fill`: the whole round is kept and unfinished results get a reason backfilled, since `tool_calls` must pair with results; `drop` takes the whole round out). Missing or invalid values are filled with the factory defaults on launch. Both are switchable under *Configuration center → Defaults*; they are read when an Agent is **built**, so closing the configuration center rebuilds the session automatically (or run `/reload` manually).
- **Models resolve in three levels** (session override > Agent definition > `defaultModel`): the everyday model lives on the Agent definition's `modelId` (see below); `config.defaultModel` is a **fallback** used only when the Agent binds none, and it is not written by default. `/model <id>` changes the current session, `/model -a <id>` the definition, `/model -g <id>` the fallback.

## Agent definition (`agents/<id>.json`)

Each Agent binds its model in its own definition file — the **second of the three levels** (and the one that usually wins): the resolved model (session override > this field > `config.defaultModel`) drives the status bar, the credential pre-check, context thresholds and the actual API request. `/model -a` is what writes this field.

```json
{
  "id": "default",
  "name": "Default assistant",
  "modelId": "deepseek-flash",
  "messages": [ ... ],
  "modelParams": { "thinking": { "type": "enabled" }, "reasoning_effort": "high" }
}
```

- `modelId`: the bound model. **Required** — when missing, startup fails with a hint to pick a model via `/config`.
- `modelParams`: per-Agent parameter overrides, shallow-merged into the model's `defaultParams` (this is what `/think` writes). **It is cleared when switching models** so the target model falls back to its own defaults: thinking parameters are model-specific, and DeepSeek's `thinking.type: "disabled"` is rejected outright by GLM-5.3.

## Filesystem layout

```
~/.ai-zen/                    ← Shared root (AI_ZEN_DIR)
├── cli/                      ← CLI runtime data
│   └── preferences.json      ← CLI-local preferences (interface language, etc.)
├── workspaces/<workspaceId>/ ← Sessions (per workspace, shared by CLI/Desktop)
│   ├── workspace.json        ← The original path this workspace stands for
│   ├── sessions/<id>.json    ← Session archive
│   └── last-session.json     ← Pointer to this workspace's last session
├── config.json               ← Global config (endpoints, models, etc., shared by CLI/Desktop)
├── agents/                   ← Agent definitions (shared)
│   ├── default.json
│   └── my-custom-agent.json
├── sub-agents/               ← SubAgent definitions (shared)
│   ├── sub-agent-default.json
│   └── my-coder.json
├── skills/                   ← Skill directory (shared)
│   └── my-skill/SKILL.md
├── tools/                    ← User tools (shared)
│   └── my-tool.js
├── mcp.json                  ← MCP config (shared)
├── mcp-oauth/                ← MCP OAuth tokens (shared, not yet implemented)
├── run/                      ← Written by the resident server: how to reach it
│   ├── server.json           ← Discovery: host / port of the server that is running
│   └── token                 ← Credential (read or created by the server, 0600)
├── cli/                      ← The CLI's own runtime data
│   ├── connection.json       ← Last chosen server (local / remote + address, token; 0600)
│   └── preferences.json      ← UI language and similar preferences
└── logs/                     ← Diagnostics (sdk.log: SDK global log, 2MB rotation)

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
- What you can set: **endpoints** (name / Base URL / API Key / description — add, edit, delete), **models** (name / endpoint / model name / reasoning preset / handoff threshold / guard threshold / vision / description — add, edit, delete), **image models** (name / endpoint / model name / size / quality — add, edit, delete), **MCP servers** (scope switchable in-screen: global `~/.ai-zen/mcp.json` / project `<cwd>/.ai-zen/mcp.json`; name / transport stdio·http·sse / enable·disable / description / command / args / env / URL / headers — add, edit, delete), **agent definitions** (top-level `agents/*.json` and `sub-agents/*.json`; name / id / description / model / prompt [system editor] / four-dimension permissions `tools`·`skills`·`mcps`·`subagents` / custom, plus `function` for sub-agents — add, edit, delete), **defaults** (default model / image model / agent / migration model / the two interrupt strategies), and the **tool-output cap**.
- Each list is [add …] + its entries; selecting an entry opens a **detail screen** for in-place editing (`↑ ↓` to move, `Enter` to edit / toggle / choose, with confirmation for destructive actions). Editing a "factory-managed" model automatically marks it `custom: true`; the detail screen no longer exposes the `custom` toggle — it offers a **restore factory defaults** action instead (factory models / image models are replaced wholesale by their factory definition and go back to being SDK-managed; user-built entries do not show it). Deleting an endpoint first checks whether any model still references it.
- **MCP servers**: transport is a choice (stdio / http / sse), enable/disable toggles in place; args are split shell-style (quotes / escapes) into argv; env and headers open a **key-value editor sub-screen** (`KEY=VALUE`, add / edit / delete). Changes are written to the matching `mcp.json` immediately; closing the center rebuilds the session so new servers / tools take effect.
- **Agent definitions**: the list separates top-level agents from sub-agents (each with an "add" entry); the detail screen edits name / id (renaming the file) / description / model (enum) / four-dimension permissions (compact syntax `allow: a, b` or `deny: x`; empty clears the dimension); the default agent also gets a **restore factory defaults** action (reverts the prompt only, keeping name / model / permissions). Sub-agents also carry a `function` (name / description / parameters JSON schema). **Multi-line fields** (prompt / function description / parameters schema) open the **system editor** (`$EDITOR`; `notepad` on Windows) on Enter: the prompt writes back the first system message; the parameters schema opens as `.json` and is validated on save (invalid JSON is rejected while **keeping your edits** for retry); unchanged content is not written. Editing the factory-managed `default` agent auto-marks it `custom: true` so your change survives the SDK's sync.
- On first launch, if the endpoint bound to the model has no API Key, a credential screen appears first; `/key` in the chat changes the current endpoint's key (the session is rebuilt on save).
- Skills (`skills/SKILL.md`) and user tools (`tools/*.js`) still require editing the files by hand.

> Note: the CLI entry only implements the `hook` subcommand (`ai hook install|uninstall`); there is **no `config` subcommand**. If an endpoint has no API Key, pure stdio mode fails fast with a non-zero exit code, and TUI mode reports it when starting a conversation.
