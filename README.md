# @ai-zen/cli

A command-line interface for AI agents, built on `@ai-zen/agents-sdk` and `@ai-zen/agents-core`. Provides an interactive conversation terminal with built-in file system tools, sub-agent orchestration, and skill management.

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

## Quick Start

```bash
# Interactive main menu
zen

# Quick chat (pass message as argument)
zen Hello, introduce yourself.
```

## Main Menu

Run `zen` to enter the main menu:

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

### Draft Recovery

If you exit a conversation without saving (or the process is killed), the conversation is **automatically saved as a draft**. Next time you start `zen`, you'll see:

```
▶️  Continue last unfinished conversation (12 messages, 2025/1/1 12:00:00)
💬  Start a new conversation (discard draft)
```

### Conversation Commands

While in a conversation, all commands start with `/`:

| Command | Description |
|---------|-------------|
| `/exit` `/quit` | Exit the conversation (prompts to save) |
| `/save` | Save the current conversation |
| `/new` | Reset the conversation (clear history) |
| `/back` | Undo messages (roll back to a specific point and resend) |
| `/editor` | Open system editor for long-form input |
| `/clear` | Clear the screen |
| `/help` | Show available commands |

### Conversation Migration

When the API response's `usage.prompt_tokens` exceeds the model's `maxContextTokens`, the system automatically generates a **handover document** summarizing completed tasks, pending items, and key decisions. A new conversation session is created with this document as context, ensuring seamless continuation.

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
zen hook install

# After that, try typing something random:
> what's the weather today?
# This will be forwarded to AI instead of showing "command not found"

# Uninstall
zen hook uninstall
```

## Configuration

Configuration is stored in `~/.ai-zen/cli/config.json` (or `$AI_ZEN_DIR/cli/config.json` if set). The `maxContextTokens` field on each model sets the migration threshold (typically ~25% of the model's actual context window, e.g. 250,000 for a 1M-token model).

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

### Environment Variable

- `AI_ZEN_DIR` — Override the shared root directory (default: `~/.ai-zen`). CLI runtime data goes to `$AI_ZEN_DIR/cli/`, and shared resources (agents, skills, tools, MCP, etc.) go to `$AI_ZEN_DIR/`.

## Filesystem Layout

```
~/.ai-zen/                    ← Shared root (AI_ZEN_DIR)
├── cli/                      ← CLI runtime data
│   ├── config.json           ← CLI endpoints, models
│   ├── conversations/        ← CLI conversations
│   └── drafts/               ← CLI drafts
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

1. Project personal `.ai-zen/mcp.json` (collected from cwd up to git root)
2. Project shared `.mcp.json` (same)
3. User-level `~/.ai-zen/mcp.json`

Same-named servers in higher priority override lower ones.

## Built-in Tools

The CLI provides 16 built-in file system tools, implemented by `@ai-zen/agents-sdk`:

| Tool | Description |
|------|-------------|
| `cwd` | Get current working directory |
| `readFile` | Read file contents |
| `writeFile` | Write content to file |
| `edit` | Replace text in files (single replacement) |
| `batchEdit` | Batch replace text in files |
| `mkdir` | Create directories |
| `rm` | Delete files or directories |
| `glob` | Scan files with glob patterns |
| `ls` | List directory contents |
| `exist` | Check if path exists |
| `exec` | Execute shell commands |
| `findText` | Search text in files |
| `downloadFile` | Download file from URL |
| `generateImage` | Generate images from text |
| `rename` | Rename or move files |
| `copy` | Copy files or directories |

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

Tools are assembled in three phases by the SDK's `Capabilities` class:

1. **Discovery** — Scan filesystem for built-in tools, user tools, SubAgents, Skills, and MCP servers
2. **Filtering** — Apply permissions (`allow`/`deny`) and security exclusions (recursion protection)
3. **Instantiation** — Map filtered names to `Tool` instances and register dynamic loaders

Each Agent has independent permissions — no inheritance between parent Agent and SubAgent. The only exception is the temporary Skill sub-agent (created by `call_skill_sub_agent`), which inherits the caller's permissions as a transient conversation proxy rather than an independent entity.

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
  "servers": {
    "my-server": {
      "transport": "stdio",
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

### OAuth (HTTP transport only) — 暂不支持

OAuth 2.0 授权流程（`mcp.json` 中的 `oauth` 字段）已定义类型和预留 `mcp-oauth/` 存储目录，但尚未实现。目前配置了 `oauth` 的 HTTP MCP 服务器将因缺少 token 而连接失败。

## Preset Endpoints

| ID | Name | Default Base URL |
|----|------|-----------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (ZhipuAI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## Preset Models

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
pnpm test -- src/__tests__/e2e.test.ts
```

## License

ISC
