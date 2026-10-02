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
              v1.0.0-alpha.1 · sdk x · core y
```

After the splash, you land **directly in the chat screen** (resuming the last session if there is one, otherwise starting a new conversation). The chat screen is **bottom-pinned**: a divider, the input line, and the status bar (model · agent · token usage · generating) always sit at the bottom of the terminal, while the conversation scrolls above them. While generating, the spinner replaces the input line.

The chat screen provides a streaming output area (reasoning / answer / tool calls on separate lines), a multiline input (`Enter` sends; `Ctrl+N` inserts a newline; `← →` move the cursor, `Ctrl+← →` by word), and an inline `/` command menu (↑↓ to choose, `Tab` to complete). `Ctrl+C` cancels the current request while generating, and exits when idle.

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
| `/migrate` | Manually trigger task migration (generate handoff doc & start a new session) |
| `/help` | Show available commands |

### Conversation Migration

When the API response's `usage.prompt_tokens` exceeds the model's `maxContextTokens`, the system first asks for a **second confirmation** (showing current usage and the threshold, defaulting to "yes"; choosing "no" skips this migration and leaves the current conversation untouched), then generates a **handover document** summarizing completed tasks, pending items, and key decisions. A new conversation session is created with this document as context, ensuring seamless continuation. The confirmation only appears when both stdin and stdout are TTYs; non-interactive scenarios such as pipes and redirections keep the previous automatic migration behavior.

You can also manually trigger a migration at any time by typing `/migrate` in the conversation — no need to wait for the token limit. Both automatic and manual migration delegate to the SDK's `TaskMigrationService`, so the handoff document is always produced consistently.

The same context guard also applies to **sub-agents**: at each delegation boundary (`onSubAgentStart`) the CLI installs the same `ContextGuardPlugin` (same `maxTokens`) onto the newly built sub-agent, so a delegated sub-agent (including the Skill sub-agent created by `call_skill_sub_agent`) is interrupted as soon as its context exceeds the hard limit. This is transparent — a normally-running sub-agent is unaffected.

The migration prompt template includes:
- **Conversation Breakpoint** — Last user/AI exchange verbatim
- **Completed Tasks** — Task titles and output paths
- **Pending Tasks** — Description, progress, next steps
- **Important Notes** — Technical preferences, lessons learned, architecture decisions
- **File Index** — Key files with descriptions
- **Handover Instructions** — SOP for the relay agent (read files first, verify state, then act)

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
| Endpoints / models / image models, defaults, tool-output cap | `/config` (the configuration center — full management) |
| MCP servers, agent definitions, and other advanced fields | Edit `mcp.json` / `agents/*.json` manually |

The `maxContextTokens` field on each model sets the migration threshold (typically ~25% of the model's actual context window, e.g. 250,000 for a 1M-token model).

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

> Note: entries in `models` / `imageModels` **without `custom: true`** are **factory-managed** — on every launch they are reconciled with (and replaced by) the SDK factory catalog; add `"custom": true` for your own entries. `endpoints` are never managed and always keep your configuration.

### Environment Variable

- `AI_ZEN_DIR` — Override the shared root directory (default: `~/.ai-zen`). CLI runtime data goes to `$AI_ZEN_DIR/cli/`, and shared resources (agents, skills, tools, MCP, etc.) go to `$AI_ZEN_DIR/`.

## Filesystem Layout

```
~/.ai-zen/                    ← Shared root (AI_ZEN_DIR)
├── config.json               ← Endpoints & models (shared with other AI-Zen clients)
├── cli/                      ← CLI runtime data
│   ├── conversations/        ← CLI conversations
│   └── last-session.json     ← Pointer to the last session id
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
└── mcp-oauth/                ← MCP OAuth tokens (shared)

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
| `readFile` | Read file contents (supports `range` for partial reads) |
| `inspectFile` | Inspect file structure (lines, chars, column widths, line-ending style) without reading content |
| `writeFile` | Write content to file |
| `edit` | Replace text in files (single replacement) |
| `batchEdit` | Batch replace text in files |
| `exec` | Execute shell commands |
| `exec_async` | Execute a shell command asynchronously (returns immediately) |
| `mkdir` | Create directories |
| `rm` | Delete files or directories |
| `glob` | Scan files with glob patterns |
| `ls` | List directory contents |
| `exist` | Check if path exists |
| `findText` | Search text in files |
| `downloadFile` | Download file from URL |
| `rename` | Rename or move files |
| `copy` | Copy files or directories |
| `sleep` | Wait for a specified number of milliseconds |
| `viewImage` | View/analyze an image — vision models only (`Model.vision`). A network URL is returned as an `image_url` content block; a local path is auto-uploaded via the Files API and returned as a `file` content block |
| `generateImage` | Generate images from text — requires `defaultImageModel`; always returns a plain string (JSON with the image URLs plus `viewImage` / `downloadFile` hints) instead of forcing image content blocks |

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
2. **Filtering** — Apply permissions (`allow`/`deny`), security exclusions (recursion protection), and each tool's self-declared `isAvailable(config, definition)` (availability is decided at build time when the model is known; e.g. `viewImage` only for vision models, `generateImage` requires `defaultImageModel`)
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
