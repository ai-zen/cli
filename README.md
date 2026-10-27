# @ai-zen/cli

A command-line interface for AI agents, built on `@ai-zen/agents-sdk` and `@ai-zen/agents-core`. It runs in **two modes**: an interactive terminal (TUI) for conversations with the AI, and a pure stdio mode for scripts, pipes, and the shell fallback hook. It ships built-in file system tools and supports MCP integration, sub-agent orchestration, and skill management.

## Installation

### Global Install

```bash
npm install -g @ai-zen/cli
```

### Build from Source

```bash
git clone git@github.com:ai-zen/cli.git
cd cli
pnpm install
pnpm build
npm install -g .
```

## Run Modes

The CLI has two **non-mixing** run modes, chosen automatically from the launch arguments and the terminal environment:

| Mode | Trigger | Audience | Behavior |
|------|---------|----------|----------|
| **Pure stdio** | Arguments present, **or** stdin/stdout is not a TTY (pipe, redirect, CI) | Scripts, pipes, shell fallback hook | No extra interaction; reads input and writes the **final answer as plain text to stdout** |
| **TUI** | No arguments and both stdin/stdout are TTYs | Human users | Interactive chat UI |

In pure stdio mode, logs / progress / tool activity / error summaries all go to **stderr**; stdout carries the result only (no ANSI, no emoji prefix, no spinner). Exit code is `0` on success and non-zero on failure. Nothing is persisted by default (no conversation archive).

## Quick Start

```bash
# TUI: no arguments, interactive terminal
ai

# Pure stdio: argument is the prompt, result goes to stdout
ai Hello, introduce yourself.

# Pipe: stdin is the content, the argument is the instruction
cat README.md | ai "summarize in three sentences"

# Persist: off by default, opt in with --save
ai --save "name this function for me"

# Help / version
ai --help
ai --version
```

> The legacy command names `aiz` / `zen` still work as transition aliases in this version and will be removed in a future release.

## Interface (TUI)

When run with no arguments on an interactive terminal, the CLI opens a full-screen interface built with **Ink (React)**. It starts with an animated, gradient ASCII splash:

```
 █████╗ ██╗    ███████╗███████╗███╗   ██╗
██╔══██╗██║    ╚══███╔╝██╔════╝████╗  ██║
███████║██║      ███╔╝ █████╗  ██╔██╗ ██║
██╔══██║██║     ███╔╝  ██╔══╝  ██║╚██╗██║
██║  ██║██║    ███████╗███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝    ╚══════╝╚══════╝╚═╝  ╚═══╝

              AI workbench in your terminal
              v1.0.0-alpha.21 · sdk x · core y
```

After the splash, you land **directly in the chat screen** (resuming the last session if there is one, otherwise starting a new conversation). The chat screen is **bottom-pinned**: a divider, the input line, and a **status bar** (three priority-ordered blocks: model · agent · reasoning effort | this-round / cumulative tokens · generation rate · generating | key hints; a block that does not fit moves to the next line whole, so nothing is truncated and no block gets split) always sit at the bottom of the terminal, while the conversation scrolls above them. While generating, the spinner replaces the input line. The generation rate shows a live value while streaming (2-second sliding window, estimated from output deltas) and switches to this round's average once it finishes (preferring the real `completion_tokens` from the API).

