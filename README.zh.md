# @ai-zen/cli

AI Agent 命令行界面，基于 `@ai-zen/agents-sdk` 和 `@ai-zen/agents-core` 构建。提供**双模式**运行：交互式终端（TUI）用于人与 AI 对话，纯 stdio 模式用于脚本、管道与 shell 兜底钩子。内置文件系统操作工具，支持 MCP 协议集成外部工具、子 Agent 编排和 Skill 管理。

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

## 运行模式

CLI 有两种**互不混合**的运行模式，由启动参数与终端环境自动判定：

| 模式 | 触发条件 | 面向对象 | 核心行为 |
|------|----------|----------|----------|
| **纯 stdio** | 带参数，**或** stdin/stdout 非 TTY（管道、重定向、CI） | 脚本、管道、shell 兜底钩子 | 无任何额外交互；读入文本，把**最终回答以纯文本写入 stdout** |
| **TUI** | 无参数且 stdin/stdout 均为 TTY | 人类用户 | 交互式对话界面 |

纯 stdio 模式下，日志 / 进度 / 工具过程 / 错误摘要一律走 **stderr**，stdout 只有结果本身（零 ANSI、零 emoji 前缀、零 spinner）；成功退出码 `0`，失败非 `0`。默认**不落盘**（不写对话存档）。

## 快速使用

```bash
# TUI：无参数且处于交互终端
ai

# 纯 stdio：参数即提示词，结果写入 stdout
ai 你好，请介绍一下你自己。

# 管道：stdin 作为内容，参数作为指令
cat README.md | ai "用三句话总结"

# 落盘：默认不保存，需要时显式 --save
ai --save "帮我给这个函数起个名字"

# 帮助 / 版本
ai --help
ai --version
```

> 旧命令名 `aiz` / `zen` 作为过渡别名在当前版本仍可用，未来版本会移除。

## 界面（TUI）

无参数且处于交互终端时，进入由 **Ink（React）** 打造的全屏界面。启动先呈现动画渐变的 ASCII 启动界面：

```
 █████╗ ██╗    ███████╗███████╗███╗   ██╗
██╔══██╗██║    ╚══███╔╝██╔════╝████╗  ██║
███████║██║      ███╔╝ █████╗  ██╔██╗ ██║
██╔══██║██║     ███╔╝  ██╔══╝  ██║╚██╗██║
██║  ██║██║    ███████╗███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝    ╚══════╝╚══════╝╚═╝  ╚═══╝

              终端里的 AI 协作台
              v1.0.0-alpha.25 · sdk x · core y
```

启动界面结束后**直接进入对话界面**（若存在「上一轮会话」则自动续接，否则新建对话）。对话界面采用**底部固定**布局：分隔线、输入行与**状态栏**（按优先级分三块：模型 · Agent · 思考强度 ｜ 本轮 / 累计 token 用量 · 生成速率 ｜ 快捷键提示；窄屏时放不下的块整块顺延到下一行，既不截断内容也不劈开单块）始终贴在终端底部，对话内容在其上方滚动；生成中时输入行位置显示**分阶段进度**（连接中 → 排队中 → 思考中 → 调用工具 → 等待工具返回 → 输出中，工具阶段带上工具名）。生成速率在生成中显示实时值（最近 2 秒滑动窗口，按输出增量估算），一轮结束后换成这一轮的平均值（优先用 API 返回的真实 `completion_tokens`）。

子 Agent 运行期间，消息列表下方会出现一条**主子 Agent 栏目**（`主AGENT　◈子AGENT1　◈子AGENT2`）：`←` / `→` 切换即换消息列表的数据源，圆点表示执行状态（运行中蓝点闪烁 / 完成绿 / 失败红），本轮内循环结束时栏目自动收起。

**不进上下文的消息会划删除线**：判据与 core 的 `formatHistory()` 同源（`status` 非 `Completed` 或带 `omit`）。比如中断后按 `drop` 策略结算的那一轮、或请求出错的那条 —— 它们仍在转录里可见，但整行划掉，一眼看出「还在，可没发给模型」；正在流式输出的那条不算（那是「尚未」，不是「被丢弃」）。

