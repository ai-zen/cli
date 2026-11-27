# Getting started

`@ai-zen/cli` is the terminal client for an AI-Zen host. It does not call models itself and does not store sessions: sessions, history and model configuration live on the host. The client connects, renders and sends commands.

## Requirements

- Node.js 24 or newer
- A reachable host (`@ai-zen/agents-host`), local or remote
- An OpenAI-compatible endpoint key, configured on the host side

## Install and start

```bash
npm i -g @ai-zen/cli
ai
```

Three equivalent names are registered in `bin`: `ai`, `aiz`, `zen`. To build from source: `cd cli && npm run build`, entry point `dist/index.js`.

Startup lands on the connect screen:

| Item | What it does |
|---|---|
| Local | Start a host on this machine and connect to it. If the host is not installed it is downloaded first, and started if necessary; the interface shows download and startup progress |
| Remote | Enter a host address and an access token |

`↑↓` selects, `Enter` confirms, `Esc` exits. The address may be `wss://example.com/ai-zen` or `10.0.0.5:8790`; with no scheme it is treated as `ws://`. An empty token means the local host's token, which is generated when the host starts and written to `<data root>/run/token`.

An explicit target skips this screen:

```bash
ai --server ws://192.168.1.10:8790
```

## Two modes

One process takes exactly one of them:

| Invocation | Mode |
|---|---|
| With positional arguments, or stdin / stdout is not a TTY | Pure stdio: one call, only the final assistant text on stdout, logs and progress on stderr |
| No arguments and both stdin and stdout are TTYs, or `--tui` | Interactive interface |

```bash
ai "which build scripts does this repo use"   # one call, nothing persisted
ai --save "read src and summarise it"         # one call, written into a real session
ai --new                                     # open the interface on a new session
```

`--tui` demands the interface; when the terminal cannot provide it the command fails instead of degrading to stdio.

## Inside the interface

Type in the input row at the bottom. `Enter` sends, `Ctrl+J` inserts a newline, `/` opens the command menu, `@` opens file completion, `PgUp` looks back through history.

A session works in a workspace directory. The first time you enter a directory the interface asks you to pick a workspace — that directory is where the agent works, and both `@` completion and tool paths are relative to it.

## Exiting

| Action | Result |
|---|---|
| `Ctrl+D` twice | Exit the program; the host keeps running |
| `/exit` (alias `/quit`) | Same |
| `/shutdown` | Shut the host down and return to the connect screen |

Exiting does not affect sessions: the history is on the host, and returning to the same directory picks up the session that was last open.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including `--help`, `--version`, `hook` usage output, and `--server-status` when the host is running) |
| `1` | Failure after the run has started: a model error, `--server-status` finding nothing running, an unknown `hook` sub-action |
| `2` | The command itself was wrong: `--tui` without a TTY, a malformed `--server` address, no input in stdio mode |

Scripts rely on this split: `1` is runtime failure, `2` is misuse.

## Next

- Areas of the interface and key bindings: [Interface](interface.md)
- Every command: [Commands](commands.md)
- Configuration centre, models and thinking levels: [Configuration](configuration.md)
- Pipeline usage and the shell hook: [Pipeline and hooks](pipeline.md)