The chat screen provides a streaming output area (reasoning / answer / tool calls on separate lines), a multiline input (`Enter` sends; `Ctrl+N` inserts a newline; `← →` move the cursor, `Ctrl+← →` by word; `Ctrl+W` / `Alt+Backspace` delete the previous word, `Alt+D` / `Ctrl+Delete` the next word; `Ctrl+K` kills to end of line; `Ctrl+U` kills to line start; `PgUp`/`PgDn` (or `Alt+V`/`Ctrl+V`) scroll the transcript, the mouse wheel scrolls by line; on macOS `⌘← →` moves by word, `⌘⌫`/`⌘⌦` deletes by word, `⌘[`/`⌘]` pages and `⌘;`/`⌘'` scrolls by line (depending on whether the terminal reports Cmd — see below)., and an inline `/` command menu (↑↓ to choose, `Tab` to complete). Tool calls render as `⚙ name(args)` with **JSON syntax highlighting**; the answer / reasoning is **Markdown-source-colored** (headings, bold, italic, inline code, lists, quotes, links), and fenced code blocks are **syntax-highlighted by language with the fence markers kept** (highlight data from `highlight.js` via `lowlight`). `Ctrl+C` cancels the current request while generating, and exits when idle.

### Keyboard & terminal compatibility (macOS, etc.)

The convention for terminal TUIs on macOS is **Option-as-Meta plus readline-style Ctrl keys**: `Cmd` is not part of the terminal protocol (`super` is only reported under the [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)), so `⌘` is left to the terminal itself (copy / paste / search). This CLI follows that convention.

**Step one: make Option act as Meta.** macOS terminals do not send the Option modifier by default — until you enable it, every `Option+X` shortcut does nothing:

| Terminal | Setting |
|---|---|
| Apple Terminal | Settings → Profiles → Keyboard → check **Use Option as Meta Key** |
| iTerm2 | Settings → Profiles → Keys → General → Left/Right Option key = `Esc+` |
| VS Code / Cursor | add `"terminal.integrated.macOptionIsMeta": true` to settings |
| Ghostty / kitty / WezTerm | enable Option-as-Alt / Option-as-Meta in the config |

Key map (aligned with [Claude Code](https://docs.claude.com/en/docs/claude-code/interactive-mode)):

| Keys | Action |
|---|---|
| `Enter` | Send |
| `Ctrl+J`, `Ctrl+Enter`, `Alt+Enter`, `Shift+Enter` | Newline |
| `Ctrl+C` | While generating: interrupt; when idle: clear the draft, press again to exit |
| `Ctrl+D` | With a draft: delete the character after the cursor; empty input: press twice to exit |
| `Esc` | While generating: interrupt; otherwise clear the draft and jump to the bottom |
| `Ctrl+A` / `Ctrl+E` | Line start / end |
| `Ctrl+P` / `Ctrl+N` | Previous / next history entry (also moves the slash menu) |
| `Ctrl+K` / `Ctrl+U` | Kill to line end / line start |
| `Ctrl+W` | Kill back to the previous whitespace (punctuation does not split: `src/utils/foo.ts` goes in one press) |
| `Alt+B` / `Alt+F` | Move by word |
| `Alt+D`, `Alt+Backspace`, `Ctrl+Delete` | Delete by word |
| `Ctrl+Y` / `Alt+Y` | Yank the last killed text / cycle older entries |
| `Ctrl+_` | Undo the last input edit |
| `Ctrl+S` | Stash the draft / press again to restore |
| `Ctrl+V` | Reserved for image paste (**not implemented yet**; shows a notice) |
| `Ctrl+L` | Clear the screen (context kept) |
| `PgUp` / `PgDn` | Page through the transcript |
| Mouse wheel | Scroll by line (3 lines per notch). With mouse reporting on, text selection needs `Shift` (native terminal selection); `tmux` users need `set -g mouse off`, otherwise the wheel is swallowed by copy-mode |
| `Shift+↑ ↓`, `Alt+↑ ↓`, `⌘;` / `⌘'`* | Scroll by line |
| `\` + `Enter` | Newline (works in any terminal) |

> After an interrupt (`Ctrl+C` / `Esc`), **the reasoning and content the model already produced stay in the context** — on the next turn it picks up that half-finished sentence instead of pretending it never said it. Use `/new` if you want a clean slate. Tool rounds are still reconciled all-in or all-out: unfinished tools get a reason backfilled, so no illegal "call without result" history is left behind.

Not implemented (no counterpart here): `Ctrl+O` transcript viewer, `Ctrl+R` reverse search, `Ctrl+B` background tasks, `Ctrl+T` task list, `Shift+Tab` permission modes.

`Ctrl+V` (Claude Code's "paste image") is **not implemented yet** — pressing it shows a notice. It first needs a proper "file → content block" capability probe (Files API upload vs base64 inline) instead of hard-coding a single endpoint. Note that macOS maps `⌘⌫` to `Ctrl+U`, which is why `Ctrl+U` kills to line start here; use `Esc` to clear the draft.

\* `⌘` combos only carry the `super` bit when the terminal **enables the kitty keyboard protocol** (and for iTerm2, when Cmd is mapped to Super). Terminals without it (e.g. Apple Terminal) can only map `⌘` to `ESC` sequences (e.g. `⌘←` → `ESC[1;9D`, equivalent to `Alt+←`), or you can use the Alt combos above.

> macOS maps `⌘⌫` to `Ctrl+U` in iTerm2 and Terminal.app, which is why `Ctrl+U` here follows readline semantics (delete to line start): making it "clear everything" would throw away the whole draft whenever a Mac user presses `⌘⌫`.

> On macOS `Ctrl+← →` is usually swallowed by the system: Mission Control binds it to "Move left/right a space". Uncheck it under System Settings → Keyboard → Keyboard Shortcuts → Mission Control.

If a key still does nothing, turn on the key diagnostics and press it once:

```bash
AIZ_DEBUG_KEYS=1 aiz
# in another shell
tail -f /tmp/aiz-key-debug.log
```

The first line records the terminal environment (`TERM`, `TERM_PROGRAM`, ...); every keypress then appends one line:

```
key input="d" flags=[meta] raw=true
key input="" flags=[pageUp] raw=false
```

- **No new line after pressing** → the key never reached the app (system shortcut / terminal key mapping)
- **Line present but `flags` unexpected** → the sequence arrived; the matching logic is at fault (paste that line in a report)
- **`raw=false`** → stdin was not in raw mode, so the terminal interpreted the key itself (e.g. scrolled its scrollback)

### First-run setup (API Key)

On first launch, if the endpoint bound to the selected model has no API Key yet, a **credential screen** appears instead of an error:

```
 ? First-run setup · Set the API Key for DeepSeek
 Endpoint: DeepSeek · https://api.deepseek.com/v1
 Current: not set
 Get a key at: https://platform.deepseek.com/api_keys
 Saving enters the chat immediately (Esc aborts and exits).
 ❯ ▏
```

`Enter` saves it (to `~/.ai-zen/config.json`) and drops you straight into the chat; `Tab` toggles plaintext, `Esc` aborts. Inside the chat, `/key` changes the **current endpoint's** key (the session is rebuilt on save, so it applies immediately) and `/config` opens the configuration center (default model / endpoint management: a list of [add endpoint] plus each endpoint; select one to edit its API key / base URL in place).

### Session Recovery

Every conversation is persisted directly as its own file (`cli/conversations/<id>.json`) while you chat — there is no separate draft store. A single pointer (`cli/last-session.json`) remembers the **last session id**; next time you start `ai`, that session is **resumed automatically** so you pick up where you left off.

### UI language (Chinese / English)

On first launch the language is detected from the system: `LC_ALL` → `LC_MESSAGES` → `LANG` → the system `Intl` locale, **falling back to English**. The result is stored in `~/.ai-zen/cli/preferences.json`; from then on the stored preference wins, so changing the system language will not make the UI drift. `/lang` toggles at any time (no argument flips between the two), and `/lang zh` / `/lang en` select one directly.

The preference lives in the CLI's own `preferences.json`, **not in the shared `config.json`** — the latter is the config contract shared by the CLI and the Desktop app.

The whole TUI is covered: the chat screen (status bar / input hints / notices), commands and `/help`, every configuration-center screen, the handoff picker, and the splash / boot-error screens. **Deliberately not translated:**

- protocol content sent to the model (Sub-agent tool-schema descriptions, the working-directory change note injected into history) — translating them makes model behaviour drift;
- terminal output printed outside the TUI and before the locale is initialised, such as `ai --help` / `ai hook install`;
- the default conversation name and `formatShortTime()` format that end up in file names — following the UI language would interleave old and new files.

### Conversation Commands

While in a conversation, all commands start with `/`. Typing `/` lists the available commands, with descriptions, right below the input line; typing more characters narrows the candidates by prefix:

```
💬 You: /b
  /back         Undo messages (roll back to a specific point and resend)
```

> Typing `/` lists candidate commands below the input line (↑↓ to choose, `Tab` to complete, `Enter` to submit/run). Commands are matched by their full names; an unrecognized `/xxx` reports "Unknown command".

| Command | Description |
|---------|-------------|
| `/exit` `/quit` | Exit the conversation |
| `/save` | Save the current conversation (it is already flushed on every turn) |
| `/load` | Load a saved conversation (replaces the current session) |
| `/new` | Reset the conversation (clear history) |
| `/back` | Undo messages (roll back to a specific point and resend) |
| `/editor` | Open system editor for long-form input |
| `/clear` | Clear the screen |
| `/config` | Open the configuration center (endpoints / models / image models / MCP servers / agent definitions / defaults / tool-output cap) |
| `/model` | Switch the model of the current session and persist it (written to the Agent's `modelId`; thinking level is reset to the model default) |
| `/agent` | Quickly switch the main Agent (a picker lists every Agent; picking one writes `defaultAgent` and rebuilds the session; Agents that cannot run are marked unavailable with the reason) |
| `/reload` | Refresh the runtime: rebuild the scope and rediscover tools / skills / MCP servers (use it after hand-editing `mcp.json` etc.; messages and context are kept) |
| `/mcp` | Manage MCP servers (opens the MCP screen of the configuration center: add / remove / edit / toggle / switch between global and project scope; `/mcp global` and `/mcp project` jump straight to a scope) |
| `/lang` | Switch the interface language (中文 / English); `/lang zh` and `/lang en` set it explicitly, no argument toggles |
| `/think` `/effort` | Switch reasoning effort (available levels come from the model's reasoning preset, e.g. `low/high/max`); persisted into the current Agent definition; `/think default` falls back to the model default |
| `/key` | Set the API Key of the current endpoint (rebuilds the session on save) |
| `/handoff` | Write a handoff document only (session keeps running; no confirmation) |
| `/migrate` | Handoff + start a new session (discards history; asks for confirmation) |
| `/help` | Show available commands |

### Task Handoff & Migration

Two related commands, one pipeline:

- **`/handoff`** — the original agent stops what it is doing and writes a handoff document to `<project>/.ai-zen/handoffs/<timestamp>-<conversation id>.md`, using its own tools to verify the real state (branch, uncommitted changes, tests, ports). The session keeps running, so you can keep refining the document.
- **`/migrate`** — the same handoff, then history is cleared and a new session starts from the document (the breakpoint message carries only the path; the new agent reads it).

Two executors: `self` (default — the original agent writes it in-session, highest fidelity) and `summary` (a single independent model call, cheap but lossy). `self` degrades to `summary` one-way on failure. Pass it explicitly with `/handoff summary` or `/migrate self`.

When `usage.prompt_tokens` exceeds the model's `tokenThresholds.handoff`, an interactive terminal shows a three-way picker (self / summary / skip); non-interactive pipes migrate with the default executor without blocking.

The document template is not hard-coded: it comes from the `handoff` Skill (`~/.ai-zen/skills/handoff/SKILL.md`, released and synced by the SDK; mark `metadata.custom: "true"` to keep your own version, or override per project). See [Task Handoff & Migration](./docs/en/migration.md) for the full chain, cost notes, and the template sections.

The same context guard also applies to **sub-agents**: at each delegation boundary (`onSubAgentStart`) the CLI installs the same `ContextGuardPlugin` (same `maxTokens`) onto the newly built sub-agent, so a delegated sub-agent (including the Skill sub-agent created by `call_skill_sub_agent`) is interrupted as soon as its context exceeds the hard limit. This is transparent — a normally-running sub-agent is unaffected.
### Shell Fallback Hook

When you type an unrecognized command in your terminal, it can be automatically forwarded to AI for processing:

```bash
# Install the hook
ai hook install

# After that, try typing something random:
> what's the weather today?
# This will be forwarded to AI instead of showing "command not found"

# Uninstall
ai hook uninstall
```

The hook calls `ai "$@"` (pure stdio mode) so the answer is printed in your current shell session. If you previously installed the legacy `aiz` hook, re-running `ai hook install` upgrades it automatically; you can also run `ai hook uninstall` first.

## Configuration

Configuration is stored in `~/.ai-zen/config.json` (or `$AI_ZEN_DIR/config.json` if set), shared with other AI-Zen clients and used as the **single source of truth**. The TUI can edit the common fields for you:

| Scenario | How |
|----------|-----|
| First launch, endpoint has no key | The **credential screen** appears automatically |
| Change the current model's endpoint key | `/key` in the chat (session rebuilt on save) |
| Endpoints / models / image models, MCP servers, agent definitions (incl. sub-agents), defaults, tool-output cap | `/config` (the configuration center — full management) |
| Other advanced fields (skills / user tools, …) | Edit the files under `~/.ai-zen/` manually |

The `tokenThresholds` field on each model sets two usage lines: `handoff` (soft — a handoff is triggered above it) and `guard` (hard — the round is aborted above it, before the request). Both are absolute values; `guard ≈ handoff × 1.5` is recommended (typically ~25% of the model's actual context window for `handoff`, e.g. 250,000 for a 1M-token model).

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
  "defaultMigrationModel": "deepseek-flash"
}
```

> Note: entries in `models` / `imageModels` **without `custom: true`** are **factory-managed** — on every launch they are reconciled with (and replaced by) the SDK factory catalog; add `"custom": true` for your own entries. `endpoints` are never managed and always keep your configuration.
>
> The model is **not** selected in `config.json`: each Agent binds one in its own definition file (`agents/<id>.json`, field `modelId`), which is the single source of truth at runtime. `/model` writes exactly that field.

### Environment Variable

- `AI_ZEN_DIR` — Override the shared root directory (default: `~/.ai-zen`). CLI runtime data goes to `$AI_ZEN_DIR/cli/`, and shared resources (agents, skills, tools, MCP, etc.) go to `$AI_ZEN_DIR/`.
- `AIZ_DEBUG_KEYS=1` — Enables key diagnostics logging (off by default, zero overhead); `AIZ_KEYS_FILE=<path>` overrides the target file (default `/tmp/aiz-key-debug.log`).
- `AIZ_DEBUG_SDK=0` — Disables SDK global logging. **On by default**: everything is written to `$AI_ZEN_DIR/logs/sdk.log` (no library logs ever reach the screen), rotated to `sdk.log.1` once the file passes 2MB; `AIZ_SDK_LOG_FILE=<path>` overrides the location. Check this file when debugging "MCP won't connect" or "Skill failed to parse".

## Filesystem Layout

```
~/.ai-zen/                    ← Shared root (AI_ZEN_DIR)
├── config.json               ← Endpoints & models (shared with other AI-Zen clients)
├── cli/                      ← CLI runtime data
│   ├── conversations/        ← CLI conversations
│   ├── last-session.json     ← Pointer to the last session id
│   └── preferences.json      ← CLI-local preferences (interface language, etc.)
├── agents/                   ← Agent definitions (shared)
│   ├── default.json          ← Default agent (created on first run)
│   └── my-custom-agent.json
├── sub-agents/               ← SubAgent definitions (shared)
│   ├── general-assistant.json ← Default sub-agent (created on first run)
│   └── my-coder.json
├── skills/                   ← Skill directory (shared)
│   └── my-skill/
│       └── SKILL.md
├── tools/                    ← User-defined tools (shared)
│   └── my-tool.js
├── mcp.json                  ← MCP config (shared)
├── mcp-oauth/                ← MCP OAuth tokens (shared)
└── logs/                     ← Diagnostics (sdk.log: SDK global log, 2MB rotation)

/path/to/project/
├── .mcp.json                 ← Project-shared MCP config (committable)
└── .ai-zen/
    ├── mcp.json              ← Project-personal MCP config (not committed)
    ├── skills/               ← Project Skill directory
    │   └── my-skill/
    │       └── SKILL.md
    ├── tools/                ← Project tool directory
    │   └── my-tool.js
    ├── sub-agents/           ← Project SubAgent directory
    │   └── project-helper.json
    └── agents/               ← Project Agent directory (overrides user-level)
        └── project-agent.json
```

### MCP Config Merge Priority

MCP server configurations are merged from multiple sources (high to low priority):

1. Project shared `./.mcp.json` (collected from cwd up to git root)
2. Project personal `./.ai-zen/mcp.json` (same)
3. Project convention `./.agents/mcp.json`
4. User-level `~/.ai-zen/mcp.json`
5. User convention `~/.agents/mcp.json`

Same-named servers in higher priority override lower ones.

## Built-in Tools

The CLI provides 20 built-in tools, implemented by `@ai-zen/agents-sdk`. Tool availability is self-declared by each tool via `isAvailable(config, definition)` at build time (when the model is already known):

| Tool | Description |
|------|-------------|
| `cwd` | Get current working directory |
| `read` | Read file contents (supports `range` for partial reads) |
| `inspect_file` | Inspect file structure (lines, chars, column widths, line-ending style) without reading content |
| `write` | Write content to file |
| `edit` | Replace text in files (single replacement) |
| `batch_edit` | Batch replace text in files |
| `exec` | Execute shell commands |
| `spawn` | Execute a shell command asynchronously (returns immediately) |
| `mkdir` | Create directories |
| `rm` | Delete files or directories |
| `glob` | Scan files with glob patterns |
| `ls` | List directory contents |
| `exist` | Check if path exists |
| `find_text` | Search text in files |
| `download_file` | Download file from URL |
| `rename` | Rename or move files |
| `copy` | Copy files or directories |
| `sleep` | Wait for a specified number of milliseconds |
| `view_image` | View/analyze an image — vision models only (`Model.vision`). A network URL is returned as an `image_url` content block; a local path is auto-uploaded via the Files API and returned as a `file` content block |
| `generate_image` | Generate images from text — requires `defaultImageModel`; always returns a plain string (JSON with the image URLs plus `view_image` / `download_file` hints) instead of forcing image content blocks |

### Dynamic Tools

In addition to built-in tools, the SDK provides 5 dynamic loading tools that are registered based on available resources and permissions:

| Tool | Purpose |
|------|---------|
| `load_skill` | Load a Skill document into context (idempotent, repeated calls skip re-injection) |
| `call_skill_sub_agent` | Delegate a task to a Skill sub-agent (only works for Skills with `sub-agent: true` in frontmatter) |
| `load_mcp` | Connect to an MCP server and list its tools (idempotent, repeated calls skip reconnection) |
| `call_mcp_tool` | Call a tool on a connected MCP server |
| `read_mcp_resource` | Read a resource from a connected MCP server |

## Tool Assembly Pipeline

Tools are assembled in three phases by the SDK's `Scope` capability pipeline:

1. **Discovery** — Scan filesystem for built-in tools, user tools, SubAgents, Skills, and MCP servers. All 20 built-in tools are discovered unconditionally (no filtering at this stage)
2. **Filtering** — Apply permissions (`allow`/`deny`), security exclusions (recursion protection), and each tool's self-declared `isAvailable(config, definition)` (availability is decided at build time when the model is known; e.g. `view_image` only for vision models, `generate_image` requires `defaultImageModel`)
3. **Instantiation** — Map filtered names to `Tool` instances and register dynamic loaders

Each Agent has independent permissions — no inheritance between parent Agent and SubAgent. The only exception is the temporary Skill sub-agent (created by `call_skill_sub_agent`), which reuses the caller's tool set without a second permission pass, as a transient conversation proxy rather than an independent entity.

## Permission Model

```typescript
interface AgentPermissions {
  tools?: { allow: string[] } | { deny: string[] };
  skills?: { allow: string[] } | { deny: string[] };
  mcps?: { allow: string[] } | { deny: string[] };
  subagents?: { allow: string[] } | { deny: string[] };
}
```

- Missing `permissions` field = all dimensions denied (`deny: ["*"]`)
- Each dimension uses either `allow` (whitelist) or `deny` (blacklist), mutually exclusive
- `"*"` wildcard matches any name
- Denied resources are fully invisible to the LLM (not just blocked)

## MCP Server Support

MCP servers are configured in `mcp.json` files:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "xxx"
      }
    }
  }
}
```

Connection lifecycle (connect, reconnect with exponential backoff, idle timeout) is fully managed by the SDK's `McpConnectionManager`.

### OAuth (HTTP transport only) — Not Yet Supported

The OAuth 2.0 authorization flow (the `oauth` field in `mcp.json`) has its types defined and a `mcp-oauth/` storage directory reserved, but is not implemented yet. An HTTP MCP server configured with `oauth` currently fails to connect due to the missing token.

## Preset Endpoints

| ID | Name | Default Base URL |
|----|------|-----------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (ZhipuAI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## Preset Models

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

## Development

```bash
pnpm install
pnpm build
pnpm start
```

## Testing

```bash
# Unit tests
pnpm test

# E2E tests (requires API key in .env.local)
pnpm test:e2e
```

## License

MIT
