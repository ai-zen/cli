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
- **运行时依赖**（由 `package.json` 的 `dependencies` 声明）：`ink`、`react`、`highlight.js`、`lowlight`、`string-width`。`@ai-zen/agents-client`（私有包、不发版）与 `@ai-zen/agents-sdk` / `@ai-zen/agents-core`（会发布，但运行期不该由消费者安装）都在构建时**内联进产物** —— `check:imports` 钉住 `dist/*.js` 里不再出现 `@ai-zen/agents-client`。
- **宿主不需要预先安装**：宿主包是 `@ai-zen/agents-host`（线上契约是它的子路径 `@ai-zen/agents-host/protocol`），但它只住在 `devDependencies` 里当**版本范围的声明** —— 本机模式由 `npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>` 现下现起，`<range>` 是构建时注入的 semver 范围。
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

**纯 stdio 也跑在宿主上。** 两种模式是同一条链路：`ai "…"` 会先确保本机宿主在跑（不在就用 `npx` 现下现起一个），再开一段**一次性会话**把这一轮跑完 —— 所以 Agent 装配、工具、MCP 连接、上下文护栏与 TUI 完全同一套（不存在「管道模式少几个插件」），会话也落在同一个地方（宿主的 `<数据根>/ai-zen.db`，按工作区归属）。

代价是**首次调用要先把宿主拉起来**：`npx` 解析版本 → 下载并安装 → 启动宿主 → 连上，这几步在 TUI 上是一块**阶段式下载屏**（不确定进度，不假装百分比）；之后复用已在跑的那个，这一笔不再付。此外 `<数据根>/run/` 需要可写、`node` 需要能起子进程。三条行为保持不变：默认不落盘；`--save` 只归档、**不改**「上一轮会话」指针（下次 `ai` 不会续接到一条管道结果上）；stdout 仍然只有答案。

**工作区跟着你的目录走。** 宿主和 CLI 在同一台机器上时（默认就是：CLI 用 `npx` 现下现起本机宿主），你**在哪个目录敲 `ai`，会话就属于那个目录的工作区** —— 没有就用这个目录建一个（`workspace.create` 递上当前目录），有就接着它最后一段对话。连的是**别的机器上的宿主**时反过来：客户端**不上送**自己的目录，只认「上次进入的那个工作区」，没有就进选择环节（`/ws` 列 / 选 / 新建）。

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

启动后**直接进入对话界面**（由 Ink/React 渲染）——没有开屏动画——若存在「上一轮会话」则自动续接，否则新建对话。空对话时对话区顶部展示品牌区（logo、标语与 CLI / SDK / core 版本），随消息自然上滚。对话界面采用**底部固定**布局，自下而上依次是：状态栏 → 输入行 → 分割线 → 排队区 → 阶段行 → 命令菜单，这一摞始终贴在终端底部，对话内容在其上方滚动。**阶段行**只在忙时出现（生成中说清「连接中 → 排队中 → 思考中 → 调用工具 → 等待工具返回 → 输出中」，阻塞命令执行时回落到命令名），它住在**输入行上方的分割线之上、恒 1 行**，不顶替输入框。

**生成中照常能输入。** 输入框一直在，能打字、能唤出 `/` 菜单、能回车发送：这一句会排在**当前这一轮后面**（在**输入框上方的排队区**回显，不再单独弹通知），本轮工具轮跑完时它落地成一条用户消息，**不打断**模型正在说的那一段；本轮结束后它会自然出现在转录里、带着回答。运行中只有 `Ctrl+C` / `Esc` 的含义变成「中止这一轮」（其余键位照旧，翻页 / 缩放 / 双击 `Ctrl+D` 退出都不变）。

若本轮派生了子 Agent，消息列表下方会出现一条**主子 Agent 栏目**（`主AGENT　◈子AGENT1　◈子AGENT2`）：`←` / `→` 切换即换消息列表的数据源，圆点表示执行状态（运行中蓝点闪烁 / 完成绿 / 失败红），本轮内循环结束时栏目自动收起。

