---
title: 快速开始
description: 安装 @ai-zen/cli，进入主菜单，使用对话命令与 Shell 兜底钩子。
outline: deep
---

# 快速开始

## 概述

`@ai-zen/cli` 提供两个可执行入口：`aiz` 与 `zen`（均指向 `dist/index.js`）。无参数启动会进入**交互式主菜单**；传入参数则直接以该参数作为初始消息开始对话。

## 环境要求

- **Node.js**：包以 ESM（`"type": "module"`）发布。`package.json` 未声明 `engines` 字段，实际所需版本以 Node 生态为准（建议使用较新的 LTS）。
- **运行时依赖**（由 `package.json` 声明）：
  - `@ai-zen/agents-core` `^4.0.0`
  - `@ai-zen/agents-sdk` `^0.9.0`
  - `@modelcontextprotocol/sdk` `^1.29.0`
  - `chalk`、`dayjs`、`inquirer`、`zod`
- **平台**：底层工具与 Shell 钩子依赖 Unix shell（`bash`/`zsh`）与 `process.env.SHELL`；在 Windows 上 Shell 钩子不可用（`hook` 会报“不支持的 shell”）。

## 安装

### 全局安装

```bash
npm install -g @ai-zen/cli
```

### 从源码构建

```bash
git clone git@github.com:ai-zen/cli.git
cd cli
pnpm install
pnpm build
npm install -g .
```

> 项目使用 `pnpm` 管理依赖，构建命令为 `pnpm build`（即 `tsc`）。

## 快速示例

```bash
# 进入交互式主菜单
zen

# 直接发起对话（参数作为初始消息）
zen 你好，请介绍一下你自己。
```

启动后出现主菜单：

```
🤖 Welcome to AI-Zen CLI

? Select an action:
  ▶️  继续上次未完成的对话   (如有草稿)
  💬  开始新对话
  📂  继续已保存的对话
  📋  管理已保存的对话
  🤖  管理 Agents
  ⚙️   配置管理
  ❌  退出
```

## 对话中的命令

对话中所有命令以 `/` 开头，可用 `/help` 查看：

| 命令 | 说明 |
|------|------|
| `/exit` `/quit` | 退出对话（提示是否保存） |
| `/save` | 保存当前对话 |
| `/new` | 重置会话（清空历史，替换为 Agent 定义的初始消息） |
| `/back` | 撤回消息（选中用户消息可修改重发，选中工具结果可继续追问） |
| `/editor` | 用系统编辑器输入长消息 |
| `/clear` | 清屏 |
| `/migrate` | 手动触发任务迁移（生成交接文档并开启新会话） |
| `/help` | 显示帮助 |

> 说明：当输入未识别的 `/xxx` 命令时会提示：“未知命令: xxx（输入 /help 查看可用命令）”。

## Shell 兜底钩子

终端中无法识别的命令可自动转发给 AI 处理：

```bash
# 安装钩子（写入 ~/.zshrc 或 ~/.bashrc）
zen hook install

# 之后随意输入：
> 今天天气怎么样？
# 会被转发给 AI，而不是提示 "command not found"

# 卸载
zen hook uninstall
```

> 钩子仅在 `bash` / `zsh` 下可用（依赖 `process.env.SHELL`），不支持其他 shell。

## 配置 API Key

首次使用某端点时若未设置 API Key，会弹出交互式输入向导（见 `src/config-wizard.ts`）。你可以在主菜单 → **配置管理** → **设置 API Key** 中手动配置。

> 注意：源码中的一条提示文案引用了 `aiz config set-key` 命令，但当前 CLI 的入口（`src/index.ts`）**并未实现**该子命令——配置应在交互式主菜单中完成。详见 [配置](./configuration.md)。

## 开发与测试

```bash
pnpm install
pnpm build
pnpm start

# 单元测试
pnpm test

# E2E（需要 .env.local 中的 API Key）
pnpm test -- src/__tests__/e2e.test.ts
```

> 参考 `package.json` 的 `scripts`。`test:all` 会依次执行类型检查、单元测试、构建与 E2E。
