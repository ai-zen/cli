---
title: Commands
description: The slash commands of @ai-zen/cli — session, configuration, handoff and host groups, with aliases and arguments, plus the / menu and /help.
outline: deep
---

# Commands

Commands are typed into the input line starting with `/`. Names, aliases and descriptions come from one table (`src/commands/registry.ts`), so the menu below the input line, `/help` and this page cannot drift apart.

Arguments follow the command name, split on whitespace: `/handoff self` is a command name plus one argument. Names and aliases are case-insensitive.

## Commands that need an idle session

While this session is running (the host reports `working`) the five below are refused up front, with a line saying so:

| Command     | Why                                                                                     |
| ----------- | --------------------------------------------------------------------------------------- |
| `/model`    | writes the session row; the next request already switches model — mixing two providers inside one batch, where tool-call shape and reasoning params can disagree |
| `/think`    | same (the effort preset is a model parameter)                                            |
| `/back`     | revert deletes messages; the host refuses while it is running ("wait until it stops")   |
| `/handoff`  | handoff reads this session's whole memory; the host refuses while it is answering        |
| `/migrate`  | same, and it swaps the memory too                                                        |

The `/` menu prefixes those entries with "unavailable while busy"; the gate and the menu read the same flag (`CommandMeta.needsIdle`).

**Starting and switching sessions is not affected**: `/new` `/load` `/sessions` `/ws` only change which session you are looking at or where the next one starts, and the running one keeps running in the registry. `/clear` (screen only), `/free` (the queue), `/pin` `/rename` `/agent` and the configuration commands stay available.

## Sessions

| Command     | Alias     | Arguments                           | What it does                                                                                                                                                                             |
| ----------- | --------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/new`      |           |                                     | open a session in the current project with the same agent; the running one keeps running                                                                                                 |
| `/load`     |           | `-a`, `--all`                       | switch to an existing session (`session.list`); `--all` crosses projects                                                                                                                 |
| `/sessions` | `/ps`     | `-a`, `--all`                       | list sessions and switch; rows for sessions this process holds also say busy or idle, what it is doing, and how many entries wait                                                        |
| `/ws`       |           | `new [path]`, `delete <name or id>` | list projects and switch to one (`/ws new` registers the current directory on a local host, an absolute path on a remote one; `/ws delete` removes a project together with its sessions) |
| `/pin`      |           | `on`, `off`                         | pin or unpin this session (`session.pin`); without an argument it flips the current state                                                                                                |
| `/back`     | `/revert` |                                     | retract to before one of your messages (`session.rewind`); the removed text and assets come back to the input                                                                            |
| `/rename`   | `/save`   | `<name>`                            | rename this session (`session.rename`); the id stays                                                                                                                                     |
| `/editor`   |           |                                     | compose this message in `$EDITOR`, `$VISUAL` or the platform default                                                                                                                     |
| `/clear`    |           |                                     | clear the screen only; the context stays                                                                                                                                                 |
| `/free`     |           |                                     | drop the queue (`runtime.agent.clearInbox`) and say how many entries went; with nothing queued it says nothing                                                                           |
| `/delete`   |           |                                     | delete this session (`session.delete`); the confirmation states the message count and the asset count first                                                                              |
| `/kill`     |           | `[id or name]`                      | kill the agent of a session (`runtime.agent.kill`); the session row and its history stay, and the next send wakes it again                                                               |
| `/exit`     | `/quit`   |                                     | quit the client; the host keeps running                                                                                                                                                  |

`/save` is an alias of `/rename`: the old `/save <name>` renamed the session, and that half is kept; saving itself is gone, since a session is in the database from the moment it is created. The launch parameter `--save` is a different thing (it keeps one stdio call as a session).

`/kill` picks a session by full id first, then by id prefix, then by name; when several match it lists their ids instead of guessing. `/delete` moves to the most recent other session in this project afterwards, and when there is none it stays put and says `/new` opens one.

## Configuration

| Command   | Alias     | Arguments                                               | What it does                                                                                                                           |
| --------- | --------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/config` |           |                                                         | open the configuration centre (see [Configuration](./configuration.md))                                                                |
| `/model`  |           | `[<id>]`, `-a`/`--agent [<id>]`, `-g`/`--global [<id>]` | switch the model for this session, for the agent definition, or the global fallback                                                    |
| `/think`  | `/effort` | `[level]`, `-a`/`--agent [level]`                       | switch the reasoning effort for this session or for the agent definition                                                               |
| `/agent`  |           | `[id]`                                                  | choose the default agent; it applies to sessions opened later                                                                          |
| `/mcp`    |           | `[user\|workspace]`                                     | open the MCP screen of the configuration centre at that layer; without an argument, at the layer that has entries                      |
| `/key`    |           |                                                         | set the API key of the current endpoint (that field of the configuration centre)                                                       |
| `/lang`   |           | `[zh\|en]`                                              | switch the language: `config.language` for the sentences the host renders, the local preference for the interface; no argument toggles |
| `/reload` |           |                                                         | make the host rediscover tools, skills, MCP servers and sub-agents (`runtime.scope.reload`), then re-read this session                 |

