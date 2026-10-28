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
  - `@ai-zen/agents-core` `^4.5.2`
  - `@ai-zen/agents-sdk` `1.0.0-alpha.18`
  - `@modelcontextprotocol/sdk` `^1.29.0`
  - `dayjs`、`ink`、`react`、`zod`、`highlight.js`、`lowlight`
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
| **纯 stdio** | 带参数，**或** stdin/stdout 非 TTY（管道、重定向、CI） | 脚本、管道 | 无额外交互；把最终回答以纯文本写入 stdout |
| **TUI** | 无参数且 stdin/stdout 均为 TTY；或 `--tui` | 人类用户、shell 兜底钩子 | 交互式对话界面 |

纯 stdio 模式下日志 / 进度 / 错误一律走 **stderr**，stdout 仅含结果（零 ANSI / emoji / spinner），成功退出码 `0`、失败非 `0`，默认**不落盘**（可用 `--save` 保存对话存档）。

另有两个修饰选项：`--tui` 强制进交互界面（参数作为首条消息自动发送；非 TTY 时直接报错退出，不降级成管道）；`--new` 进界面时**开新会话**，不续接该目录的上一轮对话（只对 TUI 生效，stdio 路径上忽略——一次 stdio 调用本就是一次性会话）。

## 快速示例

```bash
# TUI：无参数 + 交互终端
ai

# 纯 stdio：参数即提示词，结果写入 stdout
ai 你好，请介绍一下你自己。

# 管道：stdin 作为内容，参数作为指令
cat README.md | ai "用三句话总结"
```

启动后先呈现动画渐变的 ASCII 启动界面，随后**直接进入对话界面**（由 Ink/React 渲染）——若存在「上一轮会话」则自动续接，否则新建对话。对话界面采用**底部固定**布局：分隔线、输入行与状态栏始终贴在终端底部，对话内容在其上方滚动；生成中时输入行位置换成**分阶段进度**（连接中 → 排队中 → 思考中 → 调用工具 → 等待工具返回 → 输出中）。

若本轮派生了子 Agent，消息列表下方会出现一条**主子 Agent 栏目**（`主AGENT　◈子AGENT1　◈子AGENT2`）：`←` / `→` 切换即换消息列表的数据源，圆点表示执行状态（运行中蓝点闪烁 / 完成绿 / 失败红），本轮内循环结束时栏目自动收起。

对话界面提供流式输出区、多行输入（`Enter` 发送 / `Ctrl+N` 换行 / `← →` 移动光标 / `Ctrl+← →` 跨词 / `Ctrl+W`、`Alt+Backspace` 删前一个词 / `Alt+D`、`Ctrl+Delete` 删后一个词 / `Ctrl+K` 删到行尾 / `Ctrl+U` 删到行首 / `Esc` 清空 / `PgUp`、`PgDn`（或 `Alt+V`、`Ctrl+V`）翻页 / 鼠标滚轮按行滚动）与内联 `/` 命令菜单；工具调用以 `⚙ 名称(参数)` 展示并带 **JSON 高亮**，正文与思考按 **Markdown 源码着色**（标题 / 粗体 / 斜体 / 行内代码 / 列表 / 引用 / 链接），围栏代码块按语言高亮并**保留围栏标记**。

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
| `/exit` `/quit` | 退出对话（提示保存） |
| `/save` | 保存对话 |
| `/new` | 重置会话（清空历史） |
| `/back` | 撤回上一条（可修改重发） |
| `/editor` | 用外部编辑器写长消息 |
| `/clear` | 清屏 |
| `/config` | 打开配置中心（模型 / 端点） |
| `/model` | 切换模型（写入配置） |
| `/agent` | 切换主 Agent（重建会话） |
| `/reload` | 刷新运行环境（重新发现工具 / MCP） |
| `/mcp` | 管理 MCP 服务器（增删改 / 启停） |
| `/lang` | 切换界面语言 |
| `/think` `/effort` | 切换思考强度 |
| `/key` | 设置端点 API Key |
| `/migrate` | 交接并开启新会话 |
| `/load` | 加载对话（替换当前会话） |
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

