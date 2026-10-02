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
  - `@ai-zen/agents-core` `^4.3.0`
  - `@ai-zen/agents-sdk` `1.0.0-alpha.2`
  - `@modelcontextprotocol/sdk` `^1.29.0`
  - `dayjs`, `ink`, `react`, `zod`
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
| **Pure stdio** | Arguments present, **or** stdin/stdout is not a TTY (pipe, redirect, CI) | Scripts, pipes, shell fallback hook | No extra interaction; writes the final answer as plain text to stdout |
| **TUI** | No arguments and both stdin/stdout are TTYs | Human users | Interactive chat UI |

In pure stdio mode, logs / progress / errors all go to **stderr**; stdout carries the result only (no ANSI / emoji / spinner). Exit code is `0` on success and non-zero on failure; nothing is persisted by default (use `--save` to keep a conversation archive).

## Quick example

```bash
# TUI: no arguments, interactive terminal
ai

# Pure stdio: argument is the prompt, result goes to stdout
ai Hello, please introduce yourself.

# Pipe: stdin is the content, the argument is the instruction
cat README.md | ai "summarize in three sentences"
```

On start, an animated gradient ASCII splash appears, then you land **directly in the chat screen** (rendered with Ink/React) — resuming the last session if there is one, otherwise starting a new conversation. The chat screen is **bottom-pinned**: a divider, the input line, and the status bar always sit at the bottom of the terminal, while the conversation scrolls above them.

The chat screen provides a streaming output area, a multiline input (`Enter` sends, `Ctrl+N` inserts a newline, `← →` move the cursor, `Ctrl+← →` by word), and an inline `/` command menu.

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
| `/exit` `/quit` | Exit the conversation (prompts to save) |
| `/save` | Save the current conversation |
| `/new` | Reset the session (clear history, replace with the Agent-defined initial message) |
| `/back` | Undo a message (select a user message to edit and resend, or select a tool result to continue asking) |
| `/editor` | Use the system editor to enter a long message |
| `/clear` | Clear the screen |
| `/config` | Open the configuration center (default model / endpoint management) |
| `/key` | Set the API Key of the current endpoint (rebuilds the session on save) |
| `/migrate` | Manually trigger task migration (generate a handoff document and start a new session) |
| `/load` | Load a saved conversation (replaces the current session) |
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

> The hook is only available on `bash` / `zsh` (it depends on `process.env.SHELL`); other shells are not supported. The hook body calls `ai "$@"` (pure stdio mode) so the answer is printed in your current shell session; if the legacy `aiz` hook is installed, re-running `ai hook install` upgrades it automatically.

## Configuring the API Key

`~/.ai-zen/config.json` (or `$AI_ZEN_DIR/config.json`) is the **single source of truth**; the TUI can edit the common fields for you, so you rarely need to touch the JSON by hand:

| Scenario | How |
|----------|-----|
| First launch, endpoint has no key | The **credential screen** appears automatically; entering a key saves it and enters the chat |
| Change the key of the **endpoint used by the current model** | `/key` in the chat (the session is rebuilt on save, so it takes effect immediately) |
| Endpoint key / base URL, default model, add endpoint | `/config` → "Endpoint management" |
| Models / image models / MCP servers / defaults / tool-output cap | `/config` → configuration center |

> Note: the CLI entry only implements the `hook` subcommand (`ai hook install|uninstall`); there is **no `config` subcommand** — configuration editing happens inside the TUI (endpoints, models, image models, MCP servers, defaults and the tool-output cap can all be added/edited/deleted under `/config`). See [Configuration](./configuration.md).

> Pure stdio mode (arguments / pipes) has no interactive channel: a missing API Key fails fast on stderr with a non-zero exit code. Configure it in the TUI or edit `config.json` first.

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
