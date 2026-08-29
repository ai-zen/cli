---
title: Quick Start
description: Install @ai-zen/cli, enter the main menu, and use conversation commands and the shell fallback hook.
outline: deep
---

# Quick Start

## Overview

`@ai-zen/cli` provides two executable entries: `aiz` and `zen` (both point to `dist/index.js`). Running it without arguments enters the **interactive main menu**; passing an argument starts a conversation with that argument as the initial message.

## Requirements

- **Node.js**: the package is published as ESM (`"type": "module"`). `package.json` does not declare an `engines` field, so the actual required version follows the Node ecosystem (a recent LTS is recommended).
- **Runtime dependencies** (declared in `package.json`):
  - `@ai-zen/agents-core` `^4.0.0`
  - `@ai-zen/agents-sdk` `^0.9.0`
  - `@modelcontextprotocol/sdk` `^1.29.0`
  - `chalk`, `dayjs`, `inquirer`, `zod`
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

## Quick example

```bash
# Enter the interactive main menu
zen

# Start a conversation directly (the argument becomes the initial message)
zen Hello, please introduce yourself.
```

After starting, the main menu appears:

```
🤖 Welcome to AI-Zen CLI

? Select an action:
  ▶️  Continue last unfinished conversation  (if draft exists)
  💬  Start a new conversation
  📂  Continue a saved conversation
  📋  Manage saved conversations
  🤖  Manage Agents
  ⚙️   Configuration
  ❌  Exit
```

## Conversation commands

All in-conversation commands start with `/`; use `/help` to list them:

| Command | Description |
|---------|-------------|
| `/exit` `/quit` | Exit the conversation (prompts to save) |
| `/save` | Save the current conversation |
| `/new` | Reset the session (clear history, replace with the Agent-defined initial message) |
| `/back` | Undo a message (select a user message to edit and resend, or select a tool result to continue asking) |
| `/editor` | Use the system editor to enter a long message |
| `/clear` | Clear the screen |
| `/migrate` | Manually trigger task migration (generate a handoff document and start a new session) |
| `/help` | Show help |

> Note: typing an unrecognized `/xxx` command shows: "Unknown command: xxx (type `/help` to view available commands)".

## Shell fallback hook

Unrecognized terminal commands can be automatically forwarded to the AI for processing:

```bash
# Install the hook (writes to ~/.zshrc or ~/.bashrc)
zen hook install

# Afterwards, just type something:
> what's the weather today?
# This is forwarded to the AI instead of showing "command not found"

# Uninstall
zen hook uninstall
```

> The hook is only available on `bash` / `zsh` (it depends on `process.env.SHELL`); other shells are not supported.

## Configuring the API Key

If you use an endpoint for the first time without an API Key set, an interactive input wizard will appear (see `src/config-wizard.ts`). You can also configure it manually at main menu → **Configuration** → **Set API Key**.

> Note: a hint text in the source refers to a `aiz config set-key` command, but the current CLI entry (`src/index.ts`) **does not implement** that subcommand — configuration should be done via the interactive main menu. See [Configuration](./configuration.md).

## Development and testing

```bash
pnpm install
pnpm build
pnpm start

# Unit tests
pnpm test

# E2E (requires API Key in .env.local)
pnpm test -- src/__tests__/e2e.test.ts
```

> See the `scripts` field in `package.json`. `test:all` runs typecheck, unit tests, build, and E2E in sequence.
