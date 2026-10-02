---
title: 快速开始
description: 安装 @ai-zen/cli，进入对话界面，使用对话命令与 Shell 兜底钩子。
outline: deep
---

# 快速开始

## 概述

`@ai-zen/cli` 的可执行入口为 `ai`（过渡别名 `aiz` / `zen`，均指向 `dist/index.js`）。无参数且在交互终端下启动会**直接进入对话界面**（TUI）；带参数或以管道 / 重定向传入则走**纯 stdio 模式**（结果写 stdout、日志走 stderr）。

## 环境要求

- **Node.js**：包以 ESM（`"type": "module"`）发布。`package.json` 未声明 `engines` 字段，实际所需版本以 Node 生态为准（建议使用较新的 LTS）。
- **运行时依赖**（由 `package.json` 声明）：
  - `@ai-zen/agents-core` `^4.3.0`
  - `@ai-zen/agents-sdk` `1.0.0-alpha.0`
  - `@modelcontextprotocol/sdk` `^1.29.0`
  - `dayjs`、`ink`、`react`、`zod`
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

## 运行模式

CLI 有两种**互不混合**的运行模式，由启动参数与终端环境自动判定：

| 模式 | 触发条件 | 面向对象 | 核心行为 |
|------|----------|----------|----------|
| **纯 stdio** | 带参数，**或** stdin/stdout 非 TTY（管道、重定向、CI） | 脚本、管道、shell 兜底钩子 | 无额外交互；把最终回答以纯文本写入 stdout |
| **TUI** | 无参数且 stdin/stdout 均为 TTY | 人类用户 | 交互式对话界面 |

纯 stdio 模式下日志 / 进度 / 错误一律走 **stderr**，stdout 仅含结果（零 ANSI / emoji / spinner），成功退出码 `0`、失败非 `0`，默认**不落盘**（可用 `--save` 保存对话存档）。

## 快速示例

```bash
# TUI：无参数 + 交互终端
ai

# 纯 stdio：参数即提示词，结果写入 stdout
ai 你好，请介绍一下你自己。

# 管道：stdin 作为内容，参数作为指令
cat README.md | ai "用三句话总结"
```

启动后先呈现动画渐变的 ASCII 启动界面，随后**直接进入对话界面**（由 Ink/React 渲染）——若存在「上一轮会话」则自动续接，否则新建对话。对话界面采用**底部固定**布局：分隔线、输入行与状态栏始终贴在终端底部，对话内容在其上方滚动。

对话界面提供流式输出区、多行输入（`Enter` 发送 / `Ctrl+N` 换行 / `← →` 移动光标 / `Ctrl+← →` 跨词）与内联 `/` 命令菜单。

### 首次配置（API Key）

首次启动时若所选模型绑定的端点还没有 API Key，会**先弹出凭据设置屏**引导输入：

```
 ? 首次配置 · 设置 DeepSeek 的 API Key
 端点：DeepSeek · https://api.deepseek.com/v1
 当前：未设置
 DeepSeek 申请地址：https://platform.deepseek.com/api_keys
 保存后立即进入对话（Esc 放弃并退出）。
 ❯ ▏
```

输入后按 `Enter` 保存（写入 `~/.ai-zen/config.json`）并**直接进入对话**；`Tab` 可临时切明文核对，`Esc` 放弃并退出。进入对话后仍可用 `/key` 修改当前端点的 Key、用 `/config` 打开配置中心。

## 对话中的命令

对话中所有命令以 `/` 开头，可用 `/help` 查看。输入 `/` 会在输入行下方实时列出可用命令及说明，继续输入即按前缀收敛候选：

```
💬 你: /b
  /back         撤回消息（可修改后重发）
```

| 命令 | 说明 |
|------|------|
| `/exit` `/quit` | 退出对话（提示是否保存） |
| `/save` | 保存当前对话 |
| `/new` | 重置会话（清空历史，替换为 Agent 定义的初始消息） |
| `/back` | 撤回消息（选中用户消息可修改重发，选中工具结果可继续追问） |
| `/editor` | 用系统编辑器输入长消息 |
| `/clear` | 清屏 |
| `/config` | 打开配置中心（默认模型 / 端点凭据 / 端点地址 / 新建端点） |
| `/key` | 设置当前端点的 API Key（保存后自动重建会话） |
| `/migrate` | 手动触发任务迁移（生成交接文档并开启新会话） |
| `/load` | 加载已保存的对话（替换当前会话） |
| `/help` | 显示帮助 |

> 说明：输入 `/` 会在输入行下方实时列出候选命令（↑↓ 选择、`Tab` 补全、`Enter` 提交/执行）；命令按完整名称匹配，输入未识别的 `/xxx` 会提示“未知命令”。

## Shell 兜底钩子

终端中无法识别的命令可自动转发给 AI 处理：

```bash
# 安装钩子（写入 ~/.zshrc 或 ~/.bashrc）
ai hook install

# 之后随意输入：
> 今天天气怎么样？
# 会被转发给 AI，而不是提示 "command not found"

# 卸载
ai hook uninstall
```

> 钩子仅在 `bash` / `zsh` 下可用（依赖 `process.env.SHELL`），不支持其他 shell。钩子函数体调用 `ai "$@"`（纯 stdio 模式），答案就地写入当前 shell 会话；若安装过旧版 `aiz` 钩子，重新执行 `ai hook install` 会自动升级。

## 配置 API Key

配置以 `~/.ai-zen/config.json`（或 `$AI_ZEN_DIR/config.json`）为**唯一数据源**；TUI 内可直接编辑其中的常用项，无需手改 JSON：

| 场景 | 做法 |
|------|------|
| 首次启动、端点缺 Key | 启动时自动弹出**凭据设置屏**，输入即存盘并进入对话 |
| 修改**当前模型所用端点**的 Key | 对话内 `/key`（保存后自动重建会话，立即生效） |
| 端点 Key / Base URL、默认模型、新建端点 | 对话内 `/config` 打开配置中心 |
| 模型、MCP 服务器等高级项 | 手动编辑 `~/.ai-zen/config.json` |

> 说明：CLI 入口只实现 `hook` 子命令（`ai hook install|uninstall`），**没有 `config` 子命令**；配置编辑在 TUI 内完成。MCP 服务器与模型的增删改仍在 P1 待办（当前手动编辑 `config.json`）。详见 [配置](./configuration.md)。

> 纯 stdio 模式（带参数 / 管道）没有交互通道：端点缺 Key 时会向 stderr 报错并以非 0 退出；请先在 TUI 或直接编辑 `config.json` 完成配置。

## 开发与测试

```bash
pnpm install
pnpm build
pnpm start

# 单元测试
pnpm test

# E2E（需要 .env.local 中的 API Key）
pnpm test:e2e
```

> 参考 `package.json` 的 `scripts`。`test:all` 会依次执行类型检查、单元测试、构建与 E2E。
