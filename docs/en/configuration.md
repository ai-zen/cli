---
title: Configuration
description: Config file paths, directory layout, environment variables, preset endpoints and models, and interactive configuration management in @ai-zen/cli.
outline: deep
---

# Configuration

## Config file paths

Configuration lives under the **data root** (`AI_ZEN_DIR`, default `~/.ai-zen`): `$AI_ZEN_DIR/config.json` — endpoints, models, image models and defaults all live in that one file. **The host owns it**: the CLI only reads and writes through the contract (`config.get` / `config.patch` / `config.setDefaults` …) and never assembles a whole config locally to write back.

> The data root is **shared** with the desktop app: config, the conversation database, assets, logs and agent definitions all sit under the same root; `~/.ai-zen/cli/` holds only the CLI's own four small files (see the layout below). **Conversations belong to a workspace and live in the host's database `<dataRoot>/ai-zen.db`** — not one file per session.

`src/config.ts` derives **no paths at all** (the host and the client may not be the same machine, and a second answer computed locally would be quietly wrong in a two-machine deployment): it is a vocabulary for the shapes the UI needs, every field fetched through the host's method table (`ConfigView` / `ModelView` / `DiscoveryView` …). Its header comment lists the data-root layout, matching the host's `HostPaths` (`agents/packages/host/src/config.ts`):

| Name | Path | Description |
|------|------|-------------|
| `AI_ZEN_DIR` | `~/.ai-zen` (or `$AI_ZEN_DIR`) | Data root, shared by the host and every client (this process gets it from `cliEnv()`) |

Everything else (`config.json`, `host.json`, `run/host.json`, `ai-zen.db`, `assets/`, `logs/`, `agents/`, `skills/`, `tools/`, `mcp.json` …) is decided by the host and the SDK; this process holds no constants for them. To learn the state of a layer (present / broken / missing) ask `config.getDiscovery`; for the data root's location use `configDir` from `config.get`.

"Which host / which key" comes in **three layers**, each with its own owner:

| Layer | Who supplies it | Remembered? |
|-------|-----------------|-------------|
| `--server` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN` | this run's command line / environment | no (a one-off statement) |
| `$AI_ZEN_DIR/cli/connection.json` | what the user picked on the connection screen | yes (the only layer that writes to disk) |
| `$AI_ZEN_DIR/run/host.json` + `run/token` | the host running on that machine | not the CLI's business (the client reads it) |

There is exactly one place that resolves them (`readConnectPlan` in `src/connection.ts`) and one place that writes them (`saveConnectPlan` → `connection-settings.ts` in `@ai-zen/agents-client`, `0600` + atomic write). Address/credential precedence, the default route and the `unauthorized` wording all belong to `resolve-target.ts` in the same package. The host binds loopback by default (`agents-host serve` → `127.0.0.1:8790`); reaching it from another machine takes a tunnel or a reverse proxy — see `agents/docs/en/deploy.md`.

### Connection screen and "remember the last host"

`ai` (the interactive UI) first checks where it connected last time:

- **reachable** → straight into the conversation (no screen);
- **unreachable / very first run** → the connection screen: `This machine` (bring a host up here with `npx`) / `Remote` (address + token) / `Retry` / `Quit`. Submitting **verifies before it persists**: a failed attempt writes nothing, so a known-bad config never lands on disk.
- `--server` / `AI_ZEN_SERVER_URL` **override** the saved entry and are **never remembered** (trying a colleague's machine once should not change your default).

`ai "…"` (pipes / one-shot) **has nobody to ask**: with no configuration it **fails immediately** (exit code 2, one line telling you what to do) and will **never** bring a local host up on your behalf. Once you have picked `This machine`, one-shot calls work as before (fetching and starting a host through `npx` when needed).

### Environment variables

- **`AI_ZEN_DIR`**: overrides the data root (default `~/.ai-zen`). The CLI's own four small files go to `$AI_ZEN_DIR/cli/`; config, the database, assets, logs and agent definitions live under `$AI_ZEN_DIR/` (read and written by the host and the SDK).
- **`AI_ZEN_SERVER_URL`**: explicit host address, the same as `--server <url>` (`--server` wins when both are given); without it the discovery file `$AI_ZEN_DIR/run/host.json` is used.
- **`AI_ZEN_SERVER_TOKEN`**: credential for an explicit host, taking precedence over `$AI_ZEN_DIR/run/token`. There is deliberately **no** `--token` flag: argv ends up in `ps` and in your shell history.

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
~/.ai-zen/                    ← Data root (AI_ZEN_DIR), shared by the host and the desktop app
├── ai-zen.db                 ← The database: workspaces, conversations, messages, notices, questions, credentials
├── assets/                   ← Attachments (the database only stores references)
├── config.json               ← SDK config: endpoints / models / image models / defaults / caps / behavior switches
├── host.json                 ← The host's own settings (currently just `port`)
├── run/                      ← Written by the host, read by clients: who is serving on this machine
│   ├── host.json             ← Discovery file (pid, listening address and port)
│   └── token                 ← Local credential (read or generated by the host, 0600)
├── logs/                     ← one directory per process; each is written by exactly one process
│   ├── host/
│   │   └── host.log          ← Host log (size-based rotation: host.log.1 …)
│   └── cli/
│       ├── cli.log           ← CLI log (2MB rotation; warn / error also surface in the notice bar and are cleared when you send a message)
│       ├── launch.log        ← Output of the host process this CLI spawned (rewritten on every launch — the failure reason lives here)
│       └── keys.log          ← Key diagnostics (only with AIZ_DEBUG_KEYS=1; AIZ_KEYS_FILE overrides)
├── agents/                   ← Agent definitions (one file per entity; this is the only place, projects do not override)
│   ├── default.json
│   └── my-custom-agent.json
├── sub-agents/               ← Sub-agent definitions
├── skills/                   ← User-level Skills
│   └── my-skill/SKILL.md
├── tools/                    ← User-level tools
├── mcp.json                  ← User-level MCP (one layer of the five-layer chain)
├── mcp-oauth/                ← MCP OAuth tokens (directory created by the SDK; the flow is not implemented yet)
└── cli/                      ← The CLI's own four small files (the host never reads them)
    ├── connection.json       ← Last host this CLI connected to (local / remote + address, token; 0600)
    ├── preferences.json      ← UI language and similar local preferences
    ├── last-workspace.json   ← The workspace this machine entered last
    └── last-conversation.json ← The conversation entered last (resumed on the next launch)

/path/to/project/             ← A workspace: what the host reads inside a project
├── .mcp.json                 ← Project-shared MCP (committable, read-only)
├── .agents/                  ← Industry-convention directory (Cursor / Windsurf / Cline)
│   ├── mcp.json              ← read-only
│   ├── skills/               ← project Skills
│   ├── tools/                ← project tools
│   └── sub-agents/           ← project sub-agents
└── .ai-zen/
    ├── mcp.json              ← the only writable MCP layer on the project side (scope = workspace)
    ├── skills/               ← project Skills
    └── handoffs/             ← handoff documents (<YYYYMMDD-HHmmss>.md)
```

