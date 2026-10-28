---
title: Quick Start
description: Install @ai-zen/cli, enter the chat screen, and use conversation commands and the shell fallback hook.
outline: deep
---

# Quick Start

## Overview

`@ai-zen/cli`'s executable entry is `ai` (with transition aliases `aiz` / `zen`, all pointing to `dist/index.js`). Running it without arguments on an interactive terminal opens the **chat screen** directly (TUI); passing arguments, or piping/redirecting, runs **pure stdio mode** (result on stdout, logs on stderr).

## Requirements

- **Node.js**: the package is published as ESM (`"type": "module"`). `package.json` does not declare an `engines` field, so the actual required version follows the Node ecosystem (a recent LTS is recommended).
- **Runtime dependencies** (declared in `package.json`):
  - `@ai-zen/agents-core` `^4.5.3`
  - `@ai-zen/agents-sdk` `1.0.0-alpha.23`
  - `@modelcontextprotocol/sdk` `^1.29.0`
  - `dayjs`, `ink`, `react`, `zod`, `highlight.js`, `lowlight`
- **Platform**: the underlying tools and the Shell hook depend on a Unix shell (`bash`/`zsh`) and `process.env.SHELL`; the Shell hook is unavailable on Windows (`hook` will report "unsupported shell").

## Installation

### Global install

```bash
npm install -g @ai-zen/cli
```

### Build from source

```bash
git clone git@github.com:ai-zen/cli.git
cd cli
pnpm install
pnpm build
npm install -g .
```

> The project uses `pnpm` for dependency management; the build command is `pnpm build` (i.e. `tsc`).

## Run modes

The CLI has two **non-mixing** run modes, chosen automatically from the launch arguments and the terminal environment:

| Mode | Trigger | Audience | Behavior |
|------|---------|----------|----------|
| **Pure stdio** | Arguments present, **or** stdin/stdout is not a TTY (pipe, redirect, CI) | Scripts, pipes | No extra interaction; writes the final answer as plain text to stdout |
| **TUI** | No arguments and both stdin/stdout are TTYs; or `--tui` | Human users, shell fallback hook | Interactive chat UI |

In pure stdio mode, logs / progress / errors all go to **stderr**; stdout carries the result only (no ANSI / emoji / spinner). Exit code is `0` on success and non-zero on failure; nothing is persisted by default (use `--save` to keep a conversation archive).

Two modifiers refine this: `--tui` forces the interactive UI (the arguments are auto-sent as the first message; in a non-TTY environment it fails instead of degrading to pipe mode), and `--new` starts a **fresh conversation** instead of resuming the last one in this directory (TUI only; ignored on the stdio path, where a run is always a one-off session).

## Quick example

```bash
# TUI: no arguments, interactive terminal
ai

# Pure stdio: argument is the prompt, result goes to stdout
ai Hello, please introduce yourself.

# Pipe: stdin is the content, the argument is the instruction
cat README.md | ai "summarize in three sentences"
```

On start, an animated gradient ASCII splash appears, then you land **directly in the chat screen** (rendered with Ink/React) — resuming the last session if there is one, otherwise starting a new conversation. The chat screen is **bottom-pinned**: a divider, the input line, and the status bar always sit at the bottom of the terminal, while the conversation scrolls above them. While generating, the input row is replaced by a **phase indicator** (connecting → queued → thinking → calling a tool → waiting for the tool to return → streaming).

If the round spawns sub-agents, a **main / sub-agent bar** appears below the transcript (`主AGENT　◈子AGENT1　◈子AGENT2`): `←` / `→` switches which agent's conversation the transcript shows, the diamond shows each one's state (blue blinking while running / green when done / red when failed), and the bar disappears once this round's inner loop finishes.

The chat screen provides a streaming output area, a multiline input (`Enter` sends, `Ctrl+N` inserts a newline, `← →` move the cursor, `Ctrl+← →` by word, `Ctrl+W` / `Alt+Backspace` delete the previous word, `Alt+D` / `Ctrl+Delete` the next word, `Ctrl+K` kills to end of line, `Ctrl+U` kills to line start, `Esc` clears the input, `PgUp` / `PgDn` (or `Alt+V` / `Ctrl+V`) scroll the transcript), and an inline `/` command menu. Tool calls render as `⚙ name(args)` with **JSON highlighting**; the answer/reasoning is **Markdown-source-colored** (headings / bold / italic / inline code / lists / quotes / links), and fenced code blocks are highlighted by language with the **fence markers kept**.

### First-run setup (API Key)

On first launch, if the endpoint bound to the selected model has no API Key yet, a **credential screen** appears before the chat screen:

```
 ? First-run setup · Set the API Key for DeepSeek
 Endpoint: DeepSeek · https://api.deepseek.com/v1
 Current: not set
 Get a key at: https://platform.deepseek.com/api_keys
 Saving enters the chat immediately (Esc aborts and exits).
 ❯ ▏
```

Press `Enter` to save (written to `~/.ai-zen/config.json`) and **land directly in the chat**; `Tab` toggles plaintext for verification, `Esc` aborts and exits. Inside the chat you can still use `/key` to change the current endpoint's key and `/config` to open the configuration center.

## Conversation commands

All in-conversation commands start with `/`; use `/help` to list them. Typing `/` lists the available commands, with descriptions, right below the input line; typing more characters narrows the candidates by prefix:

```
💬 You: /b
  /back         Undo messages (roll back to a specific point and resend)
```

