---
title: Host
description: The relationship with the local and the remote host — how each is reached, the local launch and its stages, how /upgrade runs, what /shutdown takes down, and where credentials come from.
outline: deep
---

# Host

One process has one connection, and one connection talks to one host. Which host that is comes from the choice made on the connect screen, or from this invocation's `--server` (including `AI_ZEN_SERVER_URL`). Launching a host is the client's job alone, and only when the connection is local and nothing answers.

## Local and remote

|                      | Local                                                                             | Remote                                                                                           |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| When                 | the connect screen's local entry was chosen, or the remembered choice is that one | `--server` / `AI_ZEN_SERVER_URL` was given, or the remote entry was chosen on the connect screen |
| How it is found      | `<data root>/run/host.json` and `run/token`                                       | the address that was given                                                                       |
| When nothing answers | a host is fetched with `npx` (see below)                                          | connect only; nothing is ever launched                                                           |
| Credential           | `<data root>/run/token`, written when the host starts                             | `AI_ZEN_SERVER_TOKEN`; for a loopback address, `run/token` also works                            |

There is one rule for whether a host counts as local: the connection goes through the local discovery file, or the address's host is a loopback (`localhost`, `127.0.0.1`, `::1`). It decides two things — whether the directory `ai` was run in becomes the project to enter (see [Quick Start](./getting-started.md)), and which slot the last-entered project is remembered in.

Only a choice made by a human on the connect screen is written to `<data root>/cli/connection.json` (`0600`, written atomically). Flags and environment variables are this invocation's statement and are not persisted: having run `ai --server wss://…` once should not change the default to that host. Submitting on screen verifies first and writes second, so a configuration known to be wrong is never left on disk.

## The local launch and its stages

```bash
npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <data root>
```

`<range>` is the semver range this build was made against, baked into `dist/` at build time. The launch screen reports the launch as three stages that get drawn — resolving the version, installing, starting the host — one line at a time, never a percentage. The connected stage is not drawn: the screen switches straight to the session.

| Situation                   | On screen                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| It came up                  | the stages advance line by line, and connecting swaps the screen                                                     |
| It did not                  | one more line with the child process's own reason, and `R` fetches again                                             |
| `Esc` / `Ctrl+C`            | the child process is killed and the connect screen returns, so another host can be chosen; the program does not quit |
| A host is already listening | no stage ever arrives and the launch screen draws nothing at all                                                     |

The child process's output is written to `<data root>/logs/cli/launch.log`, rewritten on every launch; on a failure its last line is the reason shown on screen.

## `/upgrade`

Upgrading has three parts, and the client does only the first:

| Part                           | Whose        | What happens                                                                                  |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------------- |
| 1. Pick the version            | client       | asks the registry for the dist-tags and takes the highest semver                              |
| 2. Verify, record, ask to exit | host         | verifies that version can be had, records which one to launch next, and exits for the upgrade |
| 3. Install and launch          | the launcher | reads that record, installs that version and starts it                                        |

So `/upgrade` runs in five steps:

1. Ask: `npm view @ai-zen/agents-host dist-tags --json --prefer-online`.
2. Pick: the highest semver across all tags (trusting `latest` alone would miss the actual state where an alpha is newer than the release).
3. Compare with the version that is running (`host.version`). If the target is not newer, it stops and tells the host nothing — a locally built development version should not be "upgraded" downwards.
4. Confirm: a yes / no prompt that states the target version, which part the host performs, and that other clients connected to this machine will be dropped as well.
5. Hand over: `host.upgrade` takes one concrete version number. The host verifies that version can be had (either it is already the one on disk, or the registry really has it); if not it answers `not_available` and does not exit, and the client shows that sentence while staying connected; if it holds, the host records it and exits for the upgrade.

After the receipt arrives the client goes back to the connect screen, which says the host is being relaunched on the new version. Neither installing the package nor launching it happens in the client, and not in the host either: the host does not re-exec itself and does not touch npm.

## `/shutdown`

After one confirmation it calls `host.shutdown` and goes back to the connect screen, which says the host has been shut down.

One host serves the whole machine, so this drops every other client connected to it, including other terminals and the desktop app. The connect screen is entered without trying to connect and without launching: trying would bring back the host that was just shut down. Whether to launch a new one, or to connect somewhere else, is then a human decision.

Quitting the client does not shut the host down: `/exit`, `/quit`, `Ctrl+C` on an empty draft and `Ctrl+D` twice each take down this process only, and the session that was working keeps working on the host side.

## Where credentials come from

| Source                                | Used for                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `<data root>/run/token`               | the local path; the host writes this file when it starts                         |
| `AI_ZEN_SERVER_TOKEN`                 | the explicit-address path                                                        |
| the token typed on the connect screen | written to `<data root>/cli/connection.json`; empty means the local host's token |
| an explicit loopback address          | `run/token` is read when the settings carry no token                             |

There is no `--token` argument: argv ends up in `ps` output and in shell history. The reason shown when a connection fails is redacted first, so the token itself never reaches the screen.

On the host side: a local instance listens on loopback only, while a public instance listens on all interfaces and clients on other machines connect to it with a credential. Reaching a host across machines therefore means either such a public instance, or a tunnel or reverse proxy — and `--server` accepts a reverse-proxy sub-path as well.

To diagnose one connection without launching anything, use `ai --server-status`: it prints the status of the host at that address as JSON (version and endpoint when it answers, a reason when it does not) and exits 0 or 1. It reports the current state, not whether a discovery file exists.
