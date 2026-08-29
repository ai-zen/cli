---
title: Skill 技能
description: @ai-zen/cli 的 Skill 目录、目录优先级，以及 load_skill / call_skill_sub_agent 两个动态工具。
outline: deep
---

# Skill 技能

Skill（技能）是可复用的、带 Fronmatter 说明的 Markdown 文档，用于把某一类工作流沉淀成可加载的知识片段。CLI 通过 `@ai-zen/agents-sdk` 发现与加载 Skill，并提供两个动态工具：`load_skill` 与 `call_skill_sub_agent`。

## Skill 目录结构

每个 Skill 是一个目录，内含 `SKILL.md`：

```
~/.ai-zen/skills/my-skill/SKILL.md
```

项目级 Skill 位于项目目录下：

```
/path/to/project/.ai-zen/skills/my-skill/SKILL.md
/path/to/project/.agents/skills/my-skill/SKILL.md
```

## 目录优先级

Skill 目录从多个来源**由高到低**合并（来自 `src/agent-creator.ts` 的 `getProvider()` 与 `src/config.ts` 注释）：

1. 项目 `./.ai-zen/skills/`
2. 项目 `./.agents/skills/`
3. 用户级 `~/.ai-zen/skills/`
4. 用户规范 `~/.agents/skills/`

## 动态工具

- **`load_skill`**：把 Skill 文档加载到上下文中（幂等，重复调用会跳过重复注入）。枚举由 `filteredSkills` 提供完整信息，不限是否支持子 Agent。
- **`call_skill_sub_agent`**：将一个任务委托给 Skill 子 Agent。**仅对 frontmatter 含 `sub-agent: true` 的 Skill 生效**，枚举中自动排除不支持子 Agent 模式的 Skill。

## Skill 子 Agent 与权限

由 `call_skill_sub_agent` 创建的临时 Skill 子 Agent，作为**一次性的对话代理**存在。它是权限体系中的**唯一例外**：

- 普通子 Agent（带 `function` 字段的 Agent）拥有**独立权限**，不与父 Agent 继承。
- Skill 子 Agent 作为临时代理，**继承调用者的权限**，并非独立实体。

## 相关配置

Skill 也可通过 `.ai-zen` / `.agents` 下的 `skills/` 目录按项目共享。CLI 在 `ensureConfigDir()` 中通过 SDK 的 `ConfigManager.bootstrap()` 初始化共享目录。
