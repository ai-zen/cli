## [1.0.0-alpha.21] - 2026-10-27

### ✨ 新功能

- **状态栏改为三个信息块，并统计生成速率** —— 此前状态栏是一条按优先级排列的文本流，窄屏折行时会把 `本轮 1284 tok` 这类单元从中间劈开，也让「哪段信息属于一类」看不出来。
  - 现在分成三块：① 模型 · Agent · 思考强度　② 本轮 / 累计 token 用量 · 生成速率　③ 快捷键提示（垫底）。
  - **换行以块为单位**：新增 `packSegments()`（`src/tui/status-segments.ts`）——放得下就并排（` · ` 连接），放不下就把**整块**挪到下一行；只有单块自身超过一整行时才退化成块内折行（优先空格断、CJK 硬断、行首孤儿 `·` 丢弃、行尾空格裁掉）。行边界只会落在块边界上。
  - **行数确定**：`statusBarRows()` 在纯逻辑里量出实际行数并交给 `computeChatLayout({ statusBarLines })`，测量与渲染是同一个函数——窄屏下状态栏变高不会把输入框顶出屏幕。
  - 数字与单位用 NBSP 绑定（`本轮␣1284␣tok`），块内也不会被拆成两行。
  - **生成速率两口径，不混成一个数**：生成中 `⚡ 47 tok/s` 是估算值（按输出增量折算，CJK 0.7 / 字、其它非空白 0.25 / 字符、空白 0.1，取最近 2 秒滑动窗口）；一轮结束后改用 `⚡ 均 38 tok/s`，分母是「首字 → 末字」跨度，分子是 API 返回的真实 `usage.completion_tokens`（多轮工具调用逐轮累加）。跨度 < 400ms 不显示，避免首包爆发把速率放成几百。
- **新增 `/agent`：会话内快速切换主 Agent** —— 选择器列出 `~/.ai-zen/agents/*.json` 的全部主 Agent，标注当前项与其绑定的模型名（换 Agent 等于连模型一起换）。
  - 支持 `/agent <id>` 直切；无参弹选择器。
  - 切换前做完整链路预检：Agent 存在 → 绑定了模型 → 模型还在配置里 → 端点在 → 端点有 Key。跑不起来的标「不可用」并给出原因，而不是切过去之后卡在启动错误屏。
  - 写入 `config.defaultAgent`（与 `/config` →「默认 Agent」同一字段），随后重建会话；**消息与上下文保留**。不改 Agent 定义本身（提示词 / 权限 / `modelParams` 一概不碰）。
- **新增 `/mcp`：直达 MCP 管理界面** —— 不另建一套编辑器，直接把配置中心里已有的 MCP 屏打开（增 / 删 / 改 / 启停 / 全局⇄项目作用域切换都在那一屏）。关闭向导后沿用既有 `mcpChanged` 路径自动 `session.reload()`，新服务器当场生效。
  - 默认落点：项目级有服务器就进 `project`，否则进 `global`（项目级为空时进去只会看到空列表）。`/mcp global`、`/mcp project`（可缩写 `g` / `p`）可指定。
- **新增 `/reload`：刷新运行环境** —— `session.reload()` 内含 `resetScope()`（断开旧 MCP 连接、丢掉配置快照）→ 重建 Agent → 重新发现工具 / Skill / MCP。手改 `mcp.json` / `skills/` / `tools/` 后一条命令生效，**消息与上下文保留**，无需重启 CLI。
- **中断时保留已输出的思考与内容** —— 按 `Ctrl+C` / `Esc` 停下后，模型**已经吐出来的那半句话不再凭空消失**。此前中断只是把在途消息标成 `Aborted`，而历史过滤器只放行 `completed`，于是屏幕上还留着的思考与回答在下一轮请求里整条不见，模型下一轮像失忆一样重来。
  - 根因在上游：core 的 `abort()` 只管打标记、`formatHistory()` 只按状态过滤，两者都不关心「已经输出了什么」。core `4.5.3` 新增 `abortedMessageStrategy`（`drop` / `keep`，默认 `drop`），并导出 `reconcileAbortedMessages()`，在工具轮次归一**之后**收尾纯内容消息。
  - CLI 显式设成 `keep`：确有输出的被中断 assistant 会被恢复为 `completed` 进入上下文。**空输出不保留**（避免空消息污染上下文）、**带工具调用的不归它管**（仍走「整轮进出」，否则会出现「有调用无结果」的非法历史）。
  - SDK 依赖随之升级到 `1.0.0-alpha.20`（`createAgent` 新增第三参 `CreateAgentOptions`，顺带把此前完全没暴露的 `abortedToolRoundStrategy` / `abortedToolRoundReason` 一起接出来），core 升到 `4.5.3`。
- **界面国际化（中文 / English）** —— 首次启动按系统语言识别（`LC_ALL` → `LC_MESSAGES` → `LANG` → Node 的 `Intl` locale，**兜底英文**），识别结果写入 `~/.ai-zen/cli/preferences.json`，之后以偏好为准（改了系统语言也不会让界面语言悄悄漂移）。`/lang` 可随时切换，`/lang zh` / `/lang en` 直接指定。
  - 词典编译进产物（`src/i18n/{zh,en}.ts` + 配置中心专区 `{zh,en}-wizard.ts`）：key 扁平化，`{n}` 插值；切换语言只换一个引用，不重读磁盘、不重启。缺词条时返回 key 本身（不做跨语言静默回退，否则英文界面里会突然冒出中文）。`t()` 支持 `_one` / `_other` 复数变体（由 `Intl.PluralRules` 选），但 `i18n/index.test.ts` 要求**中英 key 集合完全一致**，故现有词条统一用 `(s)` 写法，不开变体。
  - 语言偏好放 CLI 独立的 `preferences.json`，**不塞进共享的 `config.json`** —— 那是 CLI 与 Desktop 共用的 `AppConfig` 契约，塞进去会被桌面端当未知字段丢掉。
  - 覆盖范围是**整套 TUI 界面**：主对话框（状态栏三块、输入占位与提示、通知、思考档位标签、生成中提示）、命令层（`/help`、斜杠菜单、各命令的选择器与反馈）、配置中心全部屏幕（端点 / 模型 / 图片模型 / MCP / Agent 定义 / 权限 / 默认项 / 工具输出上限 / 新建引导 / KV 与多行文本编辑器）、交接方式选择器与确认框、启动屏与启动错误屏，以及业务模块返回的 summary（`/model` `/agent` `/think` 的切换结果、交接进度与降级提示）。
  - `COMMAND_REGISTRY` 里存的是 **i18n key 而不是文案** —— 它是纯数据模块、加载时机早于语言初始化，存文案会把「加载那一刻的语言」定死；渲染时由 `getCommandHints()` 现取。启动屏的 `TAGLINE` 常量同理改成了 `tagline()` 函数。
  - **管道模式不做 i18n**：`ai <提示词>` / 管道输入的所有输出与报错**一律英文**（它是给脚本用的，不应随人的界面语言变），故 stdio 路径**不初始化语言**，行为与 `preferences.json` 彻底解耦。
  - **`ai --help` 与 `ai hook install / uninstall` 走 i18n**：两者都在 TUI 之外打印，因此在各自分支里先 `initLocale()` 再取词条；`HELP_TEXT` 那个模块级常量相应改成 `helpText()` 现拼（常量会把加载那一刻的语言定死）。
  - **会话 id 改名**：`对话_2025年07月01日14时30分00秒` → `chat_2026_10_28_00_56_34`（英文前缀 + 全下划线时间戳，中英一致、文件名安全）。它同时是文件名，跟着语言变会让历史文件与新文件混排，故时间戳由新增的 `formatFileStamp()` 生成；而**显示用**的 `formatShortTime()` 反而改为随语言切换。管道模式 `--save` 不再自己拼名字，改为调用 `generateConversationId()`，两处重复拼接一并消掉。
  - **注入历史的「工作目录」提示改为英文并显式标记**：`[system-injected: working directory changed — not written by the user]` —— 翻存档或交接文档时一眼能分辨哪些内容不是用户敲的；`stripCwdNote()` 同时认新旧两代格式，避免旧存档把这段笔记渲染到屏幕上。
  - 新建 Sub-agent 时写进 tool schema 的 `task` 参数描述也走词典（中 `完整的任务描述` / 英 `Full task description`）—— 这是唯一一处「协议内容也翻译」的例外，代价是同一份定义在不同界面语言下创建会得到不同的 schema 文本。
  - 唯一不翻的注入内容就是上述工作目录提示；`hook.ts` 写进 rc 文件的三个代码块标记串（`# === ai hook (开始) ===` 等）也保持原样 —— 翻了就再也找不到旧块。
  - 时间格式随语言切换 dayjs locale 与 pattern：中文 `7月1日 14:30` / `昨天 14:30`，英文 `Jul 1, 14:30` / `Yesterday 14:30`。
  - 顺带排掉两个隐藏地雷：状态栏曾用**文案**判断思考强度是否置灰（`effort === "关"`），英文界面下永远不成立，改为档位语义的 `effortDimmed()`；输入区占位提示曾硬编码在 `inputLines()` 里（渲染层却走 `t()`），英文界面下量输入行高度会短一行、连带硬件光标 y 偏移，现在两处同源。

### 🔧 行为变更

- **消息栏的「思考中…」拆成六态：连接中 / 排队中 / 思考中 / 调用工具 / 等待工具返回 / 输出中** —— 原先那行只有「思考中…」一个词，但一轮对话里模型其实走过几个阶段，用同一个词概括在多数时候是**说错话**：等首 token 时并没有在思考，工具执行时模型根本没在跑。
  - 判据只用**事件与 delta 的形状**（`src/tui/phase.ts`，纯逻辑可单测）：`connecting` = 请求发出到响应头到达；`queued` = `open` 之后、首个内容 chunk 之前；`thinking` = 收到 `reasoning_content`；`tool-calling` = 收到 `tool_calls` / `function_call`（带工具名，后续只带参数分片时沿用首个 delta 里的名字）；`tool-waiting` = `parsed` 且本轮带工具调用；`streaming` = 收到 `content`。一个 chunk 里同时出现时优先级是 tool_calls > content > reasoning。
  - 「连接中」这一段靠新增的 `PhasePlugin`（`chat-session.ts`）提供：SDK 的 `open` 事件是在 `chat.completions.create()` **await 返回之后**才发的，只代表响应头到了，之前的 DNS / TCP / TLS / 服务端受理全静默。
  - **子 Agent 的输出不推进主阶段**：委派期间主 Agent 正在等工具返回，若把子 Agent 的 delta 也算进主阶段，界面会跳成「输出中」，正好盖掉用户最需要知道的那句话。子 Agent 的 chunk 仍计入速率、仍触发重绘。
  - spinner 那一行加了 `truncate`：busy 时输入区高度被 `computeChatLayout` 固定为 1 行（`inputHeight = 1`），标签一旦折行就会把输入框顶出屏幕。
- **状态栏去掉「⏳ 生成中」** —— 本轮到底在干什么已由消息栏 spinner 逐阶段说明，状态栏再挂一个笼统的「生成中」只是重复占宽度（窄屏下还把快捷键提示挤到下一行）。

- **shell 钩子改为进入 TUI（此前的管道模式是实现错误）** —— 钩子装在 `command_not_found_handle` / `command_not_found_handler` 上，触发场景是「人坐在交互终端前把命令敲错了」，但函数体写的是 `ai "$@"`，而 `decideMode()` 的规则是「有位置参数 → stdio」，于是钩子会话必然落到管道模式：吐一段文字到 stdout 就退出，**没有历史、不能追问**。`mode.ts` 头顶那张分类表把「脚本调用」与「人手动触发」混成了一个判据，所以这不是补丁能修的，是分类本身错了。
  - 函数体现在是 `ai --tui --new "$@"`：新增 `--tui` 标志显式覆盖「有参数 → stdio」的判定，进 TUI 并把原命令**作为首条消息自动发送**（不预填到输入框——钩子的语义就是「这条命令跑不了，你帮我处理」，再让人敲一次回车没有意义）。
  - 首条消息**强制当普通用户消息**发送，不经斜杠命令解析：敲错的可能是 `/opt/bin/foo` 这种以 `/` 开头的命令，否则会被当成 CLI 命令而报「未知命令」。`runSubmit()` 为此多了 `asMessage` 选项。
  - `--tui` 在非 TTY 环境（脚本 / 管道）报错退出（退出码 2、英文提示），**不**降级成管道模式 —— 否则整屏界面内容会被写进管道。
  - 首条消息只在首次挂载时发送：切模型 / `/lang` 等引起的重挂载不会重发。
  - **钩子会话总是新开会话**：函数体多一个 `--new`（`ai --tui --new "$@"`）。否则敲错一次命令，那条命令就被追加进该目录原有的长对话里，上下文与会话名一起被搅乱。`--new` 是通用标志，手动用同样有效：`ai --new` 跳过 `last-session.json` 指针直接新建；它**只作用于 TUI 路径**，出现在 stdio 路径上时静默忽略（一次 stdio 调用本就是一次性会话，不存在续接）。
  - **`ai hook install` 现在会自我升级**：此前只要 rc 文件里存在 `MARKER_START` 就打印「已安装」直接返回，于是函数体改过之后（比如本次加了 `--new`）老用户永远升不上去。现在会把已安装块与当前版本归一化比对（去空行、逐行 trim），不一致就原地覆盖并提示「已更新到最新版本」（新增词条 `hook.updated`）。

