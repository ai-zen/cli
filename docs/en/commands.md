# Commands

Type `/` to open the candidate menu, `/help` to list everything. Commands are a client concept: the host has one method table and does not know names such as `/back` or `/pin`. There is a single list, in `src/commands/registry.ts`.

## Sessions

| Command | Effect |
|---|---|
| `/new` | Create a session |
| `/load` | Open a saved session; `--all` spans workspaces |
| `/sessions` (`/ps`) | List sessions and switch; `--all` spans workspaces |
| `/ws` | Workspaces: list, switch, create, delete |
| `/pin` | Pin or unpin the current session |
| `/rename <name>` (`/save`) | Rename the current session |
| `/title` | Ask the model for a fresh name for this session |
| `/back` (`/revert`) | Take back the last user message so it can be edited and resent |
| `/kill` | Terminate this session's agent, keeping the history |
| `/delete` | Delete this session, messages and assets included |

`/new`, `/load`, `/sessions` and `/ws` do not interrupt a running session: switching changes the view while the previous session keeps running in the background.

`/kill` and `/delete` differ in what they keep: the first only terminates the agent, leaving the session row and history to be woken again; the second removes the row, the messages and the assets, and cannot be undone.

`/rename` writes the name field of the session row; `/title` asks the model to read the conversation and propose one. Automatic naming happens only after the first answer, so a later name has to be requested.

## Runtime control

| Command | Effect |
|---|---|
| `/clear` | Clear the screen (display only) |
| `/free` | Clear the inbox (messages not yet sent) |
| `/handoff` | Write a handoff document without swapping memory |
| `/migrate` | Write a handoff document and swap memory (old memory archived) |

`/clear` and `/free` are two different things: one clears the display, the other clears the queue. They used to be one command and are now separate — "the screen lost something" and "the message I sent is still waiting" are different expectations.

`/handoff` and `/migrate` are the two kinds of handoff. The first treats the document as an export and leaves memory alone; the second swaps after writing, making the old memory a separate archived session.

## Configuration and models

| Command | Effect |
|---|---|
| `/config` | Configuration centre: endpoints, models, agent definitions |
| `/model` | Switch model: this session / agent definition / global |
| `/think` (`/effort`) | Switch thinking level |
| `/agent` | Set the default agent definition (new sessions only) |
| `/key` | Set an endpoint's API key |
| `/mcp` | Manage MCP servers: add, remove, edit, enable, disable |
| `/lang` | Switch the interface language |

`/model` has three scopes, matching the runtime's three-level resolution:

| Scope | Written to | Affects |
|---|---|---|
| This session | The session row's `modelId` | This session only |
| Agent definition | The definition's `modelId` | Every future session of that agent |
| Global | `defaultModel` in `config.json` | The fallback for agents with no bound model |

`/think` levels come from the endpoint's reasoning preset table (`reasoning-presets.json`): whatever levels the table has are the levels you can pick. Choosing "follow model default" clears this layer of parameters; a model that always thinks and has no off switch has no off level.

`/agent` and the "agent definition" scope of `/model` are not the same thing: the first changes which definition new sessions default to and leaves the current session alone; the second changes the model this session uses.

## Other

| Command | Effect |
|---|---|
| `/reload` | Reload tools, skills and MCP servers |
| `/upgrade` | Upgrade the host to the highest version among the release tags |
| `/help` | Show help |
| `/form` | Debug: lay out one of every form field |
| `/editor` | Compose a long message in an external editor |
| `/shutdown` | Shut the host down and return to the connect screen |
| `/exit` (`/quit`) | Exit the program without shutting the host down |

`/upgrade` upgrades the host, not the client: it asks the release tags for the highest version, compares, confirms, then has the host record the version for its next start and exit because of the upgrade; installing and starting are up to whatever launched it. Other clients on this machine (including the desktop app) disconnect meanwhile. Sessions and history are in the database and survive the restart, but the request that was in flight is interrupted.

`/reload` is what you use after adding files to a capability directory or editing `mcp.json`. Automatic refresh on the host side is governed by `autoRefreshTools`; when that is `off`, this command is the only way to make new capabilities take effect.

## Two command attributes

Each command carries two attributes that change its behaviour:

- **Needs idle** (`/model`, `/think`, `/back`, `/handoff`, `/migrate`): refused while the session is running, with "unavailable while processing". They change settings this session is using, and swapping them mid-run either breaks tool call formats or is rejected by the host immediately
- **Blocks input** (`/title`, `/handoff`, `/migrate`): the host calls a model for tens of seconds during these. The input row is held for that period; otherwise you would assume nothing happened, keep typing, and the keys would be swallowed into a hidden buffer

Both attributes belong to the command and are declared in the command table, not in a host-side whitelist: adding a command touches that one file and the behaviour follows.
