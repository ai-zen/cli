---
title: AI-Zen CLI
description: @ai-zen/cli 双模式 AI 终端（纯 stdio 管道 + 交互式 TUI）——内置 20 种文件系统工具，支持 MCP、Skill 技能、子 Agent 编排与任务迁移。
outline: deep
---

# AI-Zen CLI

`@ai-zen/cli` 是一个**双模式** AI Agent 终端，构建在 [`@ai-zen/agents-sdk`](https://www.npmjs.com/package/@ai-zen/agents-sdk) 与 [`@ai-zen/agents-core`](https://www.npmjs.com/package/@ai-zen/agents-core) 之上。无参数且在交互终端下进入 TUI（可多轮对话），带参数或处于管道 / 重定向时走**纯 stdio**（把回答写入 stdout）。内置一整套文件系统工具，并支持 **MCP**、**Skill 技能**、**子 Agent 编排**与**任务迁移**。

## 它能解决什么问题

在纯终端里与 AI 协作时，往往需要手动地在多个外部命令（读写文件、执行命令、搜索、下载、看图/生图……）之间来回切换。AI-Zen CLI 把这些能力封装成一组 **Agent 可直接调用的工具**，让模型在对话中自主完成文件读写、命令执行、目录浏览、文本检索、图片分析与生成等操作；配合 **MCP** 接入外部服务、**Skill** 复用可复用的工作流、**任务迁移**在上下文超限时无损续接对话。

## 主要特性

- **双模式运行**：无参数 + 交互终端进入 TUI；带参数或管道 / 重定向走纯 stdio（结果写 stdout、日志走 stderr，退出码语义明确）。
- **现代交互界面（TUI）**：基于 Ink/React 的全屏界面——动画渐变 ASCII 启动界面、启动即直达对话、底部固定输入区与状态栏、内联 `/` 命令菜单。
- **状态栏 token 用量与速率**：状态栏按**优先级**分成三个信息块 —— 模型 · Agent · 思考强度 ｜ 本轮 / 累计 token 用量 · 生成速率 · 生成状态 ｜ 快捷键提示（垫底，窄屏时最先被移到下一行）；换行以块为单位，放不下就整块顺延到下一行，不会把某块劈成两半。累计口径为 `sumUsage(agent.messages)`，含所有层级的子 Agent；生成速率在生成中为最近 2 秒窗口的实时值（按输出增量估算），一轮结束后换成本轮平均值（优先用真实 `completion_tokens`）。
- **语法高亮**：工具调用参数按 **JSON** 高亮、正文与思考按 **Markdown 源码着色**、围栏代码块按语言高亮并保留围栏标记（高亮数据来自 `highlight.js` / `lowlight`，CLI 仅负责渲染）。
- **命令提示**：对话中键入 `/` 即在输入行下方列出可用命令及说明，继续输入按前缀收敛候选。
- **20 种内置工具**：由 `@ai-zen/agents-sdk` 提供的文件系统与图片处理工具集，详见 [内置工具](./tools.md)。
- **5 种动态加载工具**：`load_skill`、`call_skill_sub_agent`、`load_mcp`、`call_mcp_tool`、`read_mcp_resource`。
- **子 Agent 编排**：带 `function` 字段的 Agent 可作为工具被其他 Agent 调用，支持独立权限体系。
- **Skill 技能**：通过 `SKILL.md` 定义可复用技能，支持按上下文加载与委托给技能子 Agent。
- **MCP 支持**：接入 stdio / HTTP / SSE 传输的 MCP 服务器，多级配置合并。
- **任务交接与迁移**：由原 agent 停手后自己核实状态、把交接文档写进 `.ai-zen/handoffs/`；需要时再清空历史、以该文档开启新会话。超限时交互式弹出执行者选择（自交接 / 独立摘要 / 跳过），`/handoff` 只写文档、`/migrate` 写文档并换会话。
- **会话恢复**：每个会话实时落盘为独立文件，指针记录「上一轮会话 id」，下次启动自动续接。
- **Shell 兜底钩子**：`ai hook install` 可把终端中无法识别的命令转发给 AI 处理。

## 文档导航

- [快速开始](./getting-started.md) — 安装、对话界面、对话命令。
- [内置工具](./tools.md) — 20 种内置工具、动态加载工具与权限模型。
- [MCP 支持](./mcp.md) — MCP 配置、合并优先级、连接与 OAuth 现状。
- [Skill 技能](./skills.md) — Skill 目录、加载与子 Agent 委托。
- [任务交接与迁移](./migration.md) — `/handoff` 与 `/migrate` 的区别、两种执行者、文档落盘位置。
- [配置](./configuration.md) — 配置文件、目录布局、预设端点与模型。

## 许可证

包 `@ai-zen/cli` 以 **MIT** 许可发布（见 `package.json` 的 `license` 字段）。