- **`/migration` 不再是 `/migrate` 的别名** —— 只保留 `/migrate`，`/migration` 现在报「未知命令」。registry、命令执行器、`blocksInput` 判定与四份文档同步。
- **SDK 全局日志默认写入 `~/.ai-zen/logs/sdk.log`** —— 以前默认**丢弃**，只有 `AIZ_DEBUG_SDK=1` 才落盘到 `/tmp`。但 SDK 的 `warn` / `error` 承载「MCP 连不上」「Skill 解析失败」这类关键诊断，默认丢弃等于故障无痕。现在默认落盘（单文件 2MB 封顶后轮转为 `sdk.log.1`），`AIZ_DEBUG_SDK=0` 可彻底关掉，`AIZ_SDK_LOG_FILE` 可改路径。界面上依旧一个字都不显示。

### 🐛 修复

- **修复 IME（输入法）候选框「有时候定位不准」** —— 硬件光标位置以前靠 `displayWidth()` 自己算。但宽度是个陷阱：Ink 排版时用 `string-width`，我们手写的表在若干字符上与它不一致（`⚡` `✅` `✨` `⭐` 我们算 1 列、Ink 算 2 列；ZWJ 组合 emoji `👨‍👩‍👧` 我们算 8 列、Ink 算 2 列；keycap `1️⃣` 我们算 3、Ink 算 2），输入里一出现这类字符，x 就会偏。现在改为**渲染后实测**：
  - 光标所在字符包进独立 `<Box ref>`（行内嵌套的 `<Text>` 片段在 yoga 里没有节点，`measureElement()` 对它返回 `null`，实测），用 Ink 7 的 `measureElement()` 读它拓印到帧内的绝对坐标 —— 宽度由渲染器自己算，不再经过我们的模型。
  - 拆行后原本整行 `truncate` 的兜底会丢：一旦内容超宽（如宽度模型把 `⚡` 算成 1 列）这行会被顶成两行，整帧高一行、底部被顶出屏幕。解法是把溢出交给**可截断的邻段**吸收——`before` / `after` 段 `flexShrink={1} minWidth={0}` + `wrap="truncate"`，光标块 `flexShrink={0}`；实测容器 40 列、`before` 60 列时仍是**一行**。
  - 测量只能在渲染后（`useEffect`）做，而 Ink 的 `setCursorPosition` 只在 commit 阶段（`useInsertionEffect`）推送，所以存在一次 commit 的延迟：首次渲染先用旧手算值顶一帧，下一帧被实测值纠正（多一趟渲染，Ink 自带节流）。
  - 占位提示行（未输入任何内容）不走实测，仍用前缀后的固定位置。
- **占位提示态不再自绘「假光标」** —— 输入框为空时会显示灰字提示「输入消息，/ 查看命令…」，末尾原本还画了一个 `▏`。但硬件光标这时就停在提示语开头（`x = 前缀宽`），终端自己会把它显示出来，再画一个方块等于屏幕上两个光标，而且位置还在提示语末尾，反而误导。现在占位态只留提示文字。
- **修复「输入 emoji 后反显光标消失 / 真实光标错位」** —— 根因有两个，都是把「字符」当成了 code point：
  - **光标停在字素簇中间**：`✌️` 是 `U+270C U+FE0F` **两个 code point、一个字素簇**（`👨‍👩‍👧` 五个、`🇨🇳` 两个区域指示符）。按 code point 切分时，光标能停在 `✌` 与 `U+FE0F` 之间，于是反显的是一串**变体选择符** —— Ink 的输出里反显段直接消失（实测：`at=U+FE0F` 时帧里既无反显转义也没字符）。同时退格会只删掉半个 emoji、留下孤立的 `U+FE0F`。现在全部光标运算（折行、移动、删除、插入、撤销）改用 `Intl.Segmenter` 的**字素簇**为单位（`graphemes()`，Node 内置无需依赖）。
  - **宽度表换成 Ink 自己的尺子**：`displayWidth()` 不再用手写的 `isWide` 区间表，直接调用 **`string-width`**（Ink 排版用的就是它，见 `ink/build/output.js`）；单簇宽度带缓存，折行热路径几乎零成本。从此折行、状态栏装行、光标列号与渲染器同源 —— 状态栏那条「预留 1 列余量」也降级为纯安全边际。
  - **光标单位改成字素簇**：`✌️` 是 `U+270C U+FE0F` **两个 code point、一个字素簇**（`👨‍👩‍👧` 五个、`🇨🇳` 两个区域指示符）。按 code point 切分时，光标能停在 `✌` 与 `U+FE0F` 之间，于是反显的是一串**变体选择符** —— Ink 的输出里反显段直接消失（实测：`at=U+FE0F` 时帧里既无反显转义也没字符）。同时退格会只删掉半个 emoji、留下孤立的 `U+FE0F`。现在全部光标运算（折行、移动、删除、插入、撤销）改用 `Intl.Segmenter` 的**字素簇**为单位（`graphemes()`，Node 内置无需依赖）。
  - **新增直接依赖** `string-width@^8.3.0`（纯 ESM，本就在 Ink 的依赖树里，体积无变化）。
- **通知栏行数未计入光标 y** —— 渲染顺序是「对话区 → 通知栏 → 斜杠菜单 → 分隔线 → 输入行」，而 y 公式漏了通知栏一段。于是任何通知出现时硬件光标都会整体上浮那么多行；`/help` 一次塞最多 8 行通知，候选框能浮进对话区。现已补上 `noticeCount`（现作为实测未就绪时的兜底算法保留）。
- **修复 SDK 日志「接管了却照样糊界面」** —— 加载 MCP 时 `[load_mcp]` 连同整份 tools / resources 清单直接砸在渲染区外面。原因是 SDK 有 4 个模块在**模块顶层**执行 `const log = getLogger()`：模块求值那一刻就把 `console.log` 的函数引用冻进了常量，`setLogger()` 事后只替换内部变量，改不动已经抓走的引用；ESM 的静态 import 又保证这些模块在 `runTui()` 之前就已求值 —— 于是 CLI 无论怎么接管都会漏。
  - 修在 SDK 侧（不改 CLI 侧骗 console 的 workaround）：4 处全部改为**运行时取 logger**（`getLogger().info(...)` 等）；`skillTools` 那处是从未被调用的死代码，连同 import 一并删除。至此 SDK 内 10 处日志调用全部经由 `getLogger()` 单一出口，不存在 console 旁路。

### 📝 文档

- README（中 / 英）与 `docs/{zh,en}/getting-started.md` 的命令表新增 `/agent`、`/reload`、`/mcp` 三行。
- README（中 / 英）与 `docs/{zh,en}/index.md` 的状态栏说明从「一条按优先级的文本流」改为「三个信息块 + 按块换行」。
- `docs/{zh,en}/mcp.md` 的「管理」章节补充 `/mcp` 直达入口与 `/reload` 刷新；`docs/{zh,en}/migration.md` 去掉「别名 `/migration`」。
- README（中 / 英）新增「界面语言」一节：识别优先级、`preferences.json` 与 `/lang`、覆盖范围，以及刻意不翻的三类内容。
- `docs/manifest.json` 与 README 中的版本号更新为 `1.0.0-alpha.21`。
- README（中 / 英）的「环境变量」补 `AIZ_DEBUG_SDK=0` / `AIZ_SDK_LOG_FILE`，「文件系统布局」补 `~/.ai-zen/logs/`，键位表下补一段「中断后已输出的思考与内容会保留」的说明。
- README（中 / 英）与 `docs/{zh,en}/getting-started.md` 的命令表补 `/lang`；「文件系统布局」与 `docs/{zh,en}/configuration.md` 的目录树补 `~/.ai-zen/cli/preferences.json`（CLI 本地偏好）。

### ⚠️ 已知取舍

- **emoji 的渲染宽度可能仍与终端对不上，这是终端层的事**：代码侧已经做到与渲染器同源（`displayWidth` = Ink 用的 `string-width`，光标位置用 `measureElement` 实测），但**终端自己对 emoji / East Asian Ambiguous 字符的列宽判定**仍可能与 Unicode 表不同（部分终端把 `✌️` 渲染成 1 列而不是 2 列，且没有查询接口）。那种情况下整行文本的相对位置就已经由终端决定了，光标只能跟着 Ink 的模型走。输入 / 删除 / 光标单位层面的 emoji 问题已在本次修完。
- **光标是「终端光标 + 字符反显」两套并存，这是故意的**：光标处的字符仍用 `<Text inverse>` 反显成一个方块，位置的真相源是实测出来的硬件光标。两者视觉上会叠成一个略重的方块——接受这个重影，因为任一层失效时另一层还能报位置（某些终端 / 多路复用器里硬件光标不显示，或 Ink 卸载时反显又没了）。以后别把反显当重复渲染删掉。
- **块不被劈开 ⇒ 行数随宽度变化**：80 列下三块各占一行（3 行），120 列可把身份与用量并成 1 行（共 2 行）。旧的「一条流」能压到 2 行，代价是把 `本轮 / 累计` 拆到两行——信息完整性优先。
- **生成中的速率是估算值**：SDK 只在每个请求的**最后一个 chunk** 才给 `usage`（`stream_options.include_usage`），拿不到逐 token 用量；把估算与精确值混成一个数字才是误导，因此分成「实时估算」与「本轮均速」两种写法。
- **`/mcp` 只覆盖配置层**：服务器当前是否连通、暴露了多少工具，在 SDK 里是插件私有状态（`McpScopePlugin` 的 `mcpManager`），没有公开 API，界面不展示连接状态。
- **`/reload` 有一两秒空档**：重建 Agent 且重连 MCP，服务器多的场景会有可感知延迟；期间消息与上下文不受影响。

### ✅ 测试

- 全量 **33 文件 / 440 例通过**，`npx tsc --noEmit -p tsconfig.test.json` 干净。
- 新增 `src/i18n/index.test.ts`（14 例：语言识别优先级 / `C`·`POSIX` 跳过 / 兜底英文 / 插值 / 缺词条回退 key / 中英词条一一对应）与 `src/i18n/preferences.test.ts`（9 例：文件缺失·损坏·非法值的容错、原子写、`initLocale` 只识别一次并落盘）；`reasoning-effort.test.ts` 补 5 例「置灰不靠文案判断」。
- pty 真机验收：`LANG=en_US.UTF-8` 首次启动→英文并落盘 `en`；`/lang` 切中文→状态栏/输入框/通知全部跟随，且**重启后保持中文**（偏好先于系统语言）；`/lang en` 切回英文正常。
- pty 真机验收（阶段 2）：英文下斜杠菜单显示 `❯ /help  Show this help`、`/help` 输出全英文列表；`/lang zh` 后斜杠菜单与 `/help` 整体切回中文。
- pty 真机验收（阶段 3 / 4，隔离的 `AI_ZEN_DIR` + `LANG=en_US.UTF-8`）：首次启动识别为英文并落盘；启动屏 `The AI collaboration desk in your terminal`；主屏 `Type a message, / for commands…`、`thinking default · total 0 tok`；配置中心 `◆ Configuration` 与 `+ New model — marked as custom automatically` / `openai · factory-managed · vision`；模型详情 `◆ Model · GPT-6 Astra` / `factory-managed (editing switches it to custom)` / `Delete model`；新建模型与新建端点引导屏全英文。把 `preferences.json` 改回 `zh` 后**在 `LANG=en_US.UTF-8` 下重启仍为中文界面**（偏好优先于系统语言），配置中心与模型列表中文文案与改造前一致。
- **断言中文的测试一律显式锁语言**：`setLocale("zh")` 加在 `screens.test.tsx`、`config-wizard.test.tsx`、`reasoning-effort.test.ts`、`registry.test.ts`、`agent-prompt.test.tsx`、`handoff-choice.test.ts`、`config-editor.test.ts`、`agent-switch.test.ts`、`model-switch.test.ts`、`handoff-service.test.ts`、`auto-migrate-confirm.test.ts` —— 默认语言是 `en`，不锁就会在 CI 上莫名其妙地红。
- `mode.test.ts` 新增 6 例 `--tui`：有参数进 TUI 且参数作为首条消息、无参数时同不带 `--tui`、以 `/` 开头的命令不被当选项 / 子命令、`--tui --help` 时 help 优先、非 TTY 拒绝而非降级、`--` 之后的 `--tui` 是普通参数。
- `mode.test.ts` 新增 8 例 `--new`：单独用时进 TUI 且 `newSession: true`、`--tui --new <命令>` 同时带首条消息与新会话、与 `--tui` 顺序无关、有参数时落到 stdio 并被忽略、非 TTY 时落到 stdio 并被忽略、`--tui --new` 非 TTY 仍拒绝而非降级、`--new --help` 时 help 优先、`--` 之后的 `--new` 是普通参数。
- 新增 `src/hook.test.ts`（9 例，全部在临时 HOME 下跑，**不触碰真实 `~/.bashrc`**）：写入的函数体含 `ai --tui --new "$@"` 且只有一个块、保留 rc 原有内容、重复安装幂等、**已装旧函数体（`ai --tui "$@"`）时原地升级**、历史 aiz 块迁移、zsh 走 `command_not_found_handler` 且写入 `.zshrc`；卸载移除块并保留其余内容、未安装时不动文件、rc 文件不存在时不报错。
- pty 真机验收（钩子路径）：`ai --tui gti status` 进 TUI 并自动把 `gti status` 当用户消息发出（界面显示 `❯ 你 / gti status`），模型报错（故意的本地假端点）后界面仍存活可继续追问；`ai --tui /opt/bin/nonexistent --flag` 同样当**普通消息**发出，不被斜杠命令解析吃掉；`ai --tui` 在非 TTY 下退出码 2；写进 `~/.bashrc` 的函数体为 `ai --tui --new "$@"` 且 `bash -n` 语法通过。
- pty 真机验收（`--new`，隔离 `AI_ZEN_DIR` + 预置 `last-session.json` 指向旧会话）：`ai` 续接并显示旧消息 `MARKER-OLD-QUESTION`；`ai --new` 停在**空对话**；`ai --tui --new gti status` 空对话且首条消息自动发出；`--help` 中英两个界面都列出 `--new`。
- 本次改动后全量 **36 文件 / 487 例通过**，`npx tsc --noEmit` 与 `-p tsconfig.test.json` 均干净。
- 新增 `src/tui/phase.test.ts`（15 例：六态各自的推进、工具名沿用、无 delta 的收尾 chunk 不改阶段、content 压过 reasoning、`reset` 归零、中英文案六者互不相同）；`chat-session.test.ts` 补 3 例（按 SDK 事件时序推进、子 Agent 输出不覆盖主阶段、`send` 结束阶段归零）。
- pty 真机验收（本地 mock SSE 服务端按阶段分段吐流）：依次抓到「连接中…」→「排队中…（等待首 token）」→「思考中…」→「输出中…」→「调用工具 no_such_tool…」→「等待 sub_agent_default 返回…」；状态栏同期只有 `⚡ 4.2 tok/s` 与本轮 / 累计 token，无「生成中」。
- 新增 `src/agent-switch.test.ts`（10 例）、`src/mcp-command.test.ts`（6 例）、`src/tui/token-rate.test.ts`（20 例）、`src/tui/status-segments.test.ts`（17 例）、`src/tui/screens/input-row.test.tsx`（7 例）、`src/tui/text.test.ts`（18 例）；`input-editing.test.ts` 补 3 例「emoji 不被拆半个」的用例。
- `src/tui/screens.test.tsx` 增加状态栏三块顺序、块内不被拆、宽屏并排、以及「Ink 实际渲染行数 == `statusBarRows` 量出行数」的断言；`computeInputCursorPosition` 补「通知栏行数参与 y」的用例。
- `input-row.test.tsx` 里那条 `⚡` 用例同时断言「手算给 8、实测给 9」——本次改动的理由就在这两行里。

