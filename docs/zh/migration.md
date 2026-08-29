---
title: 任务迁移
description: @ai-zen/cli 在上下文超限时的自动任务迁移，以及 /migrate 手动迁移与交接文档结构。
outline: deep
---

# 任务迁移

当对话的上下文接近模型的上下文窗口上限时，继续对话会导致信息被截断或请求失败。**任务迁移**通过生成一份**交接文档（handoff document）**，把当前任务的完成情况、待办与关键决策固化下来，并以这份文档为上下文开启一个**新会话**，实现无缝续接。

## 触发方式

### 自动迁移

当 API 响应的 `usage.prompt_tokens` 超过当前模型的 `maxContextTokens` 时，SDK 的 `AutoMigratePlugin` 会自动触发迁移。

- 阈值由模型配置项 `maxContextTokens` 决定（README 建议设为模型实际上下文窗口的约 25%，例如 100 万 token 模型设为 250,000）。
- 在对话装配中，`ContextGuardPlugin` 作为**安全护栏**位于迁移插件之前：当用量严重超限（`> maxTokens × 1.5`）时会抛出 `ContextOverflowError` 中断对话，防止读入超大文件等突发超限在迁移生效前撑爆上下文。

### 手动迁移

在对话中随时输入 `/migrate` 即可主动触发迁移，无需等待 token 超限：

```
/migrate
```

命令会先确认（迁移将：生成交接文档 → 保存当前对话 → 开启新会话继续），随后校验当前对话中至少存在一条用户消息（迁移文档需要“对话断点”），再委托给共享的迁移服务。

## 迁移链路

自动迁移与手动迁移**复用同一套迁移服务实例**（`ConversationContext.migrationService`，由 `src/migration-service.ts` 的 `createMigrationService(ctx)` 创建）：

1. **`onBeforeMigrate`**：保存旧对话（此时 `agent.messages` 仍是完整旧历史）到 `conversations/`。自动迁移会带 `promptTokens`/`maxTokens`，手动迁移则为 `undefined`。
2. **`onMigrated`**：为新会话生成新名称，把迁移后的开场白立即落盘为草稿（`_current.json`），并输出完成提示。

迁移**非破坏性**：旧对话在 `onBeforeMigrate` 中已保存，即使生成失败也可随时重试或继续当前对话。

## 迁移策略：prune

CLI 显式采用 SDK 的 `strategy: "prune"`（物理剔除模式）：

- **`omit`（SDK 默认）**：历史消息标记 `omit: true` 保留可审计，追加“对话断点”消息作为新上下文起点。
- **`prune`（CLI 采用）**：物理剔除历史，仅保留系统提示 + 交接断点（即旧的“替换行为”），与端侧“迁移后开启新会话”的产品语义一致，对外使用无差异。

## 交接文档结构

迁移提示模板包含以下部分：

- **对话断点（Conversation Breakpoint）**：最后一条用户/AI 交换的逐字内容。
- **已完成任务（Completed Tasks）**：任务标题与输出路径。
- **待办任务（Pending Tasks）**：描述、进度、下一步。
- **重要说明（Important Notes）**：技术偏好、经验教训、架构决策。
- **文件索引（File Index）**：关键文件及其说明。
- **交接说明（Handover Instructions）**：给继任 Agent 的 SOP（先读文件、核实状态、再行动）。

## 相关文档

- 底层迁移服务由 `@ai-zen/agents-sdk` 的 `TaskMigrationService` 提供；触发由 `AutoMigratePlugin` 承担。
- 其他能力见 [内置工具](./tools.md)、[MCP 支持](./mcp.md)、[Skill 技能](./skills.md)。
