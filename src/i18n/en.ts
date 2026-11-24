/**
 * English entries — the fallback language.
 *
 * 约定与 `zh.ts` 一致（不做复数变体：数量词直接写 `(s)`），文案口径也照 `zh.ts` 文件头：
 * 一个概念一个词（host / workspace / session / agent / model / endpoint / tool /
 * skill / MCP server / reasoning effort）、括号只放事实、命令说明动词开头且尽量短、
 * 状态符号只用 `✖` / `⚠`、不写 markdown。
 */
export const en: Record<string, string> = {
  // ---------- Input row ----------
  "input.placeholder": "Type a message, / commands, @ files…",
  "input.hint.ready": "Enter send · Ctrl+J newline · / commands · PgUp history",
  "input.hint.paused": "Esc resume · Enter send · Ctrl+J newline · PgUp history",
  "input.hint.scrolling": "↕ browsing history · PgUp/PgDn pages · sending jumps back to the bottom",
  "input.hint.initializing": "Initializing…",
  "mention.scanning": "Reading workspace files…",
  "input.pastedImages": "{n} attached · Ctrl+V add more · Esc to clear",

  // ---------- Status bar ----------
  // Four blocks (identity / usage / rate / keys): the identity separators and
  // labels live in these entries so each language defines them once.
  // The two usage numbers are summed by the client from each message's `usage`
  // (the host neither counts nor stores nor reports them); NBSP keeps the number
  // and its unit on one line when the bar wraps.
  "status.busy": "busy",
  "status.idle": "idle",
  "status.inputPaused": "intake off",
  "status.outputPaused": "output off",
  "status.dead": "stopped",
  "status.noModel": "—",
  "status.effort": " · thinking ",
  "status.lastTokens": "this answer\u00a0{n}\u00a0tok",
  "status.totalTokens": "total\u00a0{n}\u00a0tok",
  "status.avgRate": "⚡\u00a0avg\u00a0{rate}",

  // ---------- Reasoning effort ----------
  "effort.off": "off",
  "effort.none": "off",
  "effort.minimal": "minimal",
  "effort.low": "low",
  "effort.medium": "medium",
  "effort.high": "high",
  "effort.xhigh": "xhigh",
  "effort.max": "max",
  "effort.default": "default",
  "effort.custom": "custom",
  "effort.unsupported": "—",

  // ---------- Generation phases (message-area spinner; the six phases live in `src/session-phase.ts`) ----------
  // "Waiting in queue" = your words are still in the inbox; "awaiting first token" = the request is out
  // and not a single character has come back yet.
  "phase.working": "Working…",
  "phase.connecting": "Connecting…",
  "phase.waitingFirstToken": "Awaiting first token…",
  "phase.thinking": "Thinking…",
  "phase.toolCalling": "Calling tool…",
  "phase.toolCallingWith": "Calling {name}…",
  "phase.toolWaiting": "Waiting for the tool…",
  "phase.toolWaitingWith": "Waiting for {name}…",
  "phase.streaming": "Streaming…",
  "phase.handoff": "Handing off…",

  // ---------- Inbox band (the pending lines above the input, `InboxArea`) ----------
  // Prefix for lines the user posted themselves; other sources (`session` …) show their name as-is
  "inbox.pending": "pending",
  // When only the first two lines fit, the last line says how many are left (the hidden count)
  "inbox.more": "{n} more",

  // ---------- Notices ----------
  "notice.reloaded": "Session rebuilt with the new config (messages and context kept)",
  "notice.draftSaved": "Draft saved (Ctrl+S to restore)",
  "notice.draftRestored": "Draft restored",
  "notice.imagePasted": "Image pasted ({n} attached). Enter to send",
  "notice.imagesCleared": "Attached images cleared",
  "notice.textTooLarge":
    "Clipboard text is {size}KB, over the {limit}KB limit, so nothing was pasted. Save long content to a file and reference it with @",
  "notice.clipboardEmpty": "The clipboard is empty",
  "notice.clipboardUnavailable":
    "No clipboard tool found: pbpaste on macOS, wl-paste or xclip on Linux",
  "notice.inputCleared": "Input cleared · press Ctrl+C again to exit",
  "notice.handoffBlocksInput":
    "Handing off, so this message was not sent. Esc aborts the handoff and rolls back to the state before it",
  "notice.handoffAborted": "Handoff aborted, memory rolled back",
  // A sub-agent finished / failed / was stopped (PRD 3.9). {error} is the host's own wording,
  // passed through verbatim; when the host gives no reason the variant without one is used
  "notice.subAgentDone": "Sub-agent {name} finished",
  "notice.subAgentFailed": "Sub-agent {name} failed",
  "notice.subAgentFailedWhy": "Sub-agent {name} failed: {error}",
  "notice.subAgentAborted": "Sub-agent {name} was stopped",
  "notice.startFailed": "Could not start this session: {error}",
  "notice.resumeFailed": "Could not resume this session: {error}",
  "notice.pressCtrlDAgain": "Press Ctrl+D again to exit",
  "notice.languageChanged": "Interface language switched to English",
  "notice.deleteAllHint": "Ctrl+X clears this session's notices; Ctrl+G clears all",
  "notice.cleared": "Notices for this session cleared",
  "notice.deleteAllFailed": "Could not clear the notices: {error}",
  "notice.deleteAllAllTitle":
    "Clear all {n} notices? Global notices belong to no session, so they go too; notices for other sessions that nobody has seen yet go too. This cannot be undone.",
  "notice.deleteAllAllConfirm": "Clear all",
  "notice.deleteAllAllCancel": "Leave them",
  "notice.deleteAllAllDone":
    "Cleared all {n} notices (including global notices and other sessions')",
  "notice.deleteAllAllCancelled": "No notices were cleared",
  "notice.deleteAllAllFailed": "Could not clear all notices: {error}",
  "notice.deleteAllAllListFailed":
    "Could not read the notice list, so nothing was cleared: {error}",
  "notice.imagePickTitle": "Which image should open? The pick goes to your default program",
  "notice.imagePickItem": "Message {message} · image {image}",
  "notice.imagePickEmpty": "No openable image here (only assets can be fetched back)",
  "notice.imageOpened": "Handed to your default program: {path}",
  "notice.imageGone": "That image is gone from the host: {error}",
  "notice.imageTempFailed": "The image came back, but writing the temporary file failed: {error}",
  "notice.imageNoOpener":
    "The image came back, but this machine has no usable open command (tried {command}): the file is at {path}",
  "notice.imageOpenFailed":
    "The system could not open it ({command} exited {code}): the file is at {path}",
  // ---------- Command descriptions (/help & slash menu) ----------
  "cmd.load.desc": "Open a saved session (--all: all workspaces)",
  "cmd.sessions.desc": "List sessions and switch (--all crosses workspaces)",
  "cmd.ws.desc": "Workspace: list, pick, create, delete",
  "cmd.pin.desc": "Pin the current session, or unpin it",
  "cmd.new.desc": "Start a new session",
  "cmd.back.desc": "Retract your last message, then resend",
  "cmd.rename.desc": "Rename this session",
  "cmd.rename.usage": 'Currently "{name}". To rename: /rename <name>',
  "cmd.rename.done": 'Renamed to "{name}"',
  "cmd.editor.desc": "Compose a long message in your editor",
  // `/clear` clears the screen only, `/free` drops the queue only (one command, one job);
  // the old "drops queued messages" half moved to `cmd.free.*`
  "cmd.clear.desc": "Clear the screen (queue: /free)",
  "cmd.free.desc": "Drop queued messages not sent yet",
  "cmd.free.inboxCleared": "Dropped {n} queued message(s)",
  "cmd.config.desc": "Open the configuration center: endpoints, models",
  "cmd.menuNeedsIdle": "unavailable while busy",
  "cmd.needsIdle":
    "{name} needs this session idle: it is still running (switching model or effort mid-batch mixes two providers in one request; revert and handoff are refused by the host)",
  "cmd.model.desc": "Switch model: this session / agent / global",
  "cmd.agent.desc": "Set the default agent (new sessions only)",
  "cmd.reload.desc": "Rediscover tools, skills and MCP servers",
  // `/upgrade`: key names match the command name (`registry.ts`'s `descriptionKey` points at these)
  "cmd.upgrade.desc": "Move the host to the highest release tag",
  "cmd.mcp.desc": "Manage MCP servers: add, remove, edit, toggle",
  "cmd.lang.desc": "Switch interface language",
  "cmd.think.desc": "Switch reasoning effort",
  "cmd.key.desc": "Set the endpoint's API key",
  "cmd.handoff.desc": "Write the handoff document only (no memory swap)",
  "cmd.migrate.desc": "Write the document and swap now (old one archived)",
  "cmd.help.desc": "Show this help",
  // `/kill` removes the agent, the session row and history stay; `/delete` is a hard delete (PRD 1.2 / 4.1)
  "cmd.kill.desc": "Kill this session's agent (history stays)",
  "cmd.delete.desc": "Delete this session: messages and assets go too",
  "cmd.shutdown.desc": "Shut the host down, back to the connect screen",
  "cmd.exit.desc": "Quit the CLI (the host keeps running)",
  "cmd.running": "Running /{name}…",
  /** Catch-all outlet: commands that don't catch themselves report server failures here */
  "cmd.failed": "Command /{name} failed: {error}",

  // ---------- Command interaction text (notices / pickers) ----------
  "common.current": " (current)",
  /** Separator when listing several names (e.g. "Waiting for edit, exec…") */
  "common.listSeparator": ", ",
  "cmd.model.noModels": "No models configured yet — use /config to add endpoints and models",
  // One picker for all three levels: title says which level you edit **and** which one is in effect
  "cmd.model.title": "Switch model · {scope} · {endpoint} (in effect: {level})",
  "cmd.model.endpointTitle": "Choose a provider · {scope} (in effect: {level})",
  "cmd.model.endpointHint": "{count} models",
  "cmd.model.scope.session": "this session",
  "cmd.model.scope.agent": "agent",
  "cmd.model.scope.global": "global",
  "cmd.model.cancelled": "Model switch cancelled",
  "cmd.agent.noAgents": "No agents yet — use /config to create one",
  "cmd.agent.unavailable": " · unavailable",
  "cmd.agent.title": "Pick the primary agent; it also becomes the default",
  "cmd.agent.cancelled": "Agent switch cancelled",
  "cmd.reload.done": "Rediscovered: {refreshed} of {total} capability scopes refreshed",
  "cmd.reload.none":
    "Rediscovered: no capability scopes exist yet; the next one is built from the current config",
  "cmd.reload.doneSome":
    "Rediscovered: {refreshed} of {total} capability scopes refreshed, {failed} failed ({cwds}) and still using the old config",
  "cmd.upgrade.newest":
    "Already on the newest v{version} — no higher release tag, nothing to move to",
  "cmd.upgrade.found": "New version found: v{current} → v{target}",
  /**
   * The one question before calling the host: three facts in one sentence (which version / what the
   * host does / who gets kicked). `{installing}` and `{starting}` are the stage lines from
   * `host-stage.ts` (the same words the local-host download screen uses).
   */
  "cmd.upgrade.confirmTitle":
    "Upgrade the host: v{current} → v{target}. The host first verifies this version is available and records which one to launch next, then exits for the upgrade; the launcher then takes over: {installing}{starting}. Other clients connected to this machine (desktop included) get disconnected too.",
  "cmd.upgrade.confirm": "Upgrade the host",
  "cmd.upgrade.cancel": "Cancel",
  /** Cancelled: nothing was called, the host stays on the same version */
  "cmd.upgrade.cancelled": "No upgrade: the host is still v{current}",
  "cmd.upgrade.tagsFailed":
    "Cannot read {pkg}'s releases (registry unreachable, or no parseable tag) — nothing changed",
  "cmd.upgrade.handoff":
    "Told the host to move to v{version}: it verifies the version is available, records which one to launch next, then exits for the upgrade",
  "cmd.upgrade.rejected":
    "The host did not move to v{version}: {error} (it is still running v{current})",
  /** The host is exiting for the new version: go back to the connect screen carrying this line (same exit as `/shutdown`) */
  "cmd.upgrade.backToConnect":
    "The host is being relaunched as v{version}; reconnect once it is back",
  "cmd.think.followDefault": "Follow the model default",
  // 参数跟着「模型来自哪一级」走：模型是本段会话换的时，参数也写在这一段
  "cmd.think.clearHintSession": "Remove this session's reasoning params",
  // AgentDefinition 级那一项清的是**定义文件**里的思考参数（影响所有用这个 AgentDefinition 的会话）
  "cmd.think.clearHintAgent": "Remove the agent's reasoning params",
  "cmd.think.cancelled": "Reasoning effort change cancelled",
  "cmd.think.unchanged": "Reasoning effort unchanged",
  "cmd.help.title": "Available commands:",
  "cmd.new.started": "Started a new session",
  "cmd.load.none": "No saved sessions yet",
  "cmd.load.titleReplacing": "Pick a session to open (this one keeps running in the background)",
  // `--all`: not limited to the current workspace; each row's hint says which workspace it belongs to
  "cmd.load.titleAll":
    "Pick a session to open · all workspaces (this one keeps running in the background)",
  "cmd.load.hintAll": "workspace {workspace} · {id}",
  "cmd.load.cancelled": "Open cancelled",
  "cmd.sessions.title": "Sessions (pick one; whatever is running keeps running)",
  "cmd.sessions.onlyOne": "This workspace has only this session — nothing else to switch to",
  "cmd.sessions.cancelled": "Switch cancelled",
  "cmd.sessions.already": "Already on this session",
  "cmd.sessions.idle": "idle",
  "cmd.sessions.working": "working",
  "cmd.sessions.dead": "no agent (a message brings it back)",
  "cmd.sessions.inboxPending": "{n} pending",
  "cmd.sessions.pinned": "pinned",
  "cmd.sessions.model": "model {id}",
  "cmd.sessions.noModel": "no usable model",
  "cmd.sessions.updated": "updated {time}",
  "cmd.sessions.workspace": "project {name}",
  "cmd.sessions.none": "No sessions in this workspace yet — start one with /new",
  "cmd.sessions.noneAll": "This host has no sessions yet — start one with /new",
  "cmd.ws.title": "Switch workspace (new sessions open there)",
  "cmd.ws.cancelled": "Workspace switch cancelled",
  "cmd.ws.switched":
    'Switched to workspace "{name}" ({path}) · this session stays put; new sessions open there',
  "cmd.ws.none": "The host has no workspaces yet",
  "cmd.ws.newHintLocal": "Use /ws new to register the current directory as a workspace",
  "cmd.ws.newHintRemote":
    "Use /ws new <absolute path on the host> to create one (that directory is on the host machine)",
  "cmd.ws.newNeedsPath":
    "A remote host needs an absolute path: /ws new <path> (the directory is on the host machine, so it cannot be guessed here)",
  "cmd.ws.createFailed": "Could not create the workspace: {error}",
  "cmd.ws.unknownArg":
    "Unknown argument: {arg} (usage: /ws, or /ws new [absolute path], or /ws delete <name or id>)",
  // Deleting a workspace: its sessions go with it (PRD 1.5) and the directory itself is never touched.
  // Both facts have to be said out loud, or the user will read "/ws delete" as "delete that directory".
  "cmd.ws.deleteUsage": "Usage: /ws delete <name or id> (/ws lists the ones that exist)",
  "cmd.ws.deleteUnknown":
    'No workspace called "{arg}": /ws lists the ones that exist, and both name and id work',
  "cmd.ws.deleteTitle":
    'Delete workspace "{name}"? Its {sessions} sessions go too (messages and assets are gone for good), and not one byte of {path} is touched',
  "cmd.ws.deleteConfirm": "Delete this workspace",
  "cmd.ws.deleteCancel": "Cancel",
  "cmd.ws.deleteCancelled": "Nothing deleted: this workspace is still here",
  /** The number shown comes from the host's receipt (counted before it deleted) */
  "cmd.ws.deleteDone":
    'Deleted workspace "{name}": its {sessions} sessions are gone, and not one byte of {path} was touched',
  "cmd.ws.deleteFailed": "Could not delete the workspace: {error}",
  "cmd.ws.deleteNoSessionLeft": "No other session on this host — start one with /new",
  "cmd.handoff.empty": "This session has nothing to hand off",
  // The three-way picker: the title says what is being asked (who writes it), not whether to hand off
  "cmd.handoff.title": "Handoff · pick who writes the document",
  "cmd.handoff.cancelled": "Handoff cancelled",
  "cmd.handoff.skipped": "Skipped this handoff",
  "cmd.migrate.empty": "This session has nothing to migrate",
  "cmd.migrate.cancelled": "Migration cancelled",
  "cmd.back.empty": "No messages to retract",
  "cmd.back.title": "Pick the message to retract (everything after it is deleted)",
  "cmd.back.cancelled": "Retract cancelled",
  // The two facts after a retract: how many messages went, and that the text is back in the input
  "cmd.back.done": "Retracted: {n} messages deleted, and your message is back in the input box",
  "cmd.pin.unknown": "Unknown argument: {value} (use on / off, or no argument to toggle)",
  "cmd.pin.done": 'Pinned "{name}"',
  "cmd.pin.undone": 'Unpinned "{name}"',
  "cmd.shutdown.title":
    "Shut the host down? Other clients on this machine (desktop included) get disconnected too",
  "cmd.shutdown.confirm": "Shut down, disconnecting other clients",
  "cmd.shutdown.cancel": "Cancel",
  "cmd.shutdown.cancelled": "Host shutdown cancelled",
  // Killing the executor: show the cost (queued entries are voided) first; the session and its history stay
  // (PRD 1.2 "only three ways to die", 4.1 "interrupt is not kill")
  "cmd.kill.title":
    'Kill "{name}"? {pending} entries still waiting in the inbox get voided and the in-flight request is cut; this session and its history stay — only the agent is gone, and the next message brings it back.',
  "cmd.kill.confirm": "Kill this session's agent",
  "cmd.kill.cancel": "Cancel",
  "cmd.kill.cancelled": "Not killed: this session and its agent are both still here",
  /** Nothing changes on screen and no history is cleared: only "there is no agent now" gets said */
  "cmd.kill.done":
    'Killed "{name}": the agent is gone and the inbox is cleared; this session and its history stay, and the next message brings it back',
  "cmd.kill.failed": "Could not kill it: {error}",
  /** Already dead: the host's kill is a no-op, so no "{n} voided" claim — point at the command that does clear the inbox */
  "cmd.kill.alreadyDead":
    '"{name}" has no agent right now (already dead): nothing to kill; use /free to clear what is waiting in the inbox',
  "cmd.kill.unknown":
    'No session called "{arg}": /sessions lists the ones in this workspace — a name or an ID prefix both work',
  "cmd.kill.ambiguous": '"{arg}" matches {n} sessions — write more of the ID prefix: {ids}',
  // Deleting a session: show what it costs (two numbers) first. A hard delete — its notices go too (the host does that with a foreign key)
  "cmd.delete.title":
    'Delete "{name}"? This session has {messages} messages and references {assets} assets — none of it comes back, and its notices go too.',
  "cmd.delete.confirm": "Delete this session",
  "cmd.delete.cancel": "Cancel",
  "cmd.delete.cancelled": "Nothing deleted: this session is still here",
  /** The two numbers come from the host's receipt (counted before it deleted) */
  "cmd.delete.done": "Deleted this session: {messages} messages and {assets} assets are gone",
  "cmd.delete.failed": "Could not delete the session: {error}",
  /** After the delete this screen moves to the newest session left in the same workspace (the old screen's notice bar unmounts, so both lines travel together) */
  "cmd.delete.switched": 'Switched to "{name}"',
  "cmd.delete.noOtherSession": "No other session in this workspace — start one with /new",
  "cmd.shutdown.done":
    "The host is shut down and every connection on this machine dropped · back to the connect screen: start one again or connect elsewhere",
  "cmd.model.unknown": "Unknown model: {id} (available: {options})",
  "cmd.model.already": 'Already on the "{scope}" model: {id}',
  "cmd.model.done": 'Switched the "{scope}" model to {name} ({id})',
  "cmd.model.failed": "Model switch failed: {error}",
  "cmd.model.keyMissing": "{endpoint} has no API key yet — set it before switching",
  "cmd.model.keyCancelled": "Did not switch to {model}: {endpoint} has no API key",
  "cmd.agent.unknown": "Unknown agent: {id} (available: {options})",
  "cmd.agent.unavailableReason": 'Agent "{name}" is unavailable: {reason}',
  "cmd.agent.alreadyOn": "{summary} (this session already uses that agent)",
  "cmd.agent.failed": "Agent switch failed: {error}",
  // The parser accepts user / workspace, the u / w shorthands, and the old global / project (`mcp-command.ts`)
  "cmd.mcp.unknownScope":
    "Unknown scope: {scope} (use user / workspace; the old global / project still work; or no argument)",
  "cmd.lang.unknown": "Unknown language: {lang} (use zh / en, or no argument)",
  "cmd.reload.failed": "Reload failed: {error}",
  "cmd.think.notAdjustable": "Model {id} has no usable reasoning levels, so it cannot be adjusted",
  "cmd.think.unknown": "Unknown effort: {level} (available: {options} / default)",
  // One title per level: `/think` and `/think -a` look identical otherwise, and the title is the only place that says which level is being edited
  "cmd.think.titleSession": "Reasoning effort · this session (current: {level})",
  "cmd.think.titleAgent":
    "Reasoning effort · this agent, affects sessions started later (current: {level})",
  "cmd.think.failed": "Reasoning effort change failed: {error}",
  "cmd.handoff.unknownMode": "Unknown handoff mode: {who} (use self / summary)",
  "cmd.handoff.started":
    "Writing the document: the host will tell you where it landed; this session's memory and agent stay as they are",
  "cmd.handoff.failed": "Could not write the handoff document: {error}",
  "cmd.migrate.started":
    "Handoff started: when the document is written this session's memory is swapped and the old memory becomes an archived session (same id, same screen)",
  "cmd.migrate.failed": "Migration failed: {error}",
  "cmd.editor.failed": "Could not open the editor: {error}",
  "cmd.unknown": "Unknown command: {cmd} (type /help to see them all)",

  // ---------- Handoff picker / sub-task notices / welcome block / message placeholders ----------
  // The executor picker: the summary option has to say that it spins up a throwaway executor —
  // the difference between the two is who writes it, not how well it is written
  "handoff.modeSelf": "This session writes its own handoff",
  "handoff.modeSelfHint": "Accurate · checks the real state",
  "handoff.modeSummary": "A throwaway executor writes the handoff",
  "handoff.modeSummaryHint": "Fast and cheap · skips checking files",
  "handoff.modeSkip": "No handoff",
  "handoff.modeSkipHint": "Skip this one",
  "agentTabs.main": "MAIN",
  "chat.configReadFailed": "Could not read the config: {error}",
  "chat.modelNoEndpoint": "Model {id} has no usable endpoint bound — check the config with /config",
  "chat.configUpdated": "Config updated: {line}",
  "chat.configUpdatedMulti": "Config updated:\n{lines}",
  "chat.sessionReloadFailed": "Could not rebuild the session: {error}",
  "chat.subAgentMessagesFailed": "Could not read that sub-agent's messages: {error}",
  "chat.bootFailed": "✖ Cannot start the session: {error}",
  // Somebody else (another terminal / the desktop app) deleted the session this screen is showing:
  // say so, then move to the newest session left in the same workspace
  "chat.sessionRemoved": "This session was deleted elsewhere",
  "chat.bootHint":
    "Press k to open the configuration center (set the API key and endpoint URL) · Enter to go back",
  "welcome.tagline": "The AI collaboration desk in your terminal",
  "msg.imageAssetHeader":
    "[image {n}] the asset lives in the host; not expanded in the terminal (Ctrl+O opens it)",
  "msg.imageInlineHeader": "[image {n}] inlined in the message; not expanded in the terminal",
  "msg.imageUrlHeader": "[Image: {url}]",
  "msg.imageSize": "Size: {width} × {height}",
  "msg.imageSizeUnknown": "Size: unknown",
  "msg.imageName": "File name: {name}",
  "msg.imageSizeUnknownValue": "unknown size",
  "msg.file": "[File: {name}]",
  "msg.inlineFile": "inline file",
  "msg.userHeader": "❯ You",
  "msg.aiHeader": "✦ AI",

  // ---------- Summaries / errors returned by business modules ----------
  "effort.followDefault": "follow the model default",
  "effort.quoted": '"{label}"',
  "effort.summary": 'Reasoning effort set to {label} · written to agent "{id}" (model {model})',
  // 会话级那条路写的是会话存档（不碰 AgentDefinition），所以文案不提 AgentDefinition
  "effort.summarySession":
    "Reasoning effort set to {label} · written to this session (model {model})",
  "modelSwitch.resetHint": " · reasoning effort reset to the model default",
  "modelSwitch.summary": 'Switched model: {name} ({id}) · written to agent "{agent}"{hint}',
  "agentSwitch.err.agentMissing": 'Agent "{id}" does not exist',
  "agentSwitch.summary": "Switched the primary agent: {name} ({id}) · model {model} ({modelId})",

  // ---------- Entry / exit ----------
  "app.goodbye": "\nBye 👋\n",
  "app.noAgents": "No usable agent — create one in the configuration center first",
  "app.bootFailed": "✖ Cannot start the session: {error}",
  "app.unexpected": "✖ Unexpected error: {error}",
  "app.modelSwitchFailed": "✖ This session could not switch to the chosen model: {error}",

  // ---------- Connection screen (first run / unreachable) ----------
  "connect.title": "Connect to a host",
  "connect.firstRunHint": "First run: pick a host — this machine or a remote one",
  "connect.local": "This machine",
  "connect.localHint": "Start a host on this computer (downloaded first if needed)",
  "connect.remote": "Remote",
  "connect.remoteHint": "Enter an address and token",
  "connect.retry": "Retry",
  "connect.exit": "Quit",
  "connect.exitHint": "Don't connect now",
  "connect.keys": "↑↓ select · Enter confirm · Esc quit",
  "connect.connecting": "Connecting…",
  "connect.addressTitle": "Host address",
  "connect.addressHelp": "e.g. wss://example.com/ai-zen or 10.0.0.5:8790 (no scheme means ws://)",
  "connect.tokenTitle": "Access token",
  "connect.tokenHelp":
    "Leave empty to use this machine's host token (generated when the host starts)",
  "connect.continue": "Continue",
  "connect.back": "Back",
  "connect.connect": "Connect",

  // ---------- Workspace screen (remote host with no remembered workspace; PRD D30) ----------
  "ws.folderMissing": " (folder is gone)",
  "ws.title": "Pick a workspace",
  "ws.hint":
    "The host runs on another machine: both the list below and the path you type are on that machine",
  "ws.newLabel": "New workspace…",
  "ws.loading": "Reading workspaces…",
  "ws.pathTitle": "Workspace directory (absolute path on the host)",
  "ws.pathHelp": "e.g. /srv/repos/api — this path is on the host machine, not on this one",
  "ws.pathEmpty": "Enter an absolute path on the host",
  "ws.pathSubmit": "Use this directory",
  "ws.exit": "Quit",
  "ws.keys": "↑↓ select · Enter confirm · Esc quit",

  // ---------- Download screen (starting the local host; PRD D31) ----------
  //
  // Indeterminate on purpose: it reports the step, never a percentage (npm's output is not parsed)
  "download.title": "Preparing the local host",
  "download.stage.resolving": "Looking up the version to download…",
  "download.stage.installing": "Downloading and installing the host (slow the first time)…",
  "download.stage.starting": "Starting the host…",
  "download.cancelled": "Cancelled: the local host was not started",
  "download.keysRunning": "Esc / Ctrl+C to cancel and connect to a remote host instead",
  "download.keysFailed": "R to retry · Esc to go back and use a remote host",

  // ---------- `ai --help` (printed outside the TUI, hence the locale init in the help branch) ----------
  "cli.help.title": "ai — AI-Zen CLI v{version}",
  "cli.help.usage":
    '\nUsage:\n  ai                              Start the interactive UI (TUI; stdin/stdout must be a TTY)\n  ai <prompt>                     Ask in pure stdio mode; the result goes to stdout\n  cat file | ai "summarize it"   Pipe content in; the argument is the instruction\n  ai hook install                 Install the shell fallback hook (route unknown commands to the AI)\n  ai hook uninstall               Uninstall the shell fallback hook',
  "cli.help.options":
    "\nOptions:\n  --save                          Save this session to the archive (off by default)\n  --tui [prompt…]                 Force the interactive UI; the prompt is auto-sent as the first message (used by the shell hook)\n  --new                           Start a new session instead of resuming the last one\n  --server <url>                  Talk to this host instead of the local one (e.g. wss://example.com/ai-zen; AI_ZEN_SERVER_URL does the same)\n  -h, --help                      Show this help\n  -v, --version                   Show the version\n  --server-status                 Print the resident host status (JSON; exit code 1 when not running)",
  "cli.help.notes":
    "\nNotes:\n  stdio mode is non-interactive: the result goes to stdout, logs to stderr, exit code 0 on success.\n  A remote token goes in AI_ZEN_SERVER_TOKEN, never on the command line (argv shows up in ps and shell history).",

  // ---------- `ai hook install / uninstall` (outside the TUI, locale initialised in that branch) ----------
  "cli.hookUsage": "Usage: ai hook install|uninstall",
  "cli.hookUnknownAction": "Unknown subcommand: {action}",
  "hook.unsupportedShell": "✖ Unsupported shell (bash / zsh only)",
  "hook.alreadyInstalled": "ai hook is already installed — nothing to do",
  "hook.installed": "ai hook installed into {file}",
  "hook.updated": "ai hook updated to the latest version ({file})",
  "hook.restartHint": "    Restart the terminal or run source {file} to take effect",
  "hook.forwardHint": "    Unknown commands will then be forwarded to the AI",
  "hook.notInstalledNoFile": "ai hook is not installed (the file does not exist)",
  "hook.notInstalled": "ai hook is not installed",
  "hook.uninstalled": "ai hook removed from {file}",
};