## [1.0.0-alpha.20] - 2026-10-27

### ✨ 新功能

- **对话屏支持鼠标滚轮滚动** —— 此前滚轮只能滚终端自己的回滚缓冲（`alternateScreen: false` 走内联渲染），滚上去看到的是历史帧快照，状态栏与输入框会直接滚出视野。
  - 新增 `src/tui/mouse.ts`：挂载时下发 `DECSET 1000`（按钮事件，含滚轮）+ `1006`（SGR 扩展坐标）；`mount()` 的退出、`farewell()`、信号与未捕获异常兜底**三处**都下发关闭序列，进程崩了也不会把 `^[[<64;…M` 喷进 shell。
  - `parseWheel()` 剥掉 Shift(4) / Meta(8) / Ctrl(16) 修饰位后取滚轮码（`64` 上、`65` 下），横向滚轮 `66` / `67` 直接忽略；一格滚 3 行。
  - 滚轮与 `PgUp`/`PgDn`、按行滚动共用同一套视口钳制 —— 抽出纯函数 `clampViewTop()`（`screens/layout.ts`），越界方向自然吃掉，返回 `null` 即贴底跟随最新内容。生成过程中滚动不会被拉回底部。
  - **`isTerminalReply()` 纳入鼠标序列**：点击 / 拖拽 / 滚轮一律在源头丢弃。这一步是必须的 —— Ink 会把整条 SGR 序列当 `char` 交给 `useInput`（实测为 `"[<64;10;5M"`，所有键标志位 false），不拦就会落进输入框变成正文。
  - 必须用 `1006`（SGR 坐标）而不是老的 X10 编码：后者被 Ink 的解析器拆成 `[M` + 三个普通字符两条事件，三个字符会直接被当正文插入（已实测）。
  - 启动屏「任意键跳过」不再把鼠标事件当成按键。

### 📝 文档

- README（中 / 英）键位表新增「鼠标滚轮」一行，并写明两个坑：开启上报后**拖选复制需按住 `Shift`**（回退到终端原生选择）；**`tmux` 用户需 `set -g mouse off`**，否则滚轮会先被 copy-mode 拦下。
- `docs/manifest.json`、`docs/{zh,en}/getting-started.md`、README 中的版本号与运行时依赖版本对齐（`agents-core ^4.5.2`、`agents-sdk 1.0.0-alpha.18`）。

### ⚠️ 已知取舍（终端机制使然，非缺陷）

- 鼠标上报是终端级开关：点击 / 拖拽不再交给终端做原生选择，复制需按住 `Shift`（iTerm2 / Windows Terminal / kitty 等均如此）。
- 应用内滚动只动视口，不产生终端 scrollback —— 想回看历史用滚轮 / `PgUp`，而不是终端的回滚条。
- 老版 Windows `conhost` 不支持 `1006`，滚轮在那种终端上表现为无反应。

### ✅ 测试

- 全量 **25 文件 / 316 例通过**（新增 `src/tui/mouse.test.ts` 1 文件 11 例；`screens.test.tsx` 新增滚轮解析、`clampViewTop` 钳制、启动屏鼠标守卫三组用例）。
- 真机（pty）端到端验证：滚轮方向解析、修饰位剥离、点击丢弃、普通打字不受影响、退出时下发关闭序列。

## [1.0.0-alpha.19] - 2026-10-22

### 🐛 修复

- **修复升级后首次启动报「Agent「default」未绑定模型」** —— alpha.18 把模型真相源改成 `AgentDefinition.modelId`，并把「为历史 Agent 补齐 modelId」放在 `bootstrap()` 里。但 TUI 的**续接会话**路径（`resumeLastSession()` 命中上一轮存档）根本不会经过 `resolveTarget()`，也就不会读取配置，于是 `bootstrap()` 从未执行：Agent 还是没绑模型、`config.defaultModel` 也还在，启动直接失败。
  - `runTui()` 开头显式 `await ensureConfigDir()`，配置初始化早于任何 Agent 读取；
  - `modelOf()` 自身也先读一次配置（双重保险），即使调用方漏了也不会再撞到这个错误。
- 新增回归测试：老配置（有 `defaultModel`、Agent 无 `modelId`）读一次配置后，模型被搬到 Agent 上、`config.json` 里的旧字段被清除。

### ✅ 测试

- 全量 **24 文件 / 299 例通过**。

## [1.0.0-alpha.18] - 2026-10-22

### 🐛 修复

- **修复「模型显示与实际请求不是同一个」导致的 401 死锁** —— 此前模型有三处来源：状态栏与会话存档里的 `modelId`、Agent 定义里的 `modelId`、以及配置里的 `defaultModel`。三者一旦分叉，就会：
  - 状态栏写着 `deepseek-flash`，请求实际发给 GLM，而 bigmodel 的 key 无效 → 看到 401；
  - 想切回 DeepSeek 时，`/model` 拿**显示层**的值判断，发现「已经是当前模型」直接返回，实际模型一个字都没改——于是怎么切都还是 401，只能删配置。

  现在模型**只存在 `AgentDefinition.modelId` 一处**，状态栏、凭据预检、上下文阈值与 SDK 实发请求全部读它。

### 🔧 行为变更（不兼容）

- **升级 `@ai-zen/agents-sdk` 至 `1.0.0-alpha.17`**：配置层不再有 `defaultModel`，缺失 `modelId` 的 Agent 会直接报错（默认 Agent 出厂自带 `deepseek-flash`）；历史配置升级时会把老的 `defaultModel` 搬进默认 Agent，不改变你正在用的模型。
- **会话存档不再记 `modelId`** —— 续接对话时模型完全由 Agent 定义决定；旧存档里的该字段读取时忽略。
- **`/model` 只写 Agent 定义** —— 不再有「Agent 未绑定就改全局默认模型」的分支。
- **切模型即重置思考强度** —— `AgentDefinition.modelParams` 在切模型时**直接清空**（不保留、不迁移、不逐键剔除），让目标模型走自己的 `defaultParams`。原因：思考参数是模型相关的，DeepSeek 关思考的 `thinking: {type:"disabled"}` 带到 GLM-5.3 上会被直接拒绝——此前会出现「一个不肯关思考的模型 + 一个说要关的参数」同时发出去。想调再用 `/think` 选一次。
- **配置中心移除「默认模型」项** —— 模型改在 Agent 详情页的「模型」字段里选（影响范围从「全局默认」变成「该 Agent」）。

### ✅ 测试

- 全量 **24 文件 / 298 例通过**。
- 新增 `model-switch` 用例：切换即清空 `modelParams`（不是只剔除思考键）、原本没有也不多写空对象。

## [1.0.0-alpha.17] - 2026-10-22

### 🔧 行为变更

- **升级 `@ai-zen/agents-sdk` 至 `1.0.0-alpha.16`（内含 core `4.5.2`）：模型参数不再能覆盖请求体的固定字段** —— core 之前把模型参数 spread 在请求体最外层，于是 `Model.defaultParams` / `AgentDefinition.modelParams` 里若出现 `model` / `messages` / `tools` / `stream` / `stream_options`，会静默覆盖框架自己填的值。最惨的是 `stream: false`：流式被关掉而调用方仍按异步流解析，整轮直接失败。现在固定字段永远胜出。
  - 对 `/think` 与思考档位**没有影响**：写入的都是 `thinking` / `reasoning_effort` 这类非固定键，照常透传。
  - 唯一需要注意的是别在 `modelParams` 里手写上面那五个键——写了也不会生效。

## [1.0.0-alpha.16] - 2026-10-22

### 🔧 行为变更（不兼容）

- **升级 `@ai-zen/agents-sdk` 至 `1.0.0-alpha.15`：思考档位不再「存档位名」，改存展开后的参数** —— 上一版把档位名写在 Agent 定义的 `reasoningEffort` 上，运行期由 SDK 查表翻译成请求参数。那等于把「什么叫 `max`」这件产品语义塞进了运行时。现在改成**配置即事实**：
  - `/think` 把选中档位的参数补丁直接写进 `AgentDefinition.modelParams`（如 `{"thinking":{"type":"enabled"},"reasoning_effort":"high"}`），SDK 只做一次 `{...defaultParams, ...modelParams}` 浅合并；
  - **旧 `reasoningEffort` 自动迁移**：读 Agent 定义时展开成 `modelParams` 并写回；模型没关联策略的只删旧字段（不会瞎猜参数）。
- **思考策略表的归属调整为「SDK 提供、CLI 使用」** —— 表的类型、出厂内容与读写放在 SDK（CLI 与桌面端共享同一份「智谱 5.3 只认 low/high/max」的知识），CLI 只负责**利用**它：限制 `/think` 的可选档位、把档位展开成参数写进 Agent。`Scope` 不再需要注入策略表。

### 🚀 新功能

- **状态栏档位改为「从生效参数反查」** —— 显示的就是真正会发给 API 的那几个参数匹配到的档位（模型默认参数也算），不再依赖 Agent 上的档位声明。三种状态：命中某档 → 「低/中/高…」；有 Agent 覆盖但匹配不上任何档位（手改过参数）→「自定义」；完全匹配不上 →「默认」。
- **`/config` →「模型」详情页的「思考策略」字段**继续可用，显示该策略及其档位（如 `zhipu-5.3（low / high / max）`），写错名字当场拦下。

### ✅ 测试

- `src/reasoning-effort.test.ts` 重写（19 例）：写入的是展开参数而非档位名、`max` → `off` 不残留 `reasoning_effort`、保留 `temperature` 等无关参数、`null` 清空后连 `modelParams` 一起删、往返一致（写进去能反查回原档位）。
- 新增 `src/agents-store.test.ts`（4 例）：旧 `reasoningEffort` 展开并写回磁盘、无策略时只删字段、无旧字段时不写盘、迁移后能反查回原档位。
- 全量 **24 文件 / 299 例通过**。

## [1.0.0-alpha.15] - 2026-10-22

### 🔧 行为变更（不兼容）

- **升级 `@ai-zen/agents-sdk` 至 `1.0.0-alpha.14`：思考能力改为声明式策略表** —— 上一版用 `Model.reasoning: { efforts, disable? }` 表达厂商差异，`disable` 一词双义、`off` 靠拼接、还用全局枚举假装各家档位等价。现在协议差异全部搬进一张表：
  - 新增 `~/.ai-zen/reasoning-presets.json`（首次启动自动释放，出厂三张：`openai` / `zhipu-5.3` / `deepseek`）；模型只记 `reasoningPreset` 这个名字；
  - `/think` 的可选档位改为读策略表 —— 表里有 `off` 才能关思考，没有就不给这个选项；
  - 模型没关联策略、或策略名在表里不存在 → 一律视为不可调档（状态栏 `—`），绝不把来路不明的参数发出去；
  - 档位中文标签改为「已知档位查表 + 未知档位名原样显示」，用户自建的档位名（如 `turbo`）不会显示成空白。
- `src/stdio-runner.ts` / `src/tui/chat-session.ts` 的 `TokenThresholds` 改为直接从 SDK 导入（此前是绕开 alpha.13 缺导出的派生类型）。

### 🚀 新功能

- **`/config` →「模型」详情页新增「思考策略」字段** —— 显示该模型当前引用的策略及其档位（如 `zhipu-5.3（low / high / max）`），可直接改成表里另一个策略名；写错名字当场拦下并列出可选策略，留空 = 不调档。自建模型从此能指向内置策略，不必手改 JSON。
- **策略表可自行编辑** —— 加一张表、调档位补丁都行；给某张表标 `"custom": true` 后 SDK 升级不再覆盖它，其余策略仍随 SDK 同步。

### ✅ 测试

- `src/reasoning-effort.test.ts` 重写（14 例）：可选档位 = 策略表的键、未知档位名原样显示、未关联策略/策略名不存在时抛错、状态栏在非法声明时回退「默认」。
- 配置向导新增 2 例：写入合法策略名、非法策略名被拦下且不写盘。
- 全量 **23 文件 / 290 例通过**。

