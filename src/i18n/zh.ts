/**
 * 中文词条（默认兜底语言之外的另一半）。
 *
 * 约定：
 * - 扁平 key，`域.语义` 分组；
 * - `{name}` 为插值占位；
 * - `\u00a0`（不换行空格）用于把「数字 + 单位」绑成一格，窄屏折行时不会被拆开。
 *
 * ## 文案口径（改字之前先读这一段）
 *
 * 1. **一个概念只有一个词**：宿主 / 工作区 / 会话 / 助手 / 模型 / 端点 / 工具 / 技能 /
 *    MCP 服务器 / 思考强度。同一个东西在不同屏幕上换着叫，用户会以为是两件事。
 * 2. **括号只放事实**：当前值、可选值、路径、归属哪台机器、做下去的后果。
 *    括号里**不写内部字段名**（`reasoningPreset` / `mcpServers` / `messages` / `keep`）——
 *    那是给改代码的人看的，不是给用的人看的。
 * 3. **命令说明动词开头，越短越好**：斜杠菜单是**单行裁切**（宽度不够时直接切掉），
 *    说明写长了后半截根本看不见。
 * 4. **语气固定**：成功「已…」、失败「…失败：{error}」、要用户动手「请…」。
 *    状态符号只用 `✖`（失败）/ `⚠`（警告），不用 emoji —— 终端里 emoji 宽度不稳，
 *    而且风格一混就显得随手写。
 * 5. **不写 markdown**：终端不渲染 `**加粗**` 与反引号，写进去就是原样的星号和反引号。
 * 6. **可变的数字不要写死**：上限、条数一律走占位符（写死的那天配置一变就骗人）。
 */