对话界面提供流式输出区、多行输入（`Enter` 发送 / `Ctrl+N` 换行 / `← →` 移动光标 / `Ctrl+← →` 跨词 / `Ctrl+W`、`Alt+Backspace` 删前一个词 / `Alt+D`、`Ctrl+Delete` 删后一个词 / `Ctrl+K` 删到行尾 / `Ctrl+U` 删到行首 / `Esc` 清空 / `Ctrl+V` 粘贴（剪贴板有图片则附在消息上，否则粘文本；文本上限 256KB，超了报错不截断） / `↑` `↓` 在多行草稿里移动光标（首行 / 末行才翻历史）/ 输入区最多 8 行、窗口跟随光标 / `PgUp`、`PgDn`（或 `Alt+V`）翻页 / 鼠标滚轮按行滚动）与内联 `/` 命令菜单（生成中也照常唤得出来）；工具调用以 `⚙ 名称(参数)` 展示并带 **JSON 高亮**，正文与思考按 **Markdown 源码着色**（标题 / 粗体 / 斜体 / 行内代码 / 列表 / 引用 / 链接），围栏代码块按语言高亮并**保留围栏标记**。

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
| `/new` | 另开一段对话（不打断正在跑的那一段） |
| `/load` | 加载这段工作区里已有的一段对话（不打断正在跑的那一段） |
| `/sessions` `/ps` | 活跃会话列表：本进程挂着的 + 宿主在跑的，选中即切 |
| `/ws` | 工作区：列出 / 切换 / 登记一个目录（`/ws new [路径]`） |
| `/pin [on\|off]` | 置顶 / 取消置顶这一段对话（不带参数即切换） |
| `/back` `/revert` | 撤回上一条（可修改重发） |
| `/editor` | 用外部编辑器写长消息 |
| `/clear` | 清屏（只清屏，上下文保留） |
| `/free` | 清空排队区：生成中排着、还没送出去的那几句（清屏用 `/clear`） |
| `/config` | 打开配置中心（端点 / 模型 / 图片模型 / MCP / Agent 定义 / 默认项 / 工具上限） |
| `/model` | 切换模型：`/model <id>` 只改当前会话，`-a`/`--agent <id>` 改 Agent 定义，`-g`/`--global <id>` 改全局兜底；不带参数弹选择器 |
| `/think` `/effort` | 切换思考强度（写入生效模型所在的那一层；全局兜底层没有可写处，明确拒绝） |
| `/agent` | 选「以后的对话用哪个 Agent」（写 `defaultAgent`；不可用的显示宿主给的原因） |
| `/mcp [user\|workspace]` | 管理 MCP 服务器（增删改 / 启停）；不给作用域时进「已经有条目」的那一层 |
| `/key` | 设置端点 API Key |
| `/reload` | 让宿主重新读一遍磁盘上的配置 / 助手定义 / 工具 / Skill / MCP（消息与上下文保留） |
| `/upgrade` | 把宿主换到所有发布标签里版本最高的那个（查 registry → 用 npx 把那一版下到本地 → 问一句 → 记下这一版并让宿主正常关掉，回连接屏时按它重新拉起；本进程不重启自己） |
| `/lang` | 切换界面语言（`/lang zh` / `/lang en` 直指定，不带参数则切换） |
| `/handoff` | 生成交接文档（不切换会话） |
| `/migrate` | 交接并开启新会话 |
| `/help` | 显示帮助 |
| `/shutdown` | 关闭宿主（回连接屏；退出 CLI 本身**不**关宿主） |
| `/exit` `/quit` | 退出对话 |

> 说明：输入 `/` 会在输入行下方实时列出候选命令（↑↓ 选择、`Tab` 补全、`Enter` 提交/执行；菜单紧贴输入框向上生长）；命令按完整名称匹配，输入未识别的 `/xxx` 会提示“未知命令”。完整清单以 `src/commands/registry.ts` 为准（`/help` 与斜杠菜单都由它渲染）。

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
| 当前会话所用模型 | 对话内 `/model`（默认只改当前会话；`/model -a` 才写 Agent 定义的 `modelId`） |
| 思考强度（reasoning effort） | 对话内 `/think`（参数写进**生效模型所在的那一层**的 `modelParams`；可选档位来自 `~/.ai-zen/reasoning-presets.json` 里该模型引用的策略，可自行增删策略） |
| 模型 / 图片模型 / MCP 服务器 / Agent 定义 / 默认项（含中断策略）/ 工具上限 | 对话内 `/config` → 配置中心 |

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