对话界面包含：流式输出区（思考过程 / 回答正文 / 工具调用分行展示）、多行输入（`Enter` 发送、`Ctrl+N` 换行、`← →` 移动光标、`Ctrl+← →` 跨词、`Ctrl+W` / `Alt+Backspace` 删前一个词、`Alt+D` / `Ctrl+Delete` 删后一个词、`Ctrl+K` 删到行尾、`Ctrl+U` 删到行首、`PgUp`/`PgDn`（或 `Alt+V`/`Ctrl+V`）翻页、鼠标滚轮按行滚动；macOS 上另支持 `⌘← →` 跨词、`⌘⌫`/`⌘⌦` 按词删除、`⌘[`/`⌘]` 翻页、`⌘;`/`⌘'` 按行滚动（取决于终端是否上报 Cmd，见下））与内联 `/` 命令菜单（↑↓ 选择、`Tab` 补全）。工具调用以 `⚙ 名称(参数)` 展示并带 **JSON 语法高亮**，正文与思考按 **Markdown 源码着色**（标题 / 粗体 / 斜体 / 行内代码 / 列表 / 引用 / 链接），**围栏代码块按语言高亮并保留围栏标记**（高亮数据来自 `highlight.js` / `lowlight`）。`Ctrl+C` 在生成中取消本轮请求、空闲时退出。

### 键盘与终端兼容（macOS 等）

macOS 上终端 TUI 的通行做法是 **Option 当 Meta + readline 系 Ctrl 键**：`Cmd` 不在终端协议里（`super` 只有 kitty 键盘协议才会上报，见 [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)），因此 `⌘` 主要留给终端自身（复制 / 粘贴 / 搜索）。本 CLI 的键位与这条路线一致。

**第一步：把 Option 设为 Meta**。macOS 终端默认不发送 Option 修饰位，不设则所有 `Option+X` 全部无效：

| 终端 | 设置 |
|------|------|
| Apple Terminal | 设置 → 描述文件 → 键盘 → 勾选「**将 Option 用作 Meta 键**」 |
| iTerm2 | Settings → Profiles → Keys → General → Left/Right Option key 设为 `Esc+` |
| VS Code / Cursor | settings 里加 `"terminal.integrated.macOptionIsMeta": true` |
| Ghostty / kitty / WezTerm | 配置文件中启用 Option-as-Alt / Option-as-Meta |

