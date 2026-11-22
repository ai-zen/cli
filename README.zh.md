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

纯 stdio 也**跑在宿主上**：`ai "…"` 会先确保一台宿主可用（没有在跑的就在本机拉起一个，见下），再开一段**一次性会话**跑完这一轮 —— Agent 装配、工具、MCP 连接、上下文护栏与 TUI 完全同一套，答案不因为走了哪条路而不同。代价是首次调用多一两秒的冷启动，并且 `<数据根>/run/` 需要可写、`node` 要能起子进程。给了显式宿主地址（[见下](#连哪台服务端)）时这两条都不成立：本机什么也不拉起，冷启动（如果有）算在那台宿主头上。

## 连哪台服务端

单机部署**什么都不用配，也不需要预先安装什么**。不给显式地址时，`ai` 先看发现文件 `~/.ai-zen/run/host.json`（设了 `AI_ZEN_DIR` 就是 `$AI_ZEN_DIR/run/host.json`）：宿主会把自己实际拿到的端口写进去，重启后换端口也照样找得到。那儿没有宿主在跑时，就**用 `npx` 现下现起**一个 —— CLI 自己从不捆绑宿主：

```bash
npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>
```

`<range>` 是本 CLI 构建时锁定的 `@ai-zen/agents-host` 版本范围，所以宿主与客户端永远是同一档。于是**第一次启动要下一下宿主**，TUI 为此有一块阶段式下载屏（解析版本 → 下载并安装 → 启动宿主 → 连上）：只报阶段、不报百分比（不去解析 npm 的输出），宿主本来就在跑时一个字节都不画；失败就地给子进程说的最后一句原话，`R` 重试；`Esc` / `Ctrl+C` 取消这次拉起、带着原因折回连接屏，**不退出程序**。管道模式（`ai "…"`）没有屏：拉起失败就是 stderr 一行话 + 非 0 退出码。

凭证默认取同目录下的 `~/.ai-zen/run/token` —— 宿主启动时读或生成，权限 `0600`，**不在** `host.json` 里。

两条要留意的后果：

- **首启不会自己动手**：没有存过连接（`<数据根>/cli/connection.json` 不存在）又没有显式地址时，TUI 先摆**连接屏**（本机 / 远程 / 退出），在你选之前一次 I/O 都不做 —— 否则「第一次启动」就等于悄悄装了一个没人要的宿主。管道模式更进一步，直接失败并指路：退出码 `2`、stderr 一行指路话、什么都不拉起。
- **在连接屏上选「本机」才会拉起（可能还要下载）宿主**；选「远程」只连接、绝不拉起。

要连别处的服务端，就显式指定：

| 配置项 | 含义 |
|--------|------|
| `--server <url>` | 这一次连这台服务端 |
| `AI_ZEN_SERVER_URL` | 同一件事，适合「地址永远只有那一个」的 shell |
| `AI_ZEN_SERVER_TOKEN` | 那台服务端的凭证 |

- **优先级** —— 地址：`--server` > `AI_ZEN_SERVER_URL` > 发现文件；凭证：`AI_ZEN_SERVER_TOKEN` > `run/token`。
- **接受的写法** —— `ws:` / `wss:` / `http:` / `https:`（`http→ws`、`https→wss`，端口不变），并且允许带 path（nginx 子路径挂载）：`wss://your.domain/ai-zen`。
- **显式地址 ⇒ 永不拉起本地服务端**：本机拉起来的那一份一定不在那个地址上，所以 `ai` 只连这个地址，别的一概不碰。
- **没有 `--token`**：地址不是秘密，进 argv 无所谓；凭证是 —— `ps` 的输出与 shell 历史都会留下 argv，所以凭证只走环境变量。
- **服务端只监听 loopback、永不实现 TLS**：要跨机器访问，就在它前面放一条隧道（SSH 转发、tailscale）或一个终结 TLS 的反向代理（nginx）。
- **地址写错在启动早期就报**：stderr 一句人话，退出码 `2`，既不去连接也不去拉起。

```bash
# 本机：什么都不用配
ai

# 显式地址：问一下反向代理背后那台服务端的状态
ai --server-status --server wss://your.domain/ai-zen

# 进隧道（ssh -L 9999:127.0.0.1:<端口> …）：地址看着是本机，
# 凭证却是另一头那台机器上的那一份
AI_ZEN_SERVER_TOKEN="$(ssh host cat ~/.ai-zen/run/token)" \
  ai --server ws://127.0.0.1:9999 "总结这个分支的改动"
```

远程部署的完整说明 —— 隧道、nginx、凭证落在哪、握手被拒时先查什么 —— 见 `agents/docs/zh/deploy.md`（在本仓旁边的 ai-zen 工作区里）。

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

无参数且处于交互终端时，进入由 **Ink（React）** 打造的全屏界面，并**直接落在对话界面**上——没有要等的开屏动画。空对话时，对话区顶部展示品牌区（随消息自然上滚）：

```
 █████╗ ██╗    ███████╗███████╗███╗   ██╗
██╔══██╗██║    ╚══███╔╝██╔════╝████╗  ██║
███████║██║      ███╔╝ █████╗  ██╔██╗ ██║
██╔══██║██║     ███╔╝  ██╔══╝  ██║╚██╗██║
██║  ██║██║    ███████╗███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝    ╚══════╝╚══════╝╚═╝  ╚═══╝

              终端里的 AI 协作台
              v1.1.0-alpha.2 · sdk 1.2.0-alpha.2 · core 4.6.0-alpha.0
```

**直接进入对话界面**（若存在「上一轮会话」则自动续接，否则新建对话）。对话界面采用**底部固定**布局，自下而上依次是 **状态栏**（按优先级分三块：模型 · Agent · 思考强度 ｜ 本轮 / 累计 token 用量 · 生成速率 ｜ 快捷键提示；窄屏时放不下的块整块顺延到下一行，既不截断内容也不劈开单块）→ 输入行 → 分割线 → 排队区 → 阶段行 → 命令菜单，对话内容在这一摞上方滚动。**阶段行**只在忙时出现，说清这一轮在干什么（连接中 → 排队中 → 思考中 → 调用工具 → 等待工具返回 → 输出中，工具阶段带上工具名，并行调用时只列**还在跑**的那几个 —— 先完成的 `edit` 会从标签里消失，只剩 `exec`），它住在**输入行之上的分割线之上、恒 1 行**，不顶替输入框。**生成中照常能输入**：打字 / `/` 菜单 / 回车发送都还在，这一句会被排在当前这一轮后面（在**输入框上方的排队区**回显，不再单独弹通知），工具轮跑完时落地成一条消息，不打断模型正在说的那一段。生成速率在生成中显示实时值（最近 2 秒滑动窗口，按输出增量估算），一轮结束后换成这一轮的平均值（优先用 API 返回的真实 `completion_tokens`）。

子 Agent 运行期间，消息列表下方会出现一条**主子 Agent 栏目**（`主AGENT　◈子AGENT1　◈子AGENT2`）：`←` / `→` 切换即换消息列表的数据源，圆点表示执行状态（运行中蓝点闪烁 / 完成绿 / 失败红），本轮内循环结束时栏目自动收起。

**不进上下文的消息会划删除线**：判据与 core 的 `formatHistory()` 同源（`status` 非 `Completed` 或带 `omit`）。比如中断后按 `drop` 策略结算的那一轮、或请求出错的那条 —— 它们仍在转录里可见，但整行划掉，一眼看出「还在，可没发给模型」；正在流式输出的那条不算（那是「尚未」，不是「被丢弃」）。

**`@` 唤起文件路径补全**：输入框里敲 `@` 就弹出项目内候选（`@chat` 一次过滤到 `src/tui/screens/chat.tsx`，`@src/tui/` 则接着按目录往下钻），`↑`/`↓` 选择、`Tab` 或 `Enter` 补进草稿、`Esc` 只关菜单（不动草稿）。补进去的是**相对路径文本**（`@src/tui/screens/chat.tsx`），消息本身仍是普通文本，模型用 `read` 工具自己去读 —— 因此补错可 `Ctrl+_` 退回，也不会把大文件塞进上下文。候选来自 `git ls-files -co --exclude-standard`（尊重 `.gitignore`、含未跟踪文件），不在 git 仓库里时回落到 `fs.glob` 并排除 `node_modules` / `.git` / `dist`；索引缓存 15 秒；菜单紧贴输入框向上生长，装不下的从顶端丢弃（贴着输入框的那条永远是你正在选的那条）。

对话界面包含：流式输出区（思考过程 / 回答正文 / 工具调用分行展示）、多行输入（`Enter` 发送、`Ctrl+N` 换行、`← →` 移动光标、`Ctrl+← →` 跨词、`Ctrl+W` / `Alt+Backspace` 删前一个词、`Alt+D` / `Ctrl+Delete` 删后一个词、`Ctrl+K` 删到行尾、`Ctrl+U` 删到行首、`PgUp`/`PgDn`（或 `Alt+V`）翻页、鼠标滚轮按行滚动；macOS 上另支持 `⌘← →` 跨词、`⌘⌫`/`⌘⌦` 按词删除、`⌘[`/`⌘]` 翻页、`⌘;`/`⌘'` 按行滚动（取决于终端是否上报 Cmd，见下））与内联 `/` 命令菜单（↑↓ 选择、`Tab` 补全）。工具调用以 `⚙ 名称(参数)` 展示并带 **JSON 语法高亮**，正文与思考按 **Markdown 源码着色**（标题 / 粗体 / 斜体 / 行内代码 / 列表 / 引用 / 链接），**围栏代码块按语言高亮并保留围栏标记**（高亮数据来自 `highlight.js` / `lowlight`）。`Ctrl+C` 在生成中取消本轮请求、空闲时退出。

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
| `↑` / `↓` | 多行草稿里按视觉行移动光标，到首行 / 末行才翻历史；`/` 或 `@` 菜单打开时用于选择 |
| `Ctrl+K` / `Ctrl+U` | 删到行尾 / 删到行首 |
| `Ctrl+W` | 删到前一空白（标点不切分：`src/utils/foo.ts` 一次删完） |
| `Alt+B` / `Alt+F` | 跨词移动 |
| `Alt+D`、`Alt+Backspace`、`Ctrl+Delete` | 按词删除（标点算分隔） |
| `Ctrl+Y` / `Alt+Y` | 取回刚删掉的文本 / 循环取回更早的 |
| `Ctrl+_` | 撤销上一次输入编辑 |
| `Ctrl+S` | 暂存当前草稿 / 再按恢复 |
| `Ctrl+V` | 粘贴：剪贴板有图片就附在消息上，没有就粘贴文本（文本超过 256KB 直接拒绝，不截断） |
| `Ctrl+L` | 清屏（保留上下文） |
| `Alt+X` | 清空通知栏 —— 屏幕上的那几条，以及**这一段对话**在宿主上的通知（`notice.clear`）；别的对话的通知不动。提示就写在通知栏最后一行 |
| `PgUp` / `PgDn` | 应用内翻页回看 |
| 鼠标滚轮 | 按行滚动（每格 3 行）。开启鼠标上报后拖选复制需按住 `Shift`（终端原生选择）；`tmux` 用户需 `set -g mouse off`，否则滚轮会先被 copy-mode 拦下 |
| `Shift+↑ ↓`、`Alt+↑ ↓`、`⌘;` / `⌘'`* | 按行滚动 |
| `\` + `Enter` | 换行（任何终端可用） |

> 中断（`Ctrl+C` / `Esc`）后，模型**已经输出的思考与内容会保留在上下文里**（出厂默认 `abortedMessageStrategy: "keep"`）—— 下一轮它会接着这半句话往下说，而不是当作自己没说过。想彻底重置用 `/new` 开新会话；想改成「中断即丢弃」则在配置中心的「默认项 → 中断时保留已输出内容」里切到 `drop`。工具调用轮次按「整轮进出」归一（`abortedToolRoundStrategy`，出厂 `fill`）：没跑完的工具会补上中断原因，不会留下「有调用无结果」的非法历史；改成 `drop` 则整轮出列、不发给模型。两项都只在**建 Agent** 时读取，改完关掉配置中心会自动重建会话生效。

未实现（我们的场景没有对应物）：`Ctrl+O` 转录查看器、`Ctrl+R` 反向历史搜索、`Ctrl+B` 后台任务、`Ctrl+T` 任务清单、`Shift+Tab` 权限模式。

`Ctrl+V` **图片优先、文本兑底**：先问系统剪贴板要图片（macOS 用 `osascript`、Linux 用 `wl-paste` / `xclip`、Windows 用 PowerShell），有图就附在消息上（输入框上方出现「📎 已附加 N 张图片」，最多 4 张，`Esc` 清空）；剪贴板里没有图片则当作普通粘贴，把文本插到光标处（文本超过 256KB **直接拒绝、不截断** —— 半截内容比不粘更坑，提示会建议存成文件用 `@` 引用）。全程不落盘 —— 字节经 `content.upload` 交给服务端，上传 Files API 还是内联由**服务端**按这段会话的端点自动决定；当前模型没有 `vision: true` 时会退化成一行路径提示并在通知栏说明。`⌘⌫` 已被终端映射为 `Ctrl+U`，所以这里删到行首；要清空草稿用 `Esc`。

\* `⌘` 组合只有终端**启用 kitty 键盘协议**时才会带上 `super` 位（iTerm2 还需把 Cmd 映射为 Super）；不支持的终端（如 Apple Terminal）只能在终端里把 `⌘` 映射成 `ESC` 序列（如 `⌘←` → `ESC[1;9D`，等价于 `Alt+←`），或直接用上表的 Alt 组合。

> macOS 的 `⌘⌫` 会被 iTerm2 / Terminal.app 映射为 `Ctrl+U`，因此本 CLI 的 `Ctrl+U` 取 readline 语义「删到行首」——若做成「清空全部」，Mac 用户按 `⌘⌫` 会丢掉整个草稿。

> `Ctrl+← →` 无效通常是系统原因：macOS 默认把它绑定给「调度中心 → 向左/向右移动一个空间」，按键在到达终端前就被截走。可在「系统设置 → 键盘 → 键盘快捷键 → 调度中心」取消勾选。

若某个键仍然没反应，打开**按键诊断**再按一次：

```bash
AIZ_DEBUG_KEYS=1 aiz
# 另开一个窗口
tail -f ~/.ai-zen/logs/cli/keys.log
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

对话**不落在文件树里**：工作区、会话、消息、通知、待答的问题全在宿主那一个库里 —— `<数据根>/ai-zen.db`（`agents/packages/host/src/config.ts` 的 `HostPaths.dbFile`）。所以「续接上次那段」是两件事拼起来的：

- **客户端只记「上次打开的是哪一段」**：`<数据根>/cli/last-conversation.json`（按工作区 id 一格，`src/session.ts` 的 `memoryPath`）。启动时拿它去问宿主；记着的那段已经不在了（被删 / 宿主换了库）就改开一段新的 —— 那不是错误。
- **那段对话本身在宿主的库里**：按 id 打开（`conversation.get` + `conversation.state`），消息一条不缺地回来（`src/session.ts` 的 `loadConversation`）。

工作区同理：它不是目录，是宿主库里的一行（`folder.cwd` 只是它的一个字段）。本机部署时工作区就是你敲 `ai` 的那个目录（`workspace.list` 里没有就 `workspace.create` 登记一个），远端宿主上只认「上次进入的那个」、没有就让你用 `/ws` 选 —— 客户端**绝不**把本机的路径递上去（`src/workspace.ts` 的 `enterWorkspace`）。

纯 stdio 的一次性调用（`ai "…"`、`cat f | ai`）是唯一的例外：它连对话都不建（`conversation.transient`，一次请求跑一轮）；`--save` 才走真对话，而 `remember: false` 让那一次不挪 `last-conversation.json`（`src/stdio.ts`）。

### 界面语言（中文 / English）

首次启动按系统语言自动识别：`LC_ALL` → `LC_MESSAGES` → `LANG` → 系统 `Intl` locale，**识别不出来兑底英文**。识别结果写进 `~/.ai-zen/cli/preferences.json`，之后以偏好为准 —— 改了系统语言不会让界面语言漂移。`/lang` 可随时切换（无参在两者间切换），`/lang zh` / `/lang en` 直接指定。

偏好存在 CLI 独立的 `preferences.json` 里，**不写共享的 `config.json`** —— 后者是 CLI 与 Desktop 共用的配置契约。

覆盖范围：整套 TUI（主对话框、命令与 `/help`、配置中心全部屏幕、交接方式选择器、欢迎块与启动错误屏），以及 `ai --help` 与 `ai hook install / uninstall` 的终端输出。**以下刻意不翻**：

- **管道模式（`ai "提示词"` / 管道输入）的输出与报错一律英文** —— 它是给脚本用的，不应随人的界面语言变；
- 注入给模型的工作目录提示：英文 + `[system-injected: …]` 标记（标明不是用户敲的）。这是唯一不翻的协议内容（新建 Sub-agent 的 `task` 参数描述仍随界面语言）；
- `ai hook` 写进 `~/.bashrc` 的三个代码块标记串（`# === ai hook … ===`） —— 翻了就找不到旧块；
- 会话 id 时间戳 `chat_YYYY_MM_DD_HH_mm_ss` —— 它同时是文件名，跟着语言变会让历史文件与新文件混排。

### 对话命令

对话中输入的所有命令以 `/` 开头。输入 `/` 会在输入行下方实时列出可用命令及说明，继续输入即按前缀收敛候选：

```
💬 你: /b
  /back /revert  撤回上一条（可修改重发）
```

> 输入 `/` 会在输入行下方实时列出候选命令（↑↓ 选择、`Tab` 补全、`Enter` 提交/执行）；命令按完整名称匹配，输入未识别的 `/xxx` 会提示「未知命令」。

| 命令 | 说明 |
|------|------|
| `/new` | 另开一段新对话（同一个助手、当前选中的工作区）。**不打断**正在跑的那一段：它留在后台继续跑，随时可以切回来 |
| `/load` | 换到宿主上已有的一段对话（选择器）。同样不打断当前这一段 —— 换过去的只是「这一屏看哪一段」 |
| `/sessions` `/ps` | 活跃会话列表：本进程挂着的 ∪ 宿主上正在跑的，每行标出在跑（带阶段或起跑时刻）与「当前」，选中即切 |
| `/ws` | 工作区。`/ws` 列出并切换（每项显示目录、以及那个目录还在不在 —— 两条都是宿主给的事实）；`/ws new [路径]` 登记一个目录：本机宿主用当前目录，远端宿主给绝对路径 |
| `/pin [on\|off]` | 置顶 / 取消置顶**这一段**对话。只写一个字段，排序（置顶优先 + 创建时间倒序）由 `conversation.list` 给 |
| `/back` `/revert` | 撤回：回退到你某条消息**之前**并重发。宿主按**消息 id** 截断（不是客户端数出来的下标），被撤掉的内容会回填到输入框 |
| `/editor` | 用外部编辑器写这条长消息（`$EDITOR` → `$VISUAL` → `vi`，Windows 上是 `notepad`） |
| `/clear` | 清屏（保留上下文，不动排队区 —— 排队区归 `/free`） |
| `/free` | 清空排队区：生成中排着、还没送出去的那几句 |
| `/config` | 打开配置中心（端点 / 模型 / 图片模型 / MCP / Agent 定义 / 默认项（含中断策略）/ 工具上限） |
| `/model` | 切换模型：`/model <id>` 只改**当前会话**；`-a`/`--agent <id>` 改 Agent 定义（思考强度重置）；`-g`/`--global <id>` 改全局兜底；不带参数弹选择器（标题会说明此刻生效的是哪一档） |
| `/think` `/effort` | 切换本段会话的思考强度（`default` 清掉会话上的值、跟随 Agent 定义）；`-a`/`--agent [档位]` 改的是 Agent 定义。可选档位是宿主按模型给的，这里不自己编 |
| `/agent` | 选「以后的对话用哪个 Agent」（写 `defaultAgent`；不可用的显示宿主给的原因） |
| `/mcp [user\|workspace]` | 在配置中心的 MCP 屏管理 MCP 服务器（增删改 / 启停）；不给作用域时进「已经有条目」的那一层 |
| `/key` | 设置当前端点的 API Key（保存后重建会话，立即生效） |
| `/reload` | 让宿主重新读一遍磁盘上的配置 / 助手定义 / 工具 / Skill / MCP（消息与上下文保留） |
| `/upgrade` | 把宿主换到**所有发布标签里版本最高的那个**：查 registry → 用 npx 把那一版下到本地 → 问一句 → 记下这一版并让宿主正常关掉（回连接屏时按它重新拉起；本进程不重启自己） |
| `/lang` | 切换界面语言（`/lang zh`、`/lang en` 直指定，不带参数则切换） |
| `/handoff` | 生成交接文档（不切换会话） |
| `/migrate` | 交接并开启新会话 |
| `/help` | 显示命令清单；接了契约方法的那几条，说明取宿主能力清单里渲染好的那句 |
| `/shutdown` | 关闭宿主（`host.shutdown`）。一次二次确认 —— 而且确认框把代价说清：**一台机器可能多台客户端共用一个宿主（桌面端从不 kill 它），关掉会把别人一起踢下线**。宿主受理之后 CLI **回连接屏**并说明宿主已关闭，而不是直接退出 |
| `/exit` `/quit` | 退出对话 |

### 任务交接与迁移

两条命令，同一条管道：

- **`/handoff`** — 原 agent 停下手头工作，用自己的工具核实真实状态（分支、未提交改动、测试、端口），把交接文档写到 `<项目>/.ai-zen/handoffs/<YYYYMMDD-HHmmss>.md`。会话照旧运行，因此可以继续打磨这份文档。
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
> 模型按**三级解析**：会话级覆盖 > Agent 定义（`agents/<id>.json` 的 `modelId`）> `config.json` 的 `defaultModel`（兜底，默认不写）。日常在用的那个写在 Agent 定义上；`/model <id>` 只改当前会话，`/model -a <id>` 改定义，`/model -g <id>` 改兜底。

### 环境变量

- `AI_ZEN_DIR` — 覆盖共享根目录（默认 `~/.ai-zen`）。CLI 运行时数据在 `$AI_ZEN_DIR/cli/`，共享资源（agents、skills、tools、MCP 等）在 `$AI_ZEN_DIR/`。
- `AIZ_DEBUG_KEYS=1` — 开启按键诊断日志（默认关闭，零开销）；`AIZ_KEYS_FILE=<路径>` 可改落盘位置（默认 `<数据根>/logs/cli/keys.log`）。
- `AI_ZEN_SERVER_URL` — 显式服务端地址，与 `--server <url>` 同义（两者都给时 `--server` 胜），[详见](#连哪台服务端)。
- `AI_ZEN_SERVER_TOKEN` — 显式服务端的凭证，优先于 `~/.ai-zen/run/token`。**故意没有** `--token` 参数：argv 会被 `ps` 与 shell 历史留下。

## 文件系统布局

数据根（`AI_ZEN_DIR`，缺省 `~/.ai-zen`）下只有一条分界：**宿主的事实** vs **这个客户端自己的**。下面每一项都指得回一行代码 —— 宿主的路径全在 `HostPaths`（`agents/packages/host/src/config.ts`），客户端那四个文件在各自实现里。

```
~/.ai-zen/                     ← 数据根（AI_ZEN_DIR）
├── ai-zen.db                  ← 宿主唯一的库：工作区 / 会话 / 消息 / 通知 / 问题
├── assets/                    ← 附件与上传上来的素材（宿主管）
├── config.json                ← SDK 配置：端点 / 模型 / 默认项 / 上限 / 行为开关
├── host.json                  ← 宿主自己的设置（端口等）
├── run/                       ← 「这台机器上谁在服务」
│   ├── host.json              ← 发现文件：宿主此刻在哪个端口
│   └── token                  ← 本地凭证（0600；本机实例免输凭证靠它）
├── logs/                      ← 一个进程一格，每格只归一个进程写
│   ├── host/host.log          ← 宿主日志（按大小轮转：host.log.1 …）
│   └── cli/                   ← 这个 CLI 自己的
│       ├── cli.log            ← CLI 日志（2MB 轮转）；warn / error 同时上通知栏，发送消息那一刻清掉
│       ├── launch.log         ← 拉起宿主时那个子进程的输出（每次拉起重写：失败原因是这一回的）
│       └── keys.log           ← 按键诊断（`AIZ_DEBUG_KEYS=1` 才写）
├── agents/                    ← 助手定义（一实体一文件）—— 助手只有这一层
├── sub-agents/                ← 子 Agent 定义（用户级）
├── skills/                    ← Skill（用户级）
├── tools/                     ← 自定义工具（用户级）
├── mcp.json                   ← MCP 配置（用户级）
├── mcp-oauth/                 ← MCP 的 OAuth 凭据
└── cli/                       ← **只属于本机 CLI** 的运行时数据
    ├── connection.json        ← 这台 CLI 连哪台宿主（远程时的地址与凭证）
    ├── preferences.json       ← 界面语言等本机偏好
    ├── last-workspace.json    ← 「这台宿主上次进的是哪个工作区」
    └── last-conversation.json ← 「这个工作区上次打开的是哪段对话」

~/.agents/                     ← 业界通用目录（Cursor / Windsurf / Cline）：skills/、mcp.json

/path/to/project/
├── .mcp.json                  ← 项目共享 MCP 配置（可提交 git）
├── .ai-zen/
│   ├── mcp.json               ← 项目个人 MCP 配置（不提交；唯一可写的项目层）
│   └── skills/                ← 项目 Skill 目录
└── .agents/                   ← 其它工具约定的目录
    ├── mcp.json
    ├── skills/
    ├── tools/
    └── sub-agents/
```

各能力的层（近的在前，同 id 由近的覆盖）。`agents/` **不参与**这条链 —— 助手定义是全局配置、与项目无关：

| 能力 | 层（近 → 远） |
|---|---|
| 助手定义 | `<数据根>/agents/`（只有这一处） |
| Skill | `<项目>/.ai-zen/skills` → `<项目>/.agents/skills` → `<数据根>/skills` → `~/.agents/skills` |
| 工具 | `<项目>/.agents/tools` → `<数据根>/tools` |
| 子 Agent | `<项目>/.agents/sub-agents` → `<数据根>/sub-agents` |
| MCP | `<项目>/.mcp.json` → `<项目>/.ai-zen/mcp.json` → `<项目>/.agents/mcp.json` → `<数据根>/mcp.json` → `~/.agents/mcp.json` |

这张表是 `DiscoveryService` 的输出，不是约定：`agentsDir` / `skillLayers` / `toolLayers` / `subAgentLayers` / `mcpLayers`（`agents/packages/host/src/services/DiscoveryService.ts`）。客户端**不自己拼**这些路径 —— 两机部署时算出来的第二份答案会在对面安静地错；要知道某一层现在是什么样，问 `config.getDiscovery`。

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
pnpm build     # 等价于 `npx rolldown -c rolldown.config.mjs`
pnpm start     # 先构建，再跑构建产物
```

## 测试（五条门禁）

每一笔改动都要过完这五条 —— CI 与验收跑的就是它们：

```bash
# 1. 类型：0 错（含测试文件）
npx tsc --noEmit -p tsconfig.test.json

# 2. 单元 / 集成用例（默认门禁，不含 e2e）
npx vitest run

# 3. 构建：产出 dist/（第 4、5 条都要它）
npx rolldown -c rolldown.config.mjs

# 4. 产物图四条护栏：客户端产物里不许出现 `openai` / `@modelcontextprotocol`，
#    且 commands / session / stdio 三段不许伸进 ink / react / tui
npm run check:imports

# 5. 端到端：真 CLI 构建产物 → 真宿主进程 → 假模型端点
npx vitest run --config vitest.e2e.config.ts
```

几点说明：

- **e2e 要构建产物**（它跑的是 `dist/index.js`），还要旁边 `agents` 仓构建出来的宿主；本机拉起那条路走的是一个只转发的假 `npx`，所以全程不联网。
- **e2e 不要与别的起真宿主的用例并行跑** —— 它们抢的是同一台机器上的资源与端口。
- `npm run test:all` 把同一条链串起来（`pretest` + `format:check` + `vitest run` + `build` + `check:imports` + e2e）。

## 许可

MIT
