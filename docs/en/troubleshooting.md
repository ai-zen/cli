# Troubleshooting

## Cannot reach the host

The client looks for a host in a fixed order. Check how far it gets:

1. The address given by `--server <url>`
2. The `AI_ZEN_SERVER_URL` environment variable
3. The address in `<data root>/run/host.json` plus the credential in `<data root>/run/token`
4. None of the above, or unreachable: start a host (local instance) and wait for it to listen

Three diagnostics:

```bash
ai --server-status          # print host status; does not start one, does not open the interface
cat <data root>/run/host.json   # who is serving: address, port, pid
ls -l <data root>/run/token     # whether the local credential exists
```

`--server-status` returns 0 when a host is running and 1 when not, which makes it usable in scripts. If the process recorded in `host.json` is gone (killed with `-9`, machine rebooted), the file may be stale: delete it, or just start the host and it will overwrite it.

For a remote host, check three things first: the address scheme (no scheme means `ws://`), whether the host was started with `--public` (a loopback-only instance cannot be reached from outside), and whether a credential was minted on that machine with `token create`.

## Notices in the interface

The notice bar stays out of the transcript; `Ctrl+X` clears this session's notices, `Ctrl+G` clears all. The common ones:

| Notice | Meaning |
|---|---|
| Session failed to start: `{error}` | Waking failed: the definition could not be read, no model resolved, the history shape is wrong |
| Resume failed: `{error}` | Continuing the session that was last open failed |
| Sub-agent `{name}` failed: `{error}` | The delegation returned a failure; the parent has already received an explanation |
| Handoff in progress, this message was not sent | Input is not accepted during a handoff; `Esc` abandons it and restores the state from before |
| Handoff aborted, memory restored | You pressed `Esc` |
| No workspace yet: `@` completion unavailable | No workspace has been selected, so there is no file list to complete from |
| Failed to read pending questions / notices | The connection dropped; check whether the host is still running |

## Commands refused

"Unavailable while processing": `/model`, `/think`, `/back`, `/handoff` and `/migrate` change settings the session is currently using, so they do not run while the agent is busy. Wait for the batch to finish, or interrupt with `Ctrl+C`.

The input row is held during `/title`, `/handoff` and `/migrate` because those call a model for tens of seconds. Keys typed then do nothing — they are held, not lost.

## New capabilities do not take effect

Check three things, in order:

1. Is the file in the right directory. Tools belong in `tools/`, skills are `skills/<id>/SKILL.md`, sub-agents are `sub-agents/`. What sits in `agents/` is an agent definition, not a capability
2. Is the name claimed by a nearer layer. The nearest layer wins, so a file in the project shadows one under the data root
3. The host-side refresh timing. With `autoRefreshTools` set to `off` only `/reload` helps; with `outer-loop-start` it takes effect the next time the agent is woken

`/reload` reports how many capability containers were refreshed. "No capability containers exist yet" means this session has not been used yet; the next use creates them from the new configuration.

## Keys do nothing

Terminals encode keys very differently, especially macOS `Option` and `PgUp`/`PgDn`. Turn on key diagnostics:

```bash
AIZ_DEBUG_KEYS=1 ai                       # appends to <data root>/logs/cli/keys.log
AIZ_DEBUG_KEYS=1 AIZ_KEYS_FILE=/tmp/k aiz # writes to a specific file
```

The switch is read once at process start; setting it while the process runs has no effect. How to read the log:

| Observation | Conclusion |
|---|---|
| The key was pressed, no new line in the log | The key never arrived: a system shortcut or the terminal's key mapping took it |
| There is a line, but `input` / `flags` differ from what you expect | The sequence arrives; the matching rules are the problem |
| There is a line with `raw=false` | The terminal is not in raw mode and interpreted the key itself |

`Alt` combinations are deliberately not shortcuts: they behave differently across terminals, shells, tmux and input methods. Use the `Ctrl` equivalents.

## Logs

| Location | Content |
|---|---|
| `<data root>/logs/cli/cli.log` | The client's own log, 2MB per file, two files kept (`cli.log.1`) |
| `<data root>/logs/` | The host's logs |
| `<data root>/run/host.json` | The host's address and pid, for deciding whether it is alive |

Pipeline mode creates no file: everything goes to stderr and stdout is reserved for the result.

## Upgrades

```bash
# inside the interface
/upgrade
```

It asks the release tags for the highest version, compares, confirms, then has the host record the version for its next start and exit because of the upgrade; installing and starting are up to whatever launched the host. Other clients on this machine (including the desktop app) disconnect meanwhile.

Two common failures:

- "Already the newest version": no higher resolvable version exists among the tags
- "Cannot fetch release versions": the registry is unreachable, or the tags carry no resolvable version number. Check the network and the registry configuration

When a host upgrade fails it says why and keeps running the old version. Sessions and history are in the database and unaffected, but the interrupted request is not resent.

## Three ways to end things

| Action | Session | Agent | Host |
|---|---|---|---|
| `/kill` | Kept | Terminated | Keeps running |
| `/delete` | Deleted, with messages and assets | Terminated | Keeps running |
| `/shutdown` | Kept | All terminated | Shut down; the interface returns to the connect screen |