键位一览（与 [Claude Code](https://docs.claude.com/en/docs/claude-code/interactive-mode) 对齐）：

| 键位 | 作用 |
|------|------|
| `Enter` | 发送 |
| `Ctrl+J`、`Ctrl+Enter`、`Alt+Enter`、`Shift+Enter` | 换行 |
| `Ctrl+C` | 生成中：中断本轮；空闲：有草稿先清空，再按退出 |
| `Ctrl+D` | 有草稿：删光标后一个字符；空输入：连按两次退出 |
| `Esc` | 生成中：中断；否则清空草稿并回到底部 |
| `Ctrl+A` / `Ctrl+E` | 行首 / 行尾 |
| `Ctrl+P` / `Ctrl+N` | 历史上一条 / 下一条（也用于斜杠菜单选择） |
| `Ctrl+K` / `Ctrl+U` | 删到行尾 / 删到行首 |
| `Ctrl+W` | 删到前一空白（标点不切分：`src/utils/foo.ts` 一次删完） |
| `Alt+B` / `Alt+F` | 跨词移动 |
| `Alt+D`、`Alt+Backspace`、`Ctrl+Delete` | 按词删除（标点算分隔） |
| `Ctrl+Y` / `Alt+Y` | 取回刚删掉的文本 / 循环取回更早的 |
| `Ctrl+_` | 撤销上一次输入编辑 |
| `Ctrl+S` | 暂存当前草稿 / 再按恢复 |
| `Ctrl+V` | 预留：粘贴图片（**暂未实现**，按下会提示） |
| `Ctrl+L` | 清屏（保留上下文） |
| `PgUp` / `PgDn` | 应用内翻页回看 |
| 鼠标滚轮 | 按行滚动（每格 3 行）。开启鼠标上报后拖选复制需按住 `Shift`（终端原生选择）；`tmux` 用户需 `set -g mouse off`，否则滚轮会先被 copy-mode 拦下 |
| `Shift+↑ ↓`、`Alt+↑ ↓`、`⌘;` / `⌘'`* | 按行滚动 |
| `\` + `Enter` | 换行（任何终端可用） |

> 中断（`Ctrl+C` / `Esc`）后，模型**已经输出的思考与内容会保留在上下文里**（出厂默认 `abortedMessageStrategy: "keep"`）—— 下一轮它会接着这半句话往下说，而不是当作自己没说过。想彻底重置用 `/new` 开新会话；想改成「中断即丢弃」则在配置中心的「默认项 → 中断时保留已输出内容」里切到 `drop`。工具调用轮次按「整轮进出」归一（`abortedToolRoundStrategy`，出厂 `fill`）：没跑完的工具会补上中断原因，不会留下「有调用无结果」的非法历史；改成 `drop` 则整轮出列、不发给模型。两项都只在**建 Agent** 时读取，改完关掉配置中心会自动重建会话生效。

未实现（我们的场景没有对应物）：`Ctrl+O` 转录查看器、`Ctrl+R` 反向历史搜索、`Ctrl+B` 后台任务、`Ctrl+T` 任务清单、`Shift+Tab` 权限模式。

`Ctrl+V`（Claude Code 的「粘贴图片」）**暂未实现**：按下会提示未支持。原因是它需要先解决「文件 → 内容块」的端点能力探测（Files API 上传 vs base64内联），不能简单硬编码某个端点。⌘⌫ 已被终端映射为 `Ctrl+U`，所以这里删到行首；要清空草稿用 `Esc`。

\* `⌘` 组合只有终端**启用 kitty 键盘协议**时才会带上 `super` 位（iTerm2 还需把 Cmd 映射为 Super）；不支持的终端（如 Apple Terminal）只能在终端里把 `⌘` 映射成 `ESC` 序列（如 `⌘←` → `ESC[1;9D`，等价于 `Alt+←`），或直接用上表的 Alt 组合。

> macOS 的 `⌘⌫` 会被 iTerm2 / Terminal.app 映射为 `Ctrl+U`，因此本 CLI 的 `Ctrl+U` 取 readline 语义「删到行首」——若做成「清空全部」，Mac 用户按 `⌘⌫` 会丢掉整个草稿。

> `Ctrl+← →` 无效通常是系统原因：macOS 默认把它绑定给「调度中心 → 向左/向右移动一个空间」，按键在到达终端前就被截走。可在「系统设置 → 键盘 → 键盘快捷键 → 调度中心」取消勾选。

若某个键仍然没反应，打开**按键诊断**再按一次：

```bash
AIZ_DEBUG_KEYS=1 aiz
# 另开一个窗口
tail -f /tmp/aiz-key-debug.log
```

首行记录终端环境（`TERM` / `TERM_PROGRAM` 等），之后每次按键一行：

```
key input="d" flags=[meta] raw=true
key input="" flags=[pageUp] raw=false
```

- **按了键却没有新行** → 键被系统 / 终端截走（改系统快捷键或终端键位映射）
- **有行但 `flags` 与预期不符** → 序列已到达应用，是匹配逻辑问题（反馈时贴这一行）
- **`raw=false`** → stdin 不在 raw mode，按键被终端自己解释（例如去滚 scrollback）

### 首次配置（API Key）

首次启动时若所选模型绑定的端点还没有 API Key，会**先弹出凭据设置屏**，而不是报错退出：

```
 ? 首次配置 · 设置 DeepSeek 的 API Key
 端点：DeepSeek · https://api.deepseek.com/v1
 当前：未设置
 DeepSeek 申请地址：https://platform.deepseek.com/api_keys
 保存后立即进入对话（Esc 放弃并退出）。
 ❯ ▏
```

`Enter` 保存并直接进入对话（写入 `~/.ai-zen/config.json`），`Tab` 切明文核对，`Esc` 放弃。进入对话后仍可用 `/key` 修改**当前端点**的 Key（保存后自动重建会话，立即生效）、用 `/config` 打开配置中心（默认模型 / 端点管理：列表含「＋ 新建端点」与各端点，选中端点后可就地编辑 API Key / Base URL）。

### 会话恢复

每个会话都会在对话过程中**直接落盘为独立文件**（`cli/conversations/<id>.json`），不再有单独的草稿存储。一个指针文件（`cli/last-session.json`）记录**上一轮会话 id**；下次启动 `ai` 会**自动续接该会话**，接着上次继续。

### 界面语言（中文 / English）

首次启动按系统语言自动识别：`LC_ALL` → `LC_MESSAGES` → `LANG` → 系统 `Intl` locale，**识别不出来兑底英文**。识别结果写进 `~/.ai-zen/cli/preferences.json`，之后以偏好为准 —— 改了系统语言不会让界面语言漂移。`/lang` 可随时切换（无参在两者间切换），`/lang zh` / `/lang en` 直接指定。

偏好存在 CLI 独立的 `preferences.json` 里，**不写共享的 `config.json`** —— 后者是 CLI 与 Desktop 共用的配置契约。

覆盖范围：整套 TUI（主对话框、命令与 `/help`、配置中心全部屏幕、交接方式选择器、启动屏与启动错误屏），以及 `ai --help` 与 `ai hook install / uninstall` 的终端输出。**以下刻意不翻**：

- **管道模式（`ai "提示词"` / 管道输入）的输出与报错一律英文** —— 它是给脚本用的，不应随人的界面语言变；
- 注入给模型的工作目录提示：英文 + `[system-injected: …]` 标记（标明不是用户敲的）。这是唯一不翻的协议内容（新建 Sub-agent 的 `task` 参数描述仍随界面语言）；
- `ai hook` 写进 `~/.bashrc` 的三个代码块标记串（`# === ai hook … ===`） —— 翻了就找不到旧块；
- 会话 id 时间戳 `chat_YYYY_MM_DD_HH_mm_ss` —— 它同时是文件名，跟着语言变会让历史文件与新文件混排。

### 对话命令

对话中输入的所有命令以 `/` 开头。输入 `/` 会在输入行下方实时列出可用命令及说明，继续输入即按前缀收敛候选：

```
💬 你: /b
  /back         撤回消息（可修改后重发）
```

> 输入 `/` 会在输入行下方实时列出候选命令（↑↓ 选择、`Tab` 补全、`Enter` 提交/执行）；命令按完整名称匹配，输入未识别的 `/xxx` 会提示「未知命令」。

| 命令 | 说明 |
|------|------|
| `/exit` `/quit` | 退出对话（提示保存） |
| `/save` | 保存对话（本就每轮实时落盘） |
| `/load` | 加载对话（替换当前会话） |
| `/new` | 重置会话（清空历史） |
| `/back` | 撤回上一条（回退到指定位置并可编辑重发） |
| `/editor` | 用外部编辑器（vim/nano）写长消息 |
| `/clear` | 清屏 |
| `/config` | 打开配置中心（端点 / 模型 / 图片模型 / MCP / Agent 定义 / 默认项（含中断策略）/ 工具上限） |
| `/model` | 切换模型（写入 Agent 的 `modelId`，思考强度重置为模型默认） |
| `/agent` | 切换主 Agent（写入 `defaultAgent` 并重建会话；跑不起来的标为不可用并给出原因） |
| `/reload` | 刷新运行环境（重新发现工具 / MCP；消息与上下文保留） |
| `/update` | 升级 CLI（`npm install -g @ai-zen/cli@alpha`，装完重启 `ai` 生效） |
| `/mcp` | 管理 MCP 服务器（增删改 / 启停；`/mcp global`、`/mcp project` 指定作用域） |
| `/lang` | 切换界面语言（`/lang zh`、`/lang en` 直指定，不带参数则切换） |
| `/think` `/effort` | 切换思考强度（`/think default` 跟随模型默认） |
| `/key` | 设置端点 API Key（保存后重建会话） |
| `/handoff` | 生成交接文档（不切换会话） |
| `/migrate` | 交接并开启新会话 |
| `/help` | 显示帮助 |

### 任务交接与迁移

两条命令，同一条管道：

- **`/handoff`** — 原 agent 停下手头工作，用自己的工具核实真实状态（分支、未提交改动、测试、端口），把交接文档写到 `<项目>/.ai-zen/handoffs/<时间戳>-<会话id>.md`。会话照旧运行，因此可以继续打磨这份文档。
- **`/migrate`** — 同一次交接，然后把历史清空、以该文档开启新会话（断点消息只带路径，由新 agent 自己读取）。

两种执行者：`self`（默认——原 agent 在会话内写，保真度最高）与 `summary`（一次独立模型调用，便宜但有损）。`self` 失败时**单向**降级为 `summary`。可用 `/handoff summary` 或 `/migrate self` 显式指定。

当 `usage.prompt_tokens` 超过模型的 `tokenThresholds.handoff`，交互式终端会弹出三选一选择器（自交接 / 独立摘要 / 跳过）；管道等非交互场景按默认执行者迁移，不阻塞。

文档模板不在代码里：来自 `handoff` Skill（`~/.ai-zen/skills/handoff/SKILL.md`，由 SDK 释放并随版本同步；在 frontmatter 写 `metadata.custom: "true"` 可保留你自己的版本，也可在项目内覆盖）。完整链路、成本说明与模板章节见 [任务交接与迁移](./docs/zh/migration.md)。

同样的上下文护栏也作用于**子 Agent**：每次委派边界（`onSubAgentStart`）CLI 都会把同一个 `ContextGuardPlugin`（同一 `maxTokens`）安插到新建的子 Agent 上，因此被委派的子 Agent（含 `call_skill_sub_agent` 创建的技能子 Agent）在上下文超出硬上限时同样会被中断。该过程是透明的，正常运行的子 Agent 不受影响。
### Shell 兜底钩子

当你在终端输入一个不存在的命令时，自动转发给 AI 处理：

```bash
# 安装钩子
ai hook install

# 之后随便输入点什么：
> 今天天气怎么样？
# 这条消息会被转发给 AI，而不是显示 "command not found"

# 卸载钩子
ai hook uninstall
```

钩子函数体调用的是 **`ai --tui --new "$@"`**：进入交互界面，并把摸错的命令**作为首条消息自动发给模型**。钩子的发起场景是「人坐在交互终端前敲错了命令」，所以它应该进 TUI（可以追问、有历史），而不是落到管道模式吐一段字就退出；`--new` 进一步保证钩子会话**总是新开一条对话**，不会把敲错的命令追加进该目录原有的长对话里。已装过旧版钩子的话，重新执行 `ai hook install` 会原地升级（会比较已安装的函数体与当前版本，不一致就覆盖）；也可先 `ai hook uninstall` 再安装。

`--tui` 也可以手动用：`ai --tui 帮我看看这个报错` 会直接进 TUI 并发送。它在非 TTY 环境（如写进脚本或管道里）会报错退出而不是降级成管道模式 —— 否则整屏界面内容会被写进管道。

`--new` 也可以单独用：`ai --new` 直接开新一条对话，不续接该目录的上一轮会话。它只对 TUI 生效，stdio 模式下会被忽略（一次 stdio 调用本就是一次性会话）。

## 配置管理

配置文件存储在 `~/.ai-zen/config.json`（或 `$AI_ZEN_DIR/config.json`），与其他 AI-Zen 客户端共享，是**唯一数据源**。常用项可在 TUI 内直接编辑，无需手改 JSON：

| 场景 | 做法 |
|------|------|
| 首次启动、端点缺 Key | 启动时自动弹出**凭据设置屏** |
| 修改当前模型所用端点的 Key | 对话内 `/key`（保存后自动重建会话） |
| 端点 / 模型 / 图片模型、MCP 服务器、Agent 定义（含 Sub-agent）、默认项（含中断策略）、工具输出上限 | 对话内 `/config`（配置中心，全面管理） |
| 其它高级项（Skill / 用户工具等） | 手动编辑 `~/.ai-zen/` 下的文件 |

其中 `tokenThresholds` 是两条用量线：`handoff`（交接软线，超过它触发任务交接）与 `guard`（强行阻断硬线，请求前超过它中断本轮）。两者都是绝对值，建议 `guard ≈ handoff × 1.5`（`handoff` 通常设为模型实际上下文窗口的约 25%，例如 1M tokens 的模型设为 250,000）。

```jsonc
{
  "endpoints": [
    {
      "id": "openai",
      "name": "OpenAI",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "models": [
    {
      "id": "gpt-6.1-sol",
      "name": "GPT-6.1 Sol",
      "endpointId": "openai",
      "modelName": "gpt-6.1-sol",
      "tokenThresholds": { "handoff": 250000, "guard": 375000 },
      "reasoningPreset": "openai",
      "custom": true
    }
  ],
  "imageModels": [
    {
      "id": "cogview-4",
      "name": "CogView-4",
      "endpointId": "bigmodelcn",
      "modelName": "cogview-4",
      "defaultSize": "1024x1024"
    }
  ],
  "defaultImageModel": "cogview-4",
  "defaultAgent": "default",
  "defaultMigrationModel": "deepseek-flash"
}
```

> 说明：`models` / `imageModels` 中**未标 `custom: true`** 的条目属于**出厂托管**——每次启动会与 SDK 出厂清单对齐、被替换为最新定义；自建模型请加 `"custom": true`。`endpoints` 始终保留用户配置，不受影响。
>
> 模型**不在 `config.json` 里指定**：每个 Agent 在自己的定义文件（`agents/<id>.json`）的 `modelId` 字段上绑定模型，这是运行期的唯一真相源；`/model` 切换写的也是它。

### 环境变量

- `AI_ZEN_DIR` — 覆盖共享根目录（默认 `~/.ai-zen`）。CLI 运行时数据在 `$AI_ZEN_DIR/cli/`，共享资源（agents、skills、tools、MCP 等）在 `$AI_ZEN_DIR/`。
- `AIZ_DEBUG_KEYS=1` — 开启按键诊断日志（默认关闭，零开销）；`AIZ_KEYS_FILE=<路径>` 可改落盘位置（默认 `/tmp/aiz-key-debug.log`）。
- `AIZ_DEBUG_SDK=0` — 关闭 SDK 全局日志。**默认开启**，一律写入 `$AI_ZEN_DIR/logs/sdk.log`（界面上不显示任何库日志），单文件 2MB 封顶后轮转为 `sdk.log.1`；`AIZ_SDK_LOG_FILE=<路径>` 可改落盘位置。排查「MCP 连不上」「Skill 解析失败」时看这个文件。

## 文件系统布局

```
~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
├── config.json               ← 端点与模型配置（与其他 AI-Zen 客户端共享）
├── cli/                      ← CLI 运行时数据
│   ├── conversations/        ← CLI 对话记录
│   ├── last-session.json     ← 「上一轮会话 id」指针
│   └── preferences.json      ← CLI 本地偏好（界面语言等）
├── agents/                   ← Agent 定义（共享）
│   ├── default.json          ← 默认 Agent（首次运行自动创建）
│   └── my-custom-agent.json
├── sub-agents/               ← SubAgent 定义（共享）
│   ├── general-assistant.json ← 默认 SubAgent（首次运行自动创建）
│   └── my-coder.json
├── skills/                   ← Skill 目录（共享）
│   └── my-skill/
│       └── SKILL.md
├── tools/                    ← 用户自定义工具（共享）
│   └── my-tool.js
├── mcp.json                  ← MCP 配置（共享）
├── mcp-oauth/                ← MCP OAuth 令牌（共享）
└── logs/                     ← 诊断日志（sdk.log：SDK 全局日志，2MB 轮转）

/path/to/project/
├── .mcp.json                 ← 项目共享 MCP 配置（可提交 git）
└── .ai-zen/
    ├── mcp.json              ← 项目个人 MCP 配置（不提交）
    ├── skills/               ← 项目 Skill 目录
    │   └── my-skill/
    │       └── SKILL.md
    ├── tools/                ← 项目工具目录
    │   └── my-tool.js
    ├── sub-agents/           ← 项目 SubAgent 目录
    │   └── project-helper.json
    └── agents/               ← 项目 Agent 目录（覆盖用户级）
        └── project-agent.json
```

### MCP 配置合并优先级

MCP 服务器配置从多个来源合并（优先级从高到低）：

1. 项目共享 `./.mcp.json`（从 cwd 向上到 git root 沿途收集）
2. 项目个人 `./.ai-zen/mcp.json`（同上）
3. 项目规范 `./.agents/mcp.json`
4. 用户级 `~/.ai-zen/mcp.json`
5. 用户规范 `~/.agents/mcp.json`

同名 server 高优先级覆盖低优先级。

## 内置工具

CLI 提供 20 个内置工具，由 `@ai-zen/agents-sdk` 实现。工具可用性由各工具在构建阶段（模型已知时）通过 `isAvailable(config, definition)` 自声明：

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录 |
| `read` | 读取文件内容（支持 `range` 分批读取） |
| `inspect_file` | 勘察文件结构概况（行数、字符数、列宽分布、行尾风格），不读取内容 |
| `write` | 写入文件 |
| `edit` | 替换文件中的文本（单次替换） |
| `batch_edit` | 批量编辑文本 |
| `exec` | 执行 shell 命令 |
| `spawn` | 异步执行 shell 命令（立即返回，不等待结果） |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 通配符扫描文件 |
| `ls` | 列出目录 |
| `exist` | 检查路径是否存在 |
| `find_text` | 在文件中查找文本 |
| `download_file` | 从 URL 下载文件 |
| `rename` | 重命名或移动文件 |
| `copy` | 复制文件或目录 |
| `sleep` | 等待指定毫秒数 |
| `view_image` | 查看/分析图片 — 仅视觉模型可用（`Model.vision`）。网络图片直接以 `image_url` 内容块返回；本地图片经 Files API 自动上传后以 `file` 内容块返回 |
| `generate_image` | 根据描述生成图片 — 需配置 `defaultImageModel`；统一返回字符串（含图片 URL 列表与 `view_image` / `download_file` 提示的 JSON），不再强制返回图片内容块 |

### 动态工具

除内置工具外，SDK 还提供 5 个动态加载工具，根据可用资源和权限按需注册：

| 工具 | 用途 |
|------|------|
| `load_skill` | 加载 Skill 文档到上下文（幂等，重复加载不重复注入） |
| `call_skill_sub_agent` | 将任务委派给 Skill 子 Agent（仅对 frontmatter 声明了 `sub-agent: true` 的 Skill 有效） |
| `load_mcp` | 连接 MCP 服务器并列出其工具（幂等，重复连接不重建） |
| `call_mcp_tool` | 调用已连接 MCP 服务器上的工具 |
| `read_mcp_resource` | 读取已连接 MCP 服务器上的资源 |

## 工具装配流程

工具装配由 SDK 的 `Scope` 能力管线管理，分为三个阶段：

1. **发现** — 扫描文件系统获取内置工具、用户工具、SubAgent、Skill 和 MCP 服务器。20 个内置工具全部无条件发现（此阶段不做过滤）
2. **过滤** — 应用权限（`allow`/`deny`）、安全排除（递归保护），以及各工具自声明的 `isAvailable(config, definition)`（在模型已知的构建阶段判断可用性；如 `view_image` 仅视觉模型、`generate_image` 需配置 `defaultImageModel`）
3. **实例化** — 将过滤后的名称映射为 `Tool` 实例，注册动态加载器

每个 Agent 拥有独立的权限配置，父 Agent 与 SubAgent 之间不继承权限。唯一的例外是 `call_skill_sub_agent` 创建的临时 Skill 子 Agent——它是临时的对话分身而非独立实体，因此沿用调用者的工具能力（不再走第二遍权限过滤）。

## 权限模型

```typescript
interface AgentPermissions {
  tools?: { allow: string[] } | { deny: string[] };
  skills?: { allow: string[] } | { deny: string[] };
  mcps?: { allow: string[] } | { deny: string[] };
  subagents?: { allow: string[] } | { deny: string[] };
}
```

- 缺少 `permissions` 字段 = 所有维度拒绝（`deny: ["*"]`）
- 每个维度使用 `allow`（白名单）或 `deny`（黑名单），互斥
- `"*"` 通配符匹配任意名称
- 被拒绝的资源对 LLM 完全不可见（不仅执行阻断）

## MCP 服务器支持

MCP 服务器配置在 `mcp.json` 文件中：

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "xxx"
      }
    }
  }
}
```

连接生命周期（连接、指数退避重连、空闲超时断开）由 SDK 的 `McpConnectionManager` 全权管理。

### OAuth（仅 HTTP 传输类型）— 暂不支持

OAuth 2.0 授权流程（`mcp.json` 中的 `oauth` 字段）已定义类型和预留 `mcp-oauth/` 存储目录，但尚未实现。目前配置了 `oauth` 的 HTTP MCP 服务器将因缺少 token 而连接失败。

## 预置端点

| ID | 名称 | 默认 Base URL |
|----|------|--------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (智谱AI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## 预置模型

| ID | 名称 | 端点 |
|----|------|------|
| `gpt-6-astra` | GPT-6 Astra | OpenAI |
| `gpt-6.1-sol` | GPT-6.1 Sol | OpenAI |
| `gpt-6-luna` | GPT-6 Luna | OpenAI |
| `glm-5.3` | GLM-5.3 | 智谱AI |
| `glm-5.3-flash` | GLM-5.3-Flash（视觉） | 智谱AI |
| `glm-5.3-flashx` | GLM-5.3-FlashX（视觉） | 智谱AI |
| `glm-4.7-flash` | GLM-4.7-Flash | 智谱AI |
| `deepseek-flash` | DeepSeek-V4.1-Flash（视觉） | DeepSeek（**默认模型**） |

## 开发

```bash
pnpm install
pnpm build
pnpm start
```

## 测试

```bash
# 单元测试
pnpm test

# 端到端测试（需在 .env.local 中配置 API Key）
pnpm test:e2e
```

## 许可

MIT