| Command | Description |
|---------|-------------|
| `/exit` `/quit` | Exit the conversation (offers to save) |
| `/save` | Save the conversation |
| `/new` | Reset the session (clear history) |
| `/back` | Retract the last message (edit and resend) |
| `/editor` | Compose a long message in your editor |
| `/clear` | Clear the screen |
| `/config` | Open the configuration center (model / endpoints) |
| `/model` | Switch model (writes to config) |
| `/agent` | Switch the primary agent (rebuilds the session) |
| `/reload` | Refresh the runtime (rediscovers tools / MCP) |
| `/update` | Upgrade the CLI to the newest published release (highest semver across all dist-tags; shows each step and offers to restart into the new version) |
| `/mcp` | Manage MCP servers (add / remove / edit / toggle) |
| `/lang` | Switch interface language |
| `/think` `/effort` | Switch reasoning effort |
| `/key` | Set the endpoint API key |
| `/migrate` | Hand off and start a new session |
| `/load` | Load a conversation (replaces this one) |
| `/help` | Show help |

> Note: typing `/` lists candidate commands below the input line (↑↓ to choose, `Tab` to complete, `Enter` to submit/run). Commands are matched by their full names; an unrecognized `/xxx` reports "Unknown command".

## Shell fallback hook

Unrecognized terminal commands can be automatically forwarded to the AI for processing:

```bash
# Install the hook (writes to ~/.zshrc or ~/.bashrc)
ai hook install

# Afterwards, just type something:
> what's the weather today?
# This is forwarded to the AI instead of showing "command not found"

# Uninstall
ai hook uninstall
```

> The hook is only available on `bash` / `zsh` (it depends on `process.env.SHELL`); other shells are not supported. The hook body calls `ai --tui --new "$@"`: it opens the **interactive UI**, auto-sends the mistyped command as the first message, and always starts a **fresh conversation** (nothing is appended to the long conversation you had in that directory). If an older hook is installed, re-running `ai hook install` upgrades the function body in place (it compares the installed block with the current version and overwrites when they differ).

## Configuring the API Key

`~/.ai-zen/config.json` (or `$AI_ZEN_DIR/config.json`) is the **single source of truth**; the TUI can edit the common fields for you, so you rarely need to touch the JSON by hand:

| Scenario | How |
|----------|-----|
| First launch, endpoint has no key | The **credential screen** appears automatically; entering a key saves it and enters the chat |
| Change the key of the **endpoint used by the current model** | `/key` in the chat (the session is rebuilt on save, so it takes effect immediately) |
| Endpoint key / base URL, default model, add endpoint | `/config` → "Endpoint management" |
| Model used by the current session | `/model` in the chat (writes the Agent's `modelId`) |
| Reasoning effort | `/think` in the chat (written into the current Agent's `reasoningEffort`; available levels come from the preset referenced by the model in `~/.ai-zen/reasoning-presets.json`, which you can extend) |
| Models / image models / MCP servers / agent definitions / defaults / tool-output cap | `/config` → configuration center |

> Note: the CLI entry only implements the `hook` subcommand (`ai hook install|uninstall`); there is **no `config` subcommand** — configuration editing happens inside the TUI (endpoints, models, image models, MCP servers, agent definitions, defaults and the tool-output cap can all be added/edited/deleted under `/config`). See [Configuration](./configuration.md).

> Pure stdio mode (arguments / pipes) has no interactive channel: a missing API Key fails fast on stderr with a non-zero exit code. Configure it in the TUI or edit `config.json` first.

## Reasoning presets (`reasoning-presets.json`)

`~/.ai-zen/reasoning-presets.json` sits next to `config.json` and maps **level name → request-parameter patch**. Endpoints disagree on `thinking` / `reasoning_effort`, and all of that lives in this table.

The table ships with the SDK (**CLI and desktop share the same level knowledge**, it should not be written twice), but the SDK **never uses it to build request parameters** — the CLI consults it only at the moment you pick a level, to:
1. decide which levels `/think` offers;
2. write the chosen level's **parameter patch into the Agent definition** (`modelParams`).

Factory presets:

| Preset | Levels | Can thinking be disabled? |
|------|------|-----------|
| `openai` | `minimal` / `low` / `medium` / `high` / `off` | Yes (`reasoning_effort: "none"`) |
| `zhipu-5.3` | `low` / `high` / `max` | **No** (no `off` key; the vendor rejects it too) |
| `deepseek` | `low` / `high` / `max` / `off` | Yes (`thinking.type: "disabled"`) |

To onboard a new endpoint, copy a table and rename it, then set `/config` → Model → “Reasoning preset” to that name; `/think` immediately offers its levels:

```json
{
  "my-endpoint": {
    "levels": {
      "fast": { "reasoning_effort": "low" },
      "deep": { "reasoning_effort": "high" }
    }
  }
}
```

- The keys of the table **are** the menu entries; there is no separate “can it be disabled” switch;
- Adding `"custom": true` to a preset means “I own this table” — upgrades stop overwriting it (other presets still sync);
- Custom level names are shown verbatim in the status bar (`fast` / `deep`), never as a blank.

> **Configuration is the fact**: `/think high` writes `{"thinking":{"type":"enabled"},"reasoning_effort":"high"}` straight into `~/.ai-zen/agents/<id>.json` under `modelParams`, instead of storing a level name and looking it up at runtime. So **editing the preset table does not retroactively change Agents already configured** — they hold the parameters from that moment. Run `/think` again to update them.

## Development and testing

```bash
pnpm install
pnpm build
pnpm start

# Unit tests
pnpm test

# E2E (requires API Key in .env.local)
pnpm test:e2e
```

> See the `scripts` field in `package.json`. `test:all` runs typecheck, unit tests, build, and E2E in sequence.
