---
title: Skill
description: Skill directories, directory priority, and the two dynamic tools load_skill / call_skill_sub_agent in @ai-zen/cli.
outline: deep
---

# Skill

A Skill is a reusable Markdown document with frontmatter that distills a class of workflow into a loadable knowledge fragment. The CLI discovers and loads Skills through `@ai-zen/agents-sdk` and provides two dynamic tools: `load_skill` and `call_skill_sub_agent`.

## Skill directory structure

Each Skill is a directory containing a `SKILL.md`:

```
~/.ai-zen/skills/my-skill/SKILL.md
```

Project-level Skills live under the project directory:

```
/path/to/project/.ai-zen/skills/my-skill/SKILL.md
/path/to/project/.agents/skills/my-skill/SKILL.md
```

## Directory priority

Skill directories are merged from multiple sources **high to low** (from `getProvider()` in `src/agent-creator.ts` and the comments in `src/config.ts`):

1. Project `./.ai-zen/skills/`
2. Project `./.agents/skills/`
3. User-level `~/.ai-zen/skills/`
4. User-convention `~/.agents/skills/`

## Dynamic tools

- **`load_skill`**: load a Skill document into context (idempotent; repeated calls skip re-injection). The enumeration comes from `filteredSkills`, which provides full information regardless of whether the Skill supports a sub-agent.
- **`call_skill_sub_agent`**: delegate a task to a Skill sub-agent. **Only works for Skills whose frontmatter contains `sub-agent: true`**; the enumeration automatically excludes Skills that do not support sub-agent mode.

## Skill sub-agent and permissions

The temporary Skill sub-agent created by `call_skill_sub_agent` exists as a **one-off conversation proxy**. It is the **only exception** in the permission system:

- A normal sub-agent (an Agent with a `function` field) has **independent permissions** and does not inherit from the parent Agent.
- A Skill sub-agent, being a temporary proxy, **inherits the caller's permissions** rather than being an independent entity.

## Related configuration

Skills can also be shared per project via the `skills/` directories under `.ai-zen` / `.agents`. The CLI initializes the shared directories via the SDK's `ConfigManager.bootstrap()` in `ensureConfigDir()`.
