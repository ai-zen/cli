---
title: Task Handoff & Migration
description: How @ai-zen/cli writes handoff documents (`/handoff`) and migrates to a new session (`/migrate`), the two handoff executors, and where handoff documents live.
outline: deep
---

# Task Handoff & Migration

As a conversation's context approaches the model's context-window limit, continuing causes truncation or failed requests. Two related but distinct concepts cover this:

| Concept | What it does | Command |
|---|---|---|
| **Handoff** | Stops the current work and writes a handoff document. The session keeps running. | `/handoff` |
| **Migration** | Handoff **plus** clearing history and starting a new session with that document. | `/migrate` |

Migration is therefore "handoff + onboarding": the old agent steps down, the new session picks up from the document.

## Handoff document

Every handoff (manual or automatic) produces one Markdown file:

```
<project>/.ai-zen/handoffs/<YYYYMMDD-HHmmss>-<conversationId first 8 chars>.md
```

- The directory sits inside the project so the document can be reviewed and committed alongside the code.
- The file name is deterministic and contains the originating conversation id, making it easy to trace back.
- The breakpoint message injected into a new session contains **only the path** — the next agent reads it with `read` when it actually needs the details.

### The template lives in a Skill, not in code

The document structure and writing rules are defined by the `handoff` skill:

```
~/.ai-zen/skills/handoff/SKILL.md
```

It is released by the SDK on first bootstrap and synced on later versions:

- Untouched (no `metadata.custom: "true"` in the frontmatter) → overwritten with the latest version, so template improvements reach existing users;
- Marked `custom: "true"` → treated as yours, never overwritten.

You can also drop a project-level `./.ai-zen/skills/handoff/SKILL.md` to override it for one repository (normal skill precedence applies).

The code does **not** carry a second copy of the section list. Its only responsibilities are: read the skill body → inject it → validate that a file was actually written → fall back to a minimal built-in template if the skill is missing.

Sections produced by the default template:

- **💬 对话断点** — the last request/summary exchange.
- **🎯 任务目标** — what the user actually wants (intent and acceptance criteria).
- **📊 当前状态** — branch/commit, uncommitted changes, test status, running processes/ports.
- **✅ 已完成** — each item with its artifact path and how it was verified.
- **📋 未完成** — prioritized, each with the "next smallest action".
- **🧠 关键决策** — rationale, plus dead ends to avoid.
- **⚠️ 约束与偏好** — user rules, project conventions, untouchable parts.
- **📁 文件索引** — path + purpose + whether it changed.
- **🔔 接手第一步** — up to three commands the successor can run immediately.

## Two executors

| Executor | Who writes | Strength | Cost |
|---|---|---|---|
| `self` (**default**) | The **original agent**, in its own session, after stopping | Sees the full context, can verify real state with tools | +1~2 full-context requests (input side) |
| `summary` | A single independent model call over the serialized history | Cheap and deterministic | No tools, no original-session context — lower fidelity |

`self` is the default because fidelity is the whole point of a handoff. `summary` is the escape hatch, and also the **one-way fallback**: if `self` fails (no `write` tool, file missing or too small after one retry, tool/guard error), the service degrades to `summary` and tells you so. The reverse never happens — it would add another full request at the worst possible moment.

### Why `self` is reliable

- **Stopping is code-enforced, not just requested.** During the handoff turn a one-shot `HandoffGuardPlugin` rejects `edit` / `batch_edit` / `rm` / `rename` / `mkdir` / `copy`, and only allows `write` when the target resolves to the handoff file. Rejections are *soft*: the reason is returned to the model as a tool result, so it re-focuses instead of crashing the turn.
- **Boundary**: this cannot stop `exec` (`echo > file` always works). It reduces accidental damage, it is not a sandbox.
- **The guardrail relaxes instead of disappearing.** `ContextGuardPlugin` switches from `maxTokens × 1.5` to `maxTokens × 2` while `service.busy` — a handoff happens exactly when context is fullest, but a fuse is still in place.
- **No recursion.** The handoff turn is itself a `send()`; `AutoMigratePlugin` steps aside while `service.busy`, so "handoff triggers migration triggers handoff" cannot happen.

## Triggering

### Manual

```
/handoff                # write the document only, keep this session
/handoff self           # specify the executor explicitly: this session writes (no prompt)
/handoff summary        # specify the executor explicitly: separate summary
/migrate                # handoff + start a new session (alias: /migration)
/migrate self           # specify the executor explicitly
```

Both `/handoff` and `/migrate` first show the **same three-way "handoff method" picker** (see below) — unless you pass `self` / `summary` right after the command to pick the executor directly (no prompt). `/handoff` keeps the session (non-destructive, rerunnable) and its handoff turn stays in `agent.messages`, so you can keep refining the same file; `/migrate` discards history and opens a new session.

### Automatic (context limit)

When `usage.prompt_tokens` exceeds the model's `tokenThresholds.handoff`, the SDK's `AutoMigratePlugin` triggers a migration. In an interactive terminal the CLI shows the **same three-way picker** as the manual commands:

- **Write in the current session** (`self`, highlighted by default) — the original agent stops, verifies with tools, and writes; highest fidelity;
- **Write via a separate agent** (`summary`) — a single independent generation over the serialized history; faster and cheaper, but does not verify files;
- **Don't hand off** — skip this round (same as `Esc`). History is untouched; the prompt appears again after the next response while usage stays over the threshold.

Non-interactive environments (pipes, redirects, e2e scripts) have no picker: they migrate with the default executor, without blocking and without extra output.

## Migration chain

1. **`onBeforeHandoff`** — progress notice (`正在编写任务交接文档…`).
2. **Handoff turn** — abort in-flight work, run the `self` turn (or the `summary` call), verify the file (`exists` + ≥ 400 bytes, one retry, then degrade).
3. **`onHandoff`** — log the document path; for migration, save the old conversation **now** (it already contains the handoff turn, so the archive is auditable).
4. **`migrate` strategy `prune`** — physically drop history, keeping `definition.messages` + one breakpoint message holding the path.
5. **`onMigrated`** — clear `agent.lastUsage` (otherwise the guardrail would kill the first message of the new session using stale token counts), assign a new conversation id, persist it, update the last-session pointer.

The old conversation is always saved before pruning, so a failed handoff never costs you history: you can retry or keep chatting.

> **The conversation id has exactly one source of truth.** The new id written by `onMigrated` must be visible to the persistence layer immediately (in the CLI, `ChatSession.currentId` proxies `ConversationContext.currentId` instead of holding its own copy). Otherwise the next auto-persist still uses the **old** id and writes the post-`prune` shell (system prompt + breakpoint) **over the old conversation file** — from the user's side, "after the handoff my history was gone and only the handoff doc was left".

## Cost notes

- Each handoff writes the document **once**; the code never re-generates or re-summarizes it.
- The injected breakpoint carries only a path; the cost of `read`-ing it is paid by whoever actually needs it.
- `self` costs roughly one or two extra full-context *inputs* compared with `summary`; the output side is nearly identical (the document plus a ≤40-character confirmation).

## Related

- Implemented in `@ai-zen/agents-sdk`: `HandoffService` (`handoff()` / `migrate()`), `HandoffGuardPlugin`, `AutoMigratePlugin`, `ContextGuardPlugin`; the factory skill lives in `config/factory-skills.ts`.
- For other capabilities, see [Built-in Tools](./tools.md), [MCP Support](./mcp.md) and [Skills](./skills.md).