> 钩子仅在 `bash` / `zsh` 下可用（依赖 `process.env.SHELL`），不支持其他 shell。钩子函数体调用 `ai --tui --new "$@"`：**进交互界面**，把敲错的命令作为首条消息**自动发给模型**，并且**总是开新会话**（不往该目录原有的长对话里追加）。已装过旧钩子的，重新执行 `ai hook install` 会自动升级到最新函数体（比较已安装块与当前版本，不一致就原地覆盖）。

## 配置 API Key

配置以 `~/.ai-zen/config.json`（或 `$AI_ZEN_DIR/config.json`）为**唯一数据源**；TUI 内可直接编辑其中的常用项，无需手改 JSON：

| 场景 | 做法 |
|------|------|
| 首次启动、端点缺 Key | 启动时自动弹出**凭据设置屏**，输入即存盘并进入对话 |
| 修改**当前模型所用端点**的 Key | 对话内 `/key`（保存后自动重建会话，立即生效） |
| 端点 Key / Base URL、默认模型、新建端点 | 对话内 `/config` →「端点管理」 |
| 当前会话所用模型 | 对话内 `/model`（写入该 Agent 的 `modelId`） |
| 思考强度（reasoning effort） | 对话内 `/think`（写入当前 Agent 定义的 `reasoningEffort`；可选档位来自 `~/.ai-zen/reasoning-presets.json` 里该模型引用的策略，可自行增删策略） |
| 模型 / 图片模型 / MCP 服务器 / Agent 定义 / 默认项 / 工具上限 | 对话内 `/config` → 配置中心 |

> 说明：CLI 入口只实现 `hook` 子命令（`ai hook install|uninstall`），**没有 `config` 子命令**；配置编辑在 TUI 内完成（端点、模型、图片模型、MCP 服务器、Agent 定义、默认项与工具上限均已可在 `/config` 内增删改）。详见 [配置](./configuration.md)。

> 纯 stdio 模式（带参数 / 管道）没有交互通道：端点缺 Key 时会向 stderr 报错并以非 0 退出；请先在 TUI 或直接编辑 `config.json` 完成配置。

## 思考策略表（reasoning-presets.json）

`~/.ai-zen/reasoning-presets.json` 与 `config.json` 同级，记录「档位名 → 请求参数补丁」。两家端点对 `thinking` / `reasoning_effort` 的要求不一样，这些差异全部关在这张表里。

表由 SDK 提供（**CLI 与桌面端共享同一份档位知识**，不该各写一遍），但 SDK **不用它生成请求参数**——它只在你选档位的那一刻被 CLI 用来：
1. 决定 `/think` 能列哪几档；
2. 把选中档位的**参数补丁写进 Agent 定义**（`modelParams`）。

出厂三张表：

| 策略 | 档位 | 能否关思考 |
|------|------|-----------|
| `openai` | `minimal` / `low` / `medium` / `high` / `off` | 能（`reasoning_effort: "none"`） |
| `zhipu-5.3` | `low` / `high` / `max` | **不能**（表里没有 `off`，官方也不支持） |
| `deepseek` | `low` / `high` / `max` / `off` | 能（`thinking.type: "disabled"`） |

想接一个新端点，照抄一张表改个名，再在 `/config` →「模型」→「思考策略」里填这个名字，`/think` 立刻就能列出该表的档位：

```json
{
  "my-endpoint": {
    "levels": {
      "fast": { "reasoning_effort": "low" },
      "deep": { "reasoning_effort": "high" }
    }
  }
}
```

- 表里的键就是菜单里的档位，**没有**单独的「能否关闭」开关；
- 给某张表加 `"custom": true` 表示「这张表我接管了」，升级时不再覆盖它（其余策略仍会同步）；
- 自定义的档位名在状态栏直接显示原名（`fast` / `deep`），不会变成空白。

> **配置即事实**：`/think high` 把 `{"thinking":{"type":"enabled"},"reasoning_effort":"high"}` 直接写进 `~/.ai-zen/agents/<id>.json` 的 `modelParams`，不再是「存一个档位名、运行时查表」。所以**改了策略表不会追溯已经配过的 Agent**——它们存的是当时那份参数。想更新就再跑一次 `/think`。

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
