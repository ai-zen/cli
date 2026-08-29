---
title: Task Migration
description: Automatic task migration in @ai-zen/cli when the context limit is exceeded, the /migrate manual trigger, and the handoff document structure.
outline: deep
---

# Task Migration

As a conversation's context approaches the model's context-window limit, continuing the conversation causes information to be truncated or requests to fail. **Task migration** generates a **handoff document** that records how far the task has progressed, what remains, and the key decisions, then starts a **new session** with that document as context, achieving seamless continuation.

## Triggering

### Automatic migration

When the API response's `usage.prompt_tokens` exceeds the current model's `maxContextTokens`, the SDK's `AutoMigratePlugin` automatically triggers a migration.

- The threshold is determined by the model config `maxContextTokens` (the README suggests setting it to roughly 25% of the model's actual context window — e.g. 250,000 for a 1M-token model).
- During conversation assembly, `ContextGuardPlugin` acts as a **safety guardrail** placed before the migration plugin: when usage severely exceeds the limit (`> maxTokens × 1.5`) it throws a `ContextOverflowError` to interrupt the conversation, preventing a sudden over-limit (such as reading a very large file) from blowing past the context before migration takes effect.

### Manual migration

You can actively trigger migration at any time during a conversation with `/migrate`, without waiting for the token limit:

```
/migrate
```

The command first confirms (migration will: generate a handoff document → save the current conversation → start a new session to continue), then verifies that the current conversation contains at least one user message (the migration document needs a "conversation breakpoint"), and finally delegates to the shared migration service.

## Migration chain

Automatic and manual migration **reuse the same migration service instance** (`ConversationContext.migrationService`, created by `createMigrationService(ctx)` in `src/migration-service.ts`):

1. **`onBeforeMigrate`**: save the old conversation (at this point `agent.messages` is still the full old history) to `conversations/`. Automatic migration passes `promptTokens`/`maxTokens`; manual migration passes `undefined`.
2. **`onMigrated`**: generate a new name for the new session, immediately persist the migrated opening line as a draft (`_current.json`), and print a completion message.

Migration is **non-destructive**: the old conversation has already been saved in `onBeforeMigrate`, so even if generation fails you can retry or continue the current conversation at any time.

## Migration strategy: prune

The CLI explicitly adopts the SDK's `strategy: "prune"` (physical pruning mode):

- **`omit` (SDK default)**: mark history messages with `omit: true` for auditability, and append a "conversation breakpoint" message as the new context starting point.
- **`prune` (CLI's choice)**: physically prune history, keeping only the system prompt + the handoff breakpoint (i.e. the old "replace behavior"). This is consistent with the product semantics of "start a new session after migration" on the client side, with no observable difference externally.

## Handoff document structure

The migration prompt template includes the following parts:

- **Conversation Breakpoint**: the verbatim content of the last user/AI exchange.
- **Completed Tasks**: task titles and output paths.
- **Pending Tasks**: description, progress, and next steps.
- **Important Notes**: technical preferences, lessons learned, and architecture decisions.
- **File Index**: key files and their descriptions.
- **Handover Instructions**: the SOP for the relay Agent (read files first, verify state, then act).

## Related documentation

- The underlying migration service is provided by `@ai-zen/agents-sdk`'s `TaskMigrationService`; triggering is handled by `AutoMigratePlugin`.
- For other capabilities, see [Built-in Tools](./tools.md), [MCP Support](./mcp.md), and [Skill](./skills.md).
