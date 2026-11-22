---
title: Quick Start
description: Install @ai-zen/cli, connect to a host for the first time (fetched locally with npx, or remote), enter a project and a session, send the first message, quit.
outline: deep
---

# Quick Start

## Install and build

The repository uses pnpm, and the build output is a bundled `dist/`:

| Command | What it does |
|---|---|
| `pnpm install` | installs dependencies |
| `pnpm build` | bundles the sources and the connection layer into `dist/` with rolldown |
| `pnpm start` | `pnpm build`, then `node dist/index.js` |

`package.json` declares three bin names — `ai`, `aiz`, `zen` — and all three point at `dist/index.js`. Installing the package globally on this machine (`npm install -g .`) puts those three names on the PATH.

The host is not a runtime dependency: `@ai-zen/agents-host` lives in `devDependencies` only, as the declaration of a version range, and at runtime it is fetched with `npx` (see below); `@ai-zen/agents-client` is a private package inlined into `dist/` at build time.

## Launch parameters

| Parameter | What it does |
|---|---|
| `--server <url>` | talk to this host instead of the local one |
| `--new` | open a new session instead of resuming the last one (the interactive path only) |
| `--tui [prompt…]` | force the interactive interface; trailing words are sent as the first message; rejected when stdin or stdout is not a TTY |
| `--save` | keep a stdio call as a real session (ignored by the interactive path) |
| `--server-status` | print the status of the host at that address as JSON and exit 0 when it answers, 1 when it does not; never launches anything |
| `hook install` / `hook uninstall` | install or remove the shell fallback hook |
| `-h`, `--help`, `-v`, `--version` | usage and version; the single words `ai help` / `ai version` are the same |

`--` ends option parsing, so a prompt may start with `-`.

## The first launch

Nothing is configured yet, so the client asks. With no `<data root>/cli/connection.json` (the file it writes only after a human picks a host on screen) and no explicit address, `ai` opens the connect screen — local, remote, exit — and performs no I/O until one of them is chosen.

Choosing local hands over to the launch screen. The host is started through `npx`, so the first local launch downloads it:

```bash
npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <data root>
```

`<range>` is the semver range of `@ai-zen/agents-host` this build was made against, baked into `dist/` at build time; `<data root>` is `AI_ZEN_DIR`, `~/.ai-zen` by default.

The launch screen reports where the launch stands, one line at a time, and never a percentage (npm output is not parsed):

| Stage | What is being waited for |
|---|---|
| Resolving the version | npx resolving which version in that range to use |
| Installing | npx downloading and installing it |
| Starting the host | the child process is up; waiting for the discovery file and the handshake |
| connected | not drawn: the screen switches to the session |

A failed launch adds the child process's own last line and accepts `R` to try again; `Esc` and `Ctrl+C` kill the child and go back to the connect screen without quitting. When a host is already listening, no stage ever arrives and the launch screen draws nothing at all.

## Connecting to a remote host

Nothing starts a host on the remote machine for you, so it is only ever connected to:

| Form | Result |
|---|---|
| `ai --server <url>` | talk to this host instead of the local one |
| `AI_ZEN_SERVER_URL` | same as `--server <url>`; the flag wins when both are given |
| the remote entry on the connect screen | address plus access token; an empty token means the local host's token |

An address accepts `ws:`, `wss:`, `http:` and `https:`, and a path for a reverse-proxy mount; a bare `host:port` without a scheme is taken as `ws://`. A malformed address fails before anything connects or launches, with one sentence on stderr and exit code 2.

| Environment variable | Meaning |
|---|---|
| `AI_ZEN_DIR` | data root (default `~/.ai-zen`) |
| `AI_ZEN_SERVER_URL` | same as `--server <url>` |
| `AI_ZEN_SERVER_TOKEN` | credential for an explicit address |

There is no `--token`: argv ends up in `ps` output and in shell history. Where credentials come from, in full, is on the [Host](./host.md) page.

`ai --server-status` is the diagnostic: it prints the status of the host at that address as JSON, exiting 0 when it answers and 1 when it does not. It never launches anything.

## Entering a project, opening a session

Once connected, the client enters a project and opens a session:

| Step | Local host | Remote host |
|---|---|---|
| Project | the directory `ai` was run in, reused when `workspace.list` already has it | the one entered last time on that host, otherwise a picker |
| Session | the one opened last time in that project, unless `--new` is given | same |
| Credential | a screen asks for the API key when the endpoint behind the effective model has none | same |

## Sending the first message

The cursor sits in the input line: type, and `Enter` sends. The answer streams into the transcript, and the status bar and phase line say what is happening right now (see [Interface](./interface.md)).

Four things worth knowing straight away:

- A leading `/` lists the commands and narrows them by prefix; `/help` lists them all (see [Commands](./commands.md)).
- `@` completes file paths of this project; what goes into the draft is the path itself, so the message stays ordinary text and the model reads the file with a tool.
- `Ctrl+V` asks the clipboard for an image first and attaches it to this message; with no image on the clipboard it pastes text.
- Typing keeps working while a request is in flight: that message is handed to the host, which puts it in the inbox, and the queue band above the divider shows what is waiting.

## Quitting

| How | Result |
|---|---|
| `/exit` or `/quit` | quits the client |
| `Ctrl+C` with an empty input line | quits the client |
| `Ctrl+D` twice in a row | quits the client |

Quitting only takes down this process: the host keeps running, and the session that was working keeps working on the host side. Shutting the host down is `/shutdown` (see [Host](./host.md)).

## With arguments, or through a pipe

`ai` only enters the interactive interface when there are no positional arguments and both stdin and stdout are TTYs. With an argument, or when stdin or stdout is not a TTY, it runs in pure stdio: one invocation is one message and one answer, stdout carries the answer text and nothing else, log and progress go to stderr, and this mode writes no log file.

```bash
ai 你好，请介绍一下你自己。
cat README.md | ai "用三句话总结"
```

By default the call goes through `session.transient` with the directory it was run in: no session row is created, nothing appears in any session list. With `--save` it becomes a real session, and the session id is printed on stderr. Exit codes: 0 on success, 1 when the call fails, 2 when the invocation itself is wrong.
