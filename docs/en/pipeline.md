# Pipeline and hooks

Besides the interactive interface, the same executable has a path that draws nothing: one-shot calls. It is aimed at scripts, editor plugins and shell pipelines.

## When this path is taken

One rule decides it, and either condition is enough:

- positional arguments were given
- stdin or stdout is not a TTY

With no arguments and both ends being TTYs, the interactive interface opens. `--tui` is an explicit override: demanding the interface on a terminal that cannot provide it fails instead of degrading to the pipeline.

## Output contract

| Stream | Content |
|---|---|
| stdout | Only the final assistant text. No ANSI, no emoji prefixes, no spinner |
| stderr | Logs, progress, notices, and the session id printed by `--save` |

So `ai "…" > answer.txt` receives a clean result, with not a byte of diagnostics mixed in.

## Two destinations

```bash
ai "what does this error mean"                 # one-shot: belongs to no session, not persisted, absent from lists
ai --save "turn this config into yaml"         # written as a real session: create row, wake, send, then follow to the end
```

The default call is not persisted: on the local path not even a project row is created. The remote-host path needs to know which directory to work in — even a one-shot call needs a directory to assemble capabilities, and directories belong to project rows. So on a remote host with no project yet, this command first asks you to pick a directory in the interactive interface.

`--save` prints the new session id on stderr. It does not move the "last opened session" bookmark: a scripted call should not relocate where the interactive interface resumes.

## Nobody to ask

A one-shot call has no interactive interface, so this path installs no question board: questions from the host (which handoff executor to use, a form requested by an MCP server) stay pending instead of being answered on the user's behalf. For those features, use the interactive interface.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Model error, host rejection, connection failure |
| `2` | Misuse: no input, malformed `--server` address |

## The shell hook

Turns "wrong command" into "ask the model". Installing:

```bash
ai hook install      # write a command_not_found_* hook into the rc file
ai hook uninstall    # remove it
ai hook              # show usage only
```

The target depends on `$SHELL`: if it contains `zsh` the hook is `command_not_found_handler` in `~/.zshrc`; if it contains `bash` it is `command_not_found_handle` in `~/.bashrc`. Other shells are unsupported and the command says so.

The hook runs `ai --tui --new "$@"`, not the pipeline:

- `--tui`: whoever mistyped a command is sitting at a terminal and wants a conversation they can follow up on; the pipeline would print one paragraph and exit with no history
- `--new`: every mistyped command opens a new session. Otherwise the content would be appended to whatever long session this directory last used, scrambling both context and session name
- `"$@"` preserves word splitting, so arguments containing spaces survive

The hook block is delimited by a fixed pair of markers inside the rc file, and both install and uninstall rely on them. Those two marker lines are not translated — translate them and the old block can never be found again, leaving the user with a pile of duplicate hooks.

If the rc file cannot be read (permissions, not a regular file) the command fails instead of treating the file as empty and writing back: that would wipe the user's rc.

## Relation to the interactive interface

Both paths share the same connection logic, the same configuration and the same host. They differ only at the exits:

| | Pipeline | Interface |
|---|---|---|
| Session | Not created by default; only with `--save` | Always inside a session |
| Output | stdout carries only the answer | Full-frame redraws |
| Logs | stderr | `<data root>/logs/cli/cli.log` |
| Questions | Not shown; stay pending | Answered in an overlay |
| Exit | Process ends | Program exits, host keeps running |