`/model` without a flag writes the session row, `-a` the agent definition and `-g` the fallback in `config.json`. Changing the model or the thinking level of a session that has work in hand is refused by the host, so the client asks first whether to try now.

The levels `/think` offers come from the preset table the model references; the agent-level screen also carries one entry that stops writing that layer, which strips the thinking parameters back out of the definition. When neither layer can be written it says so instead of showing an empty menu.

The receipt of `/reload` says how many scopes were refreshed and whether any failed: `0/2` and `2/2` are two different facts, and that sentence does not merge them.

## Handoff

| Command    | Arguments         | What it does                                                                                                                  |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/handoff` | `[self\|summary]` | write a handoff document only (`handoff.start` with `kind: "document"`); memory, agent and archive stay as they are           |
| `/migrate` | `[self\|summary]` | write the document and swap memory now (`kind: "swap"`): memory becomes a new one, the old memory becomes an archived session |

`self` has this session's own agent write the document; `summary` starts a separate one-shot agent to do it. Without an argument `/handoff` asks who writes it, `/migrate` does not. Neither swaps the screen: a swap replaces memory in place, and the session id stays.

Where the document went is the host's fact, so the receipt only says started; the notice carrying the path arrives in the notice bar when it is written.

Both run a model call, so the input line is held while they run.

## Host

| Command     | What it does                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/upgrade`  | move the host to the highest version on the registry (`host.upgrade`); the client goes back to the connect screen and waits for the host to be relaunched on the new version |
| `/shutdown` | shut the host down (`host.shutdown`); one host serves the whole machine, so this drops every other client on it, and the client goes back to the connect screen              |
| `/help`     | list the commands with their descriptions                                                                                                                                    |

Both `/upgrade` and `/shutdown` confirm once (yes / no); until then no procedure is called. How each of them runs is on the [Host](./host.md) page.

## Questions from the host

When the context reaches the handoff line, or before an action that cannot be undone, the host asks a question. The client draws it with the host's own wording and choices, and sends the chosen value back through `question.answer`.

Leaving it unanswered leaves it pending: the question stays, and the host then refuses further sends. Picking a choice for the human would decide on their behalf whether to hand off, so the client does not pick.

## The `/` menu and `/help`

Typing `/` in the input line lists every command; further typing narrows the candidates by prefix. The menu grows upwards from the input line: the arrow keys select, `Enter` runs the highlighted entry, `Tab` puts that command name into the input line.

`/help` prints the same list into the transcript, one command per line, with the description the menu shows. It needs no round trip, so it works even when the host cannot be reached.

Candidates match on the prefix of a name or an alias; an unknown `/xxx` gets one line saying the command is unknown.

## What a failure says

Where a handler can say something specific it does (a write failed, the user cancelled, an argument was not recognised). Whatever escapes those is caught at one exit and turned into one sentence: which command, plus the host's own words. Nothing is retried, downgraded or half-applied — a failed command left the state untouched, so the next frame is the truth.
