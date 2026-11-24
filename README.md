# @ai-zen/cli

The terminal client for an AI-Zen host. One WebSocket carries a tRPC connection to the host; the terminal draws what the host reports and sends the human's actions back.

## What it is

This repository is the client half of the ai-zen workspace. The host (`@ai-zen/agents-host`) holds the database and runs the agents — model calls, tool calls, sub-agents, capability scopes; this client decides what an invocation does, draws frames, and keeps no facts of its own apart from a pointer to the host it talked to and the interface language.

|                                                   | Host                         | This client                                                   |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| ModelDefinition calls, tool calls, sub-agents     | yes                          | no                                                            |
| Sessions, messages, inbox, gates, handoff, assets | in `<data root>/ai-zen.db`   | read over the connection                                      |
| `<data root>/config.json`                         | read and written by the host | edited only through procedures                                |
| The terminal                                      | nothing                      | everything                                                    |
| Launching a host                                  | never launches itself        | launches one when the connection is local and nothing answers |

The dividing line in one sentence: the host decides what is true at this moment, the client decides what an invocation does and how a frame looks.

## Install and run

| Command        | What it does                            |
| -------------- | --------------------------------------- |
| `pnpm install` | installs dependencies                   |
| `pnpm build`   | bundles with rolldown into `dist/`      |
| `pnpm start`   | `pnpm build`, then `node dist/index.js` |

`package.json` declares three bin names — `ai`, `aiz`, `zen` — and all three point at `dist/index.js`.

The dependency graph ties this checkout to the neighbouring `agents` checkout: the `@ai-zen/agents-*` packages are `link:../agents/packages/*` dev dependencies, and the connection layer `@ai-zen/agents-client` is a private package that is inlined into `dist/` at build time. The host lives in `devDependencies` as well — it is never a runtime dependency of the client, and at runtime it is fetched with `npx`.

### First launch

Nothing is configured yet, so the client asks. With no `<data root>/cli/connection.json` (the file it writes only after a human picks a host on screen) and no explicit address, `ai` opens the connect screen — local, remote, or exit — and performs no I/O until one of them is chosen. Choosing local hands over to the launch screen; choosing remote only ever connects.

The host is started through `npx`, so the first local launch downloads it:

```bash
npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <data root>
```

`<range>` is the semver range of `@ai-zen/agents-host` this build was made against; it is baked into `dist/` at build time. The launch screen reports where the launch stands, one line at a time, and never a percentage (npm output is not parsed):

| Stage                 | What is being waited for                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| Resolving the version | npx resolving which version in that range to use                          |
| Installing            | npx downloading and installing it                                         |
| Starting the host     | the child process is up; waiting for the discovery file and the handshake |
| connected             | not drawn: the screen switches to the session                             |

A failed launch adds the child process's own last line and accepts `R` to try again; `Esc` and `Ctrl+C` kill the child and go back to the connect screen without quitting. When a host is already listening, no stage ever arrives and the launch screen draws nothing at all.

Once connected, the client enters a workspace and opens a session:

| Step       | Local host                                                                          | Remote host                                                |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Workspace  | the directory `ai` was run in, reused when `workspace.list` already has it          | the one entered last time on that host, otherwise a picker |
| Session    | the one opened last time in that workspace, unless `--new` is given                 | same                                                       |
| Credential | a screen asks for the API key when the endpoint behind the effective model has none | same                                                       |

### Launch parameters

