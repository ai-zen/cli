# Changelog

## [1.0.0-alpha.1] - 2026-09-30

### ✨ 新增 — TUI 全屏交互界面（Ink + React）

- **以 Ink（React）重写交互界面**，取代原 inquirer 行式对话。启动呈现**动画渐变 ASCII 启动界面**（对角渐变 + 扫光 + 逐行揭示），结束后**直接进入对话界面**（存在上一轮会话则自动续接，否则新建对话）。
- **对话界面底部固定**：分隔线 / 输入行 / 状态栏始终吸附终端底部，对话历史在其上方滚动 —— 按显示宽度**预折行** + 自底部截取 + 顶部补齐。整帧高度**预留末行**、恒小于终端行数：既避免单条回复远超一屏时撑破帧，也规避 Ink 在「帧高 ≥ 终端行数」时走全屏分支（渲染串不补末尾换行却仍按「光标停在末行之后」定位）导致硬件光标整体上移一行、IME 候选框偏上的问题。
- 对话界面：
  - 流式输出区（思考过程、回答正文、工具调用分行展示 —— **每个工具调用单行展示 `⚙ 名称(参数)`**：参数折叠空白后内联，超宽则按显示宽度裁剪并补省略号，始终保持**严格单行**），历史按行裁剪、自底部滚动；
  - **多行输入**（`Enter` 发送、`Ctrl+N` 换行；`Ctrl+J` 亦可）；
  - **光标编辑**：`←`/`→`、`Home`/`End`、`Backspace`/`Delete`、光标处插入，及 `Ctrl`/`Meta` + `←`/`→` 跨词移动；反显光标 + 硬件光标同步；
  - **应用内翻页**：`PgUp`/`PgDn` 翻页、`Shift`/`Alt` + `↑`/`↓` 单行滚动、发送自动回底、`Esc` 清输入并回底（翻页时内容冻结，新内容追加不漂移）；
  - 输入历史（`↑`/`↓`）；
  - **内联 `/` 命令菜单**（↑↓ 选择、`Tab` 补全、`Enter` 确认），取代原 `src/slash-hint-prompt.ts` 底栏提示；
  - 状态栏（模型 · Agent · token 用量 · 生成状态）；
  - 确认框（是/否，支持 y/n / ←→ / Esc）。
