---
title: Built-in Tools
description: The 19 built-in tools, 5 dynamically loaded tools, the tool assembly pipeline, and the permission model of @ai-zen/cli.
outline: deep
---

# Built-in Tools

All tool capabilities come from `@ai-zen/agents-sdk` (`BUILTIN_TOOL_CLASSES`, 19 in total) and the SDK's dynamic loading mechanism. The CLI itself does **not** add any tool class; it only assembles paths, builds the `Provider` singleton, and passes the tool directories plus the MCP/Skill-related paths to the SDK.

## The 19 built-in tools

These tools are instantiated by the SDK's static registry (`discoverBuiltinTools`) and are assembled **without any filtering** (all are unconditionally registered during discovery); their availability is self-declared by each tool (`isAvailable`).

| Tool | Description |
|------|-------------|
| `cwd` | Get the current working directory |
| `readFile` | Read file contents |
| `writeFile` | Write content to a file |
| `edit` | Replace text in a file (single replacement) |
| `batchEdit` | Batch-replace text in files |
| `exec` | Execute a shell command |
| `exec_async` | Execute a shell command asynchronously (returns immediately) |
| `mkdir` | Create directories |
| `rm` | Delete files or directories |
| `glob` | Scan files with glob patterns |
| `ls` | List directory contents |
| `exist` | Check whether a path exists |
| `findText` | Search for text inside files |
| `downloadFile` | Download a file from a URL |
| `rename` | Rename or move files/directories |
| `copy` | Copy files or directories |
| `sleep` | Wait for the specified number of milliseconds |
| `viewImage` | View/analyze an image (vision models only) |
| `generateImage` | Generate images from a text description |

### Availability of the vision and image tools

- **`viewImage`**: enabled only for vision models. `isAvailable(config, definition)` resolves the current model from `definition.modelId` and checks `Model.vision`, so **non-vision models will not get this tool** (no need for repeated runtime validation).
  - Input `path_or_url`: an `http(s)` URL is returned directly as an `image_url` content block; a local path is auto-uploaded via the Files API (DeepSeek) and returned as a `file` content block (`file_id`). Base64 inline is not used.
- **`generateImage`**: depends on `imageModels` and `defaultImageModel` in the config; if not configured, it is filtered out by `isAvailable`. It **always returns a string** (JSON, containing the image URL list plus `viewImage`/`downloadFile` hints) rather than forcing an image content block.

> The exact field names, declarations, and return types should be confirmed against the SDK's `.d.ts` (e.g. `ViewImageTool` / `GenerateImageTool`).

## The 5 dynamically loaded tools

In addition to the built-in tools, the SDK also provides **dynamically loaded tools** that are registered on demand based on available resources and permissions:

| Tool | Purpose |
|------|---------|
| `load_skill` | Load a Skill document into context (idempotent; repeated calls skip re-injection) |
| `call_skill_sub_agent` | Delegate a task to a Skill sub-agent (only works for Skills with `sub-agent: true` in frontmatter) |
| `load_mcp` | Connect to an MCP server and list its tools (idempotent; repeated calls skip reconnection) |
| `call_mcp_tool` | Call a tool on a connected MCP server |
| `read_mcp_resource` | Read a resource from a connected MCP server |

> These tools are created by the SDK's `createLoadSkillTool` / `createCallSkillSubAgentTool`, `createLoadMcpTool` / `createCallMcpTool` / `createReadMcpResourceTool`, respectively.

## Sub-agent tools

The SDK's `createSubAgentTool` registers Agents that have a **`function` field** as tools that other Agents can call (SubAgents). It uses lazy building (`AgentToolLazy`) to avoid recursive creation issues during the tool-list construction phase. A sub-agent has **independent permissions** and does not inherit permissions from its parent Agent.

## Tool assembly pipeline

Tools are assembled through the SDK `Provider` capability pipeline in three phases:

1. **Discovery**: scan the filesystem to discover built-in tools, user tools, SubAgents, Skills, and MCP servers. All 19 built-in tools are registered unconditionally (no filtering at this stage).
2. **Filtering**: apply permissions (`allow`/`deny`), security exclusions (recursion protection), and each tool's self-declared `isAvailable(config, definition)`. Availability is decided at build time when the model is known — e.g. `viewImage` is only available for vision models, and `generateImage` requires `defaultImageModel` to be configured.
3. **Instantiation**: map the filtered names to `Tool` instances and register the dynamic loaders.

## Permission model

`AgentPermissions` defines permissions across four dimensions (from the SDK types):

```typescript
interface AgentPermissions {
  tools?: { allow: string[] } | { deny: string[] };
  skills?: { allow: string[] } | { deny: string[] };
  mcps?: { allow: string[] } | { deny: string[] };
  subagents?: { allow: string[] } | { deny: string[] };
}
```

Key rules:

- A missing `permissions` field = all dimensions denied (`deny: ["*"]`).
- Each dimension uses either `allow` (whitelist) or `deny` (blacklist); the two are mutually exclusive.
- `"*"` wildcard matches any name.
- Denied resources are **completely invisible** to the LLM (not merely blocked).
- Each Agent has **independent permissions**; parent and child Agents do not inherit from each other.
- **The only exception**: the temporary Skill sub-agent created by `call_skill_sub_agent` acts as a one-off conversation proxy that **inherits the caller's permissions** rather than being an independent entity.