## [1.0.0-alpha.14] - 2026-10-22

### 🚀 新功能

- **输入框键位对齐 Claude Code / readline** —— 编辑快捷键统一为业界通行的一套：
  - 按词操作：`Alt+B` / `Alt+F` 跨词移动（macOS 上 `Option+←/→` 发的就是 `ESC b` / `ESC f`，此前完全不响应）；`Alt+Backspace`、`Alt+D`、`Ctrl+Delete` 按词删除
  - 整段操作：`Ctrl+K` 删到行尾、`Ctrl+U` 删到行首、`Ctrl+W` **删到前一空白**（标点不切分，`src/utils/foo.ts` 一次删完）
  - kill ring：`Ctrl+Y` 取回刚删的文本，`Alt+Y` 循环取回更早的；`Ctrl+_` 撤销上一次输入编辑；`Ctrl+S` 暂存 / 恢复草稿
  - 移动与历史：`Ctrl+A` / `Ctrl+E` 行首 / 行尾，`Ctrl+P` / `Ctrl+N` 历史上下
  - 新增纯函数层 `src/tui/input-editing.ts`（`deleteToPrevWhitespace` / `killedText` / kill ring / 撤销栈），12 例单测
- **macOS 按键诊断** —— `AIZ_DEBUG_KEYS=1` 时把终端环境（`TERM` / `TERM_PROGRAM`）与每次按键（`input` + 修饰位 + `raw` 状态）写入 `/tmp/aiz-key-debug.log`（`AIZ_KEYS_FILE` 可改路径），用于定位「某个键在我机器上没反应」：没新行=键被系统截走，`flags` 不符=匹配逻辑问题，`raw=false`=按键被终端自己解释。
- **`/model` 切换当前会话的模型并写入配置** —— 无参弹模型选择器（标注当前），`/model <id>` 直切。写入位置按「会话模型真正的来源」决定：Agent 定义显式绑定了模型 → 改该 Agent 的 `modelId`；没绑定（走默认模型）→ 改 `config.json` 的 `defaultModel`。切换后重建 Scope 与会话（消息与上下文保留），状态栏模型名随之更新。判定逻辑抽为 `src/model-switch.ts`（`resolveModelWriteTarget` / `switchModel`，7 例单测）。
- **思考强度展示与切换（`/think`，别名 `/effort`）** —— 状态栏在模型名后展示当前强度（`关` / `极低` / `低` / `中` / `高` / `极高` / `最高`；模型可调但 Agent 未声明时显示`默认`，模型不可调时显示 `—`）。`/think` 无参弹选择器（标注当前）、`/think high` 直设、`/think default` 清除声明恢复跟随模型默认。
  - **档位存在 Agent 定义上**（`AgentDefinition.reasoningEffort`），不在模型上：同一个模型可以给编程 / 小说 / 闲聊三个 Agent 配不同强度，而模型的 `defaultParams` 不动。
  - **可选档位由模型能力决定**（`Model.reasoning.efforts`，SDK 按厂商官方文档声明）：智谱 GLM-5.3 系只有 `low/high/max` 且不能关（传 `medium` 或 `disabled` 会 400），DeepSeek 是 `off/low/high/max`，OpenAI 是 `off/minimal/low/medium/high`；模型没声明就一个档位都不给，绝不推测。
  - 读写与校验抽为 `src/reasoning-effort.ts`（`effortChoices` / `describeEffort` / `setAgentEffort`，9 例单测）。
- **SDK 日志接管** —— TUI 启动即 `setLogger()`，关掉 SDK 的 `console.log` 兜底（否则 `load_mcp` 的 manifest 会直写 stdout 撕裂界面）；`AIZ_DEBUG_SDK=1` 时改为落盘 `/tmp/aiz-sdk.log`（`AIZ_SDK_LOG_FILE` 可改路径），6 例单测。

### 🔧 行为变更（不兼容）

- **升级 `@ai-zen/agents-sdk` 至 `1.0.0-alpha.13`，上下文阈值改为结构体** —— `Model.maxContextTokens` 被 `Model.tokenThresholds: { handoff, guard }` 取代（`maxContextChars` 淘汰）：
  - `handoff`：交接软线，`prompt_tokens` 超过它触发任务交接；
  - `guard`：强行阻断硬线，每次请求**前**超过它即中断本轮并报错。
  - 两条线都是**绝对值**，`ContextGuardPlugin` 的 `ratio` / `suspendedRatio` / `isSuspended` 已从 SDK 删除——想调松就改数字。代价是交接回合不再有 2.0 倍额外放宽，出厂把 `guard` 配成 `handoff × 1.5`（375K）以留出缓冲。
  - 旧配置**自动迁移**：SDK 的 `ConfigManager.read()` 读到即迁（`maxContextTokens` → `handoff`，`maxContextChars` 按 `/4` 折算，缺 `guard` 按 1.5 倍补一次，旧键删除），检测到差异才写回磁盘。用户无需手改 `config.json`。
  - 配置中心里原来的「迁移阈值」一项拆成「交接阈值」与「阻断阈值」两行，并校验软线必须小于硬线。

