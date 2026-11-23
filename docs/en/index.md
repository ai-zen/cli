---
title: AI-Zen CLI
description: The terminal client for an AI-Zen host — one WebSocket carrying one tRPC connection; the terminal draws what the host reports and sends the human's actions back.
outline: deep
---

# AI-Zen CLI

`@ai-zen/cli` is the terminal client for an AI-Zen host (`@ai-zen/agents-host`). One WebSocket carries one tRPC connection: sessions, messages, inbox, gates, handoff and assets live on the host, and the terminal draws what the host reports and sends the human's actions back.

## The division of labour

|                                                   | Host                         | This client                                                   |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| Model calls, tool calls, sub-agents               | yes                          | no                                                            |
| Sessions, messages, inbox, gates, handoff, assets | in `<data root>/ai-zen.db`   | read over the connection                                      |
| `<data root>/config.json`                         | read and written by the host | edited only through procedures                                |
| The terminal                                      | nothing                      | everything                                                    |
| Launching a host                                  | never launches itself        | launches one when the connection is local and nothing answers |

The dividing line in one sentence: the host decides what is true at this moment, the client decides what an invocation does and how a frame looks.

So this repository holds no tool implementations, no skill discovery, no MCP connections and no model requests. The tool surface, capability scopes and the two kinds of handoff belong to the host and the SDK; what the client keeps is the command entry points (see [Commands](./commands.md)), and the capabilities themselves are documented on the `@ai-zen/agents-host` and SDK side.

## What the client owns

Two things belong to the client, because they are about this invocation: what a slash command does ([Commands](./commands.md)) and how a frame looks ([Interface](./interface.md)).

On this machine it keeps four small files and its own log directory — the host picked on the connect screen, the project entered last, the session opened last, the interface language. Sessions and configuration are not among them. The paths are listed at the end of [Configuration](./configuration.md).

## Where to read next

| Page                                | What it covers                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [Quick Start](./getting-started.md) | install, build, the first launch (a host fetched with `npx`), connecting to a remote host, the first message, quitting  |
| [Commands](./commands.md)           | the command tables grouped by session / configuration / handoff / host, aliases and arguments, the `/` menu and `/help` |
| [Configuration](./configuration.md) | the configuration centre tree, each field written as it is edited, configuration living on the host                     |
| [Interface](./interface.md)         | the status bar, the phase line, sub-agent tabs, the notice bar, the input line                                          |
| [Host](./host.md)                   | local and remote hosts, local launch, `/upgrade`, `/shutdown`, credentials                                              |

## License

The package `@ai-zen/cli` is released under the MIT license (see `LICENSE` at the repository root).
