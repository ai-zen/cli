## [1.0.1] - 2026-11-09

> Interrupting a handoff now puts you back where you were. Before this release `Ctrl+C` only
> stopped the work — and on the auto-migration path it did not even stop it: the aborted round
> was read as "the model never wrote the document", so it retried, degraded to a standalone
> summary, and migrated anyway (two extra full-context rounds for a keypress that was supposed
> to cancel). On the manual path the handoff turn stayed behind in the conversation: a multi-KB
> skill instruction, its tool results and the acknowledgement, visible in the transcript,
> reachable with `↑`, and resent as history on the next turn.
>
> Ships on `@ai-zen/agents-sdk@1.1.0` (exact), which is where the cancellation switch and the
> rollback live.

### 🐛 Fixed

- **`Ctrl+C` during a handoff returns to the pre-handoff state** — the handoff turn is truncated
  from the conversation, a document created by this run is deleted, nothing is migrated, and no
  retry / degradation happens. The "how should the document be written" step can be cancelled
  too: `Ctrl+C` now works in that picker (it accepted `Esc` only, while both main input handlers
  are inactive during a picker — so the key did nothing at all).
- **Cancellation now works on the auto-migration path** (context overflow). The cancel handle
  lives in `HandoffService` (`handoffService.abort()`), so all three paths (`/handoff`,
  `/migrate`, auto-migration) share one switch; `ChatSession.abort()` is just
  `handoffService.abort()` + `agent.abort()`.
- **A cancelled migration no longer leaves the "already migrated" illusion** — history is not
  pruned and the old conversation is not archived.
- **Commit point**: once the document passes validation the run is committed, so `Ctrl+C` during
  the final save / prune / persist step no longer reacts — you never end up with "cancelled,
  but the old conversation is archived and history is pruned".

### 🧪 Tests

- 811 unit cases in 59 files — 5 new: interrupting a handoff rolls `session.messages` back to
  the pre-handoff state, `abort()` is forwarded to the service, and the picker's
  `Ctrl+C` / `Esc` / `Enter` keys. Plus 9 e2e cases (3 skipped — they need a real API key).
  `tsc` and the build are clean.

## [1.0.0] - 2026-11-03

> First stable release. Everything from the `1.0.0-alpha.x` line — `alpha.1` through
> `alpha.32` — is folded into this version: nothing was dropped, no alpha behaviour was
> reverted. The version number is a promise, not a code change: the documented surface (the
> `ai` command, both run modes, the chat screen and its keybindings, the `/` command set, the
> configuration center, the config file layout) is now frozen, so `^1.0.0` is safe to depend on.
>
> If you are coming from `0.9.0`, read `[1.0.0-alpha.1]` below first — that entry was written
> as a complete summary of the `0.9.0 → 1.0.0` delta (the `aiz` / `zen` → `ai` rename, dual-mode
> run, the Ink full-screen rewrite). Everything after it is listed release by release.

### 📌 What this release ships on

- `@ai-zen/agents-sdk@1.0.0` (exact) + `@ai-zen/agents-core@^4.5.4`. The SDK's 1.0.0 is the
  release where its own public surface freezes, so this pair is the first combination whose
  type surface is not expected to move underneath you.

### ✨ Where the alpha line landed

- **Bilingual UI** (zh / en), detected from the system locale on first run and changeable with
  `/lang`; the whole TUI, `/help`, and the command output are covered. `README` ships a key
  table for both.
- **Main / sub-agent tabs** — while sub-agents run, a bar appears below the transcript and
  `←` / `→` switches whose conversation you are reading.
- **Handoff and migration** — an out-of-context round can hand off to a fresh agent (with a
  picker for "self / separate summary / skip"), and a conversation can be migrated onto a
  different model in the configuration center.
- **Configuration center, end to end** — endpoints, models, image models, defaults, tool
  output limits, MCP servers (global / project), and Agent definitions with four dimensions of
  permission. Factory-managed entries are hosted by the SDK; "restore factory defaults" puts
  them back without hand-editing `custom`.
- **Composer upgrades** — multi-line editing with a hardware-cursor-synced IME, input history
  that carries attached images, bottom-anchored `/` and `@` menus, `@` file-path completion,
  `Ctrl+V` image paste (256KB text limit, over which it errors instead of truncating), and
  in-app paging with the mouse wheel.
- **`/update`** reports progress step by step and restarts for real once confirmed.
- **Syntax highlighting** for JSON tool arguments and fenced code blocks, and a three-block
  status bar (model · agent · effort | this-round / cumulative tokens · rate | key hints).

### 💥 The last behaviour change before the freeze

- **The startup splash is gone** (`alpha.32`). Startup used to block for about 1.8s on a reveal
  + gradient sweep before entering the chat; it now goes straight into the chat screen, and an
  empty conversation shows the brand block (logo, tagline, CLI / SDK / core versions) in the
  middle of the chat area, scrolling away with the conversation. The animated splash described
  in `[1.0.0-alpha.1]` no longer exists.

### 🧪 Tests

- 806 unit cases in 58 files, plus e2e 9 passed / 3 skipped (the skipped ones need a real API
  key). `tsc --noEmit` (production and test configs) and `npm run build` are clean.
- The two `↑`-history cases in `chat.test.tsx` that were flaky on `HEAD` are fixed in
  `alpha.32`'s follow-up: they waited a fixed 20ms for a `busy` flip that needs a promise
  callback plus a frame, so they now wait until the input actually echoes a probe keystroke.

## [1.0.0-alpha.32] - 2026-11-03

> This release does one thing: it removes the startup splash animation. Previously every `ai`
> startup waited about 1.8s for the reveal + sweep before entering the chat, and that pure
> blocking sat right in front of "read config → resume session → create session". Now it goes
> straight into the chat, and the branding moved into the chat area itself, landing in the
> vertical middle when the conversation is empty.

### 💥 Behavior changes

- **No splash animation on startup** — removed `splash.tsx` and the `await mount(<Splash />)`
  in `runTui()`. The old implementation revealed line by line over 330ms + a 700ms diagonal
  gradient sweep + a 1100ms hold and auto fade-out, about 1.8s in total; after removal the
  remaining blank window measured about 66ms (`readConfig` three times + `AgentRepository.list`,
  all local file reads), so initialization was not moved into the chat screen.
- **An empty conversation shows the brand block in the vertical middle of the chat area** — logo
  (6 lines of ASCII on wide terminals, degrading to `◢ AI · ZEN ◣` on narrow ones) + tagline +
  the three version numbers `CLI / sdk / core`, each line centered on its own. It is now
  ordinary transcript content: it scrolls up naturally with messages and can be scrolled back
  into view; it yields as soon as the first message is typed (including the optimistic echo).
  The gradient is fixed at phase 0 and runs no timers.
- **The version numbers moved** — previously they appeared once on the splash, now they hang in
  the brand block; the bottom status bar (model · Agent · reasoning effort | per-turn /
  cumulative usage · rate | keybindings) is unchanged, character for character.
- **`computeChatLayout` gains `anchor: "bottom" | "center"`** (defaults to `bottom`, existing
  behavior unchanged): an empty conversation passes `center`, splitting the remainder below one
  screenful evenly between top and bottom. Pinning to the top leaves a big empty band in the
  middle, pinning to the bottom presses right onto the input box, and neither looks good.
- Bottom-pinning semantics are unchanged: once there are messages, the whole remainder is still
  added at the head, so the bottom edge of the latest line sits right against the divider.

### 🧪 Tests

- 806 cases all green, `tsc` (production / test configs) and `npm run build` clean.
- Added: 6 cases in `welcome.test.ts` (wide / narrow logo selection, tagline, three version
  spots, per-character coloring, per-line centering), 2 chat screen cases (appears on an empty
  conversation / disappears after the first message), 1 case for `anchor: center`; removed the
  2 Splash cases.
- Known leftover: the two `↑` history cases in `chat.test.tsx` were already flaky in the
  previous release (`flush(20)` colliding with the 60ms frame batching), unrelated to this
  release, not yet addressed.

## [1.0.0-alpha.31] - 2026-11-03

> This release attaches the CLI to the re-reviewed SDK: `@ai-zen/agents-sdk` alpha.26 +
> `@ai-zen/agents-core` 4.5.4. The CLI's own changes are small (guardrails stand down by
> themselves during handoff, handoff document filenames drop the session id suffix), but all
> 24 SDK fixes reach users with this release — several of them are of the "one ordinary command
> is enough to wedge the process" or "the tool reported success but did nothing at all" kind.
>
> The stance is unchanged: the tool layer does not carry the safety boundary (the model is not
> an attacker); it only fixes things normal usage runs into.

### 💥 Behavior changes (from SDK alpha.26)

- **The `exec` exit code is no longer `null`** — a command that ends normally reports `0`, and
  non-zero codes are returned truthfully; the model no longer misreads a successful command as
  "did not end normally".
- **A timeout reclaims the whole process group** — previously only the shell was killed, so the
  grandchildren of `cmd | cat`, `sh -c '… &'` were left as orphans (`sleep 45 &` could even
  serve as a resident process, bypassing `spawn`). Now `detached` + `kill(-pid)` reclaims the
  entire group.