- **`Ctrl+N` 由「换行」改为「历史下一条」** —— 换行改用 `Ctrl+J` / `Ctrl+Enter` / `Alt+Enter` / `Shift+Enter` / `\` + `Enter`
- **`Ctrl+V` 不再兼任「翻页」** —— 预留给 Claude Code 的「粘贴图片」；当前按下会提示暂未实现。翻页用 `PgUp` / `PgDn`，按行滚动用 `Shift+↑ ↓` / `Alt+↑ ↓`
- **`Ctrl+U` 由「清空整个输入框」改为「删到行首」** —— macOS 的 iTerm2 与 Terminal.app 会把 `⌘⌫` 映射成 `Ctrl+U`，原先的语义会让 Mac 用户一按 ⌘⌫ 就丢掉整段草稿；清空全部改由 `Esc` 负责
- **`Ctrl+C` 空闲时不再直接退出** —— 有草稿时先清空并提示，再按一次才退出
- **`Ctrl+D` 改为双击确认退出** —— 有草稿时改为 readline 语义（删光标后一个字符）
- **忙碌期（生成 / 迁移中）`Esc` 现在等于中断本轮**

### ⏳ 暂未实现

- **粘贴图片（`Ctrl+V`）** —— 需要先解决「文件 → 内容块」的端点能力探测（Files API 上传 vs base64 内联），不能把上传端点硬编码成某个 id；随后的 SDK 改造再做，本轮已把该功能代码移除，避免半成品上线。

### ✅ 测试

- 新增 `src/tui/input-editing.test.ts`（12 例）+ `src/tui/key-debug.test.ts`（4 例）+ `src/sdk-log.test.ts`（6 例）+ `src/model-switch.test.ts`（7 例）+ `src/reasoning-effort.test.ts`（9 例）+ 输入工具函数 8 例；全量 **23 文件 / 286 例** 通过，`tsc` 与 `build` 零错误。

### 📄 文档

- `README{,.zh}.md` 重写「键盘与终端兼容」小节：改为业界通行路线「Option 当 Meta + readline 系 Ctrl 键」，附 Apple Terminal / iTerm2 / VS Code / Ghostty 的具体设置路径；说明 `⌘` 需 kitty 键盘协议才会上报、`⌘⌫` 被终端映射为 `Ctrl+U` 的原因；补充按键诊断用法。`README{,.zh}.md` 与 `docs/{zh,en}/getting-started.md` 的命令表新增 `/model`、`/think`（含「配置文件来源」对照），`docs/manifest.json` 版本号同步。

## [1.0.0-alpha.13] - 2026-10-21

### 🚀 新功能

- **交接二次确认统一为「三选一」** —— 自动迁移、手动 `/migrate`、手动 `/handoff` 三条链路此前交互不一致（自动是 2 项选择器 + Esc 跳过；`/migrate` 是 yes/no 确认；`/handoff` 不询问）。现统一为同一个「交接方式」选择器：
  - **当前会话自己写交接文档**（`self`，保真 · 可核实真实状态）
  - **单独 Agent 写交接文档**（`summary`，独立摘要 · 快且省，不核实文件）
  - **不交接**（跳过本次；`Esc` 同效）

  命令后显式带 `self` / `summary`（如 `/migrate self`）时直接执行、不再询问。选择器抽为共用模块 `src/tui/screens/handoff-choice.ts`，三处复用同一份选项与文案。

### 🔧 修复

- **自动「不交接」的确认提示被覆盖** —— `notice` 通道只保留最新一条，原先「已跳过本次任务迁移」与「可随时 /migrate…」分两条推送，后者覆盖前者；现合并为单条，跳过确认可见。

### ✅ 测试

- 新增 `src/tui/screens/handoff-choice.test.ts`（5 例）：三选一取值顺序、`self`/`summary` 原样返回、「不交接」/`Esc` → `null`、标题透传。全量 **18 文件 / 237 用例**通过，`tsc` 与 `build` 零错误。

### 📄 文档

- `docs/{zh,en}/migration.md`「触发方式」同步为统一的三选一交互（手动命令均会先询问，除非显式指定执行者）；`docs/manifest.json`、`README{,.zh}.md` 版本号同步。

## [1.0.0-alpha.12] - 2026-10-20

### 🔧 修复

- **自动迁移后旧会话被覆盖、历史丢失** —— `ChatSession` 曾把会话 id 存两份（`this.currentId` 与 `ctx.currentId`）。手动 `/migrate` 与 `/new` 会同步两份，但**自动迁移**由 SDK 的 `AutoMigratePlugin` 直接驱动 `HandoffService.migrate()`，**不经过 `ChatSession` 的任何方法**，新 id 只写进了 `ctx.currentId`。于是 `ConversationPersistPlugin.getId()` 仍返回旧 id，迁移后第一次落盘就把 `prune` 产生的「系统提示 + 交接断点」写进**旧会话文件**，把已保存的完整历史覆盖掉（用户表现为「交接之后历史全没了，只剩交接文档」）。
  - 修法：`currentId` / `currentName` 改为**代理 `ctx` 的 getter/setter**，消灭双真相源——谁更新 `ctx` 都立刻生效。
  - `ConversationContext.currentId` 由 `string | undefined` 收紧为 `string`；`reset()` 中两行冗余双写随之删除。
- **测试污染**：`chat-session.test.ts` 的端到端用例会把交接文档写进 `<cwd>/.ai-zen/handoffs`，现改指临时目录并自动清理。

### ✅ 测试

- 新增 3 例：`ctx` 变更即时生效、赋值回写 `ctx`、端到端（真实 `handoffService.migrate()` 后 id 必须跟随；该用例在修复前会失败，已反向验证）。全量 **17 文件 / 232 用例**通过，`tsc`（含测试工程）与 `build` 零错误。

### 📄 文档

- `docs/{zh,en}/migration.md`「迁移链路」补充「会话 id 只有一个真相源」的约束与失效表现；`docs/manifest.json`、`README{,.zh}.md` 版本号同步。
- 依赖仍为 `@ai-zen/agents-sdk` `1.0.0-alpha.11`（本次无 SDK 改动）。

## [1.0.0-alpha.11] - 2026-10-20

### ⚠️ 依赖

- `@ai-zen/agents-sdk` `1.0.0-alpha.10 → 1.0.0-alpha.11`（`createCallMcpTool` 新增 `env` 参数为破坏性变更；CLI 不直接调用该工厂，无代码改动）。

### 🔧 变更（随 SDK）

- **`call_mcp_tool` 输出保护**：调用 MCP 工具时，文本输出超过 `maxToolOutput`（默认 32768 字符）会完整落盘为 `result.txt`，只返回警告 + 头尾预览，可用 `read` 分批读取——不再一次把上万字符灌进上下文。
- **图片 / 音频 / 二进制资源原样返回**：MCP 返回的 `image` / `audio` / `resource.blob` 转成 `image_url` / `file` 内容块透传（`resource.text` 并入正文、`resource_link` 转为可读线索），不再静默丢弃；媒体不受 `maxToolOutput` 约束。

### 📄 文档

- `docs/{zh,en}/mcp.md` 说明「仅文本受输出保护、媒体不受上限约束」；`docs/{zh,en}/getting-started.md`、`docs/manifest.json`、`README{,.zh}.md` 版本同步。

## [1.0.0-alpha.10] - 2026-10-20

### 💥 变更

- **交接与迁移拆成两条命令**（语义唯一，命名与实现对齐）：
  - **`/handoff`** —— 原 agent 停手、核实状态、把交接文档写到 `<项目>/.ai-zen/handoffs/`，**会话照旧**（不弹确认，可反复执行；交接回合留在 `agent.messages` 里，可继续要求细化同一份文档）；
  - **`/migrate`**（别名 `/migration`）—— 同一次交接 + 清历史 + 开新会话（需确认）。
  - 两条都支持 `self` / `summary` 参数（如 `/handoff summary`、`/migrate self`）跳过默认选择。
- **自动迁移改为「执行者三选一」选择器**：上下文超阈值时不再只问「是否迁移」，而是选择 **原 agent 自交接（默认高亮，保真）/ 独立摘要（便宜）/ 跳过本次**。选择器复用既有 picker 浮层（`setPickerState`）。非交互环境（管道、重定向、e2e）无选择通道，按默认执行者迁移，不阻塞、不额外输出。
- **交接文档目录**：新增 `PROJECT_HANDOFFS_DIR = <cwd>/.ai-zen/handoffs`，交接文档落在项目内，可随仓库共享/评审。

### ♻️ 重构

- **`src/migration-service.ts` → `src/handoff-service.ts`**：`createMigrationService` → `createHandoffService`，钩子从 `onBeforeMigrate` / `onMigrated` 改为 `onBeforeHandoff` / `onHandoff` / `onMigrated`。存档旧会话移到 `onHandoff`（此时已包含交接回合，归档可审计）；`/handoff` 不切换会话也因此不需要额外存档（`ConversationPersistPlugin` 每轮已落盘）。
- **`src/auto-migrate-confirm-plugin.ts` → `src/auto-migrate-confirm.ts`**：`AutoMigrateConfirmPlugin`（继承 + 重写 `onAfterSend`）退化为 `createAutoMigratePlugin()` 工厂——「何时迁移」仍在 SDK 插件里，「用谁交接」通过 SDK 新增的 `resolveMode` 回调注入，不再重复实现阈值判断。
- `src/agent-creator.ts` 抽出并导出 `listSkillDirs()`：Scope 装配与交接服务（读取 `handoff` Skill 正文）共用同一份目录优先级，避免两处各算一遍。
- `ChatSessionOptions.requestConfirm` → `requestMode`（返回 `HandoffMode | null`）；`ChatSession.migrate()` / `handoff()` 返回文档路径；`ConversationContext.migrationService` → `handoffService`。
- `ContextGuardPlugin` 接线 `isSuspended: () => handoffService.busy`：交接回合护栏从 `× 1.5` 放宽到 `× 2`。
- 斜杠命令解析支持参数：命令名取首个 token（`/migrate summary` 不再被当成未知命令）。

### ⚠️ 依赖

- `@ai-zen/agents-sdk` `1.0.0-alpha.9 → 1.0.0-alpha.10`（`TaskMigrationService` → `HandoffService` 为破坏性变更）。

### ✅ 测试

- 新增 `src/handoff-service.test.ts`（迁移清 `lastUsage` / 新会话落盘 / `/handoff` 不切会话）、`src/auto-migrate-confirm.test.ts`（非交互默认值、选择透传、取消跳过、busy 让行）。全量 **17 文件 / 229 用例**通过，`tsc --noEmit`（含测试工程）与 `build` 零错误。

### 📄 文档

- `docs/{en,zh}/migration.md` 重写为「任务交接与迁移」：两条命令的差异、两种执行者的取舍、自交接的代码级保障（守卫/放宽/防递归）、文档位置与命名、模板由 `handoff` Skill 承载（`metadata.custom: "true"` 退出同步、可项目级覆盖）、成本说明。网站镜像同步。
- `README.md` / `README.zh.md` 命令表与「任务交接与迁移」章节、`docs/{en,zh}/index.md` 特性与导航同步。

## [1.0.0-alpha.9] - 2026-10-14

### 🔧 修复

- **自动迁移与 CLI 的交互适配（两处）**：
  - **迁移期间输入框未真正拦住** —— 主输入 `useInput` 的 `isActive` 此前只挡「确认框 / 选择器 / 配置向导」，未挡「生成中」态。自动迁移在 `send()` 内 `await onAfterSend` 执行（`busy` 为真、输入框已被 Spinner 顶替），但按键仍会被静默吞进隐藏的输入缓冲、待本轮结束才浮现。现令主输入在 `busy` 时整体失活，另设「忙碌期」处理器仅放行 `Ctrl+C` 中止 / `Ctrl+D` 退出 / `PgUp`·`Shift+↑↓` 回看；`/migrate` 手动迁移同样纳入 `busy`。
  - **迁移完成后仍被总上下文护栏拦截** —— 迁移（prune）会物理重置上下文，却遗留 `agent.lastUsage`（迁移前那一次请求的 `prompt_tokens`）。`ContextGuardPlugin`（`onInnerLoopStart`，硬上限 `maxTokens × 1.5`）据此误判，迁移后第一条消息即被 `ContextOverflowError` 中断。现于迁移后清空 `agent.lastUsage`，护栏首轮无据可查而放行，待下一次响应以真实用量回填。

### ✅ 测试

- 新增 `src/migration-service.test.ts`：断言迁移后 `agent.lastUsage` 被清空（移除修复后该用例确会失败）。全量单测 **17 文件 / 227 用例**通过，`tsc --noEmit` 与 `pnpm build` 零错误。

## [1.0.0-alpha.8] - 2026-10-14

### 🔧 修复

- **修复长时间 TUI 会话内存无界增长导致的 OOM（崩溃）** —— CLI 入口此前从未设定 `NODE_ENV`，React 因而按 `process.env.NODE_ENV !== "production"` 载入 **development** 版 `react-reconciler`；该开发构建每次渲染都会调用 `performance.measure()`（User Timing API），而 Node 的 performance 条目缓冲**无上限、从不逐出**，长时间流式会话下条目持续累积，约 55 分钟即将堆顶到 `heap_size_limit`（本机 ~1GB）触发 OOM。现于 `src/index.ts` 顶部设 `process.env.NODE_ENV ||= "production"`；因 ESM 静态 `import` 会被提升到模块体之前执行，对 TUI 入口 `./tui/index.js` 改用动态 `import()`，确保 React/Ink 在 `NODE_ENV` 设定**之后**才被求值，从而加载 production 版 reconciler（该版不调用 `performance.measure`）。显式 `NODE_ENV=development` 仍保留开发构建，便于排查。

### ✅ 测试

- **端到端实证** —— 真实 ESM 下经入口加载 Ink 并连续重渲染 300 次：修复后 `performance.measure` 条目 **0 → 0**（production reconciler），显式 `NODE_ENV=development` 对照组 **0 → 905**（dev 埋点仍在）。全量单测 **16 文件 / 226 用例**通过，`tsc --noEmit` 与 `pnpm build` 零错误。

## [1.0.0-alpha.7] - 2026-10-14

### 📄 文档

- **状态栏 token 用量纳入文档** —— `docs/zh|en/index.md` 的「主要特性」补上「状态栏实时展示 模型 · Agent · 本轮/累计 token 用量 · 生成状态」（此前仅在 README 提及），累计口径为 `sumUsage(agent.messages)`（含所有层级的子 Agent）。
- 修正 `TODO.md` 中已过时的路径引用（`src/tui/config-wizard.tsx` → 目录 `src/tui/config-wizard/`）。

### ⚠️ 依赖

- `@ai-zen/agents-core` `^4.5.0 → ^4.5.1`、`@ai-zen/agents-sdk` `1.0.0-alpha.8 → 1.0.0-alpha.9`

> 纯文档修正，无代码变更。

## [1.0.0-alpha.6] - 2026-10-14

### ♻️ 重构

- **累计用量改用 SDK 的 `sumUsage`，移除 CLI 自建的内存累加器** —— 依赖 `@ai-zen/agents-sdk` `1.0.0-alpha.8` / `@ai-zen/agents-core` `4.5.0`：除助手消息的 `usage` 外，委派产生的用量现由 core 在委派边界钉到工具消息的 `subAgentUsage` 上。故 `ChatSession.totalUsage` 直接 `sumUsage(agent.messages)` 即可（含所有层级的子 Agent），删掉 `src/usage.ts` 与 `onSubAgentEnd` 内存回灌——子 Agent 开销随消息持久化，续接 / `/load` 亦不丢，且不再有双重计数风险。

### ⚠️ 依赖

- `@ai-zen/agents-sdk` `1.0.0-alpha.7 → 1.0.0-alpha.8`、`@ai-zen/agents-core` `^4.4.0 → ^4.5.0`

### ✅ 测试

- 移除 `src/usage.test.ts`（逻辑下沉 core，已由 core 覆盖）；`chat-session.test.ts` 的 `totalUsage` 用例改为覆盖「assistant 的 usage + 工具消息的 subAgentUsage」求和。全量单测 **16 文件 / 226 用例**通过，`tsc --noEmit` 与 `npm run build` 零错误。

## [1.0.0-alpha.5] - 2026-10-14

### 🚀 新功能

- **状态栏展示 token 累计消耗** —— 依托 `@ai-zen/agents-sdk` `1.0.0-alpha.7` / `@ai-zen/agents-core` `4.4.0` 为每条 assistant 消息钉上的 `usage`，新增 `src/usage.ts`（`addUsage` / `sumMessagesUsage` 纯函数）与 `ChatSession.totalUsage`：对本会话全部 assistant 消息的 `usage` 求和即计费口径的累计消耗；子 Agent 的 messages 不在父 Agent 中，故在 `onSubAgentEnd` 单独累加并入、`/new` 时归零。状态栏由「`{tokens} tok`」升级为「`本轮 x · 累计 y tok`」（本轮 = `lastUsage.total_tokens`，累计 = `totalUsage.total_tokens`）。
- **依赖升级** —— `@ai-zen/agents-sdk` `1.0.0-alpha.6 → 1.0.0-alpha.7`、`@ai-zen/agents-core` `^4.3.2 → ^4.4.0`（后者新增 `AgentNS.Message.usage` 逐条 token 用量）。

### ✅ 测试

- 新增 `src/usage.test.ts`（4 例）；`chat-session.test.ts` 增补 `totalUsage` 求和用例；`screens.test.tsx` 的 `StatusBar` 用例更新。全量单测 **17 文件 / 230 用例**通过，`tsc --noEmit` 与 `npm run build` 零错误。

## [1.0.0-alpha.4] - 2026-10-13

### ♻️ 重构

- **TUI 渲染直接以 `agent.messages` 为唯一数据源** —— 移除 `ChatEvent` / `chatReducer` / `LiveAssistant` / `Block` / `messagesToBlocks` 等自定义中间模型。SDK 在流式期间会**实时更新 `agent.messages`**（`Agent.parseStreamData` 把每个 delta 增量写进当前那条 message），因此跨消息顺序（数组序）与单条 assistant 内部顺序（`思考 → 工具 → 正文`）天然保持，直接渲染即可，杜绝「第二套真相」的失真与维护负担。已完成消息的折行 / 高亮按「消息 + 列宽 + 内容签名」缓存（`cachedMessageToLines`），流式中那条靠内容签名自动失效。
- **notice / error 改为独立栏位** —— 系统级提示（命令反馈 / 迁移进度 / 报错）不再混入对话转录，也**绝不写进 `agent.messages`**（那会被 `formatHistory()` 原样发给模型、污染上下文）；改在输入框上方的独立一行渲染（`src/tui/screens/notice.ts`）。

### 🎯 优化

- **流式增量渲染**：Ink 开启 `incrementalRendering` —— 从「每帧 erase 整屏 + 重写整屏」（`createStandard`）切到「只重绘变化的行」（`createIncremental`），每帧输出量由 O(屏幕大小) 降到 O(变化量)，SSH / 弱网下流式更稳。
- **流式合帧**（`src/tui/screens/frame-buffer.ts`）：内容变更先攒入缓冲，按 60ms（约 16fps，低于 Ink 默认 30fps 输出节流）批量触发重渲染，把上屏频率从「每个 delta 一次」降到固定帧率。
- **渲染缓存**：长对话下历史消息的折行 / 高亮免于每帧重算，成本不再随对话增长而恶化。
- **思考与工具调用之间补一个空行**，排版更清晰。

### ✅ 测试

- 新增 `frame-buffer.test.ts`、`notice.test.ts`；`screens.test.tsx` 重写为基于 `messageToLines` / `transcriptLines` / `computeChatLayout(transcript)`。
- `tsc` 零错误；全量单测 **16 文件 / 225 用例**通过；`npm run build` 通过。
- 真机（pty）验证：SSH / 弱网下流式稳定，长对话滚动流畅。

## [1.0.0-alpha.3] - 2026-10-13

### 💥 破坏性变更

- **内置工具改名（统一 `snake_case`：多词收敛、单词简化）** —— 随 `@ai-zen/agents-sdk` `1.0.0-alpha.6` 落地：SDK 将内置工具名统一为 `snake_case`，并把单词工具简化为单词 —— `readFile` → `read`、`writeFile` → `write`、`exec_async` → `spawn`、`findText` → `find_text`、`batchEdit` → `batch_edit`、`inspectFile` → `inspect_file`、`downloadFile` → `download_file`、`generateImage` → `generate_image`、`viewImage` → `view_image`、`indexedSearch` → `indexed_search`；工具类名同步为 `ReadTool` / `WriteTool` / `SpawnTool`。**若你在 Agent 定义、权限白名单（`tools.allow` / `tools.deny`）或自定义提示词里引用了旧工具名，请同步更新为 `snake_case` 新名**（旧名仅保留在 CHANGELOG 历史条目中）。

### 🚀 新功能

- **正文 / 思考按 Markdown 源码着色** —— AI 回答本身即 Markdown，现交给 `highlight.js` 的 `markdown` 词法着色：标题（`#`）、粗体、斜体、行内代码、列表、引用、链接各有配色；**围栏代码块保留围栏行**（开 / 闭围栏以低调暗灰渲染）并继续按标注语言做语法高亮。标记符（`#` / `**` / 反引号 等）**原样保留、只染色**（源码着色，非语义渲染）。正文用**空格优先折行**，避免把英文单词从中间切断。

### 🎯 优化

- **正文默认文本色改用终端默认前景色** —— 此前正文基础色写死近白 `#e2e8f0`，在**亮色主题终端**里会「白底白字」看不见。现正文（含未指定颜色的默认分段）一律回落**终端默认前景色**，绝对色只留给标题 / 代码等强调项；同步移除语法色板里两处近白 token 色（`variable` / `params`）。

### ⚠️ 依赖升级

