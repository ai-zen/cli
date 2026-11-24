---
title: Interface
description: The elements of the interactive interface — bottom-anchored layout, the five status-bar blocks, the phase line, sub-agent tabs, the notice bar's three tones and two clearing entries, the multi-line input line and its images.
outline: deep
---

# Interface

## An empty session

An empty session shows the brand block at the top of the transcript — logo, tagline, and the versions of the client, the SDK and core. It is ordinary transcript content: it scrolls away with the transcript and comes back when scrolling up.

## Layout

The layout is bottom-anchored. From the bottom up:

| Position        | What it is                                              |
| --------------- | ------------------------------------------------------- |
| Status bar      | five blocks of facts plus the key hint                  |
| Input line      | the draft and the cursor block (drawn; the hardware cursor is only positioned for the IME, never painted) |
| Divider         | the boundary between the bottom area and the transcript |
| Queue band      | the messages still sitting in the inbox, not yet taken (each with its priority) |
| Phase line      | what is happening right now, one line                   |
| Command menu    | shared by `/` commands and `@` path completion          |
| Attachment line | how many images are attached to this message            |
| Notice bar      | the only place notices appear                           |
| Sub-agent tabs  | only while sub-agents exist                             |

Everything above the divider appears only while it has something to say, and the transcript takes whatever height is left. Each band is accounted for by its own line count: the phase line and the attachment line are always one line, the queue band at most three, the notice bar at most eight plus one line for its clear hints.

Text in the transcript is always colored as **markdown source** — what you say and what the AI says are treated the same: the markers of headings, bold, inline code, lists and quotes stay verbatim and only get colored; fenced code blocks are syntax-highlighted in the annotated language. Paste a snippet or a table into the input line and its structure is still readable once it is sent.

Scroll back through history with the mouse wheel or `PgUp` / `PgDn`; some terminals keep those keys for their own scrollback, and `Ctrl+B` / `Ctrl+F` are the fallback for one page up or down.

## The status bar

Five blocks, each read from the session at frame time:

| Block    | Content                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- |
| Identity | model id, reasoning effort                                                                            |
| Gates    | busy or idle, plus stopped, output off and intake off whenever any of them is not in its normal state |
| Usage    | tokens of the last answer and tokens of all answers, summed by the client from each message's `usage` |
| Rate     | a live estimate while generating, the average of the last answer afterwards                           |
| Keys     | the key hint line of the interface                                                                    |

Blocks are the unit of wrapping: a block that does not fit moves to the next line whole, and an empty block takes no width. The two blocks whose numbers are not yet known take no space at all rather than writing 0.

## The phase line

The phase line sits above the divider and appears while the agent has work in hand. It says the phase the client can read out of the facts it has — it answers "what is this run doing right now"; **queued messages are not announced here**, the queue area echoes them one by one (`<priority> waiting <text>`). The priority is core's `InboxEntry.priority` as-is (`high` / `low`): `high` is taken at the inner loop's tool boundary, `low` waits for the current batch to finish — showing it makes "why is this still queued" visible at a glance.

| Phase                        | When                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| handing off                  | this session is writing the document or waiting for it to finish; it covers every phase below |
| connecting                   | work is in hand but this batch's message has not landed                                       |
| awaiting the first token     | the request is out and nothing has come back                                                  |
| thinking                     | reasoning has arrived, the answer has not                                                     |
| calling a tool               | the arguments are still being assembled, or were just finished                                |
| waiting for a tool to return | tools are running; when several run in parallel only the ones still running are named         |
| streaming                    | the answer text is flowing                                                                    |

The two tool phases name the tools. The line is always exactly one line, and a label that does not fit is truncated. While a command that holds the input line runs, this line names the command.

## Sub-agent tabs

While sub-agents exist, one tab line appears below the transcript. The `◈` in front of each tab carries the state:

| Colour   | State                   |
| -------- | ----------------------- |
| blinking | running                 |
| green    | ended                   |
| red      | failed                  |
| faint    | stopped                 |
| dim      | still there, not moving |

With an empty input line, `←` / `→` switch which transcript is shown. A tab only changes whose messages are being read; it does not change the session.

## The notice bar

The notice bar is the only place notices appear on screen. They never enter the messages, so they never reach the model.

Three tones: info, warn, error (the host's four levels fold into these three, with success counting as the ordinary one). Notices queue in arrival order; the bar keeps the four most recent and never more than eight lines, dropping the oldest whole notice when it runs out of room rather than splitting one in half.

Two entries clear it:

| Key           | What it clears                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| `Ctrl+X` | this session's notices: the local queue plus `notice.deleteAll` with this session id |
| `Ctrl+G` | asks once, then clears everything — global notices and other sessions' included      |

## The input line

The input line is multi-line and takes at most eight rows; longer drafts scroll a window that follows the cursor instead of squeezing the transcript out. `Enter` sends; `Ctrl+J` (or `Ctrl+Enter`) inserts a newline; `↑` `↓` move the cursor inside a multi-line draft first, and only step into history from the first and last line.

Typing keeps working while a request is in flight: that message is handed to the host, which puts it in the inbox, and the queue band shows what is still waiting (each line carrying its own priority and "waiting" prefix); the phase line only says what this run is doing right now.

The cursor block on screen is drawn by the app (the character under the cursor is shown in reverse video). The terminal's own hardware cursor keeps being moved to the editing position but is **never painted**: it exists only so the input method's candidate window follows along. The reason is that a streaming answer repaints a frame every 60ms, and Ink has to hide and re-show the hardware cursor on every frame — a dozen or so toggles per second, which reads as a cursor that will not stop blinking. With an empty input (placeholder only) there is no cursor on screen; once there is a draft, the reverse-video block is the cursor.

`@` completes file paths:

- Candidates are the relative paths the host lists for this project (`workspace.files`), scanned on the machine running the session.
- What goes into the draft is the path itself, so the message stays ordinary text and the model reads the file with a tool.
- Completion replaces the whole `@token`, so it also works with the cursor in the middle of one; while the menu is open, `Enter` completes instead of sending.

Images:

- Images in the transcript are always placeholders, since a terminal cannot draw them in line. The placeholder says what is known: which image of that message it is, how large it is, what it is called.
- `Ctrl+O` lists the images of this session that still carry an asset id; picking one fetches the bytes (`asset.get`), writes a temporary file and hands it to the default program (`open`, `xdg-open`, or `cmd /c start`). Fetching, writing and opening each report their own kind of failure.
- `Ctrl+V` (or `Cmd+V` where the terminal reports it) asks the system clipboard for an image first: `osascript` on macOS, `wl-paste` or `xclip` on Linux, PowerShell on Windows. With an image it is attached to the next message; without one the text is pasted at the cursor.

**Selecting and pasting** in the terminal (`Cmd+V` / middle click / `Shift+Insert`) goes another way: the app turns on bracketed paste (`CSI ?2004h`), the terminal wraps the whole block in `CSI 200~ … CSI 201~`, and it is inserted at the cursor as **one piece of text** — multiple lines never turn into "send the first line", `\r\n` folds into `\n`, other control characters are dropped. The `Ctrl+V` clipboard path goes through the same normalisation.
- Clipboard text over 256 KB is refused rather than truncated. Attached images go up with the message through `asset.upload`; how much fits is the host's rule, and its refusal is shown verbatim.
