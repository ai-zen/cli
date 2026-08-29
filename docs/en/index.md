---
title: AI-Zen CLI
description: An interactive AI Agent terminal for @ai-zen/cli — ships with 19 built-in file-system tools, and supports MCP, Skill, sub-agent orchestration, and task migration.
outline: deep
---

# AI-Zen CLI

`@ai-zen/cli` is an **interactive AI Agent terminal**, built on [`@ai-zen/agents-sdk`](https://www.npmjs.com/package/@ai-zen/agents-sdk) and [`@ai-zen/agents-core`](https://www.npmjs.com/package/@ai-zen/agents-core). It provides a multi-turn conversational command-line interface, ships with a complete set of file-system tools, and supports **MCP**, **Skill**, **sub-agent orchestration**, and **task migration**.

## What problem does it solve

When collaborating with AI in a bare terminal, you often have to manually switch back and forth between several external commands (reading/writing files, executing commands, searching, downloading, viewing/generating images…). AI-Zen CLI packages these capabilities into a set of **tools that the Agent can call directly**, letting the model autonomously perform file read/write, command execution, directory browsing, text search, image analysis and generation, and more—all within the conversation. Together with **MCP** for connecting external services, **Skill** for reusing reusable workflows, and **task migration** for seamlessly continuing a conversation when the context limit is exceeded.

## Key features

- **Interactive main menu**: resume an unfinished draft, start a new conversation, continue a saved conversation, manage saved conversations, manage Agents, and manage configuration.
- **19 built-in tools**: the file-system and image-processing toolset provided by `@ai-zen/agents-sdk` — see [Built-in Tools](./tools.md).
- **5 dynamically loaded tools**: `load_skill`, `call_skill_sub_agent`, `load_mcp`, `call_mcp_tool`, `read_mcp_resource`.
- **Sub-agent orchestration**: Agents with a `function` field can be called as tools by other Agents, with an independent permission system.
- **Skill**: reusable skills defined via `SKILL.md`, loaded contextually and delegatable to a Skill sub-agent.
- **MCP support**: connect MCP servers over stdio / HTTP / SSE transports, with multi-level config merging.
- **Task migration**: automatically generate a handoff document and start a new session when context tokens exceed the limit; you can also trigger it manually at any time with `/migrate`.
- **Draft recovery**: an abnormally exited conversation is automatically saved as a draft and can be resumed with one click on the next launch.
- **Shell fallback hook**: `zen hook install` forwards unrecognized terminal commands to the AI for processing.

## Documentation navigation

- [Quick Start](./getting-started.md) — installation, the main menu, and conversation commands.
- [Built-in Tools](./tools.md) — the 19 built-in tools, the dynamic loading tools, and the permission model.
- [MCP Support](./mcp.md) — MCP configuration, merge priority, connection, and current OAuth status.
- [Skill](./skills.md) — Skill directories, loading, and Skill sub-agent delegation.
- [Task Migration](./migration.md) — automatic/manual migration and the handoff document structure.
- [Configuration](./configuration.md) — config files, directory layout, preset endpoints, and models.

## License

The package `@ai-zen/cli` is released under the **MIT** license (see the `license` field in `package.json`).
