---
title: MCP Support
description: MCP server configuration in @ai-zen/cli, the multi-level merge priority, the connection lifecycle, and the current OAuth status.
outline: deep
---

# MCP Support

The CLI integrates [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers through `@ai-zen/agents-sdk` and provides three dynamically loaded tools: `load_mcp`, `call_mcp_tool`, and `read_mcp_resource`. The connection lifecycle (connect, reconnect with exponential backoff, idle timeout) is fully managed by the SDK's `McpConnectionManager`.

## MCP configuration structure

MCP server configuration is stored in `mcp.json` files, using the industry-standard top-level `mcpServers` field (the CLI's `McpConfig` top-level field).

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

Server fields (written by the CLI via the configuration menu):

- `type`: the transport, `stdio` | `http` | `sse`.
- `stdio` case: `command`, `args`, `env`.
- `http`/`sse` case: `url`, `headers`.
- `disabled`: whether it is disabled (default `false`).
- `description`: the server description (shown to the LLM by `load_mcp`).

> The underlying SDK type `McpServerConfig` uses `transport` to represent the transport and normalizes it internally (also accepting `type` / `transportType`). When the CLI reads/writes `mcp.json` itself, it consistently stores the conventional `type` field (see the `McpServersMap` in `src/config.ts`), and the README example matches it.

## Config files and merge priority

MCP server configurations are merged from multiple sources **high to low**, with same-named servers overridden by the higher-priority one:

1. Project-shared `./.mcp.json`
2. Project-personal `./.ai-zen/mcp.json`
3. Project-convention `./.agents/mcp.json`
4. User-level `~/.ai-zen/mcp.json`
5. User-convention `~/.agents/mcp.json`

> The order above comes from `getScope()` in `src/agent-creator.ts` and the comments in `src/config.ts`.

## Dynamically loaded tools

- **`load_mcp`**: connect to an MCP server and list its tools/resources/prompts (idempotent; repeated calls skip reconnection). The server enumeration is inferred automatically from `filteredMcps`.
- **`call_mcp_tool`**: call a tool on the server via the official `Client.callTool()` API.
- **`read_mcp_resource`**: read a resource on the server.

## OAuth (HTTP transport) — not yet supported

The MCP OAuth 2.0 authorization flow (the `oauth` field in `mcp.json`) is defined in the SDK types and a `mcp-oauth/` storage directory is reserved, but it is **not yet implemented**. Currently, an HTTP MCP server configured with `oauth` will fail to connect because a token is missing.

## Management

In the TUI, `/config` → "MCP servers" lets you manage `mcp.json` interactively — no hand-editing needed:

- **Scope switch**: toggle in-screen between "global" `~/.ai-zen/mcp.json` and "project" `<cwd>/.ai-zen/mcp.json`.
- Add / delete / rename MCP servers; edit transport (stdio / http / sse), enable·disable, and description.
- Edit the fields for the chosen transport: stdio → command, args (split on whitespace into argv), env; http·sse → URL, headers. Env and headers use a `KEY=VALUE` editor.
- Changes are written immediately; closing the configuration center rebuilds the session so new servers / tools take effect at once.

The other sources (project-shared `./.mcp.json`, project convention `./.agents/mcp.json`, user convention `~/.agents/mcp.json`) still follow the files.