- **语法高亮（高亮数据 / 渲染彻底分离）**：工具调用参数按 **JSON** 高亮；回答正文与思考内容里的**围栏代码块**（` ```lang `）按语言高亮（围栏行本身不显示）。高亮**数据**来自 `highlight.js`（经 `lowlight` 产出 hast），CLI 只负责把 `hljs-*` scope 映射成 Ink `<Text>` 颜色 —— 与 Google Gemini CLI（同为 Ink/React，依赖 `highlight.js` + `lowlight`）做法一致。`src/tui/highlight.ts` 为数据层（纯函数 `highlightCode` / `highlightJson` / `splitFences`，注册 ~36 种常用语言，带结果缓存，未知语言**原样不着色**不做猜测）；`src/tui/theme.ts` 的 `syntax` / `syntaxStyle()` 为 scope→样式映射；行模型 `RLine` 新增 `spans` 分段，`LineView` 逐段渲染（缺省分段继承所在行基础色）。
- 对话命令（TUI 内）：`/help`、`/load`（加载已保存的对话）、`/clear`、`/new`、`/save`、`/config`、`/key`、`/migrate`、`/back`（撤回并预填输入）、`/editor`（借助 Ink `suspendTerminal` 调用系统编辑器）、`/exit` `/quit`。
- **首启凭据引导 + 配置中心（Ink 原生）**：此前端点缺 API Key 时只有一行报错随即退出，**没有任何输入入口**（旧 inquirer 向导随主菜单一并移除）。现在：
  - **启动预检**：所选模型绑定的端点缺 API Key 时，先弹出**凭据设置屏**（端点名 / Base URL / 厂商申请链接 / 掩码输入，`Tab` 切明文核对），保存后立即进入对话；`Esc` 放弃即退出；
  - **`/key`**：对话内直达「当前模型所用端点」的 API Key 编辑，保存后**自动重建会话**（消息与上下文保留，新凭据立即生效）；
  - **`/config` 配置中心**：默认模型 / 端点管理；端点管理列表 = [＋ 新建端点] + 各端点，选中端点进入详情屏，一屏内就地编辑其 API Key / Base URL，每次确认即时写入 `config.json`；
  - **启动失败不再只能退出**：出错屏提示「按 `k` 打开配置中心」，改完自动重试（仅对话框无会话时重挂载重试）。
- 命令清单新增 `/config`、`/key`（`registry.ts` 仍是唯一来源，`/help` 与输入补全自动生效）。
- **IME 候选框跟随光标**：用 Ink `useCursor()` 把终端硬件光标同步到编辑光标（`computeInputCursorPosition`），中文输入法候选框正确定位；生成中 / 覆盖层弹出时隐藏硬件光标。
- **会话持久化改革：会话即文件 + 单指针**：每轮结束把会话落盘、并在 `cli/last-session.json` 记录上一轮会话 id；首条消息后才落盘（不留空会话）；`/save` 幂等；旧 `drafts/_current.json` 不迁移。
- 继续 / 加载已保存的对话时，会**按消息重建历史记录**显示。
- **终端状态安全**：`SIGINT` / `SIGTERM` / 未捕获异常均卸载 Ink，恢复 raw mode 与光标；`Ctrl+C` 语义为「忙时取消本轮、空闲时退出」。
- **干净退出**：Ink 卸载后显式暂停 stdin 并终止进程（`farewell()`），避免残留句柄（TTY flowing、SDK 定时器）导致「返回 shell 却不退出、终端不归还」。

### 🔧 变更

- **升级 `@ai-zen/agents-sdk` 到 `1.0.0-alpha.2`**：出厂默认 `mcp.json` 新增 `chrome-devtools` 服务器（Google 官方 `chrome-devtools-mcp`，`npx -y chrome-devtools-mcp@latest`），与既有的 `socket-pty` 并列，开箱即用浏览器调试 / 自动化能力（页面导航、性能追踪、网络与控制台检查、截图等）；**已存在的 `mcp.json` 仍不覆盖**，用户配置（含自定义 flag）不受影响。CLI 侧代码零改动 —— CLI 不引用 SDK 的 `DEFAULT_MCP_CONFIG`，自带 `mcp.json` 仅做文件读写；与 alpha.1 相比 API / 类型声明完全一致，仅有 `DEFAULT_MCP_CONFIG`（多一个服务器）与注释变动。
- **升级 `@ai-zen/agents-sdk` 到 `1.0.0-alpha.1`**：出厂模型目录刷新（`deepseek-v4-flash` → `deepseek-flash`、`gpt-5.5` → `gpt-6-*`、`glm-5.1` → `glm-5.3` 等，默认模型改为 `deepseek-flash`）；新增**出厂模型清单托管**（`models` / `imageModels` 中未标 `custom: true` 的条目会被出厂定义替换，悬空 `defaultModel` / `defaultMigrationModel` 回退到出厂默认；`endpoints` 不受影响）；`maxContextTokens` 语义澄清为「任务迁移触发阈值」；`Model` / `ImageModel` 新增可选 `custom?: boolean`。CLI 侧代码零改动，仅测试夹具需标 `custom: true`。
- 新增依赖：`ink`、`react`（运行时），`ink-testing-library`、`@types/react`（开发）；**语法高亮**新增 `highlight.js` / `lowlight`（运行时）与 `@types/hast`（开发）—— 高亮**数据**委托专业库（190+ 语言），CLI 仅实现渲染（见「语法高亮」）。
- **移除依赖**：`inquirer`、`@types/inquirer`、`chalk` —— 三者均已从代码中彻底移除：inquirer 的确认改由调用方注入（TUI 走 Ink 确认框）；着色改用 Ink `<Text color>`（随 SDK 升级到 `1.0.0-alpha.1`，chalk / inquirer 已从依赖树中彻底消失）。
- **TUI 输出统一走 Ink**：迁移进度、跳过迁移、会话落盘失败等提示不再 `console.log` / `console.warn` 直写终端（会撕裂 Ink 帧），改为经回调上报、由对话屏渲染为 notice 块；启动 Logo 渐变也由 chalk 字符串改为 Ink 逐字符 `<Text color>`。
- **配置向导改为「吸底」布局（修复 VS Code 终端里被裁切）**：此前配置中心 / 凭据设置屏是**顶对齐短帧**，从对话屏（整帧高 = 终端行数 − 1）切过来时，Ink 的擦除 / 滚动会错位，内容被顶出视口、渲染不全。现在向导与对话屏统一为「顶部留白 + 内容贴底」，整帧高度一致、内容不再飘出可视区：
  - 新增纯函数 `bottomPadding()` 与 `WizardFrame` 外壳（菜单 / 列表 / 输入屏全部套用）；输入屏的硬件光标 y 随留白一起算（`promptLayout()`，IME 仍精确跟随）；
  - 列表项与键位提示统一裁成**严格单行**（新增 `clipWidth()`，`SelectList` 接受 `columns`），列表过长时自动截断并提示，避免折行把帧高撞破；
  - `/load`、`/back` 的覆盖层同样传入列宽裁剪条目。
- **配置中心「端点管理」改造**：原「端点凭据 / 端点地址 / 新建端点」三条合并为**一条「端点管理」**——列表 = [＋ 新建端点] + 各端点；选中端点进入**详情屏**，一屏同时列出该端点的 API Key 与 Base URL（`↑ ↓` 切换字段、`Enter` 就地编辑、`Tab` 切密钥明文/掩码、`Esc` 返回；未改动不写盘）。新建端点仍为「名称 → Base URL → API Key」三步，完成后回到端点列表。
- **配置中心全面化**：`/config` 从「端点 + 默认模型」扩展为**尽可能全面管理 `config.json`** —— 端点（增删改：名称/Base URL/API Key/描述）、模型（增删改：名称/端点/模型名/迁移阈值/视觉/描述/自定义）、图片模型（增删改：名称/端点/模型名/尺寸/质量/自定义）、默认项（默认模型/默认图片模型/默认 Agent/默认迁移模型）、工具输出上限。列表 = [＋ 新建…] + 各条目；选中进入**通用详情屏**就地编辑（文本/密钥/数字/布尔/枚举五类字段；枚举弹选项列表、布尔即时切换、危险动作二次确认）。编辑「出厂托管」模型会自动标记 `custom: true`，避免被 SDK 同步覆盖；删除端点前校验模型引用。纯函数层新增 `update{Endpoint,Model,ImageModel}` / `remove*` / `addModel` / `addImageModel` / `setDefault*` / `setMaxToolOutput` / `unique*Id`。
- **配置中心新增「MCP 服务器」管理**：`/config` 新增 MCP 服务器管理屏，完整管理 `mcp.json` 的增删改 —— 作用域可**屏内切换**（全局 `~/.ai-zen/mcp.json` / 项目 `<cwd>/.ai-zen/mcp.json`）；每个服务器可编辑名称（改 key）、传输方式（stdio / http / sse）、启用·禁用、描述，以及按传输方式区分的字段（stdio：命令 / 参数 / 环境变量；http·sse：URL / 请求头）。参数按 shell 风格（引号 / 转义）解析为 argv；环境变量与请求头走**键值编辑子屏**（`KEY=VALUE`，可增 / 改 / 删）。改动即时写盘，关闭配置中心后**重建会话**让新工具生效。`src/config.ts` 的 MCP 读写**作用域化**（`readMcpConfig(scope)` / `writeMcpConfig(cfg, scope)` / `readMcpConfigAt` / `writeMcpConfigAt` / `mcpConfigPath`），服务器条目类型补全 `disabled` / `description` / `oauth`（并保留未知字段）；纯函数层新增 `parseArgs` / `formatArgs` / `parseKvInput` / `kvEntries` / `kvSummary` / `addMcpServer` / `updateMcpServer` / `removeMcpServer` / `renameMcpServer` / `uniqueMcpServerId` / `mcpServerIdTaken` / `findMcpServer`。
- **配置中心新增「Agent 定义」管理**：`/config` 新增 Agent 定义管理屏，管理顶层 Agent（`~/.ai-zen/agents/*.json`）与子 Agent（`~/.ai-zen/sub-agents/*.json`）的增删改 —— 列表区分两类并各带「＋ 新建」；详情屏可编辑名称 / 标识（改文件名 = 重命名）/ 描述 / 模型（枚举自 `config.models`）/ 四维权限（`tools`·`skills`·`mcps`·`subagents`，紧凑语法 `allow: a, b` / `deny: x`）/ 自定义开关；Sub-agent 另有 `function`（函数名 / 说明 / 参数 schema，带 JSON 校验）。**提示词**为多行内容，`Enter` 调起**系统编辑器**（复用 `/editor` 的 `suspendTerminal` 模式：`$EDITOR`，Windows 默认 `notepad`）编辑后回写首条 system 消息。编辑「出厂托管」的 `default` Agent 会自动标记 `custom: true`，避免改动被 SDK 同步覆盖；改动即时写盘，关闭配置中心后**重建会话**。新增 `src/agents-store.ts`（`AgentKind` / `AgentStore` / `readAgentStore` / `createAgentStore`）与纯函数 `createAgentDefinition` / `createSubAgentDefinition` / `getAgentPrompt` / `setAgentPrompt` / `parsePermission` / `formatPermission` / `setAgentPermission` / `summarizePermissions` / `parseFunctionParameters` / `formatFunctionParameters` / `updateAgentFunction` / `uniqueAgentId` 等。
- **多行文本统一走系统编辑器**：配置中心里 Agent 提示词、Sub-agent **函数说明 / 参数 schema** 等**多行字段**均按 `Enter` 调起系统编辑器（`$EDITOR`，Windows 默认 `notepad`）；参数 schema 以 `.json` 打开、保存后即时校验（非法 JSON 被拒，且**保留改动**便于继续修改），内容未改动则不写盘。
- **修复「详情屏字段高亮越界」**：`DetailStep` 现按当前行数收敛高亮索引 —— Agent 详情屏与权限子屏共用该组件，切换时索引可能超出新屏行数而无可高亮项；现进入后自动收敛到有效行。
- **修复「多轮工具调用在对话区被拼到同一行」**：AI 一轮里可**并行**调用多个工具，且**工具执行后会在同一轮对话内继续下一轮**（每次请求 SDK 都 `emit("open")`）；每轮的 `tool_calls.index` 都会从 `0` 重新计数，而流式渲染此前**按 index 归并不分轮**，导致第二轮的工具名被追加到上一轮同一行上（`read` + `edit` → `readedit`，参数同理混在一起）。现为 `live` 增加「本轮起始下标 `roundBase`」，每轮开始（`assistant-start`）时锚定当前工具数，新一轮的 index 落到**新的一行** —— 并行与多轮工具调用各自独立成行。
- **修复「输入框偶尔自动填入 `[?0u`」**：Ink 的 `kittyKeyboard: auto` 会在**每个实例创建时**向终端发送一次 `CSI ? u` 查询，终端回 `CSI ? 0 u`（flags=0，不支持）；本 TUI 反复挂载（启动界面 → 对话 → 配置向导 …），应答源源不断。应答一旦被**拆包**（前导 ESC 被 Ink 的「待定转义刷新」当作一次独立的 Escape 键消费），残留在后一个 chunk 里的 `[?0u` 会退化成普通文本、被当作输入插入对话框（已实测重现）。修法两层：
  - 渲染选项改为 `kittyKeyboard: { mode: "disabled" }`，**不再发查询**（根因消除；该协议在本环境本就不生效，换行由不依赖终端协议的 `Ctrl+N` / `Ctrl+J` 承担）；
  - 新增纯函数 `isTerminalReply()`，在输入层丢弃整段终端应答（Kitty 协议应答 / 光标位置报告 / 设备状态报告），逐字键入同样字符不受影响。
- **修复「斜杠命令菜单回车不执行」**：输入 `/` 时下方会实时列出候选命令（可 `↑ ↓` 选择），但此前回车把**半截输入**（如仅 `/` 或未补全的命令名）直接提交，落到「未知命令」报错。现在候选菜单可见时回车**直接执行高亮命令**（与先 `Tab` 补全再回车等效）；并在输入变化后把高亮重置回首项、对越界索引兑底，避免「看似选中却回车落空」；同时把 `exit` 移到命令列表末尾，避免「只输入 `/` 就回车」直接退出。逻辑抽为纯函数 `resolveSubmitText()` 便于单测。
- `tsconfig.json` 启用 `jsx: react-jsx`。
- **移除旧行式对话链路（死代码）**：`src/conversation-runner.ts`、`src/slash-hint-prompt.ts`、`src/delta-renderer.ts`、`src/config-wizard.ts`、`src/draft-repository.ts`、`src/draft-plugin.ts` 及 `src/conversation-commands/` 下的命令处理器（保留 `registry.ts` 作为命令清单唯一来源，供 TUI 复用）。注：其中被删除的是 **inquirer 版** `src/config-wizard.ts`；同版本新增的 `src/tui/config-wizard.tsx` 是**纯 Ink 重写**，二者无关。
- **移除主菜单**：删除 `MainMenu` 次级屏幕、`/menu` 命令与整个 `src/menus/*`（inquirer 流程）；对话内 `/load` 所需的列表函数迁为 `conversation-repository.ts` 的 `listConversations()`。菜单功能（管理 Agents / 管理已保存对话等）转为 P1 待办，将以 Ink 原生组件重新实现；其中**配置管理**已在同版本以 Ink 原生的 `/config` 配置中心回归（见上）。
- 新增 `src/session-pointer.ts`（上一轮会话 id 指针，原子写）与 `src/conversation-persist-plugin.ts`（每轮落盘会话 + 更新指针）。
- 新增 `src/config-editor.ts`：配置查询与**不可变改写**的纯函数层（模型/端点解析、凭据状态、密钥掩码、厂商申请指引、新增端点），供 TUI 与单测共用。
- 新增 `src/tui/config-wizard.tsx`：**纯 Ink** 的凭据设置屏 / 配置中心 / 单行输入屏（自带硬件光标同步，IME 候选框跟随）。
- 文本度量与折行（`displayWidth` / `wrapText` / `layoutInput` / `INPUT_PREFIX_WIDTH` / `usableFrameRows`）抽到 `src/tui/text.ts`，消除 `screens.tsx` 与向导之间的循环依赖（`screens.tsx` 保留 re-export，既有引用与测试不变）。
- `resetScope()` 改为 `async` 并 `dispose()` 旧 Scope；新增 `ChatSession.reload()`。**Scope 持有配置快照**，改了端点凭据 / 地址后必须连同 Scope 一起重建才会生效（这也是 `/config`、`/key` 保存后能立刻生效的原因）。
- `src/index.ts` 的 TUI 分支改调 `runTui()`；`src/tui/` 为新的界面实现（`theme` / `components` / `screens` / `chat-session` / `index`）。

### ✅ 测试

- 新增 `src/tui/theme.test.ts`、`src/tui/screens.test.tsx`：颜色/渐变/Logo、组件渲染、`chatReducer` 流式拼接、`messagesToBlocks`、`stripCwdNote`，以及吸底布局的文本测量/折行、块 → 行、`computeChatLayout`（行数守恒 + 应用内翻页视口 + 内容冻结）、`layoutInput` 光标定位、`computeInputCursorPosition`（IME 光标）、`wordLeft`/`wordRight` 跨词移动、`usableFrameRows` 预留末行。
- `src/agent-creator.test.ts` 改为「临时 `AI_ZEN_DIR` + 动态 import」，不再依赖 `vi.mock`（在某些环境中 `vi.mock` 会静默失效）。
- `screens.test.tsx` 新增 `isTerminalReply`（终端应答识别与不误伤普通输入）、`resolveSubmitText`（斜杠菜单回车执行高亮命令 / 越界兑底 / 非命令原样返回）与 `RENDER_OPTIONS` 决策锁定（断言 kitty 查询已关闭）；`config-wizard.test.tsx` 新增「终端应答不写进输入框 / 逐字键入不受影响」用例。
- `config-wizard.test.tsx` 新增吸底布局用例：`promptLayout` 的顶部留白与硬件光标坐标（含宽字符列宽）、内容超帧时留白为 0；菜单屏与列表屏的整帧高度、顶部留白与「内容贴底」断言。
- `src/config-editor.test.ts` 扩展至 **20 例**：在原有查询/掩码/厂商指引/不可变改写/端点 id 派生之外，新增 `update{Endpoint,Model,ImageModel}`、`remove*`（含悬空默认引用修正）、`addModel`/`addImageModel`、`setDefault*` / `setMaxToolOutput`、`uniqueModelId`/`uniqueImageModelId`。
- 新增 `src/tui/config-wizard.test.tsx`（**27 例**：掩码输入不回显明文、`Tab` 切明文、`Esc` 取消、`Backspace`/`Home` 编辑、菜单 → 端点管理 → 选中端点就地编辑并写盘、端点详情字段切换/URL 校验/未改动不写盘、空 Key/非法 URL 校验、`closeOnSave` 保存即关闭、新建端点三步、默认模型切换，以及**新建模型自动 `custom: true`、模型详情布尔切换、托管模型编辑自动转自定义、删除端点引用守卫、默认 Agent 枚举选择、工具输出上限**）。
- 新增 `src/tui/highlight.test.ts`（9 例）：JSON / 代码的 scope 归类、语言别名（`ts` → `typescript`）、未注册语言回退（原样不着色）、空串、围栏切分；`screens.test.tsx` 新增「工具调用参数带 JSON 高亮分段」「正文围栏代码块按语言高亮且不显示裸围栏」两例。
- 全量单测 13 文件 / 224 例通过；`tsc --noEmit` 与 `npm run build` 零错误；e2e 12 例通过；真实 PTY 实测「启动→直达对话→流式→`/load`→`/clear`→退出交还 shell」全链路正常。
- 用「假 TTY」探针向 Ink 捕获实际写出的字节：`kittyKeyboard: auto` 每个实例写 1 次 `ESC[?u` 查询，`disabled` 为 0 次（对照实验，确认根因已消除）；真实 PTY 中手工注入 `[?0u` 应答不再落入输入框。
- 真实 PTY 实测首启凭据链路：`AI_ZEN_DIR` 指向空目录启动 → 弹出凭据设置屏 → 输入 Key 后写盘并直接进入对话（仅目标端点的 `apiKey` 被写入）→ `/config` 改「非当前端点」凭据（回菜单并提示，不重建会话）→ `/key` 改当前端点凭据（保存后自动重建会话）→ 退出后二次启动跳过凭据引导；`/help` 正确列出 `/config` 与 `/key`。

## [0.10.0] - 2026-09-30

### 💥 破坏性变更

- **启动命令由 `aiz` / `zen` 改为 `ai`** — `package.json` 的 `bin` 改为 `{ "ai", "aiz", "zen" }`。`aiz` / `zen` 作为**过渡别名**在当前版本保留，未来版本移除。
- **引入双模式运行，两种模式互不混合** — 此前「有参数 = 快速对话后继续进入交互循环」的行为被废除，改为：
  - **纯 stdio 模式**：带位置参数，**或** stdin/stdout 非 TTY（管道、重定向、CI）时启用。**无任何额外交互**，把最终 assistant 文本以纯文本写入 `stdout`（零 ANSI / emoji 前缀 / spinner），日志、进度、工具过程与错误摘要一律走 `stderr`；成功退出码 `0`，失败非 `0`；默认**不落盘**。
  - **TUI 模式**：仅在**无参数且 stdin/stdout 均为 TTY** 时进入（原交互式主菜单）。

### ✨ 新增

- `src/mode.ts` — 运行模式判定与启动参数解析（纯函数，单测覆盖）：`decideMode` / `resolveInvocation`。
- `src/stdio-runner.ts` — 纯 stdio 运行器：读取 stdin、合并「参数指令 + stdin 内容」、单轮发送、提取最终文本写 stdout。
- 新增启动选项与子命令：`ai --help` / `-h`、`ai --version` / `-v`、`ai --save`。
- 通过 SDK 的 `setLogger` 将 SDK 日志与 `console.log` 统一改道 `stderr`，保证 stdout 纯净。

### 🔧 变更

- `src/index.ts` 重构为「模式路由 + 两套入口分发」，业务逻辑下移到 `mode.ts` / `stdio-runner.ts`。
- shell 兜底钩子函数体由 `aiz "$@"` 改为 `ai "$@"`；标记由 `aiz hook` 改为 `ai hook`，`ai hook install` 会自动识别并升级旧的 `aiz` 钩子块（`ai hook uninstall` 同时清理两代标记）。
- 修正 `src/conversation-runner.ts` 中过时提示文案（`aiz config set-key` → 运行 `ai` 进入交互界面配置）。
- 文档：中英 README 与 `docs/zh|en/{index,getting-started,configuration}.md` 补充「运行模式」说明并全量改用 `ai` 命令名；`docs/manifest.json` 版本与描述同步。

### ✅ 测试

- 新增 `src/mode.test.ts`（14 例）：模式判定与参数路由。
- 新增 `src/stdio-runner.test.ts`（9 例）：`mergePrompt` 合并语义与 `extractText` 文本提取。
- e2e 重写为双模式场景（12 例）：子命令、stdio 纯净性（无 ANSI）、退出码、`--save` 落盘、真实 API 管道对话。
- `tsc --noEmit`（`tsconfig.test.json`）与 `npm run build` 零错误。

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
