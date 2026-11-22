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
- **Runtime dependencies** (declared under `dependencies` in `package.json`): `ink`, `react`, `highlight.js`, `lowlight`, `string-width`. `@ai-zen/agents-client` (a private, unpublished package) and `@ai-zen/agents-sdk` / `@ai-zen/agents-core` (published, but not meant to be installed by consumers at runtime) are all **inlined into the bundle** at build time — `check:imports` pins that `@ai-zen/agents-client` never reappears in `dist/*.js`.
- **The host does not need to be installed beforehand**: the host package is `@ai-zen/agents-host` (the wire contract is its `@ai-zen/agents-host/protocol` subpath), but it only lives in `devDependencies` as a **version-range declaration** — local mode pulls it on demand with `npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <data root>`, where `<range>` is the semver range injected at build time.
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

**Pure stdio runs on the host too.** Both modes are the same pipeline: `ai "…"` first makes sure a local host is up (spawning one with `npx` if needed), then opens a **one-off session** and runs a single turn — so the agent assembly, tools, MCP connections and context guard are exactly the same as in the TUI (there is no "pipe mode with a few plugins missing"), and conversations land in the same place (the host's `<data root>/ai-zen.db`, owned per workspace).

The trade-off is that the **first call has to get the host up**: `npx` resolves the version → downloads and installs → starts the host → connects, which the TUI shows as a **staged download screen** (indeterminate progress, no fake percentage); later calls reuse the host that is already running and pay none of it. In addition `<data root>/run/` must be writable and `node` must be able to spawn a child process. Three behaviours stay as they were: nothing is persisted by default; `--save` only archives and **does not** move the "last session" pointer (so the next `ai` will not resume a pipe result); stdout still carries the answer only.

**The workspace follows your directory.** When the host and the CLI are on the same machine (the default — the CLI pulls a local host with `npx` on demand), the directory you type `ai` in **is** the session's workspace: created on first use (via `workspace.create` with the current directory), then resumed from that workspace's last conversation. Connect to a host on **another machine** and it flips: the client sends **no** directory of its own, only remembers the last workspace you entered, and falls back to the picker (`/ws` to list / choose / create) when there is none.

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

Startup goes **directly into the chat screen** (rendered with Ink/React) — there is no splash animation — resuming the last session if there is one, otherwise starting a new conversation. An empty conversation shows the brand block (logo, tagline, CLI / SDK / core versions) at the top of the transcript, and it scrolls away with the conversation. The chat screen is **bottom-pinned**, and from the bottom up the order is: status bar → input line → divider → phase line → command menu. The **phase line** only exists while busy (while generating it says what the round is doing — connecting → queued → thinking → calling a tool → waiting for the tool to return → streaming; while a blocking command runs it falls back to the command name); it sits **above the divider, above the input row, and is always exactly one line** — it never replaces the input box.

**You can keep typing while generating.** The input box stays put: you can type, bring up the `/` menu, and press Enter. That message is handed to the host, which queues it into **the round that is already running** (the host answers "queued" and a notice says so right away); it lands as a user message when the current tool round finishes, so nothing the model is already saying gets interrupted, and once the round ends it shows up in the transcript together with its answer. While a round is running, the only keys whose meaning changes are `Ctrl+C` / `Esc` (they still abort this round); everything else stays put (paging, scrolling, double `Ctrl+D` to exit).

If the round spawns sub-agents, a **main / sub-agent bar** appears below the transcript (`主AGENT　◈子AGENT1　◈子AGENT2`): `←` / `→` switches which agent's conversation the transcript shows, the diamond shows each one's state (blue blinking while running / green when done / red when failed), and the bar disappears once this round's inner loop finishes.

The chat screen provides a streaming output area, a multiline input (`Enter` sends, `Ctrl+N` inserts a newline, `← →` move the cursor, `Ctrl+← →` by word, `Ctrl+W` / `Alt+Backspace` delete the previous word, `Alt+D` / `Ctrl+Delete` the next word, `Ctrl+K` kills to end of line, `Ctrl+U` kills to line start, `Esc` clears the input, `Ctrl+V` pastes (an image if the clipboard holds one, otherwise text — text is capped at 256KB and refused, not truncated) / `↑` `↓` move the cursor inside a multi-line draft (history only at the first / last row) / the input area is capped at 8 rows and the window follows the cursor / `PgUp` / `PgDn` (or `Alt+V`) scroll the transcript), and an inline `/` command menu (still available while generating). Tool calls render as `⚙ name(args)` with **JSON highlighting**; the answer/reasoning is **Markdown-source-colored** (headings / bold / italic / inline code / lists / quotes / links), and fenced code blocks are highlighted by language with the **fence markers kept**.

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
| `/new` | Start another conversation (nothing that is running gets interrupted) |
| `/load` | Load an existing conversation of this workspace (nothing that is running gets interrupted) |
| `/sessions` `/ps` | Active sessions: held by this process + running on the host; pick one to switch |
| `/ws` | Workspaces: list / switch / register a directory (`/ws new [path]`) |
| `/pin [on\|off]` | Pin / unpin this conversation (no argument toggles it) |
| `/back` `/revert` | Retract the last message (edit and resend) |
| `/editor` | Compose a long message in your editor |
| `/clear` | Clear the screen only (the context is kept) |
| `/free` | Clear the queue: messages typed during a run that were not sent yet (`/clear` is the screen) |
| `/config` | Open the configuration center (endpoints / models / image models / MCP / agent definitions / defaults / tool-output cap) |
| `/model` | Switch model: `/model <id>` changes this session only, `-a`/`--agent <id>` the agent definition, `-g`/`--global <id>` the global fallback; no argument opens a picker |
| `/think` `/effort` | Switch reasoning effort (written into the layer the effective model came from; the global fallback layer has nowhere to keep params, so it is refused) |
| `/agent` | Pick which Agent later conversations use (writes `defaultAgent`; unusable Agents show the host's reason) |
| `/mcp [user\|workspace]` | Manage MCP servers (add / remove / edit / toggle); without a scope it opens the layer that already has entries |
| `/key` | Set the endpoint API key |
| `/reload` | Make the host re-read config / agent definitions / tools / skills / MCP from disk (messages and context are kept) |
| `/upgrade` | Move the host to the highest version across all release tags (query the registry → pull that version with npx → confirm → record it and shut the host down cleanly; the reconnect screen starts it from that version. This process never restarts itself) |
| `/lang` | Switch the interface language (`/lang zh` / `/lang en` set it explicitly, no argument toggles) |
| `/handoff` | Write a handoff document (keeps the conversation) |
| `/migrate` | Hand off and start a new conversation |
| `/help` | Show help |
| `/shutdown` | Shut the host down (back to the connect screen; quitting the CLI itself does **not** stop the host) |
| `/exit` `/quit` | Exit the conversation |

> Note: typing `/` lists candidate commands below the input line (↑↓ to choose, `Tab` to complete, `Enter` to submit/run; the menu is anchored right above the input). Commands are matched by their full names; an unrecognized `/xxx` reports "Unknown command". The full list is `src/commands/registry.ts` — both `/help` and the slash menu render from it.

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
| Model used by the current session | `/model` in the chat (this session only by default; `/model -a` writes the agent definition's `modelId`) |
| Reasoning effort | `/think` in the chat (the params land in `modelParams` of **the layer the effective model came from**; available levels come from the preset referenced by the model in `~/.ai-zen/reasoning-presets.json`, which you can extend) |
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
