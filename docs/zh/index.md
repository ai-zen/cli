---
title: AI-Zen CLI
description: @ai-zen/cli 交互式 AI Agent 终端——内置 19 种文件系统工具，支持 MCP、Skill 技能、子 Agent 编排与任务迁移。
outline: deep
---

# AI-Zen CLI

`@ai-zen/cli` 是一个**交互式 AI Agent 终端**，构建在 [`@ai-zen/agents-sdk`](https://www.npmjs.com/package/@ai-zen/agents-sdk) 与 [`@ai-zen/agents-core`](https://www.npmjs.com/package/@ai-zen/agents-core) 之上。它提供了一个可多轮对话的命令行界面，内置一整套文件系统工具，并支持 **MCP**、**Skill 技能**、**子 Agent 编排**与**任务迁移**。

## 它能解决什么问题

在纯终端里与 AI 协作时，往往需要手动地在多个外部命令（读写文件、执行命令、搜索、下载、看图/生图……）之间来回切换。AI-Zen CLI 把这些能力封装成一组 **Agent 可直接调用的工具**，让模型在对话中自主完成文件读写、命令执行、目录浏览、文本检索、图片分析与生成等操作；配合 **MCP** 接入外部服务、**Skill** 复用可复用的工作流、**任务迁移**在上下文超限时无损续接对话。

## 主要特性

- **交互式主菜单**：继续未完成草稿、开始新对话、继续已保存对话、管理已保存对话、管理 Agents、配置管理。
- **19 种内置工具**：由 `@ai-zen/agents-sdk` 提供的文件系统与图片处理工具集，详见 [内置工具](./tools.md)。
- **5 种动态加载工具**：`load_skill`、`call_skill_sub_agent`、`load_mcp`、`call_mcp_tool`、`read_mcp_resource`。
- **子 Agent 编排**：带 `function` 字段的 Agent 可作为工具被其他 Agent 调用，支持独立权限体系。
- **Skill 技能**：通过 `SKILL.md` 定义可复用技能，支持按上下文加载与委托给技能子 Agent。
- **MCP 支持**：接入 stdio / HTTP / SSE 传输的 MCP 服务器，多级配置合并。
- **任务迁移**：上下文 token 超限时自动生成交接文档并开启新会话；也可随时用 `/migrate` 手动触发。
- **草稿恢复**：异常退出时对话自动保存为草稿，下次启动可一键恢复。
- **Shell 兜底钩子**：`zen hook install` 可把终端中无法识别的命令转发给 AI 处理。

## 文档导航

- [快速开始](./getting-started.md) — 安装、主菜单、对话命令。
- [内置工具](./tools.md) — 19 种内置工具、动态加载工具与权限模型。
- [MCP 支持](./mcp.md) — MCP 配置、合并优先级、连接与 OAuth 现状。
- [Skill 技能](./skills.md) — Skill 目录、加载与子 Agent 委托。
- [任务迁移](./migration.md) — 自动/手动迁移、交接文档结构。
- [配置](./configuration.md) — 配置文件、目录布局、预设端点与模型。

## 许可证

包 `@ai-zen/cli` 以 **MIT** 许可发布（见 `package.json` 的 `license` 字段）。
