# Interface

One terminal window, laid out from the bottom up: the input row is pinned to the bottom and the transcript takes the remaining height. The frame height always equals the number of terminal rows — the layout computes its row budget before rendering instead of relying on wrapping at render time.

## From the bottom up

| Position | Area | Content |
|---|---|---|
| Bottom | Status bar | Identity, usage and key hints in three blocks. When the width is short a whole block moves to the next line rather than being cut in half |
| Above it | Input area | A hint row and the input row. The hint follows the state: `Enter send · Ctrl+J newline · / commands · PgUp history` |
| Above it | Inbox area | Entries the agent has not taken yet, prefixed "queued". Only the first two are shown; the rest collapse into "and N more" |
| Above it | Phase row | What the agent is doing |
| Above it | Bottom menu | Command candidates while typing `/`, file candidates while typing `@`; both use this block |
| Above it | Attached images | How many pasted images are waiting to be sent |
| Above it | Notice bar | Failures, hints, command results. Notices stay out of the transcript; `Ctrl+X` clears this session's, `Ctrl+G` clears all |
| Above it | Sub-agent columns | Appear while sub-agents run, grouped per delegation |
| Rest | Transcript | The messages themselves, scrollable |

Phase row values: working, connecting, waiting for the first token, thinking, calling tool `<name>`, waiting for `<name>`, streaming, handing off.

Status bar usage block: `this call N tok`, `total N tok`, `avg N tok/s`.

## Keys

### Input

| Key | Effect |
|---|---|
| `Enter` | Send |
| `Ctrl+J` | Newline |
| `Ctrl+V` / `⌘V` | Paste. If the clipboard holds an image it is attached to the message, otherwise the text is pasted |
| `Ctrl+S` | Stash the current draft; restore it when the draft is empty |
| `Ctrl+A` / `Ctrl+E` | Start of line / end of line |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | Delete to line start / line end / previous whitespace |
| `Ctrl+Backspace` / `Ctrl+Delete` | Delete the previous / next word |
| `Ctrl+Y` | Yank back what was just deleted |
| `Ctrl+_` or `Ctrl+Shift+-` | Undo the last input edit |
| `Ctrl+P` / `Ctrl+N` | Previous / next history entry; switches candidates while a menu is open |
| `Ctrl+C` | While generating: abort this request. Idle with a draft: clear the input. Empty input: exit |
| `Ctrl+D` | With a draft: delete the character after the cursor. Empty draft: press twice to exit |

### Looking back and the screen

| Key | Effect |
|---|---|
| Wheel | Scroll line by line |
| `PgUp` / `PgDn` | Page up / down. Some terminals keep these keys for their own scrollback; `Ctrl+B` / `Ctrl+F` do the same |
| `Ctrl+L` | Clear the screen (display only, messages untouched) |
| `Ctrl+O` | Pick an image from this session and open it with the system's default program |
| `Ctrl+X` / `Ctrl+G` | Clear this session's notices / clear all notices (the latter asks for confirmation) |
| `Esc` | Resume output that was paused; during a handoff, abandon it and restore the state from before |

With the kitty keyboard protocol, `⌘[` / `⌘]` page and `⌘;` / `⌘'` scroll by line.

There are no `Alt` shortcuts. `Alt` is claimed by terminal emulators, shells, tmux and input methods, and the same combination can mean two different things on two machines; application-level actions live on `Ctrl` only.

## While busy

While the agent runs you can still type, but only two kinds of keys do anything: abort (`Ctrl+C`) and looking back (scrolling, paging). Nothing you send is lost — it goes into the inbox and is taken once the current batch finishes.

Commands that need an idle agent (`/model`, `/think`, `/back`, `/handoff`, `/migrate`) are refused while it runs, with "unavailable while processing": they change settings the session is currently using, and swapping the model or thinking parameters mid-run makes tool call formats mismatch.

## Overlays

Three kinds of overlay sit on top of the transcript and share the same layout budget:

- **Pickers**: model, session, workspace, thinking level, command and file candidates. `↑↓` select, `Enter` confirms, `Esc` cancels
- **Forms**: an MCP server asking for parameters, or the handoff executor question. `↑↓` moves between fields, `←→` changes a choice, space toggles a checkbox, `Enter` submits, `Esc` closes. Field types are text, email, single choice, multiple choice, number, integer, boolean
- **Confirmations**: irreversible actions such as clearing all notices or upgrading the host

`/form` lays out one of every field type at once, for checking rendering and keys.

## Sub-agent columns

A delegated sub-agent occupies a column above the transcript, grouped by delegation, holding its own messages and tool calls. The parent's messages always stay in the main transcript; the sub-agent's `state` is not merged into the parent's, so "is this agent running" is always answered by the parent alone.

## Where it ends and the transcript begins

Notices, command receipts and log warnings never enter the message list: they are "what is happening right now", not conversation content. Clearing them does not affect the session; on reconnect the host's notice table fills in the failures and threshold crossings that happened meanwhile.