- **`@ai-zen/agents-core` 升至 `^4.3.2`、`@ai-zen/agents-sdk` 升至 `1.0.0-alpha.6`** ——
  - core `4.3.1`：**中断的并行工具轮次归一化** —— 一轮回复里并行调用的多个工具若被中断（`Ctrl+C`），未完成的工具结果会在历史里被补齐 / 归一，避免下一轮因 `tool_calls` 数量与实际工具结果数量不匹配而被服务端拒绝（默认 `fill`：保留 assistant 正文并补齐未完成结果）。
  - core `4.3.2` / sdk `1.0.0-alpha.4…6`：内置工具统一 `snake_case` + 单词简化、`exec_async` → `spawn`、类名对齐（见「破坏性变更」）。
  - CLI 侧仅同步工具名（文档 / 测试 fixture / 提示语），运行时行为全量委托 SDK，无需其它适配。

### ✅ 测试

- `tsc --noEmit`（`tsconfig.test.json`）零错误；全量单测 **15 文件 / 235 用例**通过
- 修复 `config-wizard.test.tsx` 两个预存失败：为向导注入终端尺寸（新增可选 `terminalSize` prop），消除 `ink-testing-library` 假 stdout 缺 `rows` 时 `terminal-size` 探测本机行数、把吸底帧撑到 38 行的干扰
- 渲染核验：标题 / 粗体 / 行内代码 / 列表 / 引用 / 链接与围栏代码块均按预期着色，普通正文无颜色（回落终端默认）

## [1.0.0-alpha.2] - 2026-10-03

### ⚠️ 依赖升级

- **`@ai-zen/agents-sdk` 升至 `1.0.0-alpha.3`** — 拉取 SDK 对内置工具 `generateImage` 参数描述的修正。原描述写着「配置中的图片模型可通过 `aiz config show` 查看」，等于**指路让模型去执行宿主 CLI 命令**；而**工具描述会随每次请求的 `tools` 字段进入每一层 agent 的上下文**——模型据此 `exec("aiz config show")`，CLI 又把这条命令解析为**纯 stdio 模式**、以 `config show` 为提示词**再拉起一个 agent**，其工具描述里又是同一句指引，遂形成**自指型递归**（每层都真连 API，越套越深）。SDK 现已把该描述改为「若指定的模型不存在，本工具会返回当前可用的模型列表」，与 `call()` 的实际行为一致，且不再引导模型去执行宿主 CLI。该版本**无破坏性变更**，CLI 源码无需适配（类型 / 默认配置全量委托 SDK，版本横幅由实际安装版本读取，工具清单由 SDK 静态注册表自动发现）。

### 📝 文档

- `docs/zh|en/getting-started.md`：运行时依赖版本同步为 `@ai-zen/agents-sdk` `1.0.0-alpha.3`
- `docs/manifest.json`：版本号同步为 `1.0.0-alpha.2`
- 中英 README 启动横幅示例版本同步为 `v1.0.0-alpha.2`

### ✅ 测试

- `tsc --noEmit`（`tsconfig.test.json`）与 `npm run build` 零错误
- 全量单测 13 文件 / 224 用例通过

## [1.0.0-alpha.1] - 2026-09-30

> 本版本汇总**相对上一发布版本 `0.9.0`** 的全部变化。

### 💥 破坏性变更

- **启动命令由 `aiz` / `zen` 改为 `ai`** —— `package.json` 的 `bin` 改为 `{ "ai", "aiz", "zen" }`；`aiz` / `zen` 作为**过渡别名**保留，未来版本移除。
- **引入双模式运行，两种模式互不混合** —— 带位置参数、或 stdin/stdout 非 TTY（管道 / 重定向 / CI）时启用**纯 stdio 模式**：无任何额外交互，最终 assistant 文本以纯文本写入 `stdout`（零 ANSI / emoji 前缀 / spinner），日志、进度、工具过程与错误摘要一律走 `stderr`，成功退出码 `0`、失败非 `0`、默认不落盘；仅在**无参数且 stdin/stdout 均为 TTY** 时进入 **TUI 模式**。
- **交互界面整体重写为 Ink（React）全屏 TUI** —— 取代原 inquirer 行式对话；随之**移除主菜单**（`/menu` 与 `src/menus/*`）以及 `inquirer` / `@types/inquirer` / `chalk` 依赖。

### ✨ 新增

- **TUI 全屏交互界面（Ink + React）**：
  - 动画渐变 ASCII 启动界面，结束后直接进入对话（有上一轮会话则自动续接）；
  - 对话区**吸底**（分隔线 / 输入行 / 状态栏固定底部，整帧高度恒为「终端行数 − 1」以避开 Ink 全屏分支）；
  - 流式输出（思考 / 正文 / 工具调用分行）、历史按行裁剪自底滚动；
  - **多行输入**（`Enter` 发送、`Ctrl+N` / `Ctrl+J` 换行）与**光标编辑**（`←`/`→`/`Home`/`End`/`Backspace`/`Delete`，`Ctrl`/`Meta` + `←`/`→` 跨词，反显光标 + 硬件光标同步）；
  - **应用内翻页**（`PgUp`/`PgDn` 翻页、`Shift`/`Alt` + `↑`/`↓` 单行滚动、发送自动回底）；
  - 输入历史、内联 `/` 命令菜单、状态栏、确认框。
- **语法高亮**：工具调用参数按 **JSON** 高亮、正文与思考里的**围栏代码块**按语言高亮。高亮**数据**委托 `highlight.js`（经 `lowlight` 产出 hast），CLI 仅把 `hljs-*` scope 映射为 Ink `<Text>` 颜色 —— 与同为 Ink/React 的 Google Gemini CLI 做法一致。
- **对话内命令**：`/help`、`/load`、`/clear`、`/new`、`/save`、`/config`、`/key`、`/migrate`、`/back`、`/editor`、`/exit`（`registry.ts` 为命令清单唯一来源，`/help` 与输入补全自动同步）。
- **首启凭据引导 + 配置中心（Ink 原生）**：端点缺 API Key 时先弹凭据设置屏；`/config` 配置中心管理端点、模型、图片模型、默认项（默认模型 / 图片模型 / Agent / 迁移模型）、工具输出上限、**MCP 服务器**（全局 / 项目作用域）与 **Agent 定义**（顶层 Agent + Sub-agent，含四维权限）；编辑「出厂托管」条目自动转 `custom: true`，危险操作二次确认并做引用守卫。
- **多行文本走系统编辑器**：Agent 提示词、Sub-agent 函数说明 / 参数 schema 等多行字段按 `Enter` 调起 `$EDITOR`（Windows 默认 `notepad`）；参数 schema 以 `.json` 打开并即时校验。
- **会话持久化改革：会话即文件 + 单指针** —— 每轮结束落盘、`cli/last-session.json` 记录上一轮会话 id、首条消息后才落盘、`/save` 幂等；继续 / 加载时按消息重建历史。
- **纯 stdio 模式配套**：`ai --help` / `-h`、`ai --version` / `-v`、`ai --save`；SDK 日志与 `console.log` 统一改道 `stderr` 以保证 stdout 纯净。
- **IME 候选框跟随光标**：用 Ink `useCursor()` 把硬件光标同步到编辑光标，中文输入法候选框正确定位。

### 🔧 变更

- **依赖**：新增 `ink` / `react`（运行时）、`ink-testing-library` / `@types/react`（开发）；新增语法高亮 `highlight.js` / `lowlight`（运行时）与 `@types/hast`（开发）；**移除** `inquirer` / `@types/inquirer` / `chalk`。
- **升级 `@ai-zen/agents-sdk`**：`1.0.0-alpha.0` → `1.0.0-alpha.1` → `1.0.0-alpha.2`（出厂模型目录刷新、模型清单托管、默认 `mcp.json` 增补 `chrome-devtools` 等；CLI 侧代码零改动）。
- **TUI 输出统一走 Ink**：迁移进度、会话落盘失败等提示不再 `console.log` / `console.warn` 直写终端（会撕裂 Ink 帧），改为经回调渲染为 notice 块；启动 Logo 渐变也改为 Ink 逐字符 `<Text color>`。
- **配置向导 / 覆盖层统一「吸底」布局**，列表项与键位提示裁成**严格单行**，修复 VS Code 终端里内容被裁切的问题。
- **终端状态安全与干净退出**：`SIGINT` / `SIGTERM` / 未捕获异常均卸载 Ink、恢复 raw mode 与光标；`Ctrl+C` 语义为「忙时取消本轮、空闲时退出」；退出显式暂停 stdin 并终止进程（`farewell()`）。
- **移除旧行式链路（死代码）**：`src/conversation-runner.ts`、`src/slash-hint-prompt.ts`、`src/delta-renderer.ts`、inquirer 版 `src/config-wizard.ts`、`src/draft-*.ts` 等；新增 `src/mode.ts` / `src/stdio-runner.ts` / `src/session-pointer.ts` / `src/conversation-persist-plugin.ts` / `src/config-editor.ts` 与 `src/tui/*` 新实现。
- 文档：中英 README 与 `docs/zh|en/*` 同步（运行模式、`ai` 命令名、配置中心、多行编辑器等），`docs/manifest.json` 同步。

### ✅ 测试

- 全量单测 **13 文件 / 224 例**，`tsc --noEmit` 与 `npm run build` 零错误；e2e **12 例**真连 DeepSeek API（覆盖双模式、stdio 纯净性、退出码、`--save` 落盘）。
- 新增测试文件：`mode.test.ts`、`stdio-runner.test.ts`、`theme.test.ts`、`screens.test.tsx`、`tui/config-wizard.test.tsx`、`tui/agent-prompt.test.tsx`、`tui/highlight.test.ts`、`sub-agent-guard-plugin.test.ts`、`auto-migrate-confirm-plugin.test.ts`、`conversation-commands/registry.test.ts`。
- 真实 PTY 实测：启动 → 对话 → 流式 → `/load` → `/clear` → 退出交还 shell；首启凭据链路；配置中心各子屏。

## [0.9.0] - 2026-09-30

### 💥 破坏性变更

- **升级 `@ai-zen/agents-sdk` 到 `1.0.0-alpha.0`（Provider → Scope 架构重构）** — SDK 1.0.0-alpha.0 将全局入口对象 `Provider` 改名为 `Scope`，把四类能力来源疏散为 5 个可组合的 `ScopePlugin`，并移除 `Provider.create()`（改为显式装配）。CLI 侧同步适配 `src/agent-creator.ts`：
  - 导入 `Scope` / `allInOne` 取代 `Provider`
  - `Provider.create({ config, agentsDir, subAgentsPaths, skillsPaths, toolsPaths, mcpPaths })` → `new Scope({ config, agentsDir }).use(...allInOne({ subAgentsPaths, skillsPaths, toolsPaths, mcpPaths }))` + `await scope.init()`
  - 单例/工厂改名：`getProvider` → `getScope`、`resetProvider` → `resetScope`；`createAgent` 内部改调 `sdkCreateAgent(scope, agentId)`
  - 依赖声明由 `^0.12.0` 改为精确 `1.0.0-alpha.0`（alpha 阶段锁定）

### 📝 文档

- 中英 README 与 `docs/zh|en/{tools,mcp,skills}.md`：`Provider` / `getProvider()` 同步为 `Scope` / `getScope()`
- `docs/zh|en/getting-started.md`：运行时依赖版本同步为 `@ai-zen/agents-sdk` `1.0.0-alpha.0`
- `docs/manifest.json`：版本号同步为 `0.9.0`

### ✅ 测试

- `tsc --noEmit`（`tsconfig.test.json`）与 `npm run build` 零错误
- 全量单测 9 文件 / 74 用例通过
- e2e 6 用例通过（含真实 DeepSeek API 对话，验证 CLI → SDK `1.0.0-alpha.0` → API 全链路）

## [0.8.2] - 2026-09-29

### ⚠️ 依赖升级

- **`@ai-zen/agents-sdk` 升至 `^0.12.0`** — SDK 0.12.0 新增内置工具 `inspectFile`（内置工具类 19 → 20）、`readFile` 的 `range` 分批读取参数，新增配置项 `maxToolOutput`（缺省 32768 字符）与工具输出保护行为，并精简了 `batchEdit` 的输出。该版本**无破坏性变更**，CLI 源码无需适配：类型与默认配置全量委托 SDK，`src/version.ts` 由实际安装版本读取，工具清单由 SDK 静态注册表自动发现，故版本横幅随之显示 sdk `0.12.0`

### 📝 文档

- 同步内置工具计数 19 → 20：中英 README、`docs/zh|en/tools.md`、`docs/zh|en/index.md` 与 `docs/manifest.json`
- 工具表补充 `inspectFile`（勘察文件结构概况），并为 `readFile` 补注 `range` 参数
- `docs/zh|en/tools.md` 新增「输出保护」说明：超限时 `exec` / `findText` / `glob` / `ls` 落盘并返回警告，`readFile` / `inspectFile` 仅警告不落盘
- `docs/zh|en/getting-started.md` 的运行时依赖版本同步为 `@ai-zen/agents-sdk` `^0.12.0`

### ✅ 测试

- 沿用既有 9 文件 / 74 用例，全部通过；`tsc --noEmit` 与 `npm run build`（`0.8.2`）均通过

## [0.8.1] - 2026-09-28

### 🚀 新功能

- **Skill 子 Agent 纳入子 Agent 上下文护栏与流式渲染** — 依托 SDK 0.11.0 将 `call_skill_sub_agent` 统一到 `AgentToolLazy`，技能子 Agent 自此与常规 SubAgent 共享同一套委派边界（`onSubAgentStart` / `onSubAgentEnd` 钩子与 `sub-agent-start` / `sub-agent-end` 事件）。故 0.8.0 引入的 `SubAgentGuardInstallerPlugin` 与子 Agent 流式渲染**自动覆盖**该路径，本次 CLI 无源码改动（0.8.0 CHANGELOG「覆盖范围」中「技能子 Agent 不在覆盖范围」的说明随之失效）

### ⚠️ 依赖升级

