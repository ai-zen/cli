---
title: AI-Zen CLI
description: A dual-mode AI Agent terminal for @ai-zen/cli (pure stdio pipelines + interactive TUI) — ships with 20 built-in file-system tools, and supports MCP, Skill, sub-agent orchestration, and task migration.
outline: deep
---

# AI-Zen CLI

`@ai-zen/cli` is a **dual-mode** AI Agent terminal, built on [`@ai-zen/agents-sdk`](https://www.npmjs.com/package/@ai-zen/agents-sdk) and [`@ai-zen/agents-core`](https://www.npmjs.com/package/@ai-zen/agents-core). With no arguments on an interactive terminal it enters the TUI (multi-turn chat); with arguments, or when piped/redirected, it runs in **pure stdio** mode (writing the answer to stdout). It ships with a complete set of file-system tools and supports **MCP**, **Skill**, **sub-agent orchestration**, and **task migration**.

## What problem does it solve

When collaborating with AI in a bare terminal, you often have to manually switch back and forth between several external commands (reading/writing files, executing commands, searching, downloading, viewing/generating images…). AI-Zen CLI packages these capabilities into a set of **tools that the Agent can call directly**, letting the model autonomously perform file read/write, command execution, directory browsing, text search, image analysis and generation, and more—all within the conversation. Together with **MCP** for connecting external services, **Skill** for reusing reusable workflows, and **task migration** for seamlessly continuing a conversation when the context limit is exceeded.

## Key features

- **Dual-mode execution**: no arguments on an interactive terminal enters the TUI; arguments or a pipe/redirect runs pure stdio (result on stdout, logs on stderr, clear exit codes).
- **Modern TUI**: a full-screen Ink/React interface — animated gradient ASCII splash, straight into chat, a bottom-pinned input area and status bar, and an inline `/` command menu.
- **Syntax highlighting**: tool-call arguments are **JSON**-highlighted and fenced code blocks in the answer/reasoning are highlighted by language (highlight data from `highlight.js` / `lowlight`; the CLI only renders it).
- **Command hints**: typing `/` in a conversation lists the available commands with descriptions below the input line, narrowing the candidates by prefix as you type.
- **20 built-in tools**: the file-system and image-processing toolset provided by `@ai-zen/agents-sdk` — see [Built-in Tools](./tools.md).
- **5 dynamically loaded tools**: `load_skill`, `call_skill_sub_agent`, `load_mcp`, `call_mcp_tool`, `read_mcp_resource`.
- **Sub-agent orchestration**: Agents with a `function` field can be called as tools by other Agents, with an independent permission system.
- **Skill**: reusable skills defined via `SKILL.md`, loaded contextually and delegatable to a Skill sub-agent.
- **MCP support**: connect MCP servers over stdio / HTTP / SSE transports, with multi-level config merging.
- **Task migration**: ask for confirmation first when context tokens exceed the limit, then automatically generate a handoff document and start a new session; you can also trigger it manually at any time with `/migrate`.
- **Session recovery**: every conversation is persisted as its own file in real time, and a pointer records the "last session id"; the last session is resumed automatically on the next launch.
- **Shell fallback hook**: `ai hook install` forwards unrecognized terminal commands to the AI for processing.

## Documentation navigation

- [Quick Start](./getting-started.md) — installation, the chat screen, and conversation commands.
- [Built-in Tools](./tools.md) — the 20 built-in tools, the dynamic loading tools, and the permission model.
- [MCP Support](./mcp.md) — MCP configuration, merge priority, connection, and current OAuth status.
- [Skill](./skills.md) — Skill directories, loading, and Skill sub-agent delegation.
- [Task Migration](./migration.md) — automatic/manual migration and the handoff document structure.
- [Configuration](./configuration.md) — config files, directory layout, preset endpoints, and models.

## License

The package `@ai-zen/cli` is released under the **MIT** license (see the `license` field in `package.json`).