| Parameter                         | What it does                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--server <url>`                  | talk to this host instead of the local one; accepts `ws:` / `wss:` / `http:` / `https:` and a path for a reverse-proxy mount                       |
| `--new`                           | open a new session instead of resuming the last one (the interactive path only)                                                                    |
| `--tui [prompt…]`                 | force the interactive interface; trailing words are sent as the first message (used by the shell hook); rejected when stdin or stdout is not a TTY |
| `--save`                          | keep a stdio call as a real session (ignored by the interactive path)                                                                              |
| `--server-status`                 | print the status of the host at that address as JSON and exit 0 when it answers, 1 when it does not; never launches anything                       |
| `hook install` / `hook uninstall` | install or remove the shell fallback hook                                                                                                          |
| `-h`, `--help`, `-v`, `--version` | usage and version; the single words `ai help` / `ai version` are the same                                                                          |

`--` ends option parsing, so a prompt may start with `-`.

An explicit address is taken from `--server`, `AI_ZEN_SERVER_URL`, or the discovery file, in that order, and never causes a local host to be spawned: whatever would be started here is not listening on that address. The credential for such a host comes from `AI_ZEN_SERVER_TOKEN` or, for a loopback address, `<data root>/run/token`. There is no `--token`: argv ends up in `ps` output and in shell history.

| Environment variable  | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `AI_ZEN_DIR`          | data root (default `~/.ai-zen`)                             |
| `AI_ZEN_SERVER_URL`   | same as `--server <url>`; the flag wins when both are given |
| `AI_ZEN_SERVER_TOKEN` | credential for an explicit address                          |

A malformed address fails before anything connects or launches, with one sentence on stderr and exit code 2.

## Two run modes

The two modes do not mix: one process takes one of them.

| Mode        | Trigger                                                                | stdout                           | Exit code                                                                  |
| ----------- | ---------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| Interactive | no positional arguments and both stdin and stdout are TTYs, or `--tui` | the interface owns the terminal  | 0                                                                          |
| Pure stdio  | at least one positional argument, or stdin or stdout is not a TTY      | the answer text and nothing else | 0 on success, 1 when the call fails, 2 when the invocation itself is wrong |

In pure stdio the argument is the instruction and stdin is the content; both are merged into one message when both are present. Log, progress and notices go to stderr, and no log file is written in this mode.

A stdio call is one call and one answer. By default it goes through `runtime.agent.runOnce` with the directory it was run in: no session row is created, nothing appears in any session list. With `--save` it goes through `session.create`, `runtime.agent.wake` and `runtime.agent.send`, the session id is printed on stderr, and that run does not move the remembered session.

| Situation                             | What happens                                            |
| ------------------------------------- | ------------------------------------------------------- |
| No host configured                    | exit code 2 and one line pointing at `ai` or `--server` |
| No input (no argument, no pipe)       | exit code 2 and one line                                |
| Remote host, no workspace entered yet | exit code 2 and a pointer to `/ws`                      |
| The model answers with an error       | exit code 1                                             |
| A question from the host              | left unanswered: nobody is there to answer it           |

`ai hook install` writes one block into `~/.bashrc` or `~/.zshrc`, picked from `$SHELL` (bash and zsh are the only supported shells; anything else exits 1). The block defines `command_not_found_handle` (bash) or `command_not_found_handler` (zsh) as `ai --tui --new "$@"`: a mistyped command opens the interface with that command as the first message, in a new session. The block is delimited by two marker lines, so re-running the install replaces the current block in place and `ai hook uninstall` removes every block it finds.

## Commands

Commands are typed into the input line starting with `/`; the menu below the input lists them and narrows by prefix. Names, aliases and descriptions come from one table, so the menu, `/help` and this page cannot drift apart.

Sessions:

| Command     | Alias     | Arguments                           | What it does                                                                                                                                                                                 |
| ----------- | --------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/new`      |           |                                     | open a session in the current workspace with the same agent; the running one keeps running                                                                                                   |
| `/load`     |           | `-a`, `--all`                       | switch to an existing session (`session.list`); `--all` crosses workspaces                                                                                                                   |
| `/sessions` | `/ps`     | `-a`, `--all`                       | list sessions and switch; rows for sessions this process holds also say busy or idle, what it is doing, and how many entries wait                                                            |
| `/ws`       |           | `new [path]`, `delete <name or id>` | list workspaces and switch to one (`/ws new` registers the current directory on a local host, an absolute path on a remote one; `/ws delete` removes a workspace together with its sessions) |
| `/pin`      |           | `on`, `off`                         | pin or unpin this session in the list (`session.pin`)                                                                                                                                        |
| `/back`     | `/revert` |                                     | retract to before one of your messages (`session.rewind`); the removed text and assets come back to the input                                                                                |
| `/rename`   | `/save`   | `<name>`                            | rename this session (`session.rename`)                                                                                                                                                       |
| `/editor`   |           |                                     | compose this message in `$EDITOR`, `$VISUAL` or the platform default                                                                                                                         |
| `/clear`    |           |                                     | clear the screen only; the context stays                                                                                                                                                     |
| `/free`     |           |                                     | drop the queue (`runtime.agent.clearInbox`) and say how many entries went                                                                                                                    |
| `/delete`   |           |                                     | delete this session (`session.delete`); the confirmation states the message count and the asset count first                                                                                  |
| `/kill`     |           | `[id or name]`                      | kill the agent of a session (`runtime.agent.kill`); the session row and its history stay                                                                                                     |
| `/exit`     | `/quit`   |                                     | quit the client; the host keeps running                                                                                                                                                      |