- **`@ai-zen/agents-core` 升至 `^4.3.0`、`@ai-zen/agents-sdk` 升至 `^0.11.0`** — `src/version.ts` 由实际安装版本读取，版本横幅随之显示 core `4.3.0` / sdk `0.11.0`。SDK 0.11.0 的破坏性变更（`createCallSkillSubAgentTool` 移除第三参 `provider`）仅影响直接调用该工厂函数的代码；CLI 经 `Provider.instantiate` 间接使用，无需适配

### ✅ 测试

- 沿用既有 9 文件 / 74 用例，全部通过；`tsc --noEmit` 与 `npm run build`（`0.8.1`）均通过

## [0.8.0] - 2026-09-28

### 🚀 新功能

- **子 Agent 上下文护栏（`SubAgentGuardInstallerPlugin`）** — 补上「主 Agent 有护栏、子 Agent 无护栏」的缺口（新增 `src/sub-agent-guard-plugin.ts`）：
  - **背景**：SDK 的子 Agent 由 `AgentTool` / `AgentToolLazy` 在委派时 `new Agent({...})` 构建，新建实例不携带任何插件（`Agent._plugins` 每实例私有，不向子 Agent 传播），且子 Agent 走 `run()` 而非 `send()`（`onBeforeSend` / `onAfterSend` 不会触发）——因此主 Agent 上的 `ContextGuardPlugin` 与自动迁移插件对子 Agent 完全无效，子 Agent 的内循环没有约束
  - **介入点**：core 4.2.0 的 `onSubAgentStart` 钩子在「子 Agent 已构建、尚未 `run()`」时由宿主 Agent 分发，载荷携带子 Agent 实例；`use()` 只是把插件推入 `_plugins`，而钩子分发每次都实时遍历该列表，故在钩子内安插对**本次 `run()` 立即生效**（无需 `init()`，`AgentTool` 也不调用子 Agent 的 `init()`）
  - **约束口径**：把主 Agent 同款的 `ContextGuardPlugin` 装到子 Agent 上——同一 `maxTokens`（当前模型 `maxContextTokens`）、同样不传 ratio（沿用 SDK 默认 1.5），使「上下文 token 超过 `maxTokens` × 1.5 即中断」对子 Agent 同样成立；**不设轮次上限、不设工具调用次数上限**（仅此一项限制）
  - **中断语义为「软中断」**：子 Agent 的 run 立即结束，异常经 `AgentTool` 的 `finally`（分发 `onSubAgentEnd`）上抛至父 Agent，而父 Agent 默认 `allowJsonParseError = true`，故被降级为一条工具结果文本（`执行工具 X 时出错: …`），父 Agent 继续下一轮——停掉烧钱的子 Agent，但不终止用户对话
  - **递归覆盖**：安装器在委派时把自身一并装给子 Agent，故子 Agent 再委派（孙级）同样受约束（默认 SubAgent 定义为 `subagents: deny`，该路径默认不触发，仅在放开递归时生效）
  - **覆盖范围**：仅 core 的 `AgentTool` / `AgentToolLazy` 两条委派路径（均分发 `onSubAgentStart`）；SDK 的 `call_skill_sub_agent`（技能子 Agent）不分发该钩子，本次不覆盖

### ⚠️ 依赖升级

- **`@ai-zen/agents-core` 升至 `^4.2.0`、`@ai-zen/agents-sdk` 升至 `^0.10.0`** — `src/version.ts` 由实际安装版本读取，版本横幅随之显示 core `4.2.0` / sdk `0.10.0`；SDK 0.10.0 新增的 `load_mcp` `include_manifest` 开关为向后兼容的可选参数（默认 `true`，行为与升级前逐字一致），CLI 无需适配

### 🔧 修复

- **子 Agent 事件对齐 core 4.2.0 的改名与载荷结构** — core 4.2.0 将事件 `sub-agent` 更名为 `sub-agent-start`，载荷由 `{ agent: 子 Agent, ctx }` 改为 `SubAgentContext = { agent: 主 Agent, subAgent: 子 Agent, toolCallContext }`。`src/conversation-runner.ts` 同步适配：事件监听与注销改用 `sub-agent-start`（此前监听旧名将不再触发，子 Agent 流式渲染会静默失效）；子 Agent 实例改取自 `subAgent` 字段，工具名改取自 `toolCallContext.tool_call.function.name`（此前读取已不存在的 `ctx` 字段会在 `sub-agent-end` 回调中抛错）

### ✅ 测试

- 新增 `src/sub-agent-guard-plugin.test.ts`（6 个用例）：安装器的装载清单与「不拒绝委派」、安插后对本次 `run()` 立即生效（无需 `init()`）、用量恰好等于硬上限时放行、首轮无 usage 数据时放行、阈值随传入 `maxTokens` 变化、孙级传染
- `tsc --noEmit` 类型检查、全量单测与 `npm run build` 通过（74 passed / 9 files）

## [0.7.0] - 2026-09-20

### 🚀 新功能

- **自动迁移二次确认** — 上下文 token 超限触发的自动迁移不再静默执行，迁移前先向用户确认（新增 `src/auto-migrate-confirm-plugin.ts`）：
  - `AutoMigrateConfirmPlugin` 继承 SDK 的 `AutoMigratePlugin`，**仅在「超阈值」与「调用迁移」之间插入一次确认**：阈值判断、迁移调用与错误处理仍复用基类，实际迁移仍委托共享的 `migrationService`（与 `/migrate` 同一条链路）——即 SDK 侧「只负责触发」的语义不变，确认是 CLI 层的增量
  - 确认框展示当前用量与阈值（如 `260000/250000 tokens`）并说明影响（生成交接文档 → 保存当前对话 → 开启新会话继续），**默认「是」**（回车即迁移，与 `/migrate` 默认值一致）
  - 选择「否」仅跳过**本次**迁移，不记录隐式状态：当前对话不受影响（历史未被剔除），可继续提问或随时 `/migrate`；仍处超限状态时下次发送后再次询问，并提示继续增长至严重超限会被 `ContextGuardPlugin` 中断
  - **非交互环境不询问**：仅在 stdin 与 stdout 均为 TTY 时弹出确认框；管道、重定向、e2e 脚本无确认通道，保持既有静默自动迁移行为（不阻塞等待输入、不额外输出，管道语义不变）
  - 对话装配处（`src/conversation-runner.ts`）改注册 `AutoMigrateConfirmPlugin`，其余插件（`ContextGuardPlugin` 护栏位置）不变
- **对话内命令提示** — 对话输入行键入 `/` 即实时列出可用命令及说明，继续输入按前缀收敛候选，无匹配时提示「无匹配命令（输入 /help 查看全部）」：
  - 新增 `src/slash-hint-prompt.ts`：继承 inquirer 的 input 提示并覆写 `render`，将候选命令作为底栏（`bottomContent`）交由 inquirer 的 `ScreenManager` 渲染，复用其折行、终端缩放、擦除与光标归位处理，渲染表现与其它提示一致
  - **仅提示，不改变提交语义**：回车始终提交输入原文，命令仍由 `dispatchCommand` 按完整名称精确匹配分发（不做前缀补全、不做高亮选择）
  - 非 TTY 环境（stdin/stdout 重定向、e2e 脚本）自动不渲染提示，退化为普通输入行，既有输出行为不变
  - 普通聊天内容（非 `/` 开头）不产生任何提示
- 对话主循环输入改由 `src/slash-hint-prompt.ts` 的 `askInput()` 提供（`src/conversation-runner.ts` 不再直接构造输入提示）

### 🎯 优化

- **对话命令清单收敛为唯一来源** — 新增 `src/conversation-commands/registry.ts` 集中声明命令名、别名与说明，由分发（`index.ts`）、帮助（`help.ts`）与输入提示三处共用：
  - **别名不再重复登记**：registry 声明的别名由 `index.ts` 自动展开为处理函数表的键；registry 声明了命令却未注册处理函数时于启动阶段即报错（fail-fast）
  - `/help` 输出改由 registry 渲染，命令列按最长命令串对齐，与输入提示列宽一致（命令与说明文案保持不变）
  - `getCommandNames()` 迁至 registry，`conversation-commands/index.ts` 原样再导出，调用方无需改动

### ⚠️ 依赖约束

- **引用了 inquirer 内部模块** `inquirer/lib/prompts/input.js` — inquirer 9 未导出 BasePrompt/InputPrompt，实现命令提示底栏只能深层导入（inquirer@9 的 `package.json` 无 `exports` 字段，ESM 深层导入已在 Node 26 + inquirer 9.3.8 下实测可用）。类型声明见 `src/typings/inquirer-internals.d.ts`；**升级 inquirer 主版本时须回归验证该模块路径与 `render` 行为**
- **未新增运行时依赖**，`pnpm-lock.yaml` 不变

### ✅ 测试

- 新增 `src/auto-migrate-confirm-plugin.test.ts`（阈值判断、确认与拒绝分支、非交互降级、TTY 判定与默认确认文案）
- 新增 `src/slash-hint-prompt.test.ts`（提示文本生成 + 底栏渲染，覆盖 TTY / 非 TTY / 已提交 / 错误行分支）
- 新增 `src/conversation-commands/registry.test.ts`（元数据、别名折叠、前缀匹配、命令分发与别名等价）
- `tsc` 类型检查与全量单测通过（68 passed / 8 files），`npm run build` 成功
- 构建产物在真实 TTY 下实测：输入 `/` 列出全部命令、`/b` 收敛为 `/back`、回车提交原文且提示行正确擦除；`/help` 输出格式与列宽正常

## [0.6.3] - 2026-09-01

### 🔧 修复

- **修复迁移后旧消息既未标记 omit 也未物理删除的问题（依赖升级）** — 上游 `@ai-zen/agents-sdk` 0.9.3 修复 `createAgent` 直接引用 `definition.messages` 导致对话 `append` 反向污染 Agent 定义模板的缺陷；此前该缺陷使任务迁移 `prune`/`omit` 策略失效（旧消息不被清理、却能注入断点消息）
- **恢复草稿/已保存对话时拷贝消息数组** — `src/agent-creator.ts` 由直接引用改为 `agent.messages = [...messages]`，避免后续 `append` 改写草稿/对话存档的内存数组
- **依赖跟随升级** — `@ai-zen/agents-sdk` 至 `0.9.3`（借助 caret 范围自动解析）

### ✅ 测试

- `tsc` 类型检查与全量单测通过（37 passed / 5 files）

## [0.6.2] - 2026-08-31

### 🎯 优化

- **启动版本 banner 增强** — 新增 `src/version.ts`，统一从实际安装包读取版本号（而非依赖声明中的版本范围）；主菜单版本行由仅打印 CLI 版本扩展为同时展示 CLI / SDK / Core 三版本，例如 `AI-Zen CLI v0.6.2 · SDK 0.9.2 · Core 4.1.0`
- **适配 `@ai-zen/agents-core` 4.1.0 类型变更** — 上游将 `AgentNS.Message.id` 由可选改为**强制必填**（构造时自动生成）。`src/menus/agents.ts` 与 `src/conversation-commands/back.test.ts` 中直接构造的裸消息对象改用 `Message` 内置工厂方法创建（`Message.System` / `Message.User` / `Message.Assistant`，以及 `new Message(...)`），由 core 统一生成消息 `id`
- **依赖跟随升级** — `@ai-zen/agents-sdk` 至 `0.9.2`、`@ai-zen/agents-core` 至 `4.1.0`（借助 caret 范围自动解析）

### ✅ 测试

- 依赖升级后 `tsc` 类型检查与全量单测通过（37 passed / 5 files），`npm run build` 成功

## [0.6.1] - 2026-08-28

### 🎯 优化

- **升级 `@ai-zen/agents-sdk` 到 0.9.0** — 迁移服务新增 `strategy` 开关：
  - **`omit`（默认）**：历史消息标记 `omit: true` 保留可审计，追加「对话断点」消息为新上下文起点
  - **`prune`（CLI 采用）**：物理剔除历史，仅保留系统提示 + 交接断点（即先前替换行为）
  - CLI `migration-service.ts` 显式启用 `strategy: "prune"`，与端侧「迁移后开启新会话」的产品语义一致，**对外使用无差异**

### ✅ 测试

- 依赖升级后单测全量通过（37 passed），`tsc --noEmit` 零错误

## [0.6.0] - 2026-08-24

### 💥 破坏性变更

- **升级 `@ai-zen/agents-sdk` 到 0.8.0** — 任务迁移能力在 SDK 内完成重构（详见 SDK CHANGELOG）：
  - **`TaskMigrationService` 变为实例化、自包含迁移服务** —— 构造仅接收 `{ onBeforeMigrate?, onMigrated?, logger? }`（钩子平铺，无 `hooks` 包装），`migrate({ agent })` 直接复用传入 `agent` 的 `client`/`model`/`modelConfig` 生成交接文档，无需 Provider、无需独立迁移 Agent；暴露结构化 `MigrationContext`
  - **`AutoMigratePlugin` 收敛为仅触发角色** —— 构造注入 `{ service, maxTokens }`，只检测 token 超限并委托 `service.migrate`
  - **CLI 移除 `createMigrationAgent`** —— 删除 `src/agent-creator.ts` 中依赖已删除 `TaskMigrationService.createAgentDefinition` 的迁移 Agent 构建；手动迁移命令与自动迁移回调统一改为使用 SDK 迁移服务实例，钩子平铺在服务构造上

### 🚀 新功能

- **手动任务迁移命令 `/migrate`** — 对话中随时输入 `/migrate` 即可主动触发任务迁移，无需等待 token 超限：
  - 迁移动作：保存当前对话 → 生成交接文档 → 开启新会话（注入交接文档为上下文）→ 新对话落盘为草稿（`_current.json`）
  - 与自动迁移联动复用 SDK 的 `TaskMigrationService.migrate`，通过 `onMigrated` 钩子处理后保存
  - 非破坏性：旧对话已保存到 `conversations/`，生成失败时可重试或继续当前对话