- **`exec` output truncation is labeled truthfully** — `maxBuffer` is explicitly set to 16MB, a
  real truncation reports `truncated`, and `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is no longer
  taken as an exit code while falsely claiming "the full content was written to disk".
- **`download_file` gains a required `timeout` (milliseconds)** and now writes to disk as a
  stream (a 200MB file no longer eats 650MB of heap); on interruption it no longer deletes a
  file that already existed at the same path.
- **`spawn` no longer reports false success** — the returned field `success` becomes `started`,
  and it states that "exit status is not tracked"; a missing command / syntax error / `exit 3`
  no longer displays as success.
- **`glob` / `find_text` report an error for nonexistent directories**, no longer silently
  returning `[]` and letting you believe the file does not exist.
- **`generate_image` supports endpoints that only return `b64_json`** — after writing to disk
  it gives a local path, no more `success: true` with not a single image.
- **`edit` / `batch_edit` fix two file-destroying pitfalls** — an empty `oldText` puts the
  process into a synchronous infinite loop (not even `Ctrl+C` helps); `$&` and `$$` in the
  replacement text are taken as replacement patterns and silently corrupt the file.
- **`permissions` actually take effect** — a denied skill can no longer be loaded by naming it;
  a server not allowed in `mcps` cannot be called even if another Agent has connected to it.
- **MCP connections are more stable** — quitting mid-connect no longer "resurrects" the
  connection (stdio child processes are no longer left orphaned); a runtime disconnect marks the
  status back to `disconnected` (`load_mcp` no longer returns a stale manifest); connecting has
  a 60s timeout.

### 🛠️ CLI itself

- **Stand-down of the guardrails during handoff/migration is decided by the guardrails themselves**
  (`isSuspended: () => handoffService.busy`). Previously `lastUsage` was zeroed right before
  handoff — that was two copies of the same fact, and changing one left the other stale. Now
  `lastUsage` is a read-only value derived from `messages`; replacing `messages` follows
  automatically.
- **Handoff document filenames drop the session id suffix**: `<YYYYMMDD-HHmmss>.md`. Session
  names are usually edited by hand, so carrying them only makes files harder to recognize;
  concurrent handoffs within the same second should be avoided anyway, and no random suffix is
  added for it.

### 🧪 Tests

- 799 cases all green (including the build and e2e gates), `tsc` clean on both configs
  (production / test).
- Added: guardrail wiring cases (stand down during handoff, restore the hard line afterwards);
  usage construction switched to an "assistant message with usage" (`lastUsage` is read-only
  now).

## [1.0.0-alpha.30] - 2026-11-02

> This release closes out 22 review issues in one pass. Three of them change the feel directly:
> the completion menu is anchored to the bottom, `↑`/`↓` move the cursor first in multi-line
> input, and the input area is capped at 8 lines; the detail screen also no longer exposes
> `custom`, replaced by "restore factory defaults".
>
> Note: the `1.0.0-alpha.28` / `.29` entries had so far only existed locally (the registry's
> `alpha` tag stopped at alpha.27); this release carries them out as well.

### 💥 Behavior changes

- **The completion menu is anchored to the bottom** — `/` commands and `@` paths share one
  `BottomMenu`: `items[0]` sits right above the input box, the rest grows upward and is dropped
  from the top when it does not fit; the row cap is granted by the layout according to the
  remaining space (no longer fixed at 8 rows), and rendering and the IME cursor read the same
  `layout.hintRows`. Descriptions no longer squeeze the command name into a stub.
- **`↑` / `↓` move the cursor first** — in a multi-line draft they page through history only at
  the first / last line (previously one press jumped to history).
- **The input area is capped at 8 lines**, and the window follows the cursor (previously it was
  pinned to the end, so the cursor disappeared outside the box when it went back to the first
  line).
- **`↑` history paging carries images** — the history data source is unified on `messages`, so
  going back to a message with images restores the images as well; history images of type
  `file_id` can only restore text (there is no local copy).
- **The `/load` list shows session filenames only** — no longer reading each session file to
  parse a summary.
- **`/save <name>`** — save as a specified filename (the old filename disappears, the
  last-session pointer follows); if the name is taken and is not the current session, a second
  confirmation is asked first.
- **The detail screen no longer has a `custom` toggle, replaced by "restore factory defaults"**
  — the factory model / image model are **replaced wholesale** with the factory definition
  (`custom` disappears with it = managed by the SDK again); the default Agent only swaps the
  prompt back to the factory one, keeping the name / description / model / permissions all
  intact; entries with no matching id in the factory list (self-built) do not show the action.
- **256KB cap on pasted text** — exceeding it reports an error and does **not truncate** (half
  a piece of code / half a JSON is worse than not pasting).
- **Writing sentences no longer pops up the `@` menu at random** — the token boundary adds
  `。 、 ！ ？ （ ） 《 》 【 】 〔 〕 「 」 『 』 … — ～`.
- **No endpoint, no new model / image model** — previously an empty shell with
  `endpointId: ""` could be created.
- **A broken `mcp.json` no longer passes itself off as empty config** — the MCP screen states
  "cannot be parsed" and stays editable, and saving produces exactly a new, correctly formatted
  file (that is a repair, not a data-losing overwrite).

### 🐛 Fixes

- The KV editor crashed on Enter after deleting the last item (the cursor is clamped to the new
  last item).
- `SelectList` crashed on Enter after the list got shorter (both rendering and confirmation go
  through `safeIndex`).
- Automatic save failures were reported in an info tone.
- `/back` did not save after reverting (the reverted messages stayed in the archive).
- Deleting the default Agent did not clear `config.defaultAgent`, and the next startup died on
  "Agent has no model bound".
- An EPIPE stack trace was printed when stdout was closed early (now handled as a normal exit).
- The `/load` `/back` selector row budget under-counted by 2 rows, so the bottom-pinned layout
  ate the last two entries.
- `truncate` truncates by grapheme cluster and no longer splits emoji into lone surrogates.
- The e2e assertion did not match reality (`ai hook` writes to stdout, exit code 0) and was
  excluded by `vitest.config.ts`, so it could never go red — after correcting the assertion it
  went from 5 red to all green.

### 🔒 Security

- **`@ai-zen/agents-sdk` bumped to `1.0.0-alpha.25`**: `EntityRepository.path()` now validates
  that an entity id cannot escape the repository directory (`resolve` + `root + sep`; a bare
  `startsWith` cannot stop `<root>-evil`). `/save ../x` now reports a clear error and can no
  longer write outside the session directory. This release also carries the SDK's endpoint
  `capabilities` migration backfill (old `deepseek` endpoints get `filesApi`, and images move
  to the Files API).

### ✅ Tests

- Unit tests **57 files / 798 cases passing**, e2e **9 passed / 3 skipped** (3 need a real API
  key), `tsc --noEmit` clean.
- The release gate `prepublishOnly` changed to `npm run test:all` (unit tests + build + e2e);
  `npm test` keeps its semantics and still runs only types + unit tests.
- Test time 43.6s → ~8s: removed `isolate`, single fork, dependency injection replaced all
  module-level `vi.mock`.

## [1.0.0-alpha.29] - 2026-10-31

> `Ctrl+V` goes from "pops up an unsupported notice" to **actually pasting**: if the clipboard
> holds an image it is attached to the message, otherwise it falls back to pasting text.

### ✨ New features

- **Pasting images** — `Ctrl+V` (or `⌘V` under the kitty protocol) first asks the system
  clipboard for an image; if there is one it is attached to the message being composed, and
  `📎 N images attached · Ctrl+V to add more · Esc to clear` appears above the input box; with
  no image it counts as an ordinary paste, inserting the clipboard text at the cursor. Probed
  per platform:

  | Platform | Image | Text |
  |---|---|---|
  | macOS | `osascript -e "get the clipboard as «class PNGf»"` (stdout is `«data PNGf<HEX>»`) | `pbpaste` |
  | Linux | `wl-paste --type image/png` (Wayland) → `xclip -t image/png -o` (X11) | `wl-paste --no-newline` → `xclip -o` |
  | Windows | PowerShell `Get-Clipboard -Format Image` → PNG → base64 | `Get-Clipboard -Raw` |

- **Nothing ever touches the disk** — images are handed to the SDK's `fileToContentSection()`
  as raw base64 (its `FileSource` already has a `{ base64, mime }` variant): whether to upload
  to the Files API or inline base64, and how to degrade when the model does not support vision,
  is entirely decided by the SDK per current endpoint — the CLI neither reimplements it nor
  hardcodes endpoints.
- **At most 4 images per message** (`MAX_PASTED_IMAGES`): one screenshot is often 1–3MB once
  inlined, and a few more in a single request easily reach tens of MB. Over the cap, an
  oversized image (>20MB), an empty clipboard and a missing clipboard tool each have their own
  message.

### 🎨 Interaction

- **Images first, text as the fallback**, and the order cannot be reversed: pasting the text
  first leaves no room (there is already a chunk in the draft by then).
- **`Esc` with attachments clears the attachments first and keeps the draft** — a mistaken paste
  always has a way back, and `Esc` does not have to become a random key that "clears everything".
- The attachment hint row is always one line, and its row count is counted both in
  `computeChatLayout` (height) and in `computeInputCursorPosition` (IME cursor y) — one row off
  and the whole input box shifts; this has happened before.
- The optimistic echo is built from "text segments + image placeholder blocks", matching the
  structure actually sent (otherwise the image entries would flash and vanish before the real
  message lands); inline images in the transcript show only `[image]`, so a data URL of hundreds
  of thousands of characters is not painted on screen (only remote URLs carry an address).

### 🐛 Fixes

- **Messages with images lost the cwd injection** — `CwdTrackerPlugin` used to look only for
  user messages whose `content` was a string, and skipped them outright once content became a
  block array, so the model saw the working directory of the previous turn for that round. Now
  it appends to the **last text segment**; when the array has no text segment, one is added.
- "`PgUp`/`PgDn` (or `Alt+V`/`Ctrl+V`) page through" in README / getting-started was wrong:
  `Ctrl+V` never doubled as paging (`common-keys.ts` only accepts `Alt+V`), now corrected.

### ✅ Tests

- 33 cases added: `clipboard.test.ts` 15 (three-platform command selection / osascript hex
  parsing / missing tool / empty output / over the limit / CRLF normalization),
  `user-content.test.ts` 6 (text segment first / partial failure / total failure falls back to
  plain text / warning passthrough), `cwd-tracker-plugin.test.ts` 4 (string / content blocks /
  images only / no duplicate injection), `pasted-images.test.tsx` 3 (always one line / layout
  takes one extra row / cursor y stays in sync), `chat.test.tsx` +5 (paste text without images /
  attachment row with images / Esc clears attachments and keeps the draft / send with images /
  empty clipboard notice).
- Full run **57 files / 741 cases passing**, `tsc --noEmit` 0 errors.
- Real-artifact verification (local Linux, no clipboard tool): `readClipboardImage() → { kind: "none" }`,
  `readClipboardText() → null`, 11ms without throwing; running the real SDK conversion without
  stubs, `vision: true` yields an `image_url` inline block and a missing `vision` yields a text
  hint + warning.

## [1.0.0-alpha.28] - 2026-10-31

> Typing `@` in the input box brings up **file path completion** — what gets inserted is the
> relative path text, and the model reads the file itself with the `read` tool.

### ✨ New features

- **`@` file path completion** — typing `@` pops up in-project candidates, `↑`/`↓` to select,
  `Tab` or `Enter` to insert into the draft, `Esc` to close the menu only (without touching the
  draft). Three layers, consistent with the existing style of the repo:
  - `tui/mention.ts` (pure logic): `extractMention()` decides whether the cursor is inside an
    `@token`, `rankPaths()` fuzzy subsequence ranking, `menuWindow()` the viewport,
    `mentionMenuRows()` the row count;
  - `tui/file-index.ts` (IO): `git ls-files -co --exclude-standard` preferred (honors
    `.gitignore`, includes untracked files), falling back to `fs.glob` outside a git directory
    and excluding `node_modules` / `.git` / `dist`; 15s cache, 20000 entries capped, 5s timeout;
  - `screens/chat.tsx`: the wiring from keybinding → candidates → `replaceRange()` insertion.
- **The criterion rests on character facts**: scan back from the cursor to whitespace / line
  start, and an `@` encountered on the way counts as a mention only if it is preceded by line
  start, whitespace or a separator. So `a@b.com` does not pop up the menu, while `@src/tui`,
  `(@src/x)` and `"@src/x"` all do; when the cursor sits in the middle of a token
  (`@src|/foo.ts`), the query ends at the cursor and `end` eats the whole token forward —
  completion replaces the whole span and leaves no partial leftovers.
- **Ranking**: greedy subsequence + gap penalty + consecutive-hit bonus; **whole-span prefix >
  filename prefix**, and on a tie the shallower / shorter one wins. Measured on this repo: `@`
  takes 50 out of 182 indexed entries (1.1ms), `@chat` hits 19 (0.2ms), `@file-index` matches 2
  exactly (0.1ms).
- **Directories can be drilled into level by level**: selecting a directory appends a trailing
  slash (`@src/tui/`), and after insertion the menu refilters to that directory's contents, so
  you can walk `@src/` → `@src/tui/` → the target file.

### 🎨 Interaction

- `Tab` / `Enter` = **complete without sending** (keep writing after picking, to avoid sending
  half a message by mistake); `Esc` only closes the menu and does not clear the draft (the old
  `Esc` semantic was to clear the draft, so pressing Esc halfway through an `@` took the body
  with it).
- Candidates can number in the dozens; the menu **takes at most 8 rows** and scrolls with the
  highlight; while the index is not ready, one row of "Scanning project files…" is shown first.
- The row count has a **single source of truth** `mentionMenuRows()`: `computeChatLayout`'s
  `hintCount`, the IME cursor y coordinate and `MentionMenu`'s actual rendering draw from the
  same source, with a case asserting `mentionMenuRows(n) === menuWindow(n)`.
- The placeholder changed to "Type a message, / for commands, @ for files…" so this entry point
  can be seen.

### 🔧 Refactors

- `useInputEditing` gains `replaceRange(start, end, text)`: it replaces the span **and records
  an undo snapshot**, so a wrong completion can be taken back with `Ctrl+_` (using
  `setInputText` would bypass the undo stack).

### ✅ Tests

- 39 cases added: `mention.test.ts` 22 (extraction / insertion / ranking / viewport / row count
  consistency), `file-index.test.ts` 9 (git listing normalization / cache TTL / cwd switch /
  fallback / error convergence / real disk), `components-mention.test.tsx` 5 (8-row cap /
  scrolling follows / directory trailing slash / scanning placeholder / no match takes no row),
  `chat.test.tsx` +6 (menu pops up / Tab completes without sending / Enter completes / ↓ changes
  the highlight / Esc only closes the menu / no match still sends), `use-input-editing.test.tsx`
  +3 (range replacement / undoable / out-of-range clamping).
- Full run **53 files / 708 cases passing**, `tsc --noEmit` 0 errors.

## [1.0.0-alpha.27] - 2026-10-29

> SDK warnings and errors now go to the notice bar — a **generic channel**, not wired up
> separately for each feature.

### ✨ New features

- **SDK logs → notice bar** (`sdk-log.ts` goes from "write to disk only" to a tee) —
  `installSdkLogger()` used to **take over SDK logs wholesale into a file** (otherwise
  `console.log` would tear up Ink's frames), at the cost that a single word of "what the SDK
  said" was invisible in the UI and could only be found afterwards in `~/.ai-zen/logs/sdk.log`.
  Now `warn` / `error` are also forwarded to the notice bar besides being written to disk:
  - **Late binding**: `installSdkLogger()` runs before Ink renders, while the notice bar lives
    in `Chat`'s React state. `Chat` registers a sink on mount; the latest 5 messages are
    buffered before registration and pushed on registration — startup problems are exactly what
    most needs to be seen.
  - **Dedup**: the same sentence repeating (for example failing once per turn) reaches the bar
    only once.
  - **Capped at 20 rows**: after the cap, one extra line `More SDK warnings suppressed — see <log path>`
    is appended and nothing more is pushed. SDK log volume is counted per "request / refresh",
    and without a cap the bar and the React state would be flooded together.
  - `info` goes to the file only — the SDK logs info densely (mcp manifest, tool discovery), and
    putting it on the bar is spam.
  - From now on, any new SDK feature that logs `warn` / `error` is automatically visible in the
    UI, **no callback needs to be passed for it**. This channel only uses the existing
    `setLogger` and is decoupled from the SDK version.
- **The notice bar gains a `warn` tone** — `NoticeTone` expands from `info | error` to
  `info | warn | error`, and `NoticeBar` colors it with `theme.warn`. A warning should neither be
  downgraded to an ordinary notice (it would be missed) nor pass itself off as an error (it
  would mislead).

### 🔧 Dependencies

- `@ai-zen/agents-sdk` `1.0.0-alpha.23` → `1.0.0-alpha.24`: loading of the `tools/` directory
  became fail-safe — files without `export` are no longer evaluated, `process.exit` / `abort`
  are suppressed during evaluation while `console` output is redirected to stderr, and importing
  a single file now has a timeout.

  This fixes a real incident: a dev script that called `process.exit(2)` when run without
  arguments was placed in `.ai-zen/tools/`, the SDK `import()`-ed it midway through creating a
  session, and so **every startup killed the CLI during initialization**, leaving only the last
  frame on screen and looking like "stuck on startup"; several other scripts in the same
  directory silently rewrote PNG assets in the project on every startup. Such files are now
  skipped (or suppressed) and reported in the notice bar through the channel above.

### ✅ Tests

- 6 cases added in `src/sdk-log-notice.test.ts`: `warn`/`error` reach the bar, `info` does not,
  buffered startup messages are pushed later, dedup, cap wrap-up, silent mode does not touch the
  bar.
- Full run **50 files / 663 cases passing** (49 files / 657 cases at alpha.26), `tsc --noEmit`
  0 errors.

## [1.0.0-alpha.26] - 2026-10-29

> `/update` changes from "one spinner + one result line" to **saying what it is doing at every
> step**, and fills in the previously nominal "takes effect after restart" — it now really
> restarts the process.

### ✨ New features

- **One key to restart after install** — a confirmation box pops up after install: "vX is
  installed, it takes effect after a restart… restart now?", with "Yes" highlighted by default
  (the same `Confirm` overlay used by `/migrate`, Enter goes ahead); after confirming, the
  current conversation is saved first and then the process restarts, and the new process
  **resumes the previous session** on a normal start. Declining blocks nothing and still gives
  the "takes effect after restarting ai" hint.
- **Progress information is no longer missing** — it reports in order "Querying the latest
  version…" → "Found vX (current vY), installing…" → "✅ Installed …"; before handing the
  terminal over to npm, it prints a header on the real TTY: which package is being installed,
  the current version, the install location from `npm root -g`, and the command actually
  executed.

### 🐛 Fixes

- **"Takes effect after restart" was an empty promise** — the old implementation only `push`-ed
  one "takes effect after restarting ai" line, and `/update` itself never restarted. And the
  `exit({ restart: true })` path (used by `/model`, `/lang`) merely remounted `<Chat/>` in the
  same process, so the in-memory module graph stayed old, which for an upgrade like "the code on
  disk changed" amounts to not installing at all. It now **really re-execs itself**: `spawn` a
  new process running the new dist, and the parent waits in a suspended state and exits after
  the child exits.
- **The spinner during `/update` was "frozen"** — `readDistTags()` used `spawnSync`, blocking
  the event loop synchronously, so Ink's animation timer stalled for 1–3 seconds. Changed to an
  async `spawn` with a 20 second timeout (no more hanging indefinitely when offline).
- **The spinner label was "Processing…"** — that label comes from `phaseLabel(session.phase)` in
  the generation phase, but `/update` has no generation turn at all, so `phase` was `null` and
  the fallback became the generic "Processing…", having nothing to do with what was happening.
  Added `busySpinnerLabel()`: with a generation phase it is still driven by the SDK phase, and
  during blocking commands it shows `/update running…` instead.

### 🔧 Improvements

- **`--prefer-online` on both the query and the install** — npm caches the packument, so right
  after a release `npm view` may still return old dist-tags and mistake "there is a new version"
  for "already the latest" (this happened on release day); the install side likewise. Also added
  `--no-fund` to cut noise.

### ⚠️ Two terminal gotchas (written in code comments)

- **The restart must exit inside the suspended state**: `beginSuspend()` in `suspendTerminal`
  turns raw mode off, and `endSuspend()` turns it back on; if `process.exit` is called after
  `suspendTerminal` returns, the terminal stays in raw mode and every key is garbage after
  returning to the shell.
- **`disableMouseTracking()` must be called before the restart**: mouse reporting is toggled by
  `mount()` per Ink instance, and the instance has not exited during suspension — without
  turning it off, if the child process dies abnormally, the terminal keeps writing wheel events
  as escape sequences.

### 📖 Docs

- `README.md` / `README.zh.md` / `docs/{zh,en}/getting-started.md` — the `/update` description is
  corrected: the original said "installs the alpha channel globally", while it actually picks
  the highest semver among **all** dist-tags (so alpha is installed when it is newer than
  `latest`), and "shows progress step by step, one-key restart after install" was added.

### ✅ Tests

- Full run **49 files / 657 cases passing** (649 cases at alpha.25), `tsc --noEmit` 0 errors.
- `/update` cases went from 6 to 11: added "restart after confirmation + save before restart",
  "declining the restart neither saves nor restarts", "a new session with no user messages is
  not saved", "three progress notices reported in order", "the terminal header contains
  version/location/command", "the query carries `--prefer-online`".
- 3 cases added for `busySpinnerLabel`, including a regression guard: the label **must not** fall
  back to "Processing…" while a command is running.

## [1.0.0-alpha.25] - 2026-10-29

> Upgraded to SDK `1.0.0-alpha.23` (model-facing and user-facing copy is now fully in English),
> and added the missing `LICENSE` file.

### 🔧 Dependencies

- `@ai-zen/agents-sdk` `1.0.0-alpha.22` → `1.0.0-alpha.23`.

### 💬 Behavior changes (from SDK)

- **All built-in SDK copy is now English** — tool schema descriptions, the factory system prompt,
  injected wording, tool return values, error messages, factory Skills and catalog data are all
  fixed English; the SDK no longer contains any Chinese copy, and **no i18n is introduced**
  (reason: `tokenThresholds` / `maxToolOutput` are absolute quantities, and changing the language
  of tool schemas means a different set of token counts, which would remove the single variable
  from performance benchmarks).
- **Reply language becomes "follow the user"** — "please reply in Chinese" in the factory system
  prompt is replaced by `Always reply in the same language the user writes in.`, adapting per
  message.
- **No breaking impact on the CLI** — the CLI ships its own `i18n` dictionary (`src/i18n`), and
  all UI copy and notices are rendered by the CLI itself without parsing SDK copy strings; SDK
  usage is limited to type imports and structural APIs such as `AgentRepository` /
  `ConfigManager` / `setLogger` / `HandoffService`. The 49 files / 649 test cases are identical
  item by item before and after the upgrade.

### 📄 License

- **Added `LICENSE`** — `package.json` declared `"license": "MIT"` before, but the repository
  had no license text, and naturally the npm package did not either. The full MIT text is added
  now (identical to `LICENSE` at the root of the `agents` repository,
  `Copyright (c) 2024 LZQCN`). The `files` field is unchanged: npm includes `LICENSE` forcibly,
  and `npm pack` confirmed the tarball contains the file.

### 📖 Docs

- `docs/{zh,en}/getting-started.md` — the SDK version in the runtime dependency list is corrected
  from `1.0.0-alpha.18` to `1.0.0-alpha.23`, and `@ai-zen/agents-core` from `^4.5.2` to `^4.5.3`
  (aligned with the actual `package.json`).
- `docs/{zh,en}/index.md` — the license section now points to the `LICENSE` file at the
  repository root and states that the full text ships with the package.
- `README.md` / `README.zh.md` — the version number in the startup screen example is synced to
  `1.0.0-alpha.25`.

### ✅ Tests

- Full run **49 files / 649 cases passing**, `tsc --noEmit` 0 errors, consistent with the alpha.24
  baseline (this release only bumps dependencies, no source changes).
## [1.0.0-alpha.24] - 2026-10-28

> Three things: **invisible context** is now visible (messages that never enter the context are struck through),
> upgrades have `/update`, and the abort strategy went from a hardcoded constant to a configurable option.

### ✨ New features

- **Messages that never enter the context are struck through** — the predicate shares its source with core's
  `formatHistory()` (`status == undefined || Completed` and not `omit`), while the strategy was already settled into the
  field when `Agent.run()` wraps up (`keep`→`Completed`, `drop`→`Aborted`; tool rounds `fill`→`Completed`,
  `drop`→`omit`), so the render layer does not re-derive the strategy.
  - The streaming one (`Pending` / `Writing`) is not struck through: it is absent from `formatHistory` as well, but that
    means "not yet" rather than "dropped".
  - `hidden` still does not render at all; `omit` no longer makes messages vanish into thin air (previously `hidden || omit`
    both `return []`, so after a user aborted a round of tool calls those messages evaporated silently).
- **`/update`** — installs the newest published version from the registry: reads
  `npm view @ai-zen/cli dist-tags --json` and takes the one with **the highest semver across all tags**. Honoring only
  `latest` would downgrade users running alpha builds (the actual published state is
  `latest 0.9.0 < alpha 1.0.0-alpha.23`); if the target is not newer than the current process, nothing is installed
  (a local dev build is not "upgraded" into a downgrade). Installation goes through `suspendTerminal` +
  `stdio: inherit`, so npm progress and errors land directly on the real terminal; afterwards the version is read from
  the `package.json` under `npm root -g` (`npm view` against the registry lags by a few minutes), and a restart is
  suggested (old code is still in memory; no automatic restart, to avoid losing the session).
- **Configurable abort strategy** — SDK upgraded to `1.0.0-alpha.22`: `AppConfig` gains
  `abortedMessageStrategy` (`keep` / `drop`, factory `keep`) and `abortedToolRoundStrategy`
  (`fill` / `drop`, factory `fill`); `createAgent()` reads `scope.config` directly when no arguments are passed.
  Two new items under the configuration center's "Defaults" are enough to switch them; they are read only **when an
  Agent is created**, so closing the configuration center makes the host rebuild the session automatically
  (`WizardCloseResult.sessionOptionsChanged`), with no need to type `/reload` by hand.

### ♻️ Refactors

- **CLI no longer hardcodes `abortedMessageStrategy: "keep"`** — hardcoding overrides the user's choice. Configuration
  is now the source of truth: whatever `config.json` says is used, and `agent-creator` only creates the Agent.
- **Config migration backfills the strategy fields** (SDK side) — missing or invalid values are always written back as
  the factory default and persisted once, so no client needs its own `?? "keep"` fallback.
- **New `src/version-compare.ts`** — semver comparison (core segments / prerelease identifiers / build ignored),
  used by `/update` to pick the newest among multiple dist-tags; no `semver` dependency is pulled in for it.

### ✅ Tests

- Full run: **49 files / 649 cases passed** (626 cases at alpha.23).
- New: `version-compare.test.ts` 10 cases, `chat-commands-update.test.ts` 6 cases (tag selection, already newest so
  no install, install failure, npm missing, dist-tags unavailable), `messageToLines` strikethrough 3 cases,
  strategy setters / two wizard screens / host reload 4 cases.
- End-to-end check (temporary `AI_ZEN_DIR`): factory default `config: keep fill → agent: keep fill`; after switching
  to drop and rebuilding, `config: drop drop → agent: drop drop`.

### 🔧 Dependencies

- `@ai-zen/agents-sdk` `1.0.0-alpha.21` → `1.0.0-alpha.22`.

## [1.0.0-alpha.23] - 2026-10-28

> Sub-agents went from "one line in the notice bar saying it is running" to a **switchable tab row**: main and
> sub-agent messages are shown in separate columns, with execution status inlined on the labels.

### ✨ New features

- **Main/sub-agent tab row** — when a sub-agent appears in the conversation, a tab row appears below the message
  list, `MAIN AGENT  ◈SUB AGENT1  ◈SUB AGENT2`, with the current item highlighted by background color; after
  switching with `←` / `→`, the message list is replaced by that Agent's own conversation.
  - **Data source**: core's `onSubAgentStart` hook hands over the sub-agent instance; `AgentTool` /
    `AgentToolLazy` **do not destroy** the instance after delegation ends, so `messages` is always readable — keeping
    a reference is enough to review the sub-agent's whole process (reasoning, tool calls, multi-round inference),
    not just the final result.
  - **Lifecycle aligned with the inner loop**: a sub-agent is a product of a tool call inside the inner loop; when
    this round's inner loop ends entirely (`send` wraps up; exceptions / aborts go through `finally` and clear as
    well) the whole tab row is emptied and the display index resets to zero.
  - **Inline execution status**: `◈` + color (running blue, done green, failed red); the running blue dot blinks
    between bright and dim every 500ms. It **no longer** pushes "sub-task running / done" into the notice bar —
    that would add a row out of nowhere and make the whole frame height jump.
  - **`←` / `→` routed by state**: switches tabs when the input line is empty (cursor at 0, where left/right have
    nothing to do) or while generating (the input line has been replaced by the spinner); when the input line has
    content the keys still move the cursor, sacrificing no editing capability.
  - Sending a message switches back to the main Agent view automatically (otherwise the user cannot see their own
    question).

### 🐛 Fixes

- **Sub-agents left over after `/new` and `/reload`** — those two operations only swap `agent` and do not rebuild
  the `ChatSession` instance, so the sub-agent view does not disappear on its own; it is now cleared explicitly on
  `reset` / `reload` / `migrate`.
- **View id and display index mixed up** — the index resets every round; if the id reset too, next round's `sub-1`
  would share a name with the previous round's, and since selection is matched by id, a leftover selected id would
  "latch onto" a newly appeared sub-agent. They are now two counters: the id increments forever, and only the
  display index resets.

### ♻️ Refactors

- **Fixed the outdated comment in `sub-agent-guard-plugin`** — the original comment claimed `call_skill_sub_agent`
  "does not dispatch onSubAgentStart, not covered yet", but after skill sub-agents were unified onto `AgentToolLazy`
  it in fact is covered (core has only two delegation paths, both dispatch the hook). That wrong comment directly
  misled the assessment of the covered surface early in this implementation.

### ✅ Tests

- Full run: **47 files / 626 cases passed** (604 cases when alpha.22 was released).
- New guards: tab entry order and 1-space padding, the `◈` symbol and the three-color mapping, still a single line
  when over-wide, sequential numbering, switching to `done` at the end, switching to `failed` on error without being
  overwritten by `end`, progress kept out of the notice bar, content present during execution but cleared after
  wrapping up, cleared on `reset` / `reload` too, `←`/`→` switching the data source and not switching when the input
  is non-empty, layout height and IME offset.
- Break checks: removing `agentTabLines` from `computeChatLayout` → layout case red
  (`expected 4 to be 5`); making a command description longer → width guard red (`expected 62 to be <= 36`).

## [1.0.0-alpha.22] - 2026-10-28

> This release is the result of a **full code review plus root-cause fixes**: first a complete review of all
> non-test code in `src/` (30 items P0~P3, 3 of them verified by experiment to be non-issues and left unchanged),
> then each item landed on the principle "trace the root cause if you can, no defensive fallbacks / no swallowed exceptions / no redundant validation", and finally Ctrl+C abort for handoff was added.

### 🐛 Fixes

- **Line wrapping measures width by grapheme cluster, fixing emoji blowing up the whole frame layout (P0)** — `toCells` / `wrapSpans` / `clipSpans` / `toChars` / `segmentsWidth` used to walk the text by **code point**: a VS16 sequence (`✌️` = `U+270C U+FE0F`) was counted as 1 column although it occupies 2 → the line got too wide → Ink wrapped a second time while rendering → the actual frame was one row taller than `computeChatLayout` had budgeted → **the input line was pushed off screen**; ZWJ families (`👨‍👩‍👧`) were counted as 6 columns although they occupy 2 → a wrap every two clusters. All of it now goes through `graphemes()` + `clusterWidth()`, the same ruler Ink lays out with.
- **Threshold writes no longer replace the whole object** — `updateModel` is a shallow merge, and callers used to construct `{ handoff, guard }` directly, which wiped every other field in `tokenThresholds` (compression thresholds the SDK added later, and so on). New `mergeTokenThresholds()`; all threshold writes go through it.
- **Blank screen after `/migrate`** — migration uses the `prune` strategy to cut `messages` down to 1~2, but `transcriptFrom` stayed at its old value, so `messages.slice(transcriptFrom)` was always empty: the migration succeeded and the context had content, yet the screen showed nothing. The transcript display origin is now reset after a successful migration (the same approach as `/new`).
- **Notice bar kept only the last entry** — the subscriber side is a single-value state, so a batch of summaries / staged progress overwrote each other one by one. It is now a queue keeping the most recent 4 (`MAX_NOTICE_HISTORY`), and a batch of summaries is merged into **one multi-line** entry, so everything is shown while occupying a single slot; layout decisions (wrapping / yielding when there are several / truncation within an entry) moved into `notice.ts` as pure logic, plus a new independently renderable `NoticeBar`.
- **`ai hook --help` exits with a non-zero code** — "wanted to see usage" and "wrote the wrong sub-action" used to be conflated. Now `ai hook` / `ai hook --help` print normally and exit 0; `ai hook boom` reports an error and exits 1. The bare-word forms `ai help` / `ai version` are equivalent to the corresponding options, but **only when the word is the sole argument** (`ai help me refactor this` is still a question).
- **`ai hook install` failed to clean up duplicate blocks** — an rc file may hold several hook blocks (an old version and a new one each wrote once), and the old implementation looked only at the first, so "the first block happens to be the newest → judged installed → the old blocks behind it stay forever". It now takes all blocks and counts as installed only when there is exactly one block and its content matches.
- **Conversation persistence was not an atomic write** — the SDK's `EntityRepository.write()` overwrites directly, so a process killed mid-write (Ctrl+C / OOM / power loss) leaves half a JSON, `read()` fails to parse and returns null, and **the whole history is lost** (conversation files can reach several MB, so the write window is not small). It now writes `<id>.json.tmp` → `rename`, so any read at any moment sees either the old file or a complete new one.
- **Ctrl+C could not abort a session handoff** — two root causes: the standalone model request in `summary` mode had no cancellation point at all; `self` mode could be interrupted by `agent.abort()`, but abort does not throw, so after the abort it was misjudged as "the model did not write a document", and the code **retried one round, then downgraded to summary and ran another round** — the user thought they had cancelled while two more full-input rounds burned. Handoff now accepts an `AbortSignal`: cancellation throws `HandoffAbortedError`, **no downgrade and no retry**, the half-written document is cleaned up, and `migrate` leaves the conversation history untouched; in the TUI, Ctrl+C first goes through the handoff's cancellation path and reports "cancelled" instead of an error. (Depends on the same-named change in `@ai-zen/agents-sdk`.)
- **Notice bar text shifted right by 2 columns** — the indent was applied twice: one layer from `NoticeBar`'s `paddingX={1}`, another layer from `notice.ts` hard-concatenating two spaces, so the text sat 2 columns further right than the separator and the `❯` input row on the same screen; it was most glaring when a migration pushed 4 notices at once. Horizontal positioning is now owned solely by the container and the logic layer only wraps. The `· ` / `✖ ` prefixes were dropped along the way — tone is already expressed by `tone` coloring (error goes red), so the symbols were pure placeholders; every line of a multi-line notice now starts at column 0. The per-item summary of configuration updates is now indented by one CJK character width (2 columns) instead of carrying a bullet.

### ✨ New features

- **`/load` list shows conversation summaries** — a conversation id is a timestamp (`chat_2026_10_28_00_56_34`), so listing them directly as labels made it impossible to tell which was which. The first line of the first user message is now taken as the label. Implementation-wise it only `stat`s first, and after sorting parses content **only for the few entries about to be displayed**, so `/load` is not slowed down even when conversations pile up into the hundreds.

### ♻️ Refactors

- **`chat.tsx` split into five hooks: 1085 → 830 lines** — only conversation lifecycle and render assembly are left; the rest became 5 unit-testable hooks: `use-chat-viewport` (viewport and scroll arithmetic, every action going through `clampViewTop()`), `use-overlays` (resolve lifecycle of confirm boxes / selectors, with closing and settling done in the same functional update), `use-wizard-host` (wizard host, dependency injection), `use-input-editing` (text / cursor / history / kill ring / undo / stash), `common-keys` (keybindings shared by the two `useInput` handlers + double Ctrl+D to quit).
- **Slash commands are table-driven** — the 557-line `switch` became `HANDLERS: Record<CommandName, CommandHandler>` + 18 handlers: "added a command but forgot the handler" changed from silently falling through to "unknown command" at runtime into a **compile error**; command-name parsing lives only in the registry (`parseCommandInput` / `parseCommandArgs` share one tokenizer), and `blocksInput` became command metadata instead of a host whitelist.
- **Wizard field factory de-noised** — the `commit` / `toggle` signatures were widened to `string | null | Promise<string | null>`, removing 23 `Promise.resolve(...)` noise sites; `nameField()` / `endpointIdField()` / `customPatch()` and friends absorbed 8 duplicated chunks; `DetailFieldKind`'s `"map"` was renamed to `"open"` (the semantics were always "Enter opens a sub-screen").
- **Conversation persistence converged into a single entry point** — "read the old record for `createdAt` → write → update the pointer" used to be written out in 5 places and had already drifted (`saveConversation()` missing `cwd`, stdio's `--save` not updating the pointer, and a deprecated `modelId` still being written). Everything converges on `persistConversation()`, and the only remaining difference is one explicit switch: whether to update the pointer.
- **Initialization and singletons cache promises** — when `getScope()` / `ensureConfigDir()` cached instances, there was an `await` between `if (x) return x` and the assignment, so concurrent calls fell through together (two Scopes built → MCP connected twice, tool discovery done twice). Caching the promise lets concurrent calls share one initialization; failures are not cached.
- **Dead code and unreachable fallbacks removed** — the dead fields `ConversationContext.running|input|shouldSend`, the never-enabled i18n plural machinery (`pluralRules` + `key_one/_other`), the unreachable truncation fallback at the end of `noticeLines()` (84 combinations enumerated to prove it never runs), the `pick(direct, …)` parameter nobody ever passed, the zero-reference `scrollTo` export of `useChatViewport`, and `parseHandoffMode`, which every command ran to no effect; `cwd` / `previewLimit` went from "optional + internal fallback" to required, with fallbacks kept only at the real boundary of the SDK's optional fields.
- **Command descriptions trimmed** — the slash menu and `/help` are one line per command, and an over-long description fills the whole line. Rewritten on the principle "say what it does, not how it is implemented": internal concepts dropped (`scope`, writing config, rebuilding the session) along with redundant qualifiers, and parentheses keep only the consequences the user must expect (replaces the conversation / rebuilds / does not switch conversation). Longest Chinese 59 → **34**, English 73 → **49** (mean 19.3 / 33.8), and `/mcp` fell from the longest to mid-pack.
- **The four permission dimensions go on screen through dictionary entries** — `tools` / `skills` / `mcps` / `subagents` are keys in the configuration, and showing them directly would expose internal identifiers to the user, so they map to `perm.*` entries.

### ⚡ Performance

- **Fast path for `graphemes()`** — wrapping is a per-frame hot path, but for the vast majority of text (ASCII / CJK / code) every cluster is a single code point and `Intl.Segmenter` is unnecessary. One regex first decides "could multiple code points form one cluster" (astral / CRLF / ZWNJ·ZWJ / Hangul composing jamo / `\p{M}` combining marks), and only on a hit does it go to the segmenter. One frame of 60 lines of Chinese: **655 µs → 52 µs** (604 µs saved, 1% of the frame budget). The predicate prefers false positives over false negatives, and 6 new guard cases cover the various forms.

### 🔧 Dependencies

- Upgraded `@ai-zen/agents-sdk` to `1.0.0-alpha.21` (handoff cancellation).

### ✅ Tests

- Full run: **46 files / 604 cases passed** (36 files / 487 cases before the review; a net gain of 10 files / 117 guard cases).
- Notable additions: `use-chat-viewport` 7 cases, `use-overlays` 6 cases, `use-wizard-host` 9 cases, `use-input-editing` 13 cases, `common-keys` 10 cases, `chat.test.tsx` 7 integration guard cases, `lines.test.ts` 12 cases (grapheme-cluster wrapping), `notice-bar` 4 cases, `conversation-persist` 10 cases (including a spy on `fs.rename` pinning the atomic write).
- Break checks (each confirmed to turn the guard red): wrapping back to code points, `clampCursor` switched to `Array.from`, paging step switched to `budget`, the PgUp branch removed, `\p{M}` dropped, atomic write back to direct write, the history cursor reset removed from `clearDraft`.

## [1.0.0-alpha.21] - 2026-10-27

### ✨ New features

- **Status bar split into three information blocks, plus a generation rate** — the status bar used to be one priority-ordered stream of text, and when it wrapped on a narrow screen it cut units like `this round 1284 tok` in half while also making it impossible to tell which pieces of information belonged together.
  - It is now three blocks: ① model · Agent · reasoning effort　② this round / cumulative token usage · generation rate　③ keybinding hints (at the bottom).
  - **Wrapping is per block**: new `packSegments()` (`src/tui/status-segments.ts`) — if it fits, blocks sit side by side (joined by ` · `); if not, the **whole block** moves to the next line; only a single block longer than a whole line degrades to wrapping inside the block (prefer breaking at spaces, hard break for CJK, drop an orphan `·` at line start, trim trailing spaces). Line boundaries only ever fall on block boundaries.
  - **Row count is deterministic**: `statusBarRows()` measures the actual row count in pure logic and hands it to `computeChatLayout({ statusBarLines })`; measurement and rendering are the same function, so a taller status bar on a narrow screen never pushes the input line off screen.
  - Numbers and units are bound with NBSP (`this round␣1284␣tok`), so they are not split across two lines inside a block either.
  - **Two measures for the generation rate, never mixed into one number**: while generating, `⚡ 47 tok/s` is an estimate (derived from output deltas, CJK 0.7 / character, other non-whitespace 0.25 / character, whitespace 0.1, over a sliding window of the last 2 seconds); after a round ends it switches to `⚡ avg 38 tok/s`, where the denominator is the first-char → last-char span and the numerator is the real `usage.completion_tokens` returned by the API (accumulated round by round for multi-round tool calls). A span < 400ms is not shown, so a burst on the first packet cannot inflate the rate into the hundreds.
- **New `/agent`: switch the main Agent quickly inside a conversation** — the selector lists every main Agent in `~/.ai-zen/agents/*.json`, marking the current one and the model it is bound to (switching Agent means switching the model with it).
  - Supports `/agent <id>` for a direct switch; no argument opens the selector.
  - A full-chain precheck runs before switching: Agent exists → bound to a model → the model is still in the configuration → the endpoint exists → the endpoint has a key. Ones that cannot run are marked "unavailable" with a reason, instead of switching and then being stuck on the startup error screen.
  - Writes `config.defaultAgent` (the same field as `/config` → "Default Agent") and then rebuilds the session; **messages and context are kept**. The Agent definition itself is not modified (prompt / permissions / `modelParams` all untouched).
- **New `/mcp`: jump straight to the MCP management screen** — no separate editor is built; the existing MCP screen in the configuration center is opened directly (add / delete / edit / enable-disable / global⇄project scope switching all live on that screen). After the wizard closes it reuses the existing `mcpChanged` path to call `session.reload()` automatically, so new servers take effect on the spot.
  - Default landing: if the project scope has servers, go to `project`, otherwise `global` (entering the project scope when it is empty shows only an empty list). `/mcp global`, `/mcp project` (abbreviable to `g` / `p`) can specify it.
- **New `/reload`: refresh the runtime environment** — `session.reload()` contains `resetScope()` (disconnect the old MCP connections, drop the config snapshot) → rebuild the Agent → rediscover tools / Skills / MCP. After hand-editing `mcp.json` / `skills/` / `tools/`, one command makes it take effect, **messages and context are kept**, and the CLI need not be restarted.
- **Keep the reasoning and content already output when aborting** — after stopping with `Ctrl+C` / `Esc`, the half sentence the model **already emitted no longer vanishes into thin air**. Previously abort only marked the in-flight message `Aborted`, while the history filter let only `completed` through, so the reasoning and answer still visible on screen disappeared entirely from the next request, and the model started over the next round as if it had amnesia.
  - The root cause is upstream: core's `abort()` only sets a flag and `formatHistory()` only filters by status, and neither cares about "what has already been output". core `4.5.3` adds `abortedMessageStrategy` (`drop` / `keep`, default `drop`) and exports `reconcileAbortedMessages()`, which settles pure content messages **after** tool rounds are normalized.
  - The CLI sets it explicitly to `keep`: an aborted assistant message that really produced output is restored to `completed` and enters the context. **Empty output is not kept** (to avoid empty messages polluting the context) and **messages with tool calls are not its business** (they still follow "whole round in, whole round out", otherwise the history would be illegal with "a call but no result").
  - The SDK dependency is upgraded to `1.0.0-alpha.20` accordingly (`createAgent` gains a third parameter `CreateAgentOptions`, which also surfaces the previously unexposed `abortedToolRoundStrategy` / `abortedToolRoundReason`), and core goes to `4.5.3`.
- **UI internationalization (Chinese / English)** — the first launch detects the system language (`LC_ALL` → `LC_MESSAGES` → `LANG` → Node's `Intl` locale, **English as the fallback**), the result is written to `~/.ai-zen/cli/preferences.json`, and the preference wins from then on (changing the system language later does not let the UI language drift quietly). `/lang` switches at any time; `/lang zh` / `/lang en` set it directly.
  - Dictionaries are compiled into the bundle (`src/i18n/{zh,en}.ts` plus the configuration center section `{zh,en}-wizard.ts`): flattened keys, `{n}` interpolation; switching language swaps one reference, with no disk re-read and no restart. A missing entry returns the key itself (no silent cross-language fallback, which would make Chinese pop up in the English UI). `t()` supports `_one` / `_other` plural variants (chosen by `Intl.PluralRules`), but `i18n/index.test.ts` requires the **Chinese and English key sets to be identical**, so existing entries use the `(s)` form uniformly and no variants are enabled.
  - The language preference lives in the CLI's own `preferences.json` and is **not stuffed into the shared `config.json`** — that is the `AppConfig` contract shared by the CLI and Desktop, and anything stuffed in there would be dropped by the desktop app as an unknown field.
  - Coverage is **the whole TUI**: the main conversation screen (three status bar blocks, input placeholder and hints, notices, reasoning effort labels, generating hints), the command layer (`/help`, the slash menu, selectors and feedback of every command), every screen of the configuration center (endpoints / models / image models / MCP / Agent definitions / permissions / defaults / tool output limits / creation wizard / KV and multi-line text editors), the handoff mode selector and confirm boxes, the startup screen and the startup error screen, plus the summaries returned by business modules (the switch results of `/model` `/agent` `/think`, handoff progress and downgrade hints).
  - `COMMAND_REGISTRY` stores **i18n keys rather than display text** — it is a pure data module loaded before language initialization, so storing text would freeze "the language at load time"; rendering calls `getCommandHints()` to fetch it on the spot. The startup screen's `TAGLINE` constant became a `tagline()` function for the same reason.
  - **Pipeline mode does not do i18n**: all output and errors of `ai <prompt>` / piped input are **English only** (it is for scripts and should not follow a person's UI language), so the stdio path **does not initialize the language** and its behavior is fully decoupled from `preferences.json`.
  - **`ai --help` and `ai hook install / uninstall` go through i18n**: both print outside the TUI, so each branch calls `initLocale()` before fetching entries; the module-level `HELP_TEXT` constant became `helpText()` assembled on demand (a constant would freeze the language at load time).
  - **Conversation id renamed**: the old localized `dialogue_<date and time with Chinese units>` form → `chat_2026_10_28_00_56_34` (English prefix + all-underscore timestamp, identical in Chinese and English, filename-safe). It is also the file name, and letting it follow the language would mix old and new history files, so the timestamp is produced by the new `formatFileStamp()`; **display** times, by contrast, now follow the language via `formatShortTime()`. Pipeline mode's `--save` no longer assembles a name itself and calls `generateConversationId()` instead, removing the duplicated assembly in both places.
  - **The "working directory" note injected into history switched to English with an explicit marker**: `[system-injected: working directory changed — not written by the user]` — flipping through an archive or a handoff document makes it obvious at a glance which content the user did not type; `stripCwdNote()` recognizes both generations of the format, so old archives do not render this note on screen.
  - The `task` parameter description written into the tool schema when creating a sub-agent also comes from the dictionary (Chinese `Complete task description` / English `Full task description`) — the only exception where "protocol content is translated too"; the cost is that the same definition created under different UI languages yields different schema text.
  - The only injected content left untranslated is the working-directory note above; the three code-block marker strings `hook.ts` writes into the rc file (such as `# === ai hook (开始) ===`) also stay as they are — translated, the old block could never be found again.
  - Time formats switch dayjs locale and pattern along with the language: Chinese renders a localized month-day form plus time with a "yesterday" prefix, English `Jul 1, 14:30` / `Yesterday 14:30`.
  - Two hidden mines were cleared along the way: the status bar used to decide whether reasoning effort is dimmed by **display text** (`effort === "off"`), which never held in the English UI, and now uses `effortDimmed()` based on the level's semantics; the input area placeholder used to be hardcoded inside `inputLines()` (while the render layer went through `t()`), so in the English UI the measured input row height came out one line short and dragged the hardware cursor's y offset along — both now share one source.

### 🔧 Behavior changes

- **The message row's "thinking…" split into six states: connecting / queued / thinking / calling a tool / waiting for a tool result / streaming** — that row used to have only the single word "thinking…", but a model actually goes through several stages within one round, and summing them up with one word is **plain wrong** most of the time: it is not thinking while waiting for the first token, and while a tool runs the model is not running at all.
  - The predicate uses only **the shape of events and deltas** (`src/tui/phase.ts`, pure logic and unit-testable): `connecting` = from request dispatch to response headers; `queued` = after `open` and before the first content chunk; `thinking` = `reasoning_content` received; `tool-calling` = `tool_calls` / `function_call` received (with a tool name, reusing the name from the first delta when later chunks carry only argument fragments); `tool-waiting` = `parsed` and this round has tool calls; `streaming` = `content` received. When several appear in one chunk the priority is tool_calls > content > reasoning.
  - The "connecting" stage is provided by the new `PhasePlugin` (`chat-session.ts`): the SDK's `open` event is emitted **after the `await` of `chat.completions.create()` returns** and only means the response headers arrived; the DNS / TCP / TLS / server acceptance before that is entirely silent.
  - **Sub-agent output does not advance the main stage**: during delegation the main Agent is waiting for a tool result, and counting the sub-agent's deltas into the main stage would make the UI jump to "streaming", covering exactly the sentence the user most needs to know. Sub-agent chunks still count toward the rate and still trigger a redraw.
  - The spinner row got `truncate`: while busy the input area height is fixed at 1 row by `computeChatLayout` (`inputHeight = 1`), and a wrapped label would push the input line off screen.
- **"⏳ Generating" removed from the status bar** — what this round is doing is already explained stage by stage by the message row spinner, and another generic "generating" in the status bar only duplicates it and eats width (on a narrow screen it also squeezes the keybinding hints onto the next line).

- **Shell hook switched to entering the TUI (the earlier pipeline mode was an implementation error)** — the hook is installed on `command_not_found_handle` / `command_not_found_handler`, and the triggering situation is "a person sitting at an interactive terminal typed a command wrong", yet the function body was `ai "$@"`, while the rule in `decideMode()` is "positional arguments → stdio", so the hook session inevitably fell into pipeline mode: it spat some text to stdout and exited, **with no history and no follow-up questions**. The classification table at the top of `mode.ts` merged "script invocation" and "manually triggered by a person" into one predicate, so this was not something a patch could fix — the classification itself was wrong.
  - The function body is now `ai --tui --new "$@"`: the new `--tui` flag explicitly overrides the "has arguments → stdio" decision, enters the TUI and **sends the original command automatically as the first message** (not pre-filled into the input line — the semantics of the hook are "this command cannot run, handle it for me", and making the user press Enter again is pointless).
  - The first message is **forced to be sent as an ordinary user message** and skips slash-command parsing: the mistyped command could be something like `/opt/bin/foo` starting with `/`, which would otherwise be treated as a CLI command and reported as "unknown command". `runSubmit()` gained an `asMessage` option for this.
  - In non-TTY environments (scripts / pipes) `--tui` reports an error and exits (exit code 2, English message) and does **not** degrade into pipeline mode — otherwise a whole screen of UI content would be written into the pipe.
  - The first message is sent only on the first mount: remounts caused by switching models / `/lang` do not resend it.
  - **Hook sessions always start a new conversation**: the function body has an extra `--new` (`ai --tui --new "$@"`). Otherwise one mistyped command would be appended to the long conversation that already existed in that directory, scrambling both the context and the conversation name. `--new` is a general flag and works the same when used manually: `ai --new` skips the `last-session.json` pointer and starts a new conversation; it **only affects the TUI path** and is silently ignored on the stdio path (a stdio invocation is a one-shot conversation anyway, so there is nothing to continue).
  - **`ai hook install` now upgrades itself**: previously it printed "installed" and returned as soon as `MARKER_START` existed in the rc file, so after the function body changed (say, `--new` added this time) existing users could never upgrade. It now normalizes the installed blocks and the current version and compares them (blank lines removed, every line trimmed), overwrites in place when they differ, and reports "updated to the latest version" (new entry `hook.updated`).

- **`/migration` is no longer an alias of `/migrate`** — only `/migrate` remains, and `/migration` now reports "unknown command". The registry, the command executor, the `blocksInput` decision and the four documents were updated together.
- **SDK global logs go to `~/.ai-zen/logs/sdk.log` by default** — previously they were **discarded** by default, and only `AIZ_DEBUG_SDK=1` wrote them to `/tmp`. But the SDK's `warn` / `error` carry critical diagnostics such as "MCP cannot connect" and "Skill failed to parse", and discarding them by default meant failures left no trace. They are now written by default (rotated to `sdk.log.1` after a 2MB cap per file), `AIZ_DEBUG_SDK=0` turns it off completely, and `AIZ_SDK_LOG_FILE` changes the path. The UI still shows not a single character of it.

### 🐛 Fixes

- **Fixed the IME candidate window being "sometimes mispositioned"** — the hardware cursor position used to be computed by `displayWidth()`. But width is a trap: Ink lays out with `string-width`, and the hand-written table disagreed with it on several characters (`⚡` `✅` `✨` `⭐` were counted as 1 column against Ink's 2; the ZWJ emoji `👨‍👩‍👧` as 8 columns against 2; the keycap `1️⃣` as 3 against 2), so as soon as such a character appeared in the input, x drifted. It is now **measured after rendering**:
  - The character at the cursor is wrapped in its own `<Box ref>` (inline nested `<Text>` fragments have no node in yoga and `measureElement()` returns `null` for them, verified by experiment), and Ink 7's `measureElement()` reads the absolute coordinates it is imprinted at within the frame — width is computed by the renderer itself and no longer passes through the hand-written model.
  - After splitting rows, the previous whole-row `truncate` fallback would be lost: once the content is too wide (e.g. the width model counts `⚡` as 1 column) the row is pushed into two rows, the whole frame grows a row and the bottom is pushed off screen. The solution hands the overflow to the **truncatable adjacent segments** — `before` / `after` use `flexShrink={1} minWidth={0}` + `wrap="truncate"` and the cursor block uses `flexShrink={0}`; measured with a 40-column container and a 60-column `before`, it was still **one row**.
  - Measurement can only happen after rendering (`useEffect`), while Ink pushes `setCursorPosition` only in the commit phase (`useInsertionEffect`), so there is a one-commit delay: the first render puts up one frame with the old hand-computed value, and the next frame is corrected by the measured value (one extra render pass, which Ink throttles itself).
  - The placeholder row (nothing typed yet) does not go through measurement and still uses the fixed position after the prefix.
- **The placeholder state no longer draws a "fake cursor"** — when the input line is empty it shows the gray hint "Type a message, / for commands…", and a `▏` used to be drawn at the end as well. But the hardware cursor already sits at the start of the hint (`x = prefix width`), the terminal displays it on its own, and drawing another block means two cursors on screen — and positioned at the end of the hint, which is misleading. The placeholder state now keeps only the hint text.
- **Fixed "the inverse cursor disappears / the real cursor is misaligned after typing emoji"** — two root causes, both treating a "character" as a code point:
  - **The cursor could stop in the middle of a grapheme cluster**: `✌️` is `U+270C U+FE0F`, **two code points, one grapheme cluster** (`👨‍👩‍👧` five, `🇨🇳` two regional indicators). When splitting by code point the cursor could stop between `✌` and `U+FE0F`, so the inverse display became a string of **variation selectors** — in Ink's output the inverse segment disappears entirely (measured: with `at=U+FE0F` the frame carries neither the inverse escape nor any character). Backspace also deleted only half an emoji and left an orphan `U+FE0F`. All cursor arithmetic (wrapping, moving, deleting, inserting, undoing) now uses `Intl.Segmenter`'s **grapheme clusters** as the unit (`graphemes()`, built into Node with no dependency).
  - **The width table switched to Ink's own ruler**: `displayWidth()` no longer uses the hand-written `isWide` range table but calls **`string-width`** directly (that is what Ink lays out with, see `ink/build/output.js`); per-cluster widths are cached, so the wrapping hot path costs almost nothing. From now on wrapping, status bar packing, cursor column numbers and the renderer share one source — and the status bar's "reserve 1 extra column" degraded to a pure safety margin.
  - **Cursor unit changed to grapheme clusters**: `✌️` is `U+270C U+FE0F`, **two code points, one grapheme cluster** (`👨‍👩‍👧` five, `🇨🇳` two regional indicators). When splitting by code point the cursor could stop between `✌` and `U+FE0F`, so the inverse display became a string of **variation selectors** — in Ink's output the inverse segment disappears entirely (measured: with `at=U+FE0F` the frame carries neither the inverse escape nor any character). Backspace also deleted only half an emoji and left an orphan `U+FE0F`. All cursor arithmetic (wrapping, moving, deleting, inserting, undoing) now uses `Intl.Segmenter`'s **grapheme clusters** as the unit (`graphemes()`, built into Node with no dependency).
  - **New direct dependency** `string-width@^8.3.0` (pure ESM, already in Ink's dependency tree, no size change).
- **Notice bar rows were not counted in the cursor y** — the render order is "conversation area → notice bar → slash menu → separator → input row", and the y formula was missing the notice bar. So whenever a notice appeared the hardware cursor floated up by that many rows; `/help` pushes up to 8 rows of notices at once, and the candidate window could float into the conversation area. `noticeCount` is now included (kept as the fallback algorithm while the measurement is not ready).
- **Fixed SDK logs "taken over and still smearing the UI"** — when loading MCP, `[load_mcp]` along with the whole tools / resources listing smashed straight outside the render area. The reason was that 4 SDK modules run `const log = getLogger()` **at module top level**: the moment the module is evaluated the `console.log` function reference is frozen into a constant, and `setLogger()` only swaps an internal variable afterwards, unable to change the reference already captured; ESM static imports also guarantee those modules are evaluated before `runTui()` — so no matter how the CLI took over, it leaked.
  - Fixed on the SDK side (not with a CLI-side workaround that lies to console): all 4 sites now **take the logger at runtime** (`getLogger().info(...)` and so on); the `skillTools` site was dead code that was never called and was removed along with its import. All 10 log calls inside the SDK now go through the single `getLogger()` exit; no console bypass remains.

### 📝 Docs

- README (zh / en) and `docs/{zh,en}/getting-started.md`: the command table gained three rows, `/agent`, `/reload`, `/mcp`.
- README (zh / en) and `docs/{zh,en}/index.md`: the status bar description changed from "one priority-ordered stream of text" to "three information blocks + per-block wrapping".
- `docs/{zh,en}/mcp.md`: the "Management" section gained the `/mcp` direct entry and the `/reload` refresh; `docs/{zh,en}/migration.md` dropped the `/migration` alias.
- README (zh / en) gained a "UI language" section: detection priority, `preferences.json` and `/lang`, coverage, and the three kinds of content deliberately left untranslated.
- Version numbers in `docs/manifest.json` and the READMEs updated to `1.0.0-alpha.21`.
- README (zh / en): "Environment variables" gained `AIZ_DEBUG_SDK=0` / `AIZ_SDK_LOG_FILE`, "Filesystem layout" gained `~/.ai-zen/logs/`, and a note was added under the keybinding table saying reasoning and content already output are kept after an abort.
- README (zh / en) and `docs/{zh,en}/getting-started.md`: the command table gained `/lang`; the directory trees in "Filesystem layout" and `docs/{zh,en}/configuration.md` gained `~/.ai-zen/cli/preferences.json` (CLI-local preferences).

### ⚠️ Known trade-offs

- **Emoji render width may still disagree with the terminal, and that is the terminal layer's business**: the code side now shares one source with the renderer (`displayWidth` = the `string-width` Ink uses, cursor position measured with `measureElement`), but **the terminal's own column-width judgment for emoji / East Asian Ambiguous characters** may still differ from the Unicode tables (some terminals render `✌️` as 1 column instead of 2, and offer no query interface). In that case the relative position of the whole line is already decided by the terminal, and the cursor can only follow Ink's model. The emoji problems at the input / delete / cursor-unit level are all fixed in this release.
- **The cursor is "terminal cursor + inverse character" side by side, deliberately**: the character at the cursor is still inverted into a block with `<Text inverse>`, and the source of truth for position is the measured hardware cursor. Visually the two stack into a slightly heavy block — accept the ghosting, because when either layer fails the other can still report the position (some terminals / multiplexers do not show the hardware cursor, or the inverse display is gone when Ink unmounts). Do not delete the inverse as duplicate rendering later.
- **Blocks are not split ⇒ row count varies with width**: at 80 columns the three blocks each take a row (3 rows), at 120 columns identity and usage can sit on one row (2 rows in total). The old "one stream" could be squeezed into 2 rows, at the cost of splitting `this round / cumulative` across two rows — information integrity wins.
- **The rate while generating is an estimate**: the SDK only provides `usage` in the **last chunk** of each request (`stream_options.include_usage`) and offers no per-token usage; mixing estimates and exact values into one number is the misleading option, hence the two forms "real-time estimate" and "round average".
- **`/mcp` only covers the configuration layer**: whether a server is currently reachable and how many tools it exposes is plugin-private state in the SDK (`McpScopePlugin`'s `mcpManager`) with no public API, so the UI does not show connection status.
- **`/reload` has a gap of a second or two**: it rebuilds the Agent and reconnects MCP, so with many servers there is a perceptible delay; messages and context are unaffected during it.

### ✅ Tests

- Full run: **33 files / 440 cases passed**, `npx tsc --noEmit -p tsconfig.test.json` clean.
- New `src/i18n/index.test.ts` (14 cases: language detection priority / `C`·`POSIX` skipped / English fallback / interpolation / missing entry falls back to the key / Chinese and English entries correspond one to one) and `src/i18n/preferences.test.ts` (9 cases: tolerance of a missing, corrupt or invalid file, atomic write, `initLocale` detecting only once and persisting); `reasoning-effort.test.ts` gained 5 cases for "dimming does not rely on display text".
- pty acceptance on a real terminal: `LANG=en_US.UTF-8` first launch → English, with `en` persisted; `/lang` to Chinese → status bar / input line / notices all follow, and **Chinese is kept after a restart** (the preference beats the system language); `/lang en` back to English works.
- pty acceptance (stage 2): in English the slash menu shows `❯ /help  Show this help` and `/help` outputs an all-English list; after `/lang zh` the slash menu and `/help` switch back to Chinese as a whole.
- pty acceptance (stages 3 / 4, isolated `AI_ZEN_DIR` + `LANG=en_US.UTF-8`): first launch detected as English and persisted; the startup screen shows `The AI collaboration desk in your terminal`; the main screen shows `Type a message, / for commands…` and `thinking default · total 0 tok`; the configuration center shows `◆ Configuration` with `+ New model — marked as custom automatically` / `openai · factory-managed · vision`; the model detail screen shows `◆ Model · GPT-6 Astra` / `factory-managed (editing switches it to custom)` / `Delete model`; the new-model and new-endpoint wizard screens are entirely English. After setting `preferences.json` back to `zh`, **a restart under `LANG=en_US.UTF-8` still shows the Chinese UI** (the preference beats the system language), and the Chinese text in the configuration center and model list matches the pre-rework state.
- **Tests asserting Chinese always pin the language explicitly**: `setLocale("zh")` added in `screens.test.tsx`, `config-wizard.test.tsx`, `reasoning-effort.test.ts`, `registry.test.ts`, `agent-prompt.test.tsx`, `handoff-choice.test.ts`, `config-editor.test.ts`, `agent-switch.test.ts`, `model-switch.test.ts`, `handoff-service.test.ts`, `auto-migrate-confirm.test.ts` — the default language is `en`, and without pinning they would go red on CI for no apparent reason.
- `mode.test.ts` gained 6 cases for `--tui`: with arguments it enters the TUI and the arguments become the first message; without arguments it behaves the same as without `--tui`; a command starting with `/` is not taken as an option / sub-command; `--tui --help` gives help priority; non-TTY is rejected rather than degraded; a `--tui` after `--` is an ordinary argument.
- `mode.test.ts` gained 8 cases for `--new`: used alone it enters the TUI with `newSession: true`; `--tui --new <command>` carries both the first message and the new session; the order relative to `--tui` does not matter; with arguments it falls to stdio and is ignored; in non-TTY it falls to stdio and is ignored; `--tui --new` in non-TTY is still rejected rather than degraded; `--new --help` gives help priority; a `--new` after `--` is an ordinary argument.
- New `src/hook.test.ts` (9 cases, all run under a temporary HOME, **never touching the real `~/.bashrc`**): the written function body contains `ai --tui --new "$@"` and exactly one block, existing rc content is preserved, repeated installation is idempotent, **an old function body already installed (`ai --tui "$@"`) is upgraded in place**, historical aiz blocks are migrated, zsh uses `command_not_found_handler` and writes to `.zshrc`; uninstalling removes the block and keeps the rest, leaves the file alone when nothing is installed, and does not error when the rc file does not exist.
- pty acceptance (hook path): `ai --tui gti status` enters the TUI and automatically sends `gti status` as a user message (the UI shows `❯ you / gti status`), and after the model errors out (a deliberate local fake endpoint) the UI survives and further questions are possible; `ai --tui /opt/bin/nonexistent --flag` is likewise sent as an **ordinary message** and is not eaten by slash-command parsing; `ai --tui` in non-TTY exits with code 2; the function body written to `~/.bashrc` is `ai --tui --new "$@"` and passes `bash -n` syntax checking.
- pty acceptance (`--new`, isolated `AI_ZEN_DIR` + a preset `last-session.json` pointing at an old conversation): `ai` continues it and shows the old message `MARKER-OLD-QUESTION`; `ai --new` lands in an **empty conversation**; `ai --tui --new gti status` starts empty and sends the first message automatically; `--help` lists `--new` in both the Chinese and English UI.
- Full run after this change: **36 files / 487 cases passed**, `npx tsc --noEmit` and `-p tsconfig.test.json` both clean.
- New `src/tui/phase.test.ts` (15 cases: the progression of each of the six states, tool name reuse, a trailing chunk without deltas not changing the stage, content beating reasoning, `reset` returning to zero, the six Chinese and English strings all differing from each other); `chat-session.test.ts` gained 3 cases (progression following the SDK event order, sub-agent output not overriding the main stage, the stage returning to zero when `send` ends).
- pty acceptance (a local mock SSE server emitting the stream in stages): "connecting…" → "queued… (waiting for the first token)" → "thinking…" → "streaming…" → "calling tool no_such_tool…" → "waiting for sub_agent_default…" were all observed in order; the status bar carried only `⚡ 4.2 tok/s` and this round / cumulative tokens over the same period, with no "generating".
- New `src/agent-switch.test.ts` (10 cases), `src/mcp-command.test.ts` (6 cases), `src/tui/token-rate.test.ts` (20 cases), `src/tui/status-segments.test.ts` (17 cases), `src/tui/screens/input-row.test.tsx` (7 cases), `src/tui/text.test.ts` (18 cases); `input-editing.test.ts` gained 3 cases for "an emoji is never cut in half".
- `src/tui/screens.test.tsx` gained assertions for the order of the three status bar blocks, blocks not being split, side-by-side layout on wide screens, and "the row count Ink actually renders == the row count `statusBarRows` measures"; `computeInputCursorPosition` gained a case for "notice bar rows participate in y".
- The `⚡` case in `input-row.test.tsx` asserts both "hand-computation gives 8, measurement gives 9" — the reason for this change is in those two lines.

## [1.0.0-alpha.20] - 2026-10-27

### ✨ New features

- **The chat screen supports mouse wheel scrolling** — previously the wheel could only scroll the terminal's own scrollback buffer (`alternateScreen: false` uses inline rendering), and scrolling up showed snapshots of historical frames while the status bar and input line scrolled out of view entirely.
  - New `src/tui/mouse.ts`: on mount it emits `DECSET 1000` (button events, wheel included) + `1006` (SGR extended coordinates); the close sequence is emitted in **three** places — `mount()`'s exit, `farewell()`, and the signal / uncaught exception fallback — so a crashing process does not spray `^[[<64;…M` into the shell.
  - `parseWheel()` strips the Shift(4) / Meta(8) / Ctrl(16) modifier bits and takes the wheel code (`64` up, `65` down); horizontal wheel `66` / `67` is ignored outright; one notch scrolls 3 rows.
  - The wheel shares one viewport clamp with `PgUp`/`PgDn` and line-wise scrolling — extracted into the pure function `clampViewTop()` (`screens/layout.ts`); scrolling against the boundary is absorbed naturally, and returning `null` means "glued to the bottom, following the newest content". Scrolling during generation is not snapped back to the bottom.
  - **`isTerminalReply()` now covers mouse sequences**: clicks / drags / wheel events are dropped at the source. This step is mandatory — Ink hands the whole SGR sequence to `useInput` as `char` (measured as `"[<64;10;5M"`, all key flags false), and without filtering it lands in the input line as text.
  - `1006` (SGR coordinates) must be used rather than the old X10 encoding: Ink's parser splits the latter into two events, `[M` plus three ordinary characters, and those three characters get inserted as text directly (verified by experiment).
  - The startup screen's "press any key to skip" no longer treats mouse events as keys.

### 📝 Docs

- README (zh / en): the keybinding table gained a "mouse wheel" row, documenting two gotchas: with reporting enabled **drag-select copy requires holding `Shift`** (falling back to the terminal's native selection); **`tmux` users need `set -g mouse off`**, otherwise the wheel is intercepted by copy-mode first.
- Version numbers and runtime dependency versions in `docs/manifest.json`, `docs/{zh,en}/getting-started.md` and the READMEs aligned (`agents-core ^4.5.2`, `agents-sdk 1.0.0-alpha.18`).

### ⚠️ Known trade-offs (inherent to the terminal, not defects)

- Mouse reporting is a terminal-level switch: clicks / drags no longer go to the terminal for native selection, and copying requires holding `Shift` (true for iTerm2 / Windows Terminal / kitty and others).
- In-app scrolling only moves the viewport and produces no terminal scrollback — to review history use the wheel / `PgUp`, not the terminal scrollbar.
- Old Windows `conhost` does not support `1006`, so the wheel appears to do nothing in that terminal.

### ✅ Tests

- Full run: **25 files / 316 cases passed** (new `src/tui/mouse.test.ts`, 1 file, 11 cases; `screens.test.tsx` gained three groups: wheel parsing, `clampViewTop` clamping, startup screen mouse guard).
- End-to-end check on a real terminal (pty): wheel direction parsing, modifier stripping, clicks dropped, ordinary typing unaffected, close sequence emitted on exit.

## [1.0.0-alpha.19] - 2026-10-22

### 🐛 Fixes

- **Fixed the "Agent 'default' is not bound to a model" error on the first launch after upgrading** — alpha.18 moved the model source of truth to `AgentDefinition.modelId` and put "backfill modelId for historical Agents" inside `bootstrap()`. But the TUI's **session continuation** path (`resumeLastSession()` hitting the previous archive) never goes through `resolveTarget()` and therefore never reads the configuration, so `bootstrap()` never ran: the Agent still had no model, `config.defaultModel` was still there, and startup failed outright.
  - `runTui()` now explicitly `await ensureConfigDir()` at the start, so configuration initialization precedes any Agent read;
  - `modelOf()` also reads the configuration once itself (double insurance), so a missed caller can no longer hit this error.
- New regression test: with an old configuration (has `defaultModel`, Agent has no `modelId`), after one configuration read the model is moved onto the Agent and the old field in `config.json` is cleared.

### ✅ Tests

- Full run: **24 files / 299 cases passed**.

## [1.0.0-alpha.18] - 2026-10-22

### 🐛 Fixes

- **Fixed the 401 deadlock caused by "the displayed model is not the model actually requested"** — the model used to come from three places: the `modelId` in the status bar and the session archive, the `modelId` in the Agent definition, and the `defaultModel` in config. Once the three diverged:
  - the status bar said `deepseek-flash`, the request actually went to GLM, and bigmodel's key was invalid → 401;
  - when switching back to DeepSeek, `/model` judged by the **display layer** value, found that it was "already the current model" and returned immediately, without changing the actual model at all — so no amount of switching fixed the 401, and the only way out was deleting the config.

  The model now **exists in exactly one place, `AgentDefinition.modelId`**, and the status bar, the credential pre-check, the context thresholds and the request the SDK actually sends all read it.

### 🔧 Behavior changes (incompatible)

- **Upgraded `@ai-zen/agents-sdk` to `1.0.0-alpha.17`**: the config layer no longer has `defaultModel`, and an Agent missing `modelId` errors out immediately (the default Agent ships with `deepseek-flash`); when upgrading historical configs, the old `defaultModel` is moved into the default Agent, so the model in use does not change.
- **Session archives no longer record `modelId`** — when a conversation is resumed, the model is determined entirely by the Agent definition; the field in old archives is ignored on read.
- **`/model` only writes the Agent definition** — the branch that changed the global default model when the Agent had no binding no longer exists.
- **Switching models resets reasoning effort** — `AgentDefinition.modelParams` is **cleared outright** when the model is switched (no retention, no migration, no per-key removal), so the target model uses its own `defaultParams`. Rationale: thinking parameters are model-specific, and DeepSeek's `thinking: {type:"disabled"}` for turning thinking off is rejected outright by GLM-5.3 — previously "a model unwilling to turn thinking off + a parameter saying to turn it off" could be sent together. To tune it again, select once more with `/think`.
- **Removed the "default model" entry from the configuration center** — the model is now chosen in the "model" field of the Agent detail screen (scope changes from "global default" to "that Agent").

### ✅ Tests

- Full run of **24 files / 298 cases passed**.
- New `model-switch` cases: switching clears `modelParams` (not merely removing the thinking keys), and no extra empty object is written when there was none.

## [1.0.0-alpha.17] - 2026-10-22

### 🔧 Behavior changes

- **Upgraded `@ai-zen/agents-sdk` to `1.0.0-alpha.16` (bundling core `4.5.2`): model parameters can no longer override the fixed fields of the request body** — core previously spread the model parameters at the outermost level of the request body, so if `model` / `messages` / `tools` / `stream` / `stream_options` appeared in `Model.defaultParams` / `AgentDefinition.modelParams`, they silently overrode the values the framework itself filled in. Worst of all was `stream: false`: streaming was turned off while the caller still parsed an async stream, failing the whole turn. Fixed fields now always win.
  - This has **no effect** on `/think` and the effort levels: what gets written are non-fixed keys such as `thinking` / `reasoning_effort`, which pass through as before.
  - The only thing to watch is not to hand-write those five keys in `modelParams` — writing them has no effect.

## [1.0.0-alpha.16] - 2026-10-22

### 🔧 Behavior changes (incompatible)

- **Upgraded `@ai-zen/agents-sdk` to `1.0.0-alpha.15`: effort levels no longer store the level name but the expanded parameters** — the previous version wrote the level name into the Agent definition's `reasoningEffort`, and at runtime the SDK looked it up in a table and translated it into request parameters. That pushed the product semantics of "what `max` means" into the runtime. It is now **configuration is the fact**:
  - `/think` writes the selected level's parameter patch directly into `AgentDefinition.modelParams` (e.g. `{"thinking":{"type":"enabled"},"reasoning_effort":"high"}`), and the SDK only performs a single shallow merge of `{...defaultParams, ...modelParams}`;
  - **the old `reasoningEffort` is migrated automatically**: when the Agent definition is read it is expanded into `modelParams` and written back; when the model has no associated preset, only the old field is deleted (no guessing at parameters).
- **Ownership of the reasoning preset table adjusted to "provided by the SDK, used by the CLI"** — the table's types, factory content and read/write live in the SDK (the CLI and the desktop share the same knowledge that "Zhipu 5.3 only accepts low/high/max"), and the CLI only **consumes** it: limiting the levels `/think` offers and expanding a level into parameters written into the Agent. `Scope` no longer needs the preset table injected.

### 🚀 New features

- **The status bar level is now looked up from the effective parameters** — it shows the level matched by the parameters that will actually be sent to the API (the model defaults included), no longer relying on the level declaration on the Agent. Three states: matches a level → "low / medium / high…"; there is an Agent override but it matches no level (parameters were edited by hand) → "custom"; no match at all → "default".
- **The "reasoning preset" field in `/config` → "model" detail screen** remains available, showing the preset and its levels (e.g. `zhipu-5.3（low / high / max）`), and a wrong name is rejected on the spot.

### ✅ Tests

- `src/reasoning-effort.test.ts` rewritten (19 cases): what is written is the expanded parameters rather than the level name; `max` → `off` leaves no residual `reasoning_effort`; unrelated parameters such as `temperature` are preserved; `null` clears and removes `modelParams` together; round trips are consistent (what was written can be looked up back to the original level).
- New `src/agents-store.test.ts` (4 cases): the old `reasoningEffort` is expanded and written back to disk; only the field is deleted when there is no preset; nothing is written to disk when the old field is absent; the original level can be looked up again after migration.
- Full run of **24 files / 299 cases passed**.

## [1.0.0-alpha.15] - 2026-10-22

### 🔧 Behavior changes (incompatible)

- **Upgraded `@ai-zen/agents-sdk` to `1.0.0-alpha.14`: reasoning capability changed to a declarative preset table** — the previous version expressed vendor differences with `Model.reasoning: { efforts, disable? }`, where `disable` carried two meanings, `off` relied on concatenation, and a global enum pretended that every vendor's levels were equivalent. All protocol differences are now moved into one table:
  - new `~/.ai-zen/reasoning-presets.json` (released automatically on first start, three factory presets: `openai` / `zhipu-5.3` / `deepseek`); a model only records the name `reasoningPreset`;
  - the levels `/think` offers now come from the preset table — thinking can only be turned off if the table has `off`, and that option is not offered otherwise;
  - a model with no preset associated, or with a preset name absent from the table → always treated as not adjustable (`—` in the status bar), and parameters of unknown origin are never sent;
  - level labels became "look up known levels in the table + display unknown level names as-is", so level names created by users (e.g. `turbo`) are no longer shown as blank.
- `TokenThresholds` in `src/stdio-runner.ts` / `src/tui/chat-session.ts` now imported directly from the SDK (previously a derived type that worked around the missing export in alpha.13).

### 🚀 New features

- **New "reasoning preset" field in `/config` → "model" detail screen** — shows the preset the model currently references and its levels (e.g. `zhipu-5.3（low / high / max）`), and can be changed directly to another preset name from the table; a wrong name is rejected on the spot with the available presets listed, and leaving it empty = no level adjustment. Custom models can now point at a built-in preset without hand-editing JSON.
- **The preset table can be edited** — adding a table or adjusting level patches is fine; once a table is marked `"custom": true`, SDK upgrades no longer overwrite it, while the remaining presets still sync with the SDK.

### ✅ Tests

- `src/reasoning-effort.test.ts` rewritten (14 cases): available levels = the keys of the preset table; unknown level names displayed as-is; an error is thrown when no preset is associated / the preset name does not exist; the status bar falls back to "default" on an illegal declaration.
- Configuration wizard: 2 new cases: writing a valid preset name; an invalid preset name is rejected and nothing is written to disk.
- Full run of **23 files / 290 cases passed**.

## [1.0.0-alpha.14] - 2026-10-22

### 🚀 New features

- **Input line keys aligned with Claude Code / readline** — editing shortcuts unified to the industry-standard set:
  - word operations: `Alt+B` / `Alt+F` move by word (on macOS `Option+←/→` sends `ESC b` / `ESC f`, which previously did not respond at all); `Alt+Backspace`, `Alt+D`, `Ctrl+Delete` delete by word
  - whole-segment operations: `Ctrl+K` deletes to end of line, `Ctrl+U` deletes to start of line, `Ctrl+W` **deletes to the previous whitespace** (punctuation does not split, so `src/utils/foo.ts` goes in one go)
  - kill ring: `Ctrl+Y` retrieves the text just deleted, `Alt+Y` cycles through earlier ones; `Ctrl+_` undoes the last input edit; `Ctrl+S` stashes / restores the draft
  - movement and history: `Ctrl+A` / `Ctrl+E` start / end of line, `Ctrl+P` / `Ctrl+N` previous / next history
  - new pure-function layer `src/tui/input-editing.ts` (`deleteToPrevWhitespace` / `killedText` / kill ring / undo stack), 12 unit tests
- **macOS key diagnostics** — with `AIZ_DEBUG_KEYS=1` the terminal environment (`TERM` / `TERM_PROGRAM`) and every key press (`input` + modifier bits + `raw` state) are written to `/tmp/aiz-key-debug.log` (path configurable via `AIZ_KEYS_FILE`), for tracking down "a key does nothing on my machine": no new line = the key was intercepted by the system, `flags` mismatch = a matching logic problem, `raw=false` = the key was interpreted by the terminal itself.
- **`/model` switches the current session's model and writes the config** — with no argument it opens a model picker (annotating the current one), and `/model <id>` switches directly. The write target depends on "where the session model really comes from": model bound explicitly in the Agent definition → that Agent's `modelId` is changed; not bound (using the default model) → `defaultModel` in `config.json` is changed. After switching, the Scope and session are rebuilt (messages and context retained) and the model name in the status bar updates. The decision logic is extracted into `src/model-switch.ts` (`resolveModelWriteTarget` / `switchModel`, 7 unit tests).
- **Reasoning effort display and switching (`/think`, alias `/effort`)** — the status bar shows the current effort after the model name (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`; `default` when the model is adjustable but the Agent has no declaration, `—` when the model is not adjustable). `/think` with no argument opens a picker (annotating the current one), `/think high` sets directly, `/think default` clears the declaration and follows the model default again.
  - **The level lives on the Agent definition** (`AgentDefinition.reasoningEffort`), not on the model: the same model can have different efforts for the coding / novel / chat Agents, while the model's `defaultParams` stay untouched.
  - **Available levels are decided by model capability** (`Model.reasoning.efforts`, declared by the SDK per the vendor's official docs): Zhipu GLM-5.3 only has `low/high/max` and cannot be turned off (passing `medium` or `disabled` returns 400), DeepSeek is `off/low/high/max`, OpenAI is `off/minimal/low/medium/high`; a model with no declaration offers no level at all — never guessed.
  - Read/write and validation are extracted into `src/reasoning-effort.ts` (`effortChoices` / `describeEffort` / `setAgentEffort`, 9 unit tests).
- **SDK logging takeover** — the TUI calls `setLogger()` on startup, disabling the SDK's `console.log` fallback (otherwise the `load_mcp` manifest writes straight to stdout and tears the UI apart); with `AIZ_DEBUG_SDK=1` it writes to `/tmp/aiz-sdk.log` instead (path configurable via `AIZ_SDK_LOG_FILE`), 6 unit tests.

### 🔧 Behavior changes (incompatible)

- **Upgraded `@ai-zen/agents-sdk` to `1.0.0-alpha.13`, context thresholds changed to a struct** — `Model.maxContextTokens` is replaced by `Model.tokenThresholds: { handoff, guard }` (`maxContextChars` retired):
  - `handoff`: the soft handoff line; `prompt_tokens` exceeding it triggers a task handoff;
  - `guard`: the hard cutoff line; exceeding it **before** each request aborts the turn with an error.
  - both lines are **absolute values**, and `ratio` / `suspendedRatio` / `isSuspended` of `ContextGuardPlugin` are removed from the SDK — loosen things by changing the numbers. The cost is that the handoff turn no longer gets the 2.0× extra allowance; by default `guard` is configured as `handoff × 1.5` (375K) to leave headroom.
  - old configs are **migrated automatically**: the SDK's `ConfigManager.read()` migrates on read (`maxContextTokens` → `handoff`, `maxContextChars` converted by `/4`, a missing `guard` filled in once at 1.5×, old keys deleted), writing back to disk only when a difference is detected. Users do not need to hand-edit `config.json`.
  - the former "migration threshold" entry in the configuration center is split into "handoff threshold" and "guard threshold" rows, and the soft line is validated to be less than the hard line.

- **`Ctrl+N` changed from "newline" to "next history entry"** — newline is now `Ctrl+J` / `Ctrl+Enter` / `Alt+Enter` / `Shift+Enter` / `\` + `Enter`
- **`Ctrl+V` no longer doubles as "page down"** — reserved for Claude Code's "paste image"; pressing it now shows a not-implemented-yet notice. Paging uses `PgUp` / `PgDn`, scrolling by line uses `Shift+↑ ↓` / `Alt+↑ ↓`
- **`Ctrl+U` changed from "clear the whole input box" to "delete to start of line"** — iTerm2 and Terminal.app on macOS map `⌘⌫` to `Ctrl+U`, and the old semantics made Mac users lose an entire draft with a single ⌘⌫; clearing everything is now handled by `Esc`
- **`Ctrl+C` no longer exits directly when idle** — with a draft, it clears the draft first with a notice, and a second press exits
- **`Ctrl+D` changed to double-press to confirm exit** — with a draft, readline semantics apply (delete one character after the cursor)
- **`Esc` during a busy period (generating / migrating) now aborts the current turn**

### ⏳ Not implemented yet

- **Pasting images (`Ctrl+V`)** — the endpoint capability probe for "file → content block" has to be solved first (Files API upload vs base64 inline), and the upload endpoint must not be hardcoded to a particular id; the subsequent SDK rework comes after, and the code for this feature was removed in this round to avoid shipping a half-finished feature.

### ✅ Tests

- New `src/tui/input-editing.test.ts` (12 cases) + `src/tui/key-debug.test.ts` (4 cases) + `src/sdk-log.test.ts` (6 cases) + `src/model-switch.test.ts` (7 cases) + `src/reasoning-effort.test.ts` (9 cases) + 8 cases for the input utility functions; full run of **23 files / 286 cases** passed, `tsc` and `build` with zero errors.

### 📄 Docs

- Rewrote the "keyboard and terminal compatibility" section of `README{,.zh}.md`: switched to the industry-standard route "Option as Meta + readline-style Ctrl keys", with the concrete settings paths for Apple Terminal / iTerm2 / VS Code / Ghostty; explained that `⌘` only reports with the kitty keyboard protocol, and why `⌘⌫` is mapped to `Ctrl+U` by the terminal; added the usage of key diagnostics. The command tables in `README{,.zh}.md` and `docs/{zh,en}/getting-started.md` gained `/model` and `/think` (with a "config file source" comparison), and the version in `docs/manifest.json` was synced.

## [1.0.0-alpha.13] - 2026-10-21

### 🚀 New features

- **Handoff confirmation unified to a three-way choice** — the three paths of automatic migration, manual `/migrate` and manual `/handoff` previously behaved inconsistently (automatic: a 2-item picker + Esc to skip; `/migrate`: a yes/no confirmation; `/handoff`: no question). They are now unified into the same "handoff mode" picker:
  - **the current session writes the handoff doc itself** (`self`, faithful · the real state can be verified)
  - **a separate Agent writes the handoff doc** (`summary`, independent summary · fast and cheap, files are not verified)
  - **no handoff** (skip this time; `Esc` does the same)

  When `self` / `summary` is given explicitly after the command (e.g. `/migrate self`), it executes directly without asking. The picker is extracted into the shared module `src/tui/screens/handoff-choice.ts`, with the same options and copy reused in all three places.

### 🔧 Fixes

- **The confirmation notice for an automatic "no handoff" was overwritten** — the `notice` channel keeps only the latest entry, and the previous "this task migration has been skipped" and "you can /migrate at any time…" were pushed as two entries, the latter overwriting the former; they are now merged into a single entry, so the skip confirmation is visible.

### ✅ Tests

- New `src/tui/screens/handoff-choice.test.ts` (5 cases): the value order of the three-way choice, `self`/`summary` returned as-is, "no handoff"/`Esc` → `null`, title passed through. Full run of **18 files / 237 cases** passed, `tsc` and `build` with zero errors.

### 📄 Docs

- The "trigger methods" section of `docs/{zh,en}/migration.md` synced to the unified three-way choice (manual commands always ask first unless the executor is specified explicitly); the versions in `docs/manifest.json` and `README{,.zh}.md` synced.

## [1.0.0-alpha.12] - 2026-10-20

### 🔧 Fixes

- **After automatic migration the old session was overwritten and history was lost** — `ChatSession` used to store the session id in two places (`this.currentId` and `ctx.currentId`). Manual `/migrate` and `/new` synced both, but **automatic migration** is driven by the SDK's `AutoMigratePlugin` calling `HandoffService.migrate()` directly and **goes through no method of `ChatSession`**, so the new id was written only into `ctx.currentId`. `ConversationPersistPlugin.getId()` therefore still returned the old id, and the first write after migration stored the "system prompt + handoff breakpoint" produced by `prune` into the **old session file**, overwriting the complete saved history (users saw "all history gone after the handoff, only the handoff doc left").
  - Fix: `currentId` / `currentName` became **getters/setters proxying `ctx`**, eliminating the second source of truth — whoever updates `ctx` takes effect immediately.
  - `ConversationContext.currentId` narrowed from `string | undefined` to `string`; the two redundant double writes in `reset()` were removed accordingly.
- **Test pollution**: the end-to-end case in `chat-session.test.ts` wrote handoff docs into `<cwd>/.ai-zen/handoffs`; it now points at a temp directory with automatic cleanup.

### ✅ Tests

- 3 new cases: `ctx` changes take effect immediately; assignment writes back to `ctx`; end to end (the id must follow after a real `handoffService.migrate()`; this case does fail before the fix, verified in reverse). Full run of **17 files / 232 cases** passed, `tsc` (including the test project) and `build` with zero errors.

### 📄 Docs

- The "migration chain" section of `docs/{zh,en}/migration.md` gained the constraint "the session id has a single source of truth" and its failure symptoms; the versions in `docs/manifest.json` and `README{,.zh}.md` synced.
- The dependency is still `@ai-zen/agents-sdk` `1.0.0-alpha.11` (no SDK changes this time).

## [1.0.0-alpha.11] - 2026-10-20

### ⚠️ Dependencies

- `@ai-zen/agents-sdk` `1.0.0-alpha.10 → 1.0.0-alpha.11` (the new `env` parameter of `createCallMcpTool` is a breaking change; the CLI does not call that factory directly, so there are no code changes).

### 🔧 Changes (with SDK)

- **`call_mcp_tool` output protection**: when an MCP tool is called, text output exceeding `maxToolOutput` (32768 characters by default) is written in full to `result.txt`, and only a warning plus a head/tail preview is returned, readable in batches with `read` — no more pouring tens of thousands of characters into the context at once.
- **Images / audio / binary resources returned as-is**: the `image` / `audio` / `resource.blob` returned by MCP are converted into `image_url` / `file` content blocks and passed through (`resource.text` merged into the body, `resource_link` turned into readable clues), no longer dropped silently; media is not subject to `maxToolOutput`.

### 📄 Docs

- `docs/{zh,en}/mcp.md` explains "only text is subject to output protection; media is not limited by the cap"; the versions in `docs/{zh,en}/getting-started.md`, `docs/manifest.json` and `README{,.zh}.md` synced.

## [1.0.0-alpha.10] - 2026-10-20

### 💥 Changes

- **Handoff and migration split into two commands** (single semantics, naming aligned with the implementation):
  - **`/handoff`** — the original agent stops, verifies the state and writes the handoff doc to `<project>/.ai-zen/handoffs/`, with the **session unchanged** (no confirmation, repeatable; the handoff turn stays in `agent.messages`, so you can keep asking to refine the same doc);
  - **`/migrate`** (alias `/migration`) — the same handoff + clear history + start a new session (confirmation required).
  - both support the `self` / `summary` argument (e.g. `/handoff summary`, `/migrate self`) to skip the default choice.
- **Automatic migration changed to an "executor three-way choice" picker**: when the context exceeds the threshold it no longer only asks "whether to migrate", but offers **self-handoff by the original agent (highlighted by default, faithful) / independent summary (cheap) / skip this time**. The picker reuses the existing picker overlay (`setPickerState`). Non-interactive environments (pipes, redirection, e2e) have no choice channel and migrate with the default executor, without blocking or extra output.
- **Handoff doc directory**: new `PROJECT_HANDOFFS_DIR = <cwd>/.ai-zen/handoffs`, so handoff docs live inside the project and can be shared / reviewed with the repository.

### ♻️ Refactors

- **`src/migration-service.ts` → `src/handoff-service.ts`**: `createMigrationService` → `createHandoffService`, and the hooks change from `onBeforeMigrate` / `onMigrated` to `onBeforeHandoff` / `onHandoff` / `onMigrated`. Archiving the old session moved to `onHandoff` (which now already contains the handoff turn, making the archive auditable); `/handoff` does not switch sessions and therefore needs no extra archiving (`ConversationPersistPlugin` already writes to disk every turn).
- **`src/auto-migrate-confirm-plugin.ts` → `src/auto-migrate-confirm.ts`**: `AutoMigrateConfirmPlugin` (inheriting and overriding `onAfterSend`) degenerated into the `createAutoMigratePlugin()` factory — "when to migrate" stays in the SDK plugin, and "who does the handoff" is injected through the SDK's new `resolveMode` callback, with the threshold logic no longer reimplemented.
- `src/agent-creator.ts` extracted and exported `listSkillDirs()`: Scope assembly and the handoff service (which reads the body of the `handoff` Skill) share the same directory priority, so it is not computed twice.
- `ChatSessionOptions.requestConfirm` → `requestMode` (returning `HandoffMode | null`); `ChatSession.migrate()` / `handoff()` return the doc path; `ConversationContext.migrationService` → `handoffService`.
- `ContextGuardPlugin` wired with `isSuspended: () => handoffService.busy`: the handoff-turn guard is relaxed from `× 1.5` to `× 2`.
- Slash command parsing supports arguments: the command name is the first token (`/migrate summary` is no longer treated as an unknown command).

### ⚠️ Dependencies

- `@ai-zen/agents-sdk` `1.0.0-alpha.9 → 1.0.0-alpha.10` (`TaskMigrationService` → `HandoffService` is a breaking change).

### ✅ Tests

- New `src/handoff-service.test.ts` (migration clears `lastUsage` / the new session is written to disk / `/handoff` does not switch sessions), `src/auto-migrate-confirm.test.ts` (non-interactive default, choice passed through, cancel skips, busy yields). Full run of **17 files / 229 cases** passed, `tsc --noEmit` (including the test project) and `build` with zero errors.

### 📄 Docs

- `docs/{en,zh}/migration.md` rewritten as "task handoff and migration": the difference between the two commands, the trade-offs of the two executors, the code-level guarantees of self-handoff (guard / relaxation / recursion prevention), doc location and naming, the template carried by the `handoff` Skill (`metadata.custom: "true"` opts out of sync and can be overridden per project), and cost notes. The website mirror synced.
- The command table and the "task handoff and migration" chapter of `README.md` / `README.zh.md`, and the features and navigation of `docs/{en,zh}/index.md`, synced.

## [1.0.0-alpha.9] - 2026-10-14

### 🔧 Fixes

- **Interaction adaptations between automatic migration and the CLI (two places)**:
  - **The input line did not really block during migration** — the `isActive` of the main `useInput` only blocked the "confirmation box / picker / configuration wizard", not the "generating" state. Automatic migration runs inside `send()` via `await onAfterSend` (`busy` is true and the input line has been replaced by the Spinner), yet keystrokes were still swallowed silently into the hidden input buffer and only surfaced once the turn ended. The main input is now fully deactivated while `busy`, with a separate "busy period" handler that only passes `Ctrl+C` to abort / `Ctrl+D` to exit / `PgUp`·`Shift+↑↓` to look back; manual `/migrate` is included in `busy` as well.
  - **Still blocked by the overall context guard after migration** — migration (prune) physically resets the context but left `agent.lastUsage` behind (the `prompt_tokens` of the request before migration). `ContextGuardPlugin` (`onInnerLoopStart`, hard cap `maxTokens × 1.5`) misjudged from it, and the first message after migration was aborted with `ContextOverflowError`. `agent.lastUsage` is now cleared after migration, so the guard has nothing to go on in the first round and lets it pass, until the next response fills in the real usage.

### ✅ Tests

- New `src/migration-service.test.ts`: asserts that `agent.lastUsage` is cleared after migration (this case does indeed fail when the fix is removed). Full run of **17 files / 227 cases** passed, `tsc --noEmit` and `pnpm build` with zero errors.

## [1.0.0-alpha.8] - 2026-10-14

### 🔧 Fixes

- **Fixed the OOM (crash) caused by unbounded memory growth in long TUI sessions** — the CLI entry never set `NODE_ENV`, so React loaded the **development** build of `react-reconciler` per `process.env.NODE_ENV !== "production"`; that dev build calls `performance.measure()` (User Timing API) on every render, and Node's performance entry buffer is **unbounded and never evicted**, so entries kept accumulating during long streaming sessions and the heap approached `heap_size_limit` (about 1GB on this machine) after roughly 55 minutes, triggering OOM. `process.env.NODE_ENV ||= "production"` is now set at the top of `src/index.ts`; because ESM static `import`s are hoisted and evaluated before the module body, the TUI entry `./tui/index.js` now uses a dynamic `import()`, ensuring React/Ink is evaluated **after** `NODE_ENV` is set and thus loads the production reconciler (which does not call `performance.measure`). An explicit `NODE_ENV=development` still keeps the dev build for debugging.

### ✅ Tests

- **End-to-end proof** — loading Ink through the entry point under real ESM and re-rendering 300 times in a row: after the fix, `performance.measure` entries went **0 → 0** (production reconciler), while the control group with an explicit `NODE_ENV=development` went **0 → 905** (dev instrumentation still in place). Full run of **16 files / 226 cases** passed, `tsc --noEmit` and `pnpm build` with zero errors.

## [1.0.0-alpha.7] - 2026-10-14

### 📄 Docs

- **Status bar token usage added to the docs** — the "main features" section of `docs/zh|en/index.md` gained "the status bar shows in real time the model · Agent · current-turn/cumulative token usage · generation state" (previously mentioned only in the README), with cumulative usage defined as `sumUsage(agent.messages)` (including sub-agents at all levels).
- Fixed the outdated path reference in `TODO.md` (`src/tui/config-wizard.tsx` → directory `src/tui/config-wizard/`).

### ⚠️ Dependencies

- `@ai-zen/agents-core` `^4.5.0 → ^4.5.1`, `@ai-zen/agents-sdk` `1.0.0-alpha.8 → 1.0.0-alpha.9`

> Docs-only correction, no code changes.

## [1.0.0-alpha.6] - 2026-10-14

### ♻️ Refactors

- **Cumulative usage now uses the SDK's `sumUsage`, and the CLI's own in-memory accumulator is removed** — depends on `@ai-zen/agents-sdk` `1.0.0-alpha.8` / `@ai-zen/agents-core` `4.5.0`: besides the `usage` of assistant messages, usage produced by delegation is now pinned by core onto the tool message's `subAgentUsage` at the delegation boundary. So `ChatSession.totalUsage` can simply be `sumUsage(agent.messages)` (covering sub-agents at every level), `src/usage.ts` and the `onSubAgentEnd` in-memory back-feed are deleted — sub-agent cost is persisted along with messages and is not lost on resume / `/load`, and the double-counting risk is gone.

### ⚠️ Dependencies

- `@ai-zen/agents-sdk` `1.0.0-alpha.7 → 1.0.0-alpha.8`, `@ai-zen/agents-core` `^4.4.0 → ^4.5.0`

### ✅ Tests

- Removed `src/usage.test.ts` (the logic moved down into core and is already covered there); the `totalUsage` case in `chat-session.test.ts` now covers summing "the assistant's usage + the tool message's subAgentUsage". Full unit suite **16 files / 226 cases** pass, `tsc --noEmit` and `npm run build` report zero errors.

## [1.0.0-alpha.5] - 2026-10-14

### 🚀 New features

- **Status bar shows cumulative token consumption** — built on the `usage` that `@ai-zen/agents-sdk` `1.0.0-alpha.7` / `@ai-zen/agents-core` `4.4.0` pin onto each assistant message, added `src/usage.ts` (`addUsage` / `sumMessagesUsage` pure functions) and `ChatSession.totalUsage`: summing the `usage` of all assistant messages in the session gives the cumulative consumption on the billing basis; a sub-agent's messages are not in the parent agent, so they are accumulated separately in `onSubAgentEnd` and folded in, and reset to zero on `/new`. The status bar is upgraded from "`{tokens} tok`" to "`this round x · cumulative y tok`" (this round = `lastUsage.total_tokens`, cumulative = `totalUsage.total_tokens`).
- **Dependency upgrade** — `@ai-zen/agents-sdk` `1.0.0-alpha.6 → 1.0.0-alpha.7`, `@ai-zen/agents-core` `^4.3.2 → ^4.4.0` (the latter adds `AgentNS.Message.usage`, per-message token usage).

### ✅ Tests

- Added `src/usage.test.ts` (4 cases); `chat-session.test.ts` gained a summation case for `totalUsage`; the `StatusBar` cases in `screens.test.tsx` were updated. Full unit suite **17 files / 230 cases** pass, `tsc --noEmit` and `npm run build` report zero errors.

## [1.0.0-alpha.4] - 2026-10-13

### ♻️ Refactors

- **TUI rendering uses `agent.messages` directly as the single source of truth** — removed custom intermediate models such as `ChatEvent` / `chatReducer` / `LiveAssistant` / `Block` / `messagesToBlocks`. During streaming the SDK **updates `agent.messages` in real time** (`Agent.parseStreamData` writes each delta incrementally into the current message), so the cross-message order (array order) and the order inside a single assistant message (`thinking → tool → text`) are preserved naturally and rendering directly is enough, which rules out the distortion and maintenance burden of a "second source of truth". Wrapping / highlighting of completed messages is cached by "message + column width + content signature" (`cachedMessageToLines`), and the in-flight message is invalidated automatically through its content signature.
- **notice / error moved to a dedicated slot** — system-level notices (command feedback / migration progress / errors) no longer mix into the chat transcript, and are **never written into `agent.messages`** (that would be sent to the model verbatim by `formatHistory()` and pollute the context); they now render on a dedicated row above the input line (`src/tui/screens/notice.ts`).

### 🎯 Optimizations

- **Incremental streaming rendering**: Ink enables `incrementalRendering` — switching from "erase the whole screen and rewrite it every frame" (`createStandard`) to "redraw only the changed lines" (`createIncremental`), bringing per-frame output from O(screen size) down to O(change size), so streaming is steadier over SSH / weak networks.
- **Streaming frame coalescing** (`src/tui/screens/frame-buffer.ts`): content changes are buffered first and re-rendering is flushed in batches every 60ms (about 16fps, below Ink's default 30fps output throttle), taking the paint rate from "once per delta" down to a fixed frame rate.
- **Render cache**: in long conversations the wrapping / highlighting of historical messages no longer needs to be recomputed every frame, so the cost no longer degrades as the conversation grows.
- **A blank line is added between thinking and tool calls**, for a clearer layout.

### ✅ Tests

- Added `frame-buffer.test.ts`, `notice.test.ts`; `screens.test.tsx` rewritten on top of `messageToLines` / `transcriptLines` / `computeChatLayout(transcript)`.
- `tsc` reports zero errors; full unit suite **16 files / 225 cases** pass; `npm run build` passes.
- Verified on a real terminal (pty): streaming is stable over SSH / weak networks, and scrolling in long conversations is smooth.

## [1.0.0-alpha.3] - 2026-10-13

### 💥 Breaking changes

- **Built-in tools renamed (unified on `snake_case`: multi-word names collapsed, single-word names simplified)** — landed with `@ai-zen/agents-sdk` `1.0.0-alpha.6`: the SDK unifies built-in tool names on `snake_case` and simplifies single-word tools to one word — `readFile` → `read`, `writeFile` → `write`, `exec_async` → `spawn`, `findText` → `find_text`, `batchEdit` → `batch_edit`, `inspectFile` → `inspect_file`, `downloadFile` → `download_file`, `generateImage` → `generate_image`, `viewImage` → `view_image`, `indexedSearch` → `indexed_search`; tool class names are likewise now `ReadTool` / `WriteTool` / `SpawnTool`. **If your Agent definitions, permission allow lists (`tools.allow` / `tools.deny`) or custom prompts reference the old tool names, update them to the new `snake_case` names** (old names survive only in historical CHANGELOG entries).

### 🚀 New features

- **Text / thinking colored by Markdown source** — AI answers are Markdown already, so they are now colored by `highlight.js`'s `markdown` lexer: headings (`#`), bold, italic, inline code, lists, quotes and links each get their own color; **fenced code blocks keep their fence lines** (opening / closing fences rendered in subdued dark gray) and continue to be syntax-highlighted by the annotated language. Markers (`#` / `**` / backticks, etc.) **are kept as-is and only colored** (source coloring, not semantic rendering). Text wraps **preferring spaces**, so English words are not cut in the middle.

### 🎯 Optimizations

- **The default text color falls back to the terminal default foreground** — the base text color used to be hardcoded near-white `#e2e8f0`, which was invisible "white on white" in **light-theme terminals**. Text (including default segments with no color assigned) now always falls back to the **terminal default foreground**, with absolute colors kept only for emphasis such as headings / code; the two near-white token colors in the syntax palette (`variable` / `params`) are removed at the same time.

### ⚠️ Dependency upgrades

- **`@ai-zen/agents-core` raised to `^4.3.2`, `@ai-zen/agents-sdk` raised to `1.0.0-alpha.6`** —
  - core `4.3.1`: **normalization of interrupted parallel tool rounds** — when several tools called in parallel within one reply are interrupted (`Ctrl+C`), unfinished tool results are filled in / normalized in the history, so the next round is not rejected by the server because the number of `tool_calls` does not match the number of actual tool results (default `fill`: keep the assistant text and fill in unfinished results).
  - core `4.3.2` / sdk `1.0.0-alpha.4…6`: built-in tools unified on `snake_case` + single-word simplification, `exec_async` → `spawn`, class names aligned (see "Breaking changes").
  - On the CLI side only tool names were synced (docs / test fixtures / prompts); runtime behavior is fully delegated to the SDK, with no other adaptation needed.

### ✅ Tests

- `tsc --noEmit` (`tsconfig.test.json`) reports zero errors; full unit suite **15 files / 235 cases** pass
- Fixed two pre-existing failures in `config-wizard.test.tsx`: terminal size is now injected into the wizard (new optional `terminalSize` prop), removing the interference where `ink-testing-library`'s fake stdout lacked `rows`, so `terminal-size` probed the host machine's row count and stretched the bottom-anchored frame to 38 rows
- Render verification: headings / bold / inline code / lists / quotes / links and fenced code blocks are colored as expected, and plain text has no color (terminal default)

## [1.0.0-alpha.2] - 2026-10-03

### ⚠️ Dependency upgrades

- **`@ai-zen/agents-sdk` raised to `1.0.0-alpha.3`** — picks up the SDK's fix to the parameter description of the built-in tool `generateImage`. The old description said "the image model in the configuration can be viewed via `aiz config show`", which effectively **pointed the model at running a host CLI command**; and **tool descriptions enter every layer of agent context with the `tools` field of each request** — the model therefore ran `exec("aiz config show")`, the CLI parsed that command as **pure stdio mode** and launched **another agent** with `config show` as the prompt, whose tool description carried the same instruction again, forming a **self-referential recursion** (every layer really hit the API, nesting deeper and deeper). The SDK now rewrites the description to "if the specified model does not exist, this tool returns the list of currently available models", which matches `call()`'s actual behavior and no longer steers the model toward running the host CLI. This version has **no breaking changes**, and the CLI source needs no adaptation (types / default config are fully delegated to the SDK, the version banner reads the actually installed version, and the tool list is auto-discovered from the SDK's static registry).

### 📝 Docs

- `docs/zh|en/getting-started.md`: runtime dependency version synced to `@ai-zen/agents-sdk` `1.0.0-alpha.3`
- `docs/manifest.json`: version number synced to `1.0.0-alpha.2`
- The example startup banner version in the Chinese and English READMEs synced to `v1.0.0-alpha.2`

### ✅ Tests

- `tsc --noEmit` (`tsconfig.test.json`) and `npm run build` report zero errors
- Full unit suite: 13 files / 224 cases pass

## [1.0.0-alpha.1] - 2026-09-30

> This release summarizes all changes **relative to the previous release `0.9.0`**.

### 💥 Breaking changes

- **The startup command changes from `aiz` / `zen` to `ai`** — `bin` in `package.json` becomes `{ "ai", "aiz", "zen" }`; `aiz` / `zen` are kept as **transitional aliases** and will be removed in a future version.
- **Dual-mode operation introduced, the two modes never mix** — when positional arguments are present, or stdin/stdout are not a TTY (pipe / redirection / CI), **pure stdio mode** is used: no extra interaction at all, the final assistant text is written to `stdout` as plain text (zero ANSI / emoji prefixes / spinner), while logs, progress, tool activity and error summaries all go to `stderr`, with exit code `0` on success and non-`0` on failure, and nothing written to disk by default; **TUI mode** is entered only when there are **no arguments and both stdin/stdout are TTYs**.
- **The whole interactive UI was rewritten as an Ink (React) full-screen TUI** — replacing the former inquirer line-based conversation; the **main menu is removed** (`/menu` and `src/menus/*`) along with the `inquirer` / `@types/inquirer` / `chalk` dependencies.

### ✨ Added

- **Full-screen TUI (Ink + React)**:
  - animated gradient ASCII splash screen, going straight into the conversation when it ends (auto-resuming the previous session if there is one);
  - the chat area is **bottom-anchored** (separator / input line / status bar fixed at the bottom, with the whole frame always "terminal rows − 1" tall to stay out of Ink's full-screen branch);
  - streaming output (thinking / text / tool calls on separate rows), with history trimmed by line and scrolling from the bottom;
  - **multi-line input** (`Enter` sends, `Ctrl+N` / `Ctrl+J` insert a newline) and **cursor editing** (`←`/`→`/`Home`/`End`/`Backspace`/`Delete`, `Ctrl`/`Meta` + `←`/`→` by word, inverse-video cursor + hardware cursor sync);
  - **in-app paging** (`PgUp`/`PgDn` page, `Shift`/`Alt` + `↑`/`↓` scroll one line, sending jumps back to the bottom);
  - input history, inline `/` command menu, status bar, confirmation dialogs.
- **Syntax highlighting**: tool call arguments highlighted as **JSON**, and **fenced code blocks** in text and thinking highlighted by language. The highlighting **data** is delegated to `highlight.js` (via `lowlight` producing hast), and the CLI only maps `hljs-*` scopes to Ink `<Text>` colors — the same approach as the Ink/React-based Google Gemini CLI.
- **In-conversation commands**: `/help`, `/load`, `/clear`, `/new`, `/save`, `/config`, `/key`, `/migrate`, `/back`, `/editor`, `/exit` (`registry.ts` is the single source of the command list, and `/help` and input autocomplete stay in sync automatically).
- **First-run credential onboarding + configuration center (Ink native)**: when the endpoint has no API key, a credential setup screen is shown first; the `/config` configuration center manages endpoints, models, image models, defaults (default model / image model / Agent / migration model), tool output limits, **MCP servers** (global / project scope) and **Agent definitions** (top-level Agents + sub-agents, with four dimensions of permissions); editing a "factory-managed" entry automatically switches it to `custom: true`, and dangerous operations require a second confirmation and are guarded by reference checks.
- **Multi-line text goes through the system editor**: multi-line fields such as agent prompts and sub-agent function descriptions / parameter schemas open `$EDITOR` on `Enter` (`notepad` by default on Windows); parameter schemas open as `.json` and are validated immediately.
- **Session persistence overhaul: a session is a file + a single pointer** — written to disk at the end of every round, `cli/last-session.json` records the previous round's session id, nothing is written to disk until the first message, and `/save` is idempotent; resume / load rebuilds the history from messages.
- **Extras for pure stdio mode**: `ai --help` / `-h`, `ai --version` / `-v`, `ai --save`; SDK logs and `console.log` are uniformly redirected to `stderr` to keep stdout clean.
- **IME candidate window follows the cursor**: Ink's `useCursor()` syncs the hardware cursor to the editing cursor, so the Chinese IME candidate window is positioned correctly.

### 🔧 Changes

- **Dependencies**: added `ink` / `react` (runtime), `ink-testing-library` / `@types/react` (dev); added syntax highlighting `highlight.js` / `lowlight` (runtime) and `@types/hast` (dev); **removed** `inquirer` / `@types/inquirer` / `chalk`.
- **Upgraded `@ai-zen/agents-sdk`**: `1.0.0-alpha.0` → `1.0.0-alpha.1` → `1.0.0-alpha.2` (factory model catalog refresh, model list hosting, `chrome-devtools` and others added to the default `mcp.json`; zero code changes on the CLI side).
- **TUI output uniformly goes through Ink**: notices such as migration progress and session write failures no longer use `console.log` / `console.warn` to write directly to the terminal (which tears Ink frames) and are rendered as notice blocks via callbacks; the startup logo gradient also uses Ink per-character `<Text color>`.
- **The config wizard / overlays are unified on a "bottom-anchored" layout**, with list items and key hints trimmed to a **strict single line**, fixing content clipping in the VS Code terminal.
- **Terminal state safety and clean exit**: `SIGINT` / `SIGTERM` / uncaught exceptions all uninstall Ink and restore raw mode and the cursor; `Ctrl+C` means "cancel the current round when busy, exit when idle"; exiting explicitly pauses stdin and terminates the process (`farewell()`).
- **Removed the old line-based pipeline (dead code)**: `src/conversation-runner.ts`, `src/slash-hint-prompt.ts`, `src/delta-renderer.ts`, the inquirer-based `src/config-wizard.ts`, `src/draft-*.ts` and so on; added the new implementations `src/mode.ts` / `src/stdio-runner.ts` / `src/session-pointer.ts` / `src/conversation-persist-plugin.ts` / `src/config-editor.ts` and `src/tui/*`.
- Docs: the Chinese and English READMEs and `docs/zh|en/*` synced (run modes, the `ai` command name, the configuration center, the multi-line editor, etc.), and `docs/manifest.json` synced.

### ✅ Tests

- Full unit suite **13 files / 224 cases**, `tsc --noEmit` and `npm run build` report zero errors; e2e **12 cases** really hitting the DeepSeek API (covering both modes, stdio purity, exit codes, `--save` persistence).
- New test files: `mode.test.ts`, `stdio-runner.test.ts`, `theme.test.ts`, `screens.test.tsx`, `tui/config-wizard.test.tsx`, `tui/agent-prompt.test.tsx`, `tui/highlight.test.ts`, `sub-agent-guard-plugin.test.ts`, `auto-migrate-confirm-plugin.test.ts`, `conversation-commands/registry.test.ts`.
- Verified on a real PTY: startup → conversation → streaming → `/load` → `/clear` → exit and hand the shell back; the first-run credential flow; each sub-screen of the configuration center.

## [0.9.0] - 2026-09-30

### 💥 Breaking changes

- **Upgraded `@ai-zen/agents-sdk` to `1.0.0-alpha.0` (Provider → Scope architecture refactor)** — SDK 1.0.0-alpha.0 renames the global entry object `Provider` to `Scope`, spreads the four capability sources into 5 composable `ScopePlugin`s, and removes `Provider.create()` (replaced by explicit assembly). The CLI side adapted `src/agent-creator.ts` accordingly:
  - import `Scope` / `allInOne` instead of `Provider`
  - `Provider.create({ config, agentsDir, subAgentsPaths, skillsPaths, toolsPaths, mcpPaths })` → `new Scope({ config, agentsDir }).use(...allInOne({ subAgentsPaths, skillsPaths, toolsPaths, mcpPaths }))` + `await scope.init()`
  - singleton / factory renames: `getProvider` → `getScope`, `resetProvider` → `resetScope`; `createAgent` now calls `sdkCreateAgent(scope, agentId)` internally
  - the dependency declaration changed from `^0.12.0` to the exact `1.0.0-alpha.0` (pinned during the alpha phase)

### 📝 Docs

- Chinese and English READMEs and `docs/zh|en/{tools,mcp,skills}.md`: `Provider` / `getProvider()` synced to `Scope` / `getScope()`
- `docs/zh|en/getting-started.md`: runtime dependency version synced to `@ai-zen/agents-sdk` `1.0.0-alpha.0`
- `docs/manifest.json`: version number synced to `0.9.0`

### ✅ Tests

- `tsc --noEmit` (`tsconfig.test.json`) and `npm run build` report zero errors
- Full unit suite: 9 files / 74 cases pass
- 6 e2e cases pass (including a real DeepSeek API conversation, verifying the whole CLI → SDK `1.0.0-alpha.0` → API chain)

## [0.8.2] - 2026-09-29

### ⚠️ Dependency upgrades

- **`@ai-zen/agents-sdk` raised to `^0.12.0`** — SDK 0.12.0 adds the built-in tool `inspectFile` (built-in tool classes 19 → 20) and the `range` batched-read parameter of `readFile`, adds the config option `maxToolOutput` (32768 characters by default) with tool output protection behavior, and trims the output of `batchEdit`. This version has **no breaking changes**, and the CLI source needs no adaptation: types and default config are fully delegated to the SDK, `src/version.ts` reads the actually installed version, and the tool list is auto-discovered from the SDK's static registry, so the version banner now shows sdk `0.12.0`

### 📝 Docs

- Synced the built-in tool count 19 → 20: the Chinese and English READMEs, `docs/zh|en/tools.md`, `docs/zh|en/index.md` and `docs/manifest.json`
- Added `inspectFile` (surveying a file's structural overview) to the tool table, and documented the `range` parameter for `readFile`
- `docs/zh|en/tools.md` gained an "output protection" section: when a limit is exceeded, `exec` / `findText` / `glob` / `ls` write to disk and return a warning, while `readFile` / `inspectFile` only warn without writing to disk
- The runtime dependency version in `docs/zh|en/getting-started.md` synced to `@ai-zen/agents-sdk` `^0.12.0`

### ✅ Tests

- Reuses the existing 9 files / 74 cases, all passing; `tsc --noEmit` and `npm run build` (`0.8.2`) both pass

## [0.8.1] - 2026-09-28

### 🚀 New features

- **Skill sub-agents are brought under the sub-agent context guard and streaming rendering** — relying on SDK 0.11.0 unifying `call_skill_sub_agent` under `AgentToolLazy`, skill sub-agents now share the same delegation boundary with regular SubAgents (`onSubAgentStart` / `onSubAgentEnd` hooks and `sub-agent-start` / `sub-agent-end` events). So the `SubAgentGuardInstallerPlugin` and the sub-agent streaming rendering introduced in 0.8.0 **automatically cover** that path, and this time the CLI has no source changes (the note in the 0.8.0 CHANGELOG's "coverage" saying "skill sub-agents are not covered" no longer applies)

### ⚠️ Dependency upgrades

- **`@ai-zen/agents-core` raised to `^4.3.0`, `@ai-zen/agents-sdk` raised to `^0.11.0`** — `src/version.ts` reads the actually installed version, so the version banner now shows core `4.3.0` / sdk `0.11.0`. SDK 0.11.0's breaking change (removal of `createCallSkillSubAgentTool`'s third parameter `provider`) only affects code that calls that factory function directly; the CLI uses it indirectly through `Provider.instantiate` and needs no adaptation

### ✅ Tests

- Reuses the existing 9 files / 74 cases, all passing; `tsc --noEmit` and `npm run build` (`0.8.1`) both pass

## [0.8.0] - 2026-09-28

### 🚀 New features

- **Sub-agent context guard (`SubAgentGuardInstallerPlugin`)** — closes the gap where "the main Agent has a guard while sub-agents have none" (added `src/sub-agent-guard-plugin.ts`):
  - **Background**: SDK sub-agents are built by `AgentTool` / `AgentToolLazy` via `new Agent({...})` at delegation time; a newly built instance carries no plugins (`Agent._plugins` is per-instance and does not propagate to sub-agents), and sub-agents go through `run()` rather than `send()` (`onBeforeSend` / `onAfterSend` never fire) — therefore the `ContextGuardPlugin` and the auto-migration plugin on the main Agent have no effect at all on sub-agents, and a sub-agent's inner loop is unconstrained
  - **Intervention point**: core 4.2.0's `onSubAgentStart` hook is dispatched by the host Agent at the moment "the sub-agent has been built and `run()` has not been called yet", with a payload carrying the sub-agent instance; `use()` merely pushes a plugin into `_plugins`, and the hook dispatch iterates that list live every time, so installing into the sub-agent inside the hook takes effect **for the current `run()` immediately** (no `init()` needed, and `AgentTool` does not call a sub-agent's `init()` either)
  - **Constraint policy**: install the same `ContextGuardPlugin` the main Agent uses onto the sub-agent — the same `maxTokens` (the current model's `maxContextTokens`), likewise without a ratio (keeping the SDK default 1.5), so that "context tokens exceeding `maxTokens` × 1.5 aborts" holds for sub-agents as well; **no round limit and no tool-call-count limit are set** (this is the only constraint)
  - **Interruption semantics are a "soft abort"**: the sub-agent's run ends immediately, the exception is thrown up to the parent Agent through `AgentTool`'s `finally` (which dispatches `onSubAgentEnd`), and since the parent Agent has `allowJsonParseError = true` by default, it is downgraded to a single tool result text (`error while executing tool X: …`) and the parent Agent proceeds to the next round — the money-burning sub-agent is stopped without terminating the user's conversation
  - **Recursive coverage**: the installer installs itself into the sub-agent at delegation time, so further delegation by the sub-agent (grandchild level) is constrained as well (the default SubAgent definition is `subagents: deny`, so that path does not trigger by default and only takes effect when recursion is opened up)
  - **Coverage**: only core's two delegation paths `AgentTool` / `AgentToolLazy` (both dispatch `onSubAgentStart`); the SDK's `call_skill_sub_agent` (skill sub-agents) does not dispatch that hook and is not covered here

### ⚠️ Dependency upgrades

- **`@ai-zen/agents-core` raised to `^4.2.0`, `@ai-zen/agents-sdk` raised to `^0.10.0`** — `src/version.ts` reads the actually installed version, so the version banner now shows core `4.2.0` / sdk `0.10.0`; the `include_manifest` switch of `load_mcp` added in SDK 0.10.0 is a backward-compatible optional parameter (default `true`, behavior byte-for-byte identical to before the upgrade), so the CLI needs no adaptation

### 🔧 Fixes

- **Sub-agent events aligned with core 4.2.0's renames and payload structure** — core 4.2.0 renames the event `sub-agent` to `sub-agent-start` and changes the payload from `{ agent: sub-agent, ctx }` to `SubAgentContext = { agent: main agent, subAgent: sub-agent, toolCallContext }`. `src/conversation-runner.ts` adapted accordingly: event listening and unsubscription now use `sub-agent-start` (listening to the old name no longer fires, which would silently disable sub-agent streaming rendering); the sub-agent instance is now read from the `subAgent` field, and the tool name from `toolCallContext.tool_call.function.name` (previously reading the now-nonexistent `ctx` field threw inside the `sub-agent-end` callback)

### ✅ Tests

- Added `src/sub-agent-guard-plugin.test.ts` (6 cases): the installer's plugin list and "does not reject delegation", immediate effect on the current `run()` after installation (no `init()` needed), pass-through when usage exactly equals the hard limit, pass-through on the first round with no usage data, the threshold following the passed `maxTokens`, and grandchild-level propagation
- `tsc --noEmit` type checking, the full unit suite and `npm run build` pass (74 passed / 9 files)

## [0.7.0] - 2026-09-20

### 🚀 New features

- **Second confirmation for auto-migration** — auto-migration triggered by exceeding the context token limit no longer runs silently; the user is asked to confirm before migrating (added `src/auto-migrate-confirm-plugin.ts`):
  - `AutoMigrateConfirmPlugin` extends the SDK's `AutoMigratePlugin` and **only inserts one confirmation between "threshold exceeded" and "migration invoked"**: threshold checking, migration invocation and error handling still reuse the base class, and the actual migration is still delegated to the shared `migrationService` (the same chain as `/migrate`) — i.e. the SDK-side semantics of "only responsible for triggering" are unchanged, and the confirmation is an increment on the CLI layer
  - The confirmation dialog shows the current usage and the threshold (e.g. `260000/250000 tokens`) and explains the impact (generate a handoff document → save the current conversation → start a new session and continue), and **defaults to "yes"** (Enter migrates, consistent with `/migrate`'s default)
  - Choosing "no" only skips **this** migration and records no implicit state: the current conversation is unaffected (the history is not trimmed), and the user can keep asking or run `/migrate` at any time; when still over the limit, the prompt appears again after the next send, noting that continued growth into severe overflow will be aborted by `ContextGuardPlugin`
  - **No prompt in non-interactive environments**: the confirmation dialog is only shown when both stdin and stdout are TTYs; pipes, redirection and e2e scripts have no confirmation channel, so the existing silent auto-migration behavior is kept (no blocking on input, no extra output, pipe semantics unchanged)
  - The conversation wiring (`src/conversation-runner.ts`) now registers `AutoMigrateConfirmPlugin`, while the other plugins (including the `ContextGuardPlugin` guard position) are unchanged
- **In-conversation command hints** — typing `/` on the chat input line immediately lists the available commands and their descriptions; further input narrows the candidates by prefix, and when nothing matches it shows "no matching command (type /help to see all)":
  - Added `src/slash-hint-prompt.ts`: it extends inquirer's input prompt and overrides `render`, handing the candidate commands to inquirer's `ScreenManager` as the bottom bar (`bottomContent`), so its wrapping, terminal resize, erasing and cursor restoration handling is reused and rendering matches the other prompts
  - **Hints only, submission semantics unchanged**: Enter always submits the input verbatim, and commands are still dispatched by `dispatchCommand` using exact matching on the full name (no prefix completion, no highlighted selection)
  - In non-TTY environments (stdin/stdout redirected, e2e scripts) the hint is simply not rendered and it degrades to a plain input line, with the existing output behavior unchanged
  - Ordinary chat content (not starting with `/`) produces no hint at all
- The main conversation loop now gets its input from `askInput()` in `src/slash-hint-prompt.ts` (`src/conversation-runner.ts` no longer constructs the input prompt directly)

### 🎯 Optimizations

- **The conversation command list is collapsed into a single source** — added `src/conversation-commands/registry.ts`, which declares command names, aliases and descriptions in one place, shared by dispatch (`index.ts`), help (`help.ts`) and input hints:
  - **Aliases are no longer registered twice**: aliases declared by the registry are automatically expanded by `index.ts` into keys of the handler table; if the registry declares a command with no registered handler, an error is raised at startup (fail-fast)
  - `/help` output is now rendered by the registry, with the command column aligned to the longest command string and consistent with the input hint's column width (the command and description texts are unchanged)
  - `getCommandNames()` moved to the registry, and `conversation-commands/index.ts` re-exports it as before, so callers need no changes

### ⚠️ Dependency constraints

- **References the inquirer internal module** `inquirer/lib/prompts/input.js` — inquirer 9 does not export BasePrompt/InputPrompt, so implementing the command-hint bottom bar requires a deep import (inquirer@9's `package.json` has no `exports` field, and ESM deep imports were verified working on Node 26 + inquirer 9.3.8). Type declarations live in `src/typings/inquirer-internals.d.ts`; **when upgrading inquirer's major version, that module path and the `render` behavior must be re-verified**
- **No new runtime dependency**, `pnpm-lock.yaml` unchanged

### ✅ Tests

- Added `src/auto-migrate-confirm-plugin.test.ts` (threshold checks, the confirm and decline branches, non-interactive degradation, TTY detection and the default confirmation text)
- Added `src/slash-hint-prompt.test.ts` (hint text generation + bottom bar rendering, covering the TTY / non-TTY / submitted / error-line branches)
- Added `src/conversation-commands/registry.test.ts` (metadata, alias folding, prefix matching, command dispatch and alias equivalence)
- `tsc` type checking and the full unit suite pass (68 passed / 8 files), and `npm run build` succeeds
- The build output was verified on a real TTY: typing `/` lists all commands, `/b` narrows to `/back`, Enter submits the raw text and the hint line is erased correctly; `/help` output format and column widths are normal

## [0.6.3] - 2026-09-01

### 🔧 Fixes

- **Fixed old messages being neither marked omit nor physically deleted after migration (dependency upgrade)** — upstream `@ai-zen/agents-sdk` 0.9.3 fixes the defect where `createAgent` referenced `definition.messages` directly, causing conversation `append` to pollute the Agent definition template in reverse; that defect had made task migration's `prune`/`omit` strategies ineffective (old messages were not cleaned up, yet breakpoint messages could be injected)
- **Copy the message array when restoring a draft / saved conversation** — `src/agent-creator.ts` changed from a direct reference to `agent.messages = [...messages]`, so later `append` calls do not rewrite the in-memory array of a draft / conversation archive
- **Dependencies upgraded along** — `@ai-zen/agents-sdk` to `0.9.3` (resolved automatically through the caret range)

### ✅ Tests

- `tsc` type checking and the full unit suite pass (37 passed / 5 files)

## [0.6.2] - 2026-08-31

### 🎯 Optimizations

- **Startup version banner enhanced** — added `src/version.ts`, which uniformly reads version numbers from the actually installed packages (rather than the version ranges in the dependency declarations); the main menu version row is expanded from printing only the CLI version to showing the CLI / SDK / Core versions together, e.g. `AI-Zen CLI v0.6.2 · SDK 0.9.2 · Core 4.1.0`
- **Adapted to `@ai-zen/agents-core` 4.1.0 type changes** — upstream changed `AgentNS.Message.id` from optional to **mandatory** (auto-generated on construction). Bare message objects constructed directly in `src/menus/agents.ts` and `src/conversation-commands/back.test.ts` now use `Message`'s built-in factory methods (`Message.System` / `Message.User` / `Message.Assistant`, and `new Message(...)`), letting core generate the message `id` uniformly
- **Dependencies upgraded along** — `@ai-zen/agents-sdk` to `0.9.2`, `@ai-zen/agents-core` to `4.1.0` (resolved automatically through the caret ranges)

### ✅ Tests

- After the dependency upgrade, `tsc` type checking and the full unit suite pass (37 passed / 5 files), and `npm run build` succeeds

## [0.6.1] - 2026-08-28

### 🎯 Optimizations

- **Upgraded `@ai-zen/agents-sdk` to 0.9.0** — the migration service gains a `strategy` switch:
  - **`omit` (default)**: historical messages are marked `omit: true` and kept for auditability, and a "conversation breakpoint" message is appended as the starting point of the new context
  - **`prune` (used by the CLI)**: history is physically removed, keeping only the system prompt + handoff breakpoint (i.e. the previous replacement behavior)
  - CLI `migration-service.ts` explicitly enables `strategy: "prune"`, consistent with the client-side product semantics of "start a new session after migration", with **no difference in external usage**

### ✅ Tests

- After the dependency upgrade the full unit suite passes (37 passed), and `tsc --noEmit` reports zero errors

## [0.6.0] - 2026-08-24

### 💥 Breaking changes

- **Upgraded `@ai-zen/agents-sdk` to 0.8.0** — the task migration capability was refactored inside the SDK (see the SDK CHANGELOG for details):
  - **`TaskMigrationService` becomes an instantiable, self-contained migration service** — the constructor takes only `{ onBeforeMigrate?, onMigrated?, logger? }` (hooks flat, no `hooks` wrapper), and `migrate({ agent })` directly reuses the passed `agent`'s `client`/`model`/`modelConfig` to generate the handoff document, with no Provider and no dedicated migration Agent needed; it exposes a structured `MigrationContext`
  - **`AutoMigratePlugin` narrows to a trigger-only role** — the constructor injects `{ service, maxTokens }`, and it only detects token overflow and delegates to `service.migrate`
  - **The CLI removes `createMigrationAgent`** — the migration Agent construction in `src/agent-creator.ts` that depended on the deleted `TaskMigrationService.createAgentDefinition` is removed; the manual migration command and the auto-migration callback both now use the SDK migration service instance, with hooks flat on the service constructor

### 🚀 New features

- **Manual task migration command `/migrate`** — typing `/migrate` in a conversation triggers task migration at any time, without waiting for the token limit to be exceeded:
  - Migration steps: save the current conversation → generate a handoff document → start a new session (injecting the handoff document as context) → write the new conversation to disk as a draft (`_current.json`)
  - Reuses the SDK's `TaskMigrationService.migrate` together with auto-migration, handling the post-migration save through the `onMigrated` hook
  - Non-destructive: the old conversation is already saved under `conversations/`, so on failure the user can retry or continue the current conversation

### 🎯 Optimizations

- **The migration service is collapsed to a single instance** — the `TaskMigrationService` instance is mounted on `ConversationContext.migrationService`, shared by auto-migration (triggered by `AutoMigratePlugin`) and manual migration (the `/migrate` command) as **the same instance**; pre/post-migration handling (saving the old conversation / starting a new session / writing the draft to disk) is unified into that service's hooks, eliminating the separate `new TaskMigrationService` on both the automatic and the manual side and the duplicated post-processing implementations
- **The migration service is extracted into a standalone module** — added `src/migration-service.ts`, where `createMigrationService(ctx)` builds the migration service instance uniformly (including the pre/post-migration hooks); `saveCurrentConversation` is promoted to the shared `saveConversation` in `conversation-repository.ts`, used by both the migration hooks and error saving

### ✅ Tests

- SDK side: `TaskMigrationService` (including `migrate` / serialization / hook context) and `AutoMigratePlugin` (trigger delegation assertions) all pass (447 passed / 2 skipped)
- CLI side: `pretest` type checking and the full unit suite pass (37 passed), and `npm run build` succeeds

## [0.5.0] - 2026-08-23

### 💥 Breaking changes

- **Upgraded `@ai-zen/agents-core` to 4.0.0 and `@ai-zen/agents-sdk` to 0.7.0** — along with the underlying core refactor (official OpenAI SDK + plugin-based Agent driver layer):
  - **`createModel()` return structure changed** — instead of returning an old `ChatCompletionModel` instance it now returns `{ client, model, modelConfig }` (openai SDK client + model name + model parameters); `createMigrationAgent` destructures it accordingly and passes it to `SdkAgent`'s new constructor signature
  - **`SdkAgent` constructor signature changed** — from `{ ..., model }` (a model object) to `{ client, model, modelConfig }`
  - **The rest of the CLI is fully compatible** — stream events (`open`/`chunk`/`error`/`sub-agent`/`sub-agent-end`), plugins (`AutoMigratePlugin`/`AutoRefreshToolsPlugin`/`ContextGuardPlugin`) and `AgentNS` types (`Delta`/`StreamResponseData`/`Message`) are kept as-is in core 4.0.0 / sdk 0.7.0, and `AgentPlugin`/`SendContext` are re-exported by the sdk, with no breakage

### ✅ Tests

- After the dependency upgrade the full unit suite passes (37 passed / 0 failed), and `tsc --noEmit` reports zero errors

### 🎯 Optimizations

- **`test:all` / `test:e2e` pre-build** — e2e tests run `dist/index.js`, and previously a missing or stale `dist` caused e2e failures (after an upgrade it once reported `AgentContext must have a client` because of a stale `dist`). `npm run build` now runs automatically before e2e, so a clean environment (a fresh CI clone) works out of the box

## [0.4.0] - 2026-08-05

### 🚀 New features

- **Upgraded `@ai-zen/agents-core` to 3.4.0 and `@ai-zen/agents-sdk` to 0.6.0** — the underlying upgrade brings out-of-the-box enhancements:
  - **Abort signal support for built-in tools** — `sleep`/`exec`/`downloadFile`/`generateImage`/`glob`/`findText` and the subAgent system listen to the `abort` signal, so long-running operations can be interrupted promptly when the CLI terminates a conversation, avoiding stranded resources (`exec` can distinguish `aborted` from `timeout` termination reasons)
  - **Tool definition cohesion refactor** — the `Tool` base class is slimmed down (no longer requires passing `type`/`function`), definition and implementation live in the same class, the callback signature changes from `this` injection to explicit `(parsed_args, ctx)` parameters, and the `SdkCallbackTool` constructor becomes an `{env}` container passing through the full `ToolCallContext`
  - **MCP tool signal pass-through** — `call_mcp_tool` / `read_mcp_resource` support interruption
  - The CLI layer does not use the affected APIs directly, so this is a smooth non-breaking upgrade with no functional impact

### ✅ Tests

- After the dependency upgrade the full unit suite passes (37 passed / 0 failed)

## [0.3.5] - 2026-08-13

### 🎯 Optimizations

- **Upgraded `@ai-zen/agents-core` to 3.3.1 and `@ai-zen/agents-sdk` to 0.5.7** — following upstream internal refactors, out of the box, with no CLI code changes:
  - **`innerLoopTasks` split into two set semantics** — Core 3.3.1 adds `innerLoopsTasks` (whole-group task records) and `innerLoopTasks` (tasks active in the current round); `abort()` now only aborts tasks active in the current round and no longer mislabels completed rounds
  - **An Assistant placeholder is appended uniformly at the start of the inner loop** — `send()` / `AgentTool` no longer append the Assistant manually; `run()` handles it uniformly at the start of every inner loop, and multi-round tool calls converge there as well
  - **SDK 0.5.7 upgraded in sync** — depends on core 3.3.1, all 426 tests (including real DeepSeek e2e) pass, fully compatible

## [0.3.4] - 2026-08-14

### 🎯 Optimizations

- **Upgraded `@ai-zen/agents-core` to 3.3.0 and `@ai-zen/agents-sdk` to 0.5.6** — following the upstream unified refactor, out of the box, with no CLI code changes:
  - **`ToolCallContext` runs through "interception decision → execution"** — Core 3.3.0 unifies `FunctionCallContext` into `ToolCallContext`: the `onToolCall` hook and `Tool.exec(ctx)` receive the same instance; the fields `tool_call` (unified shape), `tool` (the matched tool) and `signal` (abort signal) are added, and `toolCall` is renamed to `tool_call`. A `@deprecated FunctionCallContext` compatibility alias is kept, so old code needs no changes
  - **New `onToolCall` interception hook** — provided by both Core 3.3.0 and SDK 0.5.6: before each tool call executes it can **reject** it (returning a string = the rejection reason returned to the LLM as the tool result, the tool does not execute, and the next round continues); on the SDK side `AgentPlugin` supports the hook (multiple plugins are called in registration order, and the first string returned rejects)

## [0.3.3] - 2026-08-05

### 🎯 Optimizations

- **Dependency declarations unified as version ranges** — `@ai-zen/agents-core` and `@ai-zen/agents-sdk` changed from exact versions (`3.2.0` / `0.5.3`) to caret ranges (`^3.2.0` / `^0.5.3`), aligned with the SDK side's `workspace:^` for core (published as `^3.x`). This allows compatible upgrades within each major version and avoids repeatedly editing dependency declarations when upgrading; the resolved versions remain `3.2.0` / `0.5.3` (current latest), with no functional impact

## [0.3.2] - 2026-08-05

### 🚀 New features

- **Wired in the `ContextGuardPlugin` context guard** — registers the `ContextGuardPlugin` provided by SDK 0.5.3 in `conversation-runner.ts`'s plugin assembly (placed before `AutoMigratePlugin`, reusing the same `maxTokens`). Before each inner-loop request it checks usage and, once `maxTokens×1.2` (20% over the threshold) is exceeded, throws `ContextOverflowError` to abort the conversation, preventing sudden overflow (such as reading a huge file) from blowing up the context; it complements the migration plugin's range: normal overflow goes through handoff migration, while severe overflow is aborted directly by the guard with an error

### ✨ Optimizations

- **Fixed the plugin registration comment numbering in `conversation-runner.ts`** — unified consecutive numbering (1 cwdTracker / 2 autoRefreshTools / 3 draftPlugin / 4 contextGuard / 5 autoMigrate), removing the previous duplicate numbering

## [0.3.1] - 2026-08-05

### 🚀 New features

- **Upgraded `@ai-zen/agents-sdk` to 0.5.3** — new SDK capabilities available out of the box:
  - **A default socket-pty MCP config is released on initialization** — SDK `bootstrap()` adds `ensureDefaultMcpConfig()`; on first start the CLI automatically writes a default MCP config containing the `socket-pty` terminal (`npx -y @ai-zen/socket-pty mcp`) to `~/.ai-zen/mcp.json`, idempotently and without overwriting an existing file
  - **`load_mcp` passes through the server description** — enumerates each MCP server's description for the LLM to reference (aligned with `load_skill`)
  - **New `ContextGuardPlugin` context guard** — checks usage before sending a request and, once `maxTokens×1.2` (20% over the threshold) is exceeded, throws `ContextOverflowError` to abort the conversation, preventing a huge file read from letting the context run away; responsibilities are separated from `AutoMigratePlugin` and the ranges complement each other

### 🔧 Fixes

- **The new conversation was not saved as a draft immediately after auto-migration** — `AutoMigratePlugin` migrates in `onAfterSend` (all inner loops have ended, so `DraftPlugin`'s `onInnerLoopEnd` no longer fires), so the new opening message produced after migration replaced `agent.messages` was not written to disk in time, and a user exiting midway lost the post-migration opening. The new messages are now written to the draft (`_current.json`) immediately after migration completes in the `onMigrated` callback, closing the loop together with "the original conversation is saved to `conversations/` first"

### 🎯 Optimizations

- **The MCP config structure is unified on the industry-standard `mcpServers`** — following the SDK (`discoverMcpServers`), the CLI's `McpConfig` top-level field changes from `servers` to `mcpServers`, and the server transport field from `transport` to `type`. This eliminates format drift, fully aligning the CLI management UI (`zen config`) with the mcp.json released by the SDK by default, so the default socket-pty config can be displayed and managed correctly

### ✅ Tests

- Updated the MCP read/write assertions in `config.test.ts` to match the new `mcpServers` structure and `type` field

## [0.3.0] - 2026-08-01

### 💥 Breaking changes

- **Session/draft persistence moved down into the CLI** — SDK 0.5.0 removed the session/draft product layer (`ConversationRepository` / `DraftRepository` / `AutoDraftPlugin`). The CLI builds its own local storage:
  - Added `src/conversation-repository.ts` — `conversationRepository` (reusing the SDK's `EntityRepository`)
  - Added `src/draft-repository.ts` — `DraftRepository` + the `draftRepository` singleton (drafts have no id field, so it is implemented separately)
  - Added `src/draft-plugin.ts` — the CLI draft plugin `DraftPlugin` (replacing the removed `AutoDraftPlugin`, auto-saving in `onInnerLoopEnd`)
- **Updated `@ai-zen/agents-sdk` to 0.5.0** — built-in tools turned into classes (`SdkCallbackTool` + `ToolEnv` injection), `Provider` supports `cwd`/`env`, `generateImage` turned into the `GenerateImageTool` class

### 🎯 Optimizations

- **Dependencies synced to the published versions** — `@ai-zen/agents-core` `3.0.1`, `@ai-zen/agents-sdk` `0.5.0` (a local `link:` was used for debugging during development and has been restored to npm version numbers)

## [0.2.3] - 2026-07-29

### 🎯 Optimizations

- **Updated `@ai-zen/agents-sdk` to 0.4.0** — the load_mcp return value changed to structured JSON (including the full inputSchema), and the logging API changed to the global singleton `getLogger()`/`setLogger()`

## [0.2.2] - 2026-07-27

### 🎯 Optimizations

- **Updated `@ai-zen/agents-sdk` to 0.3.4** — includes the AutoMigratePlugin hook rename (`onHandoff` → `onMigrated`)
- **Fixed the timing of saving the old conversation** — moved from `onMigrated` (formerly `onHandoff`) to `onBeforeMigrate`, ensuring that what is saved is the complete old conversation history

## [0.2.1] - 2026-07-27

### 🎯 Optimizations

- **Updated `@ai-zen/agents-sdk` to 0.3.3** — includes default Agent/SubAgent prompt improvements (information explicitness requirements, contradiction detection)

## [0.2.0] - 2026-07-26

### 💥 Breaking changes

- **Synced to SDK 0.3.2's async API** — `@ai-zen/agents-sdk` from `0.3.1` → `0.3.2`
- **`readConfig()` / `saveConfig()` changed to async** — because the SDK's `ConfigManager` is fully async
- **`createAgent()` restored to async** — because the SDK's `createAgent()` is async again
- **`installHook()` / `uninstallHook()` changed to async** — shell hook install/uninstall uses `fs.promises`

### 🎯 Optimizations

- **Synchronous file IO fully eliminated** — every `existsSync`, `readFileSync`, `writeFileSync`, `readdirSync`, `statSync`, `renameSync`, `appendFileSync`, `mkdirSync` and `unlinkSync` in `config.ts`, `hook.ts`, `conversations.ts` and `config-display.ts` is replaced with the async `fs.promises` API
- **`getConversationsList()` changed to async** — the conversation list is read through async file APIs
- **MCP config read/write made async** — `readMcpConfig()`, `writeMcpConfig()` and `readProjectMcpConfig()` are all async now

### ✅ Tests

- `config.test.ts` updated in sync to `async`/`await`, all 43 tests pass (including 6 E2E)

## [0.1.7] - 2026-07-21

### 🔧 Fixes

- **Updated dependencies**: `@ai-zen/agents-core` → `3.0.0-alpha.4`, `@ai-zen/agents-sdk` → `0.2.7`

## [0.1.6] - 2026-07-20

### 🔧 Fixes

- **Updated `@ai-zen/agents-sdk` to 0.2.6** — includes fixes to the default SubAgent function name and description, so the LLM can now identify sub-agents correctly

## [0.1.5] - 2026-07-20

### 🔧 Fixes

- **Updated `@ai-zen/agents-sdk` to 0.2.5** — includes a fix to default SubAgent permissions, so `general-assistant` can now use tools normally