Industry-convention directories: `~/.agents/` and `<project>/.agents/` (`skills/`, `tools/`, `sub-agents/`, `mcp.json`); the host only reads those two layers.

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
- What you can set: **endpoints** (name / Base URL / API Key / description — add, edit, delete), **models** (name / endpoint / model name / reasoning preset / handoff threshold / guard threshold / vision / description — add, edit, delete), **image models** (name / endpoint / model name / size / quality — add, edit, delete), **MCP servers** (scope switchable in-screen: user-level `$AI_ZEN_DIR/mcp.json` / workspace `<cwd>/.ai-zen/mcp.json` — the only two writable layers of the five-layer MCP chain; name / transport stdio·http·sse / enable·disable / description / command / args / env / URL / headers — add, edit, delete), **agent definitions** (top-level `agents/*.json` and `sub-agents/*.json`; name / id / description / model / prompt [system editor] / four-dimension permissions `tools`·`skills`·`mcps`·`subagents` / custom, plus `function` for sub-agents — add, edit, delete), **defaults** (default model / image model / agent / migration model / the two interrupt strategies), and the **tool-output cap**.
- Each list is [add …] + its entries; selecting an entry opens a **detail screen** for in-place editing (`↑ ↓` to move, `Enter` to edit / toggle / choose, with confirmation for destructive actions). Editing a "factory-managed" model automatically marks it `custom: true`; the detail screen no longer exposes the `custom` toggle — it offers a **restore factory defaults** action instead (factory models / image models are replaced wholesale by their factory definition and go back to being SDK-managed; user-built entries do not show it). Deleting an endpoint first checks whether any model still references it.
- **MCP servers**: transport is a choice (stdio / http / sse), enable/disable toggles in place; args are split shell-style (quotes / escapes) into argv; env and headers open a **key-value editor sub-screen** (`KEY=VALUE`, add / edit / delete). Changes are written to the matching `mcp.json` immediately; closing the center rebuilds the session so new servers / tools take effect.
- **Agent definitions**: the list separates top-level agents from sub-agents (each with an "add" entry); the detail screen edits name / id (renaming the file) / description / model (enum) / four-dimension permissions (compact syntax `allow: a, b` or `deny: x`; empty clears the dimension); the default agent also gets a **restore factory defaults** action (reverts the prompt only, keeping name / model / permissions). Sub-agents also carry a `function` (name / description / parameters JSON schema). **Multi-line fields** (prompt / function description / parameters schema) open the **system editor** (`$EDITOR`; `notepad` on Windows) on Enter: the prompt writes back the first system message; the parameters schema opens as `.json` and is validated on save (invalid JSON is rejected while **keeping your edits** for retry); unchanged content is not written. Editing the factory-managed `default` agent auto-marks it `custom: true` so your change survives the SDK's sync.
- On first launch, if the endpoint bound to the model has no API Key, a credential screen appears first; `/key` in the chat changes the current endpoint's key (the session is rebuilt on save).
- Skills (`skills/SKILL.md`) and user tools (`tools/*.js`) still require editing the files by hand.

> Note: the CLI entry only implements the `hook` subcommand (`ai hook install|uninstall`); there is **no `config` subcommand**. If an endpoint has no API Key, pure stdio mode fails fast with a non-zero exit code, and TUI mode reports it when starting a conversation.