Configuration:

| Command   | Alias     | Arguments                                               | What it does                                                                                                                           |
| --------- | --------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/config` |           |                                                         | open the configuration center                                                                                                          |
| `/model`  |           | `[<id>]`, `-a`/`--agent [<id>]`, `-g`/`--global [<id>]` | switch the model for this session, for the agent definition, or the fallback                                                           |
| `/think`  | `/effort` | `[level]`, `-a`/`--agent [level]`                       | switch the reasoning effort for this session or for the agent definition                                                               |
| `/agent`  |           | `[id]`                                                  | choose the default agent; it applies to sessions opened later                                                                          |
| `/mcp`    |           | `[user\|workspace]`                                     | open the MCP screen of the configuration center at that layer                                                                          |
| `/key`    |           |                                                         | set the API key of the current endpoint                                                                                                |
| `/lang`   |           | `[zh\|en]`                                              | switch the language: `config.language` for the sentences the host renders, the local preference for the interface; no argument toggles |
| `/reload` |           |                                                         | make the host rediscover tools, skills, MCP servers and sub-agents (`runtime.scope.reload`), then re-read this session                 |

Handoff:

| Command    | Arguments         | What it does                                                                                                       |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/handoff` | `[self\|summary]` | write a handoff document only (`handoff.start` with `kind: "document"`); without an argument it asks who writes it |
| `/migrate` | `[self\|summary]` | write the document and swap memory now (`kind: "swap"`); the old memory becomes an archived session; it never asks |

Host:

| Command     | What it does                                                                                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/upgrade`  | take the highest semver tag of `@ai-zen/agents-host` from the registry, confirm once, then hand the version to the host (`host.upgrade`): the host verifies that version, records which one to launch next and exits for the upgrade; the client goes back to the connect screen |
| `/shutdown` | shut the host down (`host.shutdown`); one host serves the whole machine, so this drops every other client too, and the client goes back to the connect screen                                                                                                                    |
| `/help`     | list the commands with their descriptions                                                                                                                                                                                                                                        |

`/handoff self` writes the document with this session's own agent; `summary` makes one separate one-shot agent do it.

When the context reaches the handoff line, or before an action that cannot be undone, the host asks a question. The client draws the question with the host's own wording and choices and sends the chosen value back (`question.answer`); leaving it unanswered leaves the question pending, and the host then refuses further sends.

## Interface

An empty session shows the brand block — logo, tagline, the client, SDK and core versions — as ordinary transcript content, so it scrolls away with the transcript and comes back when scrolling up.

The layout is bottom-anchored. From the bottom up: status bar, input row, divider, queue band, phase line, command menu, attachment line, notice bar, sub-agent tabs. Everything above the divider appears only while it has something to say, and the transcript takes whatever height is left.

The status bar is made of five blocks, each read from the session at frame time:

| Block    | Content                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- |
| Identity | model id, agent name, reasoning effort                                                                |
| Gates    | busy or idle, plus `stopped`, `output off`, `intake off` when any of them is not in its normal state  |
| Usage    | tokens of the last answer and tokens of all answers, summed by the client from each message's `usage` |
| Rate     | a live estimate while generating, the average of the last answer afterwards                           |
| Keys     | the key hint line of the interface                                                                    |

Blocks are the unit of wrapping: a block that does not fit moves to the next line whole, and an empty block takes no width.

The phase line sits above the divider while the agent has work in hand and says which phase the client can read out of the facts it has: handing off, waiting in the queue, connecting, awaiting the first token, thinking, calling a tool, waiting for a tool to return, streaming. The two tool phases name the tools, and while several run in parallel they list only the ones still running.

While sub-agents exist, one tab line appears below the transcript. Each tab carries a `◈` whose colour is the state — blinking while running, green when it ended, red when it failed, faint when it was stopped, dim while it sits idle — and `←` / `→` with an empty input switches which agent's transcript is shown.

The notice bar is the only place notices appear; they never enter the messages, so they never reach the model. Three tones: info, warning, error (the host's four levels fold into these three). The bar keeps the four most recent notices, never more than eight lines, and drops the oldest whole notice when it runs out of room. Every send clears it (the local queue plus `notice.deleteAll` with that session id). Two manual entries: `Ctrl+X` clears this session's notices, and `Ctrl+G` asks once and then clears everything, global notices and other sessions' included.

Images in the transcript are placeholders, since a terminal cannot draw them in line. `Ctrl+O` lists the images of this session that still have an asset id, and for the one picked it fetches the bytes (`asset.get`), writes a temporary file and hands that file to the default program (`open`, `xdg-open`, or `cmd /c start`); each of the three steps reports its own failure.

`Ctrl+V` (or `Cmd+V` where the terminal reports it) asks the system clipboard for an image first — `osascript` on macOS, `wl-paste` or `xclip` on Linux, PowerShell on Windows — and attaches it to the next message when there is one; with no image on the clipboard it pastes the text at the cursor. Clipboard text over 256 KB is refused rather than truncated. Attached images go up with the message through `asset.upload`; how much fits is the host's rule, and its refusal is shown verbatim.

`@` completes file paths: candidates are the relative paths the host lists for this workspace (`workspace.files`), and what gets inserted is the path as plain text, so the message stays ordinary text and the model reads the file itself.

Typing keeps working while a request is in flight. A message sent then is delivered to the host, which puts it in the inbox; the queue band above the divider shows what is waiting, and the phase line says so.

## Configuration

`/config` opens the configuration center. One screen per subject, and each field writes as soon as it is edited — there is no save key, and no draft copy to lose:

| Screen              | What it edits                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| EndpointDefinitions | name, base URL, API key, description; add and remove                                                                                             |
| ModelDefinitions    | name, endpoint, model name, reasoning preset, handoff and guard thresholds, vision flag, description; add, remove, restore a factory entry       |
| Image models        | name, endpoint, model name, default size and quality, description                                                                                |
| MCP servers         | one layer at a time (user or workspace): transport, command, arguments, environment, URL, headers, enabled, description                          |
| Agents              | agents and sub-agents: name, description, model, reasoning level, prompt, permissions                                                            |
| Defaults            | default agent, fallback model, migration model, default image model, naming model, keep output on interrupt, tool calls on interrupt, auto title |
| Tool output limit   | characters of tool output kept in context                                                                                                        |

Every edit is one procedure call that returns the whole config, so what the screen shows next is what the host has. The two interrupt switches are the user-visible form of `abortedMessageStrategy` (keep the partial answer in context, or drop it) and `abortedToolRoundStrategy` (keep the whole batch of tool calls with a reason backfilled for the unfinished ones, or drop it).

ModelDefinitions come from three levels: the session row, the agent definition, and the fallback in `config.json`. `/model` without a flag writes the session row, `-a` the agent definition, `-g` the fallback. Changing the model or the thinking level of a session that has work in hand is refused by the host, so the client asks first whether to try now.

ModelDefinitions and image models carry a `custom` flag. An entry that is not marked `custom: true` belongs to the factory list and is replaced by it every time the host reads the config; restoring a factory entry clears the flag again. EndpointDefinitions are never managed that way.

## What it keeps on this machine

Under the data root (`AI_ZEN_DIR`, default `~/.ai-zen`) the client owns four files and its own log directory. Everything else there belongs to the host.

| Path                      | Contents                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `cli/connection.json`     | the host picked on the connect screen; written only when a human picks one                          |
| `cli/last-workspace.json` | the workspace entered last, one entry per host                                                      |
| `cli/last-session.json`   | the session opened last, one entry per workspace                                                    |
| `cli/preferences.json`    | interface language (`AIZ_PREFERENCES_FILE` overrides the path)                                      |
| `logs/cli/cli.log`        | the client's log, 2 MB per file, two files kept; warnings and errors also surface in the notice bar |
| `logs/cli/launch.log`     | output of the host process this client started, rewritten on every launch                           |
| `logs/cli/keys.log`       | key diagnostics, written only with `AIZ_DEBUG_KEYS=1` (`AIZ_KEYS_FILE` overrides the path)          |

The host's side of the same root: `ai-zen.db` (database), `config.json` (configuration), `run/host.json` (which port the host serves on), `run/token` (local credential), `run/next-version.json` (which version to launch next), `logs/host.log`.

## Development

| Gate                 | Command              | What it holds                                                                                                                                                                                                                                           |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types                | `pnpm run pretest`   | `tsc --noEmit` over sources and tests, 0 errors                                                                                                                                                                                                         |
| Unit and integration | `pnpm test`          | `vitest run`, the default suite                                                                                                                                                                                                                         |
| Formatting           | `pnpm format:check`  | `prettier --check` over `src/`, `scripts/` and the root config files                                                                                                                                                                                    |
| Build                | `pnpm build`         | the bundled `dist/` — the next two gates need it                                                                                                                                                                                                        |
| Artifact graph       | `pnpm check:imports` | four built entries are walked: `index` must not reach `@ai-zen/agents-client`, `openai`, `@modelcontextprotocol`, `dayjs`, `ink` or `react`; `commands/index`, `session` and `stdio` must not reach `@ai-zen/agents-client`, `ink`, `react` or `./tui/` |
| End to end           | `pnpm test:e2e`      | the built `dist/index.js`, a real host process and a fake LLM endpoint                                                                                                                                                                                  |

`pnpm test:all` runs all six (types, formatting, unit, build, artifact graph, end to end). The end-to-end suite needs `dist/` and a built host from the neighbouring `agents` checkout (`../agents/packages/host/dist/cli.js`); the local launch path is exercised through a fake `npx` that forwards to that entry, so nothing is downloaded. Do not run it next to another suite that starts real hosts.

### Running against a local dev host

`pnpm dev` builds the host from `../agents` and this CLI, starts that host as its child process and then starts the CLI against it — the host's log lines stay in the terminal and Ctrl+C takes both down. The data root defaults to the daily one (`~/.ai-zen`), so you are looking at real configuration and real sessions.

If a host is already serving that root the script asks before touching it — "stop it and start the dev host?" — and an empty answer, `n` or anything else means nothing happens and it exits. Answer `y` and that host is stopped first. In a non-interactive shell (stdin is not a terminal) nobody can answer, so nothing happens either; `--replace` is the way to say yes up front. `--keep-host` leaves the dev host running when the CLI exits, `--skip-build` reuses the existing `dist/`. Everything after `--` goes to the CLI, e.g. `pnpm dev -- --resume`.

## License

MIT
