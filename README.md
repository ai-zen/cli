# AI-Zen CLI

The terminal client for an AI-Zen host. One executable, two ways to use it: an interactive interface, and one-shot calls for scripts. Sessions, history and model configuration live on the host; the client connects, renders and sends commands.

## Install and connect

```bash
npm i -g @ai-zen/cli
ai
```

`ai`, `aiz` and `zen` are equivalent. Startup lands on the connect screen: choosing "local" starts a host on this machine (downloading it first if needed), choosing "remote" asks for an address and a token. The address may be `wss://example.com/ai-zen` or `10.0.0.5:8790`; with no scheme it is treated as `ws://`. An empty token means the local host's token.

```bash
ai --server ws://192.168.1.10:8790   # skip the connect screen
ai --server-status                   # print host status; does not start one, does not open the interface
```

## Two modes

One process takes exactly one of them:

| Invocation | Mode |
|---|---|
| With positional arguments, or stdin / stdout is not a TTY | Pure stdio: one call, stdout carries only the final assistant text, logs and progress go to stderr |
| No arguments and both stdin and stdout are TTYs, or `--tui` | Interactive interface |

```bash
ai "which build scripts does this repo use"   # one-shot, nothing persisted
ai --save "read src and summarise it"         # one-shot, written into a real session
ai --new                                     # open the interface on a new session
```

Exit codes come in three bands: `0` success; `1` failure after the run has started; `2` the command itself was wrong (`--tui` without a TTY, a malformed address, no input).

## Interface

From the bottom up: status bar, input row, inbox area, phase row, command and file candidate menu, notice bar, sub-agent columns, and the transcript filling the rest.

Keys used every day:

| Key | Effect |
|---|---|
| `Enter` / `Ctrl+J` | Send / newline |
| `/` · `@` | Command menu · file completion |
| `PgUp` `PgDn` · wheel | Look back through history |
| `Ctrl+C` | While generating: abort; with a draft: clear the input; empty input: exit |
| `Ctrl+D` twice | Exit the program; the host keeps running |
| `Ctrl+S` | Stash / restore the draft |
| `Ctrl+V` | Paste; an image on the clipboard is attached to the message |
| `Ctrl+X` / `Ctrl+G` | Clear this session's notices / clear all notices |
| `Esc` | Resume paused output; abandon a handoff in progress |

There are no `Alt` shortcuts: they behave differently across terminals, shells, tmux and input methods, so application-level actions live on `Ctrl` only.

While the agent runs you can still type, but only abort and looking back take effect; anything you send waits in the inbox and is taken once the batch finishes.

## Commands

Type `/` for candidates, `/help` for the full list. The common ones:

| Command | Effect |
|---|---|
| `/new` · `/load` · `/sessions` | Create · open · list and switch sessions |
| `/ws` | Workspaces: list, switch, create, delete |
| `/model` · `/think` | Switch model (session / agent definition / global) · switch thinking level |
| `/back` | Take back the last user message to edit and resend |
| `/handoff` · `/migrate` | Write a handoff document · write and swap memory (old memory archived) |
| `/free` · `/clear` | Clear the inbox · clear the screen |
| `/config` | Configuration centre: endpoints, models, agent definitions, MCP servers |
| `/reload` | Reload tools, skills and MCP servers |
| `/upgrade` | Upgrade the host to the highest version among the release tags |
| `/kill` · `/delete` · `/shutdown` · `/exit` | Terminate the agent (history kept) · delete the session · shut the host down · exit the program |

One group is refused while the agent is busy: `/model`, `/think`, `/back`, `/handoff`, `/migrate`. They change settings the session is currently using, and swapping them mid-run makes tool call formats mismatch.

## Configuration

Configuration lives in two places: `<data root>/config.json` holds endpoints, models and agent definitions (together with sessions and history, on the host side), and `<data root>/cli/preferences.json` holds only the interface language. `<data root>` comes from `AI_ZEN_DIR` and defaults to `~/.ai-zen`.

The model is resolved in three levels: session override > agent definition > global fallback. When all three are empty it fails and names the definition with no bound model, rather than quietly picking a factory model.

`/think` levels come from the endpoint's reasoning preset table; whatever levels it has are the ones on offer, and a model that always thinks has no off level because the table has none.

## Shell hook

Turns "wrong command" into "ask the model":

```bash
ai hook install      # write a command_not_found_* hook into ~/.zshrc or ~/.bashrc
ai hook uninstall
```

The hook runs `ai --tui --new "$@"`: it opens the interface, starts a new session, and sends the mistyped command as the first message. Shells other than `zsh` and `bash` are unsupported.

## Documentation

- [Getting started](docs/en/getting-started.md) — the connect screen, both modes, exit codes
- [Interface](docs/en/interface.md) — every area, all key bindings, overlays
- [Commands](docs/en/commands.md) — the full list and the two command attributes
- [Configuration](docs/en/configuration.md) — the configuration centre, three-level model resolution, thinking levels, thresholds
- [Pipeline and hooks](docs/en/pipeline.md) — the output contract of a one-shot call, the shell hook
- [Troubleshooting](docs/en/troubleshooting.md) — cannot connect, commands refused, key diagnostics, logs, upgrades

Chinese versions live under `docs/zh/`.

Build and test: `npm run build` (rolldown), `npm test` (runs `tsc -p tsconfig.test.json` then vitest), `npm run test:e2e` (needs real ports and a host).

## License

MIT