### 🎯 优化

- **迁移服务单实例收敛** — 将 `TaskMigrationService` 实例挂载到 `ConversationContext.migrationService`，自动迁移（`AutoMigratePlugin` 触发）与手动迁移（`/migrate` 命令）共用**同一个实例**；迁移前后处理（保存旧对话 / 开启新会话 / 落盘草稿）统一收敛到该服务钩子，消除自动与手动两侧各自 `new TaskMigrationService` 及重复的后处理实现
- **迁移服务抽离为独立模块** — 新增 `src/migration-service.ts`，由 `createMigrationService(ctx)` 统一构建迁移服务实例（含迁移前后钩子）；`saveCurrentConversation` 提升为 `conversation-repository.ts` 的共享 `saveConversation`，供迁移钩子与错误保存共用

### ✅ 测试

- SDK 侧：`TaskMigrationService`（含 `migrate` / 序列化 / 钩子上下文）、`AutoMigratePlugin`（触发委托断言）全量通过（447 passed / 2 skipped）
- CLI 侧：`pretest` 类型检查与全量单测通过（37 passed），`npm run build` 成功

## [0.5.0] - 2026-08-23

### 💥 破坏性变更

- **升级 `@ai-zen/agents-core` 到 4.0.0、`@ai-zen/agents-sdk` 到 0.7.0** — 随底层核心重构（官方 OpenAI SDK + 插件化 Agent 驱动层）：
  - **`createModel()` 返回结构变化** — 从返回旧 `ChatCompletionModel` 实例改为 `{ client, model, modelConfig }`（openai SDK client + 模型名 + 模型参数）；`createMigrationAgent` 相应解构后传入 `SdkAgent` 新构造签名
  - **`SdkAgent` 构造签名变化** — 由 `{ ..., model }`（模型对象）改为 `{ client, model, modelConfig }`
  - **CLI 其余部分完全兼容** — 流式事件（`open`/`chunk`/`error`/`sub-agent`/`sub-agent-end`）、插件（`AutoMigratePlugin`/`AutoRefreshToolsPlugin`/`ContextGuardPlugin`）、`AgentNS` 类型（`Delta`/`StreamResponseData`/`Message`）在 core 4.0.0 / sdk 0.7.0 中原样保留，`AgentPlugin`/`SendContext` 由 sdk 重新导出，无破坏

### ✅ 测试

- 依赖升级后单测全量通过（37 passed / 0 failed），`tsc --noEmit` 零错误

### 🎯 优化

- **`test:all` / `test:e2e` 前置构建** — e2e 测试运行 `dist/index.js`，此前若 `dist` 缺失或为旧构建会导致 e2e 失败（升级后曾因旧 `dist` 报 `AgentContext must have a client`）。现于 e2e 前自动 `npm run build`，干净环境（CI clone 后）可开箱运行

## [0.4.0] - 2026-08-05

### 🚀 新功能

- **升级 `@ai-zen/agents-core` 到 3.4.0、`@ai-zen/agents-sdk` 到 0.6.0** — 随底层升级带来开箱即用的增强能力：
  - **内置工具中断信号（abort）支持** — `sleep`/`exec`/`downloadFile`/`generateImage`/`glob`/`findText` 及 subAgent 体系监听 `abort` 信号，CLI 终止对话时超长耗时操作可及时中断，避免资源滞留（`exec` 可区分 `aborted` 与 `timeout` 终止原因）
  - **工具定义内聚重构** — `Tool` 基类瘦身（不再强制传 `type`/`function`），定义与实现同处一类，回调签名由 `this` 注入改为显式 `(parsed_args, ctx)` 传参，`SdkCallbackTool` 构造改为 `{env}` 容器并透传完整 `ToolCallContext`
  - **MCP 工具 signal 透传** — `call_mcp_tool` / `read_mcp_resource` 支持中断
  - cli 层未直接使用上述受影响 API，升级为无破坏性平滑升级，功能不受影响

### ✅ 测试

- 依赖升级后单测全量通过（37 passed / 0 failed）

## [0.3.5] - 2026-08-13

### 🎯 优化

- **升级 `@ai-zen/agents-core` 到 3.3.1、`@ai-zen/agents-sdk` 到 0.5.7** — 跟随上游内部重构，开箱即用，CLI 无代码改动：
  - **`innerLoopTasks` 拆分为双集合语义** — Core 3.3.1 新增 `innerLoopsTasks`（整组任务记录）与 `innerLoopTasks`（当前轮活跃任务）；`abort()` 只中止当前轮活跃任务，不再误标已完成的轮次
  - **内循环开头统一追加 Assistant 占位** — `send()` / `AgentTool` 不再手动追加 Assistant，由 `run()` 每次内循环开头统一处理，多轮工具调用同样收敛到该处
  - **SDK 0.5.7 同步升级** — 依赖 core 3.3.1，全部 426 个测试（含真实 DeepSeek e2e）通过，完全兼容

## [0.3.4] - 2026-08-14

### 🎯 优化

- **升级 `@ai-zen/agents-core` 到 3.3.0、`@ai-zen/agents-sdk` 到 0.5.6** — 跟随上游统一重构，开箱即用，CLI 无代码改动：
  - **`ToolCallContext` 统一贯穿「拦截决策 → 执行」** — Core 3.3.0 将 `FunctionCallContext` 统一为 `ToolCallContext`：`onToolCall` 钩子与 `Tool.exec(ctx)` 收同一个实例；新增 `tool_call`（统一形状）、`tool`（匹配到的工具）、`signal`（中止信号）字段，`toolCall` 改名为 `tool_call`。保留 `@deprecated FunctionCallContext` 兼容别名，旧代码无需改动
  - **新增 `onToolCall` 拦截钩子** — Core 3.3.0 与 SDK 0.5.6 同时提供：每个工具调用执行前可**拒绝**（返回字符串 = 拒绝原因作为工具结果回给 LLM、工具不执行、继续下一轮）；SDK 侧 `AgentPlugin` 支持该钩子（多插件按注册顺序调用，任一返回字符串即拒绝）

## [0.3.3] - 2026-08-05

### 🎯 优化

- **依赖声明统一为版本范围** — `@ai-zen/agents-core` 与 `@ai-zen/agents-sdk` 由精确版本（`3.2.0` / `0.5.3`）改为 caret 范围（`^3.2.0` / `^0.5.3`），与 SDK 侧对 core 的 `workspace:^`（发布为 `^3.x`）语义对齐。允许各自主版本范围内的兼容升级，避免升级版本时反复改动依赖声明；实际解析版本保持 `3.2.0` / `0.5.3`（当前 latest），功能不受影响

## [0.3.2] - 2026-08-05

### 🚀 新功能

- **接入 `ContextGuardPlugin` 上下文安全护栏** — 在 `conversation-runner.ts` 的插件装配中注册 SDK 0.5.3 提供的 `ContextGuardPlugin`（置于 `AutoMigratePlugin` 之前，复用同一 `maxTokens`）。每次内循环发请求前检测用量，超过 `maxTokens×1.2`（超阈 20%）即抛出 `ContextOverflowError` 中断对话，防止读入超大文件等突发超限撑爆上下文；与迁移插件区间互补：正常超限走交接迁移，严重超限由护栏直接中断报错

### ✨ 优化

- **修正 `conversation-runner.ts` 插件注册注释编号** — 统一连续编号（1 cwdTracker / 2 autoRefreshTools / 3 draftPlugin / 4 contextGuard / 5 autoMigrate），消除此前重复编号

## [0.3.1] - 2026-08-05

### 🚀 新功能

- **升级 `@ai-zen/agents-sdk` 到 0.5.3** — 随 SDK 新能力开箱即用：
  - **初始化默认释放 socket-pty MCP 配置** — SDK `bootstrap()` 新增 `ensureDefaultMcpConfig()`，CLI 首启在 `~/.ai-zen/mcp.json` 自动写入含 `socket-pty` 终端的默认 MCP 配置（`npx -y @ai-zen/socket-pty mcp`），文件已存在则幂等不覆盖
  - **`load_mcp` 透传 server description** — 枚举各 MCP 服务器描述供 LLM 参考（对齐 `load_skill`）
  - **新增 `ContextGuardPlugin` 上下文安全护栏** — 在发请求前检测用量，超过 `maxTokens×1.2`（超阈 20%）时抛出 `ContextOverflowError` 中断对话，防止读入超大文件导致上下文失控；与 `AutoMigratePlugin` 职责分离、区间互补

### 🔧 修复

- **自动迁移后未立即保存新对话为草稿** — `AutoMigratePlugin` 的迁移发生在 `onAfterSend`（所有内循环已结束、`DraftPlugin` 的 `onInnerLoopEnd` 不再触发），迁移替换 `agent.messages` 后的新开场白未被及时落盘，用户在中途退出会丢失迁移后的开场白。现于 `onMigrated` 回调中迁移完成后立即将新消息写入草稿（`_current.json`），与「原对话先保存为 `conversations/`」形成完整闭环

### 🎯 优化

- **MCP 配置结构统一为业界标准 `mcpServers`** — 以 SDK（`discoverMcpServers`）为准，CLI 的 `McpConfig` 顶层字段由 `servers` 改为 `mcpServers`、server 传输字段由 `transport` 改为 `type`。消除格式漂移，CLI 管理界面（`zen config`）与 SDK 默认释放的 mcp.json 完全对齐，socket-pty 默认配置可被正确显示与管理

### ✅ 测试

- 更新 `config.test.ts` 中 MCP 读写相关断言以匹配新的 `mcpServers` 结构与 `type` 字段

## [0.3.0] - 2026-08-01

### 💥 破坏性变更

- **会话/草稿持久化下放 CLI** — SDK 0.5.0 移除了会话/草稿产品层（`ConversationRepository` / `DraftRepository` / `AutoDraftPlugin`）。CLI 自建本地存储：
  - 新增 `src/conversation-repository.ts` — `conversationRepository`（复用 SDK `EntityRepository`）
  - 新增 `src/draft-repository.ts` — `DraftRepository` + `draftRepository` 单例（草稿无 id 字段，单独实现）
  - 新增 `src/draft-plugin.ts` — CLI 草稿插件 `DraftPlugin`（替代被移除的 `AutoDraftPlugin`，`onInnerLoopEnd` 自动保存）
- **更新 `@ai-zen/agents-sdk` 到 0.5.0** — 内置工具类化（`SdkCallbackTool` + `ToolEnv` 注入）、`Provider` 支持 `cwd`/`env`、`generateImage` 类化为 `GenerateImageTool`

### 🎯 优化

- **依赖同步线上版本** — `@ai-zen/agents-core` `3.0.1`、`@ai-zen/agents-sdk` `0.5.0`（开发期曾使用本地 `link:` 调试，已还原为 npm 版本号）

## [0.2.3] - 2026-07-29

### 🎯 优化

- **更新 `@ai-zen/agents-sdk` 到 0.4.0** — load_mcp 返回值改为结构化 JSON（含完整 inputSchema），日志 API 改为全局单例 `getLogger()`/`setLogger()`

## [0.2.2] - 2026-07-27

### 🎯 优化

- **更新 `@ai-zen/agents-sdk` 到 0.3.4** — 包含 AutoMigratePlugin 钩子重命名（`onHandoff` → `onMigrated`）
- **保存旧对话的时机修正** — 从 `onMigrated`（原 `onHandoff`）移至 `onBeforeMigrate`，确保保存的是完整的旧对话历史

## [0.2.1] - 2026-07-27

### 🎯 优化

- **更新 `@ai-zen/agents-sdk` 到 0.3.3** — 包含默认 Agent/SubAgent 提示词优化（信息明确性要求、矛盾检测）

## [0.2.0] - 2026-07-26

### 💥 破坏性变更

- **同步 SDK 0.3.2 异步 API** — `@ai-zen/agents-sdk` 从 `0.3.1` → `0.3.2`
- **`readConfig()` / `saveConfig()` 改为 async** — 因 SDK `ConfigManager` 全面异步化
- **`createAgent()` 恢复为 async** — 因 SDK `createAgent()` 改回异步
- **`installHook()` / `uninstallHook()` 改为 async** — Shell hook 安装/卸载使用 `fs.promises`

### 🎯 优化

- **全面消除同步文件 IO** — `config.ts`、`hook.ts`、`conversations.ts`、`config-display.ts` 中所有 `existsSync`、`readFileSync`、`writeFileSync`、`readdirSync`、`statSync`、`renameSync`、`appendFileSync`、`mkdirSync`、`unlinkSync` 替换为 `fs.promises` 异步 API
- **`getConversationsList()` 改为 async** — 对话列表读取使用异步文件 API
- **MCP 配置读写异步化** — `readMcpConfig()`、`writeMcpConfig()`、`readProjectMcpConfig()` 均改为 async

### ✅ 测试

- 同步更新 `config.test.ts` 为 `async`/`await`，全部 43 个测试通过（含 6 个 E2E）

## [0.1.7] - 2026-07-21

### 🔧 修复

- **更新依赖**: `@ai-zen/agents-core` → `3.0.0-alpha.4`, `@ai-zen/agents-sdk` → `0.2.7`

## [0.1.6] - 2026-07-20

### 🔧 修复

- **更新 `@ai-zen/agents-sdk` 到 0.2.6** — 包含默认 SubAgent 函数名和描述修复，LLM 现在能正确识别子 Agent

## [0.1.5] - 2026-07-20

### 🔧 修复

- **更新 `@ai-zen/agents-sdk` 到 0.2.5** — 包含默认 SubAgent 权限修复，`general-assistant` 现在能正常使用工具