export const zh: Record<string, string> = {
  // ---------- 输入行 ----------
  "input.placeholder": "输入消息，/ 命令，@ 文件…",
  "input.hint.ready": "Enter 发送 · Ctrl+J 换行 · / 命令 · PgUp 看历史",
  "input.hint.paused": "Esc 继续 · Enter 发送 · Ctrl+J 换行 · PgUp 看历史",
  "input.hint.scrolling": "↕ 正在翻看历史 · PgUp/PgDn 翻页 · 发送后回到底部",
  "input.hint.initializing": "初始化中…",
  "mention.scanning": "正在读取工作区文件…",
  "input.pastedImages": "已附加 {n} 张图片 · Ctrl+V 再加 · Esc 清空",

  // ---------- 状态栏 ----------
  // 四块（身份 / 用量 / 速率 / 快捷键）照旧版：身份块的分隔符与标签写在这两条词条里，
  // 于是中英文各自只有一处定义（英文是 ` · agent ` / ` · thinking `）。
  // 用量那两个数由客户端从消息的 `usage` 上算（宿主不算、不存、不报），单位用不换行空格绑定，
  // 窄屏折行时不会被拆成「1284」/「tok」。
  "status.agent": " · agent ",
  "status.busy": "忙",
  "status.idle": "闲",
  "status.inputPaused": "不收话",
  "status.outputPaused": "不取件",
  "status.dead": "已停止",
  "status.noModel": "—",
  "status.effort": " · 思考 ",
  "status.lastTokens": "本次\u00a0{n}\u00a0tok",
  "status.totalTokens": "累计\u00a0{n}\u00a0tok",
  "status.avgRate": "⚡\u00a0均\u00a0{rate}",

  // ---------- 思考档位 ----------
  "effort.off": "关",
  "effort.none": "关",
  "effort.minimal": "极低",
  "effort.low": "低",
  "effort.medium": "中",
  "effort.high": "高",
  "effort.xhigh": "极高",
  "effort.max": "最高",
  "effort.default": "默认",
  "effort.custom": "自定义",
  "effort.unsupported": "—",

  // ---------- 生成阶段（消息栏 spinner；六阶段在 `src/session-phase.ts`） ----------
  // 「排队」= 话还在 inbox 里没被取走；「等待首字」= 请求已发出、一条字都还没回来。
  "phase.working": "处理中…",
  "phase.connecting": "连接中…",
  "phase.inboxWaiting": "排队中…",
  "phase.waitingFirstToken": "等待首字…",
  "phase.thinking": "思考中…",
  "phase.toolCalling": "调用工具…",
  "phase.toolCallingWith": "调用工具 {name}…",
  "phase.toolWaiting": "等待工具返回…",
  "phase.toolWaitingWith": "等待 {name} 返回…",
  "phase.streaming": "输出中…",
  "phase.handoff": "正在交接…",

  // ---------- 排队区（输入框上方的排队带，`InboxArea`） ----------
  // 前缀：用户自己排进来的那句。别的来源（`session` 等）直接把来源名上屏，不走词条
  "inbox.pending": "排队中",
  // 只显示前两行时，最后一行说还剩多少条（填进去的是**没显示出来**的条数）
  "inbox.more": "还有 {n} 条",

  // ---------- 通知 ----------
  "notice.reloaded": "已按新配置重建会话（消息与上下文都保留）",
  "notice.draftSaved": "已暂存输入（Ctrl+S 恢复）",
  "notice.draftRestored": "已恢复暂存的输入",
  "notice.imagePasted": "已粘贴图片（共 {n} 张），Enter 发送",
  "notice.imagesCleared": "已清空附加的图片",
  "notice.textTooLarge":
    "剪贴板文本有 {size}KB，超过 {limit}KB 上限，没有粘贴。长内容建议存成文件，再用 @ 引用",
  "notice.clipboardEmpty": "剪贴板里没有内容",
  "notice.clipboardUnavailable": "没找到剪贴板工具：macOS 用 pbpaste，Linux 用 wl-paste 或 xclip",
  "notice.inputCleared": "已清空输入 · 再按一次 Ctrl+C 退出",
  "notice.handoffBlocksInput": "正在交接，这句话没有发出去。Esc 放弃交接并回到交接前",
  "notice.handoffAborted": "已中断交接，记忆回到交接前",
  // subagent 结束了要说一句（PRD 3.9）：完成了 / 失败了 / 被叫停了。失败那句里的 {error} 是
  // 宿主给的原话，照传；宿主没给原因时用不带原因的那一条，不自己编一个
  "notice.subAgentDone": "子助手 {name} 已完成",
  "notice.subAgentFailed": "子助手 {name} 失败",
  "notice.subAgentFailedWhy": "子助手 {name} 失败：{error}",
  "notice.subAgentAborted": "子助手 {name} 被叫停",
  "notice.startFailed": "这段会话没能叫起来：{error}",
  "notice.resumeFailed": "继续失败：{error}",
  "notice.pressCtrlDAgain": "再按一次 Ctrl+D 退出",
  "notice.languageChanged": "界面语言已切换为中文",
  // 两个清空入口写在同一行提示里（分隔用「；」而不加装饰：栏位上的句子不加任何前缀）
  "notice.clearHint": "Alt+X 清本会话的通知；Alt+Shift+X 清全部",
  "notice.cleared": "已清空这一段的通知",
  "notice.clearFailed": "清空通知失败：{error}",
  // 三档粒度里的第三档（清全部）：它会把**全局**通知与**别的会话**的通知一起清掉，
  // 所以这一问必须把这两件事说出来（PRD「清全部要明说，不能顺手全清」）
  "notice.clearAllTitle":
    "清空全部 {n} 条通知？全局通知不属于任何一段会话，所以会一起清掉；别的会话还没看过的通知也会一起清掉。不会回来。",
  "notice.clearAllConfirm": "清空全部",
  "notice.clearAllCancel": "不清",
  "notice.clearAllDone": "已清空全部 {n} 条通知（含全局通知、别的会话的通知）",
  "notice.clearAllCancelled": "没有清任何通知",
  "notice.clearAllFailed": "清空全部通知失败：{error}",
  "notice.clearAllListFailed": "读不到通知清单，所以什么都没清：{error}",
  // 图片：终端里不能内联渲染，但可以交给本机默认程序打开（`system-editor.ts`）
  "notice.imagePickTitle": "打开哪一张图片？选中就用本机默认程序打开",
  "notice.imagePickItem": "第 {message} 条消息 · 第 {image} 张",
  "notice.imagePickEmpty": "这一段里没有打得开的图片（带素材的才能取回来）",
  "notice.imageOpened": "已交给本机默认程序打开：{path}",
  "notice.imageGone": "这张图在宿主里已经不在了：{error}",
  "notice.imageTempFailed": "图片取回来了，但写到临时文件失败：{error}",
  "notice.imageNoOpener": "取回来了，但这台机器没有可用的打开命令（试过 {command}）：文件在 {path}",
  "notice.imageOpenFailed": "系统打不开它（{command} 返回 {code}）：文件在 {path}",
  // ---------- 命令说明（/help 与斜杠菜单） ----------
  "cmd.load.desc": "打开已保存的会话（--all 跨工作区）",
  "cmd.sessions.desc": "列会话，选中就切（--all 跨项目）",
  "cmd.ws.desc": "工作区：列、选、新建、删项目",
  "cmd.pin.desc": "置顶当前会话，或取消置顶",
  "cmd.new.desc": "新开一段会话",
  "cmd.back.desc": "撤回上次发言，改完重发",
  "cmd.rename.desc": "改这一段的名字",
  "cmd.rename.usage": "现在是「{name}」。要改名就写：/rename <名字>",
  "cmd.rename.done": "已改名为「{name}」",
  "cmd.editor.desc": "用外部编辑器写长消息",
  // `/clear` 只清屏、`/free` 只清排队区（一条命令一件事）：
  // 从前「顺手清队列」那一半的说明与提示文案跟着搬到 `cmd.free.*`
  "cmd.clear.desc": "清屏（排队区归 /free）",
  "cmd.free.desc": "清空排队区：还没送出去的话",
  "cmd.free.inboxCleared": "已清掉排队区里 {n} 条还没送出的话",
  "cmd.config.desc": "打开配置中心：端点、模型、助手",
  "cmd.model.desc": "切换模型：本次会话 / 助手 / 全局",
  "cmd.agent.desc": "设置默认助手，只影响以后新开的会话",
  "cmd.reload.desc": "重新发现工具、技能与 MCP 服务器",
  // `/upgrade`：键名与命令名一致（`registry.ts` 的 `descriptionKey` 就是这几条）
  "cmd.upgrade.desc": "挑发布标签里最高的一版，让宿主换过去",
  "cmd.mcp.desc": "管理 MCP 服务器：增删、改配置、启停",
  "cmd.lang.desc": "切换界面语言",
  "cmd.think.desc": "切换思考强度",
  "cmd.key.desc": "设置端点的 API Key",
  "cmd.handoff.desc": "只写交接文档（不换记忆、不换手）",
  "cmd.migrate.desc": "写文档并换手（旧记忆成为存档会话）",
  "cmd.help.desc": "显示帮助",
  // `/kill`：收掉 agent，会话行与历史一个字不动；`/delete`：硬删，不可撤销（PRD 1.2 / 4.1）
  "cmd.kill.desc": "杀死当前会话的 agent（历史保留）",
  "cmd.delete.desc": "删掉当前会话：消息与素材一起没",
  "cmd.shutdown.desc": "关闭宿主，回到连接屏",
  "cmd.exit.desc": "退出程序（不关宿主）",
  "cmd.running": "正在执行 /{name}…",
  /** 兜底出口：处理器没自己 catch 的那几条命令，服务端失败时由 `runCommand` 统一说话 */
  "cmd.failed": "命令 /{name} 失败：{error}",

  // ---------- 命令交互文案（通知 / 选择器） ----------
  "common.current": "（当前）",
  /** 列举多个名字时的分隔符（如「等待 edit、exec 返回…」） */
  "common.listSeparator": "、",
  "cmd.model.noModels": "配置里还没有任何模型，请用 /config 添加端点与模型",
  // 三档共用同一个选择器：标题说「这次改哪一档」+「当前生效的是哪一档」
  "cmd.model.title": "切换模型 · {scope}（当前生效：{level}）",
  "cmd.model.scope.session": "本次会话",
  "cmd.model.scope.agent": "助手",
  "cmd.model.scope.global": "全局",
  "cmd.model.cancelled": "已取消切换模型",
  "cmd.agent.noAgents": "还没有任何助手，请用 /config 新建",
  "cmd.agent.unavailable": " · 不可用",
  "cmd.agent.title": "选择主助手，同时设为默认",
  "cmd.agent.cancelled": "已取消切换主助手",
  "cmd.reload.done": "已让宿主重新发现能力：{total} 份能力容器里刷成了 {refreshed} 份",
  "cmd.reload.none": "已让宿主重新发现能力：现在没有已造好的能力容器，下一次用到时按新配置现造",
  "cmd.reload.doneSome":
    "已让宿主重新发现能力：{total} 份能力容器里刷成了 {refreshed} 份，没刷成的有 {failed} 份（{cwds}），它们还按旧配置算",
  "cmd.upgrade.newest": "已经是最新的 v{version}，没有更高的发布标签，不用换",
  "cmd.upgrade.found": "发现新版本：v{current} → v{target}",
  /**
   * 调宿主之前那一问：三件事一次说清（目标是哪一版 / 宿主做哪一半 / 会踢掉谁）。
   *
   * `{installing}` 与 `{starting}` 是 `host-stage.ts` 里那两句阶段文案（与拉起宿主那块下载屏
   * 同一批词）—— 装包与拉起归启动方式，不在这里另造进度词。
   */
  "cmd.upgrade.confirmTitle":
    "升级宿主：v{current} → v{target}。宿主先确认这一版拿得到、记下下次拉哪一版，然后以升级为理由退出；之后由启动方式接手：{installing}{starting}。这一台机器上连着的其他客户端（含桌面端）也会断开。",
  "cmd.upgrade.confirm": "升级宿主",
  "cmd.upgrade.cancel": "取消",
  /** 选了「否」：一个方法都没调，宿主还是原来那一版 */
  "cmd.upgrade.cancelled": "没有升级：宿主还是 v{current}",
  "cmd.upgrade.tagsFailed":
    "查不到 {pkg} 的发布版本（registry 连不上，或标签里没有能解析的版本号），没换",
  "cmd.upgrade.handoff":
    "已告诉宿主换到 v{version}：它先确认这一版拿得到、记下下次拉哪一版，然后以升级为理由退出",
  "cmd.upgrade.rejected": "宿主没有换成 v{version}：{error}（它还在跑，现在还是 v{current}）",
  /** 宿主正在按新版本退出，这一屏没宿主可连了：回连接屏并留下这句话（与 `/shutdown` 同一个出口） */
  "cmd.upgrade.backToConnect": "宿主正在按 v{version} 重新拉起，等它回来再连",
  "cmd.think.followDefault": "跟随模型默认",
  // 参数跟着「模型来自哪一级」走：模型是本段会话换的时，参数也写在这一段
  "cmd.think.clearHintSession": "清掉本次会话上的思考参数",
  // 助手级那一项清的是**定义文件**里的思考参数（影响所有用这个助手的会话）
  "cmd.think.clearHintAgent": "清掉助手上的思考参数",
  "cmd.think.cancelled": "已取消切换思考强度",
  "cmd.think.unchanged": "思考强度没变",
  "cmd.help.title": "可用命令：",
  "cmd.new.started": "已开始新会话",
  "cmd.load.none": "还没有已保存的会话",
  "cmd.load.titleReplacing": "选择要打开的会话（当前这份留在后台继续跑）",
  // `--all`：不限当前项目，每一条的 hint 上带它属于哪个工作区（`SessionSummary.workspaceId`）
  "cmd.load.titleAll": "选择要打开的会话 · 所有工作区（当前这份留在后台继续跑）",
  "cmd.load.hintAll": "工作区 {workspace} · {id}",
  "cmd.load.cancelled": "已取消打开",
  "cmd.sessions.title": "会话（选中即切，正在跑的都继续跑）",
  "cmd.sessions.tooMany": "会话（只显示前 {n} 条）",
  "cmd.sessions.onlyOne": "这个项目里只有这一段会话，没有别的可切",
  "cmd.sessions.cancelled": "已取消切换会话",
  "cmd.sessions.already": "已经在这一段会话上",
  "cmd.sessions.idle": "空闲",
  "cmd.sessions.working": "在忙",
  "cmd.sessions.dead": "没有 agent（发话才会起来）",
  "cmd.sessions.inboxPending": "排队 {n} 条待送出",
  "cmd.sessions.pinned": "置顶",
  "cmd.sessions.model": "模型 {id}",
  "cmd.sessions.noModel": "没有可用模型",
  "cmd.sessions.updated": "{time} 更新",
  "cmd.sessions.workspace": "项目 {name}",
  "cmd.sessions.none": "这个项目里还没有会话，用 /new 开一段",
  "cmd.sessions.noneAll": "这台宿主上还没有任何会话，用 /new 开一段",
  "cmd.ws.title": "切换工作区（之后新开的会话放在这里）",
  "cmd.ws.tooMany": "工作区太多，只列出前 {n} 个",
  "cmd.ws.cancelled": "已取消切换工作区",
  "cmd.ws.switched": "已切换到工作区「{name}」（{path}）· 当前会话不变，之后新开的会话放在这里",
  "cmd.ws.none": "宿主上还没有任何工作区",
  "cmd.ws.newHintLocal": "用 /ws new 把当前目录登记成工作区",
  "cmd.ws.newHintRemote": "用 /ws new <宿主上的绝对路径> 新建（那个目录在宿主那台机器上）",
  "cmd.ws.newNeedsPath":
    "连远端宿主得给绝对路径：/ws new <路径>（目录在宿主那台机器上，这边看不到）",
  "cmd.ws.createFailed": "新建工作区失败：{error}",
  "cmd.ws.unknownArg":
    "未知参数：{arg}（用法：/ws，或 /ws new [绝对路径]，或 /ws delete <项目名或 ID>）",
  // 删项目：连带它名下的会话（PRD 1.5），目录一个字不动。两件事都得说清，否则用户会以为删项目等于删那个目录
  "cmd.ws.deleteUsage": "用法：/ws delete <项目名或 ID>（/ws 里列着现有的那些）",
  "cmd.ws.deleteUnknown": "没有叫「{arg}」的项目：/ws 里列着现有的那些，名字或 ID 都认",
  "cmd.ws.deleteTitle":
    "删掉项目「{name}」？它名下的 {sessions} 段会话会跟着一起没（消息与素材都拿不回来），{path} 这个目录一个字都不动",
  "cmd.ws.deleteConfirm": "删掉这个项目",
  "cmd.ws.deleteCancel": "取消",
  "cmd.ws.deleteCancelled": "没有删：这个项目还在",
  /** 上屏的那个数是回执里的（宿主删之前数的那一份） */
  "cmd.ws.deleteDone":
    "已删掉项目「{name}」：名下的 {sessions} 段会话跟着没了，{path} 那个目录一个字都没动",
  "cmd.ws.deleteFailed": "删除项目失败：{error}",
  "cmd.ws.deleteNoSessionLeft": "这台宿主上已经没有别的会话了，用 /new 开一段",
  "cmd.handoff.empty": "当前会话还没有可交接的内容",
  // 三选一那一屏：标题说清「这一次问的是谁去写」，不是「要不要交接」
  "cmd.handoff.title": "写交接文档 · 选择谁去写",
  "cmd.handoff.cancelled": "已取消交接",
  "cmd.handoff.skipped": "这次不交接",
  "cmd.migrate.empty": "当前会话还没有可迁移的内容",
  "cmd.migrate.cancelled": "已取消迁移",
  "cmd.back.empty": "还没有可撤回的消息",
  "cmd.back.title": "选择撤回到哪条消息（它之后的内容会被删掉）",
  "cmd.back.cancelled": "已取消撤回",
  // 撤回之后的两件事实：删掉了几条、内容已经回填进输入框（旧实现只把消息变短，一句话都没有）
  "cmd.back.done": "已撤回：删掉 {n} 条消息，撤回的那句话已回到输入框",
  "cmd.pin.unknown": "未知参数：{value}（可选 on / off，不带参数就切换）",
  "cmd.pin.done": "已置顶「{name}」",
  "cmd.pin.undone": "已取消置顶「{name}」",
  "cmd.shutdown.title": "关闭宿主？这台机器上的其他客户端（含桌面端）会一起断开",
  "cmd.shutdown.confirm": "关闭宿主，断开其他客户端",
  "cmd.shutdown.cancel": "取消",
  "cmd.shutdown.cancelled": "已取消关闭宿主",
  // 杀执行体：先摆代价（排队区里那几条会作废）再问一次；历史与这一段会话本身都保留
  // （PRD 1.2「死的路只有三条」、4.1「中断不是杀死」那张表）
  "cmd.kill.title":
    "杀死「{name}」？排队区里 {pending} 条还没被取走的话会作废，在途的请求会被掐断；这一段会话与历史都保留，只是 agent 没了，下次发话会重新叫起来。",
  "cmd.kill.confirm": "杀死这一段会话的 agent",
  "cmd.kill.cancel": "取消",
  "cmd.kill.cancelled": "没有杀：这一段会话与它的 agent 都还在",
  /** 杀完不换屏、不清历史：只说「现在没有 agent 了」这一件事 */
  "cmd.kill.done":
    "已杀死「{name}」：agent 没了，排队区清空；这一段会话与历史都还在，下次发话会重新叫起来",
  "cmd.kill.failed": "杀死失败：{error}",
  /** 已经死了的那一段：宿主那边的 kill 是空操作，所以不说「N 条会作废」，并指到真正能清排队区的命令 */
  "cmd.kill.alreadyDead":
    "「{name}」现在没有 agent（已经是死的）：死的不用杀；排队区里的话要用 /free 清",
  "cmd.kill.unknown":
    "没有叫「{arg}」的会话：/sessions 里列着这个项目现有的那些，名字或 ID 前缀都认",
  "cmd.kill.ambiguous": "「{arg}」对得上 {n} 段会话，写长一点的 ID 前缀：{ids}",
  // 删会话：先摆代价（两个数）再问一次。删了就是硬删，那段的通知也跟着没（宿主用外键做掉的）
  "cmd.delete.title":
    "删掉「{name}」？这一段会话有 {messages} 条消息、引用 {assets} 份素材，删了就都拿不回来；这一段会话的通知也跟着没。",
  "cmd.delete.confirm": "删掉这一段会话",
  "cmd.delete.cancel": "取消",
  "cmd.delete.cancelled": "没有删：这一段会话还在",
  /** 上屏的两个数是宿主回执里的（它删之前数的那一份） */
  "cmd.delete.done": "已删掉这一段会话：{messages} 条消息、{assets} 份素材跟着没了",
  "cmd.delete.failed": "删除会话失败：{error}",
  /** 删完就换到同一个项目里最近的那一段（旧屏的通知栏跟着卸载，所以跟上一句一起带过去） */
  "cmd.delete.switched": "已换到「{name}」",
  "cmd.delete.noOtherSession": "这个项目里没有别的会话了，用 /new 开一段",
  "cmd.shutdown.done": "宿主已关闭，这台机器上的连接都断了 · 回到连接屏，可以重新拉起或改连别处",
  "cmd.model.unknown": "未知模型：{id}（可选：{options}）",
  "cmd.model.already": "已经是「{scope}」模型：{id}",
  "cmd.model.done": "已切换「{scope}」模型：{name}（{id}）",
  "cmd.model.failed": "切换模型失败：{error}",
  "cmd.agent.unknown": "未知助手：{id}（可选：{options}）",
  "cmd.agent.unavailableReason": "助手「{name}」不可用：{reason}",
  "cmd.agent.alreadyOn": "{summary}（当前会话已经在这个助手上）",
  "cmd.agent.failed": "切换主助手失败：{error}",
  // 解析器认 user / workspace、缩写 u / w，以及旧版的 global / project（`mcp-command.ts`）
  "cmd.mcp.unknownScope":
    "未知范围：{scope}（可选 user / workspace，旧写法 global / project 也认；或不带参数）",
  "cmd.lang.unknown": "未知语言：{lang}（可选 zh / en，或不带参数）",
  "cmd.reload.failed": "重新加载失败：{error}",
  "cmd.think.notAdjustable": "模型 {id} 没有可用的思考档位，调不了",
  "cmd.think.unknown": "未知强度：{level}（可选 {options} / default）",
  // 两档各一个标题：`/think` 与 `/think -a` 的选择器长得一样，标题是唯一说清「改的是哪一层」的地方
  "cmd.think.titleSession": "思考强度 · 这一段（当前：{level}）",
  "cmd.think.titleAgent": "思考强度 · 这个助手（影响以后新开的会话；当前：{level}）",
  "cmd.think.failed": "切换思考强度失败：{error}",
  "cmd.load.tooMany": "选择要打开的会话（只显示最近 {n} 条）",
  "cmd.load.tooManyAll": "选择要打开的会话 · 所有工作区（只显示最近 {n} 条）",
  // 忙时换模型 / 换思考的那一次确认：宿主只在空闲时放行（PLAN.md §5.5），这一问把代价说清
  "cmd.busySwitch.title": "这一段手上还有活：现在换会被宿主拒掉（它只允许空闲时换）。要现在试吗？",
  "cmd.busySwitch.confirm": "现在试",
  "cmd.busySwitch.cancel": "等它闲下来再换",
  "cmd.busySwitch.cancelled": "已取消：等这一段闲下来再换",
  "cmd.handoff.unknownMode": "未知的交接方式：{who}（可选 self / summary）",
  "cmd.handoff.started": "写文档已开始：写完之后宿主会告诉你文档在哪；这段会话的记忆与执行体都不动",
  "cmd.handoff.failed": "写交接文档失败：{error}",
  "cmd.migrate.started":
    "交接已开始：写完之后这段会话的记忆换成新版，旧记忆成为一段已存档会话（id 不变、屏幕不换）",
  "cmd.migrate.failed": "任务迁移失败：{error}",
  "cmd.back.tooMany": "选择要撤回到的消息（只显示最近 {n} 条）",
  "cmd.editor.failed": "编辑器打开失败：{error}",
  "cmd.unknown": "未知命令：{cmd}（输入 /help 查看可用命令）",

  // ---------- 交接选择器 / 子任务通知 / 启动屏 / 消息占位 ----------
  // 执行者三选一：label 贴近用户措辞，hint 交代取舍。`summary` 那一句必须说清「另起一个
  // 一次性执行体」—— 两个选项的差别不在写得好不好，而在谁去写。
  "handoff.modeSelf": "这段会话自己写交接文档",
  "handoff.modeSelfHint": "准确 · 会核实真实状态",
  "handoff.modeSummary": "另起一个一次性执行体写交接文档",
  "handoff.modeSummaryHint": "快且省 · 不核实文件",
  "handoff.modeSkip": "不交接",
  "handoff.modeSkipHint": "跳过本次",
  "agentTabs.main": "主助手",
  "chat.configReadFailed": "读取配置失败：{error}",
  "chat.modelNoEndpoint": "模型 {id} 没有绑定可用的端点，请用 /config 检查",
  "chat.configUpdated": "配置已更新：{line}",
  // 一次改了多项时合成一条多行通知（逐条 push 会互相覆盖 / 占满通知栏）
  "chat.configUpdatedMulti": "配置已更新：\n{lines}",
  "chat.sessionReloadFailed": "重建会话失败：{error}",
  "chat.subAgentMessagesFailed": "读那个子 Agent 的消息失败：{error}",
  "chat.bootFailed": "✖ 无法启动会话：{error}",
  // 别处（另一台终端 / 桌面端）把这一屏正看着的那一段删了：说一句，然后换到同项目里最近的一段
  "chat.sessionRemoved": "这一段会话已经被删掉了",
  "chat.bootHint": "按 k 打开配置中心（设置 API Key 与端点地址）· Enter 返回",
  "welcome.tagline": "终端里的 AI 协作台",
  // 图片占位：终端不内联渲染，但手里已有的事实要说出来（每条事实一行）
  "msg.imageAssetHeader": "[图片 {n}] 素材在宿主里，终端里不展开（Ctrl+O 打开）",
  "msg.imageInlineHeader": "[图片 {n}] 内联在消息里，终端里不展开",
  "msg.imageUrlHeader": "[图片：{url}]",
  "msg.imageSize": "尺寸：{width} × {height}",
  "msg.imageSizeUnknown": "尺寸：不知道多大",
  "msg.imageName": "文件名：{name}",
  // 选择器那一行只要值本身（同一个事实的短说法）
  "msg.imageSizeUnknownValue": "不知道多大",
  "msg.file": "[文件：{name}]",
  "msg.inlineFile": "内联文件",
  "msg.userHeader": "❯ 你",
  "msg.aiHeader": "✦ AI",

  // ---------- 业务模块返回的 summary / 报错（思考档位 / 切模型 / 切助手 / 交接） ----------
  "effort.followDefault": "跟随模型默认",
  "effort.quoted": "「{label}」",
  "effort.summary": "思考强度已设为 {label} · 写入助手「{id}」（模型 {model}）",
  // 会话级那条路写的是会话存档（不碰助手定义），所以文案不提助手
  "effort.summarySession": "思考强度已设为 {label} · 写入本次会话（模型 {model}）",
  "modelSwitch.resetHint": " · 思考强度已重置为模型默认",
  "modelSwitch.summary": "已切换模型：{name}（{id}）· 写入助手「{agent}」{hint}",
  "agentSwitch.err.agentMissing": "助手「{id}」不存在",
  "agentSwitch.summary": "已切换主助手：{name}（{id}）· 模型 {model}（{modelId}）",

  // ---------- 入口 / 退出 / 时间格式 ----------
  "app.goodbye": "\n再见 👋\n",
  "app.noAgents": "没有可用的助手，请先在配置中心新建一个",
  "app.bootFailed": "✖ 无法启动会话：{error}",
  "app.unexpected": "✖ 意外错误：{error}",

  // ---------- 连接屏（首启 / 连不上） ----------
  "connect.title": "连接宿主",
  "connect.firstRunHint": "第一次使用：先选一台宿主（本机或远程）",
  "connect.local": "本机",
  "connect.localHint": "在这台电脑上启动宿主（需要时先下载）",
  "connect.remote": "远程",
  "connect.remoteHint": "填写地址与令牌",
  "connect.retry": "重试",
  "connect.exit": "退出",
  "connect.exitHint": "先不连",
  "connect.keys": "↑↓ 选择 · Enter 确认 · Esc 退出",
  "connect.connecting": "正在连接…",
  "connect.addressTitle": "宿主地址",
  "connect.addressHelp": "例：wss://example.com/ai-zen、10.0.0.5:8790（不写协议前缀就当 ws://）",
  "connect.tokenTitle": "访问令牌",
  "connect.tokenHelp": "留空表示用本机宿主的令牌（启动宿主时自动生成）",
  "connect.continue": "继续",
  "connect.back": "返回",
  "connect.connect": "连接",

  // ---------- 工作区屏（启动时远端没有「上次进入的那个」；PRD D30） ----------
  "ws.folderMissing": "（目录已不在）",
  "ws.title": "选择一个工作区",
  "ws.hint": "宿主在另一台机器上：下面的列表和你要填的路径，都在那台机器上",
  "ws.newLabel": "新建工作区…",
  "ws.loading": "正在读取工作区…",
  "ws.pathTitle": "工作区目录（宿主上的绝对路径）",
  "ws.pathHelp": "例：/srv/repos/api。这个路径在宿主那台机器上，不是本机的",
  "ws.pathEmpty": "请填宿主上的绝对路径",
  "ws.pathSubmit": "使用这个目录",
  "ws.exit": "退出",
  "ws.keys": "↑↓ 选择 · Enter 确认 · Esc 退出",

  // ---------- 下载屏（本机拉起宿主，PRD D31） ----------
  //
  // 进度是**不确定**的：只报「走到哪一步」，不报百分比（不解析 npm 的输出）
  "download.title": "准备本机宿主",
  "download.stage.resolving": "查询要下载的版本…",
  "download.stage.installing": "下载并安装宿主（第一次会慢一点）…",
  "download.stage.starting": "启动宿主…",
  "download.cancelled": "已取消，本机宿主没有启动",
  "download.keysRunning": "Esc / Ctrl+C 取消，回连接屏改连远程",
  "download.keysFailed": "R 重试 · Esc 回连接屏改连远程",

  // ---------- `ai --help`（在 TUI 之外打印，故单独在 help 分支初始化语言） ----------
  "cli.help.title": "ai — AI-Zen CLI v{version}",
  "cli.help.usage":
    "\n用法:\n  ai                      进入交互式界面（TUI，需 stdin/stdout 为 TTY）\n  ai <提示词>              以纯 stdio 模式提问，结果写入 stdout\n  cat 文件 | ai “总结要点”  通过管道传入内容，参数作为指令\n  ai hook install         安装 shell 兜底钩子（命令不存在时转发给 AI）\n  ai hook uninstall       卸载 shell 兜底钩子",
  "cli.help.options":
    "\n选项:\n  --save                  保存本次会话到存档（默认不落盘）\n  --tui [提示词…]          强制进入交互界面，提示词作为首条消息自动发送（shell 钩子用）\n  --new                   进入交互界面时开新会话，不续接上一次\n  --server <url>          连到显式指定的宿主（如 wss://example.com/ai-zen；也可用 AI_ZEN_SERVER_URL）\n  -h, --help              显示本帮助\n  -v, --version           显示版本号\n  --server-status         打印常驻宿主的状态（JSON，未运行退出码 1）",
  "cli.help.notes":
    "\n说明:\n  stdio 模式无任何交互，结果走 stdout、日志走 stderr，成功退出码 0。\n  远端令牌用 AI_ZEN_SERVER_TOKEN 传，不写命令行（argv 会出现在 ps 输出与 shell 历史里）。",

  // ---------- `ai hook install / uninstall`（非 TUI 输出，同 help 一样在分支内先初始化语言） ----------
  "cli.hookUsage": "用法: ai hook install|uninstall",
  "cli.hookUnknownAction": "不认识的子命令：{action}",
  "hook.unsupportedShell": "✖ 不支持这个 shell（只支持 bash / zsh）",
  "hook.alreadyInstalled": "ai hook 已经装过了，不用再装",
  "hook.installed": "ai hook 已安装到 {file}",
  "hook.updated": "ai hook 已更新到最新版本（{file}）",
  "hook.restartHint": "    重启终端或执行 source {file} 后生效",
  "hook.forwardHint": "    之后输入不存在的命令会自动转给 AI",
  "hook.notInstalledNoFile": "ai hook 没有安装（文件不存在）",
  "hook.notInstalled": "ai hook 没有安装",
  "hook.uninstalled": "ai hook 已从 {file} 卸载",
};
