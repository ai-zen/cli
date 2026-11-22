---
title: Configuration
description: The seven subjects of the configuration centre — endpoints, models, image models, MCP servers, agents and sub-agents, defaults, tool output limit; each field written as it is edited, configuration living on the host.
outline: deep
---

# Configuration

## Configuration lives on the host

Configuration is `config.json` under the data root (given by `AI_ZEN_DIR`, `~/.ai-zen` by default), read and written by the host. The client does not assemble a whole configuration locally and does not write that file: it reads through procedures — one `config.get` returns the configuration together with the reasoning preset table — and every edit is one write call (`config.setDefaults`, `config.setGlobal`, `config.endpoint.*`, `config.model.*`, `config.imageModel.*`, `mcp.save`, `agentDefinition.update` and so on) whose result is the whole configuration after the change.

So what the screen shows next is what the host has. A successful write is already in effect; there is no "restart to apply".

## The configuration centre

`/config` opens the configuration centre. One screen per subject, with a create entry as the first row (the MCP screen also carries one entry that switches layers) and a detail screen for editing an entry in place:

| Screen | What it edits |
|---|---|
| Endpoints | name, base URL, API key, description; add and remove |
| Models | name, endpoint, model name, reasoning preset, handoff and guard thresholds, vision flag, description; add, remove, restore a factory entry |
| Image models | name, endpoint, model name, default size and quality, description; add, remove, restore a factory entry |
| MCP servers | one layer at a time (user or project): name, transport (stdio / http / sse), command, arguments, environment, URL, headers, enabled, description |
| Agents | agents and sub-agents: name, description, model, reasoning level, prompt, the four permission dimensions (tools, skills, MCPs, sub-agents) |
| Defaults | see the next section |
| Tool output limit | characters of tool output kept in context |

There is one rule: each field writes as soon as it is edited. No save key, no draft copy to lose — a field is committed with one write call, and the configuration that comes back is the next frame on screen.

Four details:

- Removing an endpoint first shows who points at it (the names of the models and image models); when the host refuses, its own sentence is shown.
- Removing a model first says which of the three default slots point at it and what they will point at instead (the first remaining model on the same endpoint), or that they will be cleared.
- A new model needs both thresholds on the spot (handoff and guard): the host does not fill them in, so the screen offers a starting point that can be edited right there.
- Multi-line content — prompts, function descriptions, parameter schemas — opens the local editor on `Enter`; content that did not change is not written.

Closing the configuration centre folds the entries changed this time into one notice saying what changed; when anything changed, this session also re-reads the facts it holds (model, reasoning level, the status bar blocks).

## Defaults

| Item | What it is |
|---|---|
| Default agent | which agent sessions opened later use; sessions already open are unaffected |
| Fallback model | what is used when an agent definition binds no model |
| Migration model | what the handoff run uses |
| Default image model | what image generation uses by default |
| Naming model | what automatic naming uses |
| Keep output on interrupt | `abortedMessageStrategy`: keep the partial answer from before the interrupt in the context, or drop it |
| Tool calls on interrupt | `abortedToolRoundStrategy`: keep the whole batch of tool calls with a reason backfilled for the unfinished ones, or drop it |
| Auto title | on / off: whether the host names a session the first time it goes idle |

The first five can be left unset, and clearing one leaves nothing pointing; the last three are a fixed set of choices with no empty state. The two interrupt items are the user-visible form of those two fields and take effect on live agents right away; auto title rebuilds no agent — the next idle moment reads the new value.

The tool output limit is not carried by the agent: the capability scope reads it at the moment a tool is called, so no agent has to be rebuilt after the change.

## Factory-managed entries

Models and image models carry a `custom` flag. An entry that is not marked `custom: true` belongs to the factory list and is replaced by it every time the host reads the configuration; editing a factory-managed entry makes the host mark it custom.

The detail screen of a model or an image model has a restore action: it replaces that entry with the factory entry of the same id and puts it back under factory management. Endpoints are never managed that way — adding, editing and removing them is a human decision.

## Models come from three levels

| Level | Written where | Written by |
|---|---|---|
| this session | `modelId` on the session row | `/model <id>` |
| agent definition | `modelId` on the definition | `/model -a <id>` |
| global fallback | `defaultModel` in `config.json` | `/model -g <id>` |

The session-level override wins, then the agent definition, then the fallback. The model id on the status bar is what the host resolved through those levels; the client does not work it out itself.

The reasoning level has two writable levels: this session (`session.setThinkingLevel`) and the agent definition (`modelParams` in `agentDefinition.update`). The levels offered come from the preset table the model references; the client looks them up and keeps no second copy.

The other commands each write one field: `/agent` writes the default agent, `/key` writes the API key of the current endpoint, `/mcp` opens the MCP screens of those two layers, `/lang` writes `config.language` and the local preference, and `/reload` changes no configuration — it has the host re-read its capability scopes from what is on disk.

## What is left on this machine

Under the data root the client owns four small files and its own log directory; everything else there belongs to the host.

| Path | Contents |
|---|---|
| `cli/connection.json` | the host picked on the connect screen; written only when a human picks one |
| `cli/last-workspace.json` | the project entered last, one entry per host |
| `cli/last-session.json` | the session opened last, one entry per project |
| `cli/preferences.json` | interface language (`AIZ_PREFERENCES_FILE` overrides the path) |
| `logs/cli/cli.log` | the client's log, 2 MB per file, two files kept; warnings and errors also surface in the notice bar |
| `logs/cli/launch.log` | output of the host process this client started, rewritten on every launch |
| `logs/cli/keys.log` | key diagnostics, written only with `AIZ_DEBUG_KEYS=1` (`AIZ_KEYS_FILE` overrides the path) |

All of these are caches: a file that cannot be read is not written back — the client carries on as if there were no record and leaves the bytes on disk alone.
