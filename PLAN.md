# CLI 审查问题修复计划

> 本文件是逐条决策的落地记录。每一条都已经过「定性 → 拍板」，未经再确认不得改修法。
> 决策日期：2026-11-02 · 基线 `dcb16a6`（`1.0.0-alpha.29`）· 目标 `1.0.0-alpha.30`

## 0. 前置规则

1. **修法已定，不得自行扩大**。每条只做表里写的事。
2. **先红后绿**：每条修复先写失败用例，跑红，再改实现，跑到绿。
3. **不加兜底**：对几乎不可能发生的场景（并发同 tick、坏文件、极端窗口尺寸）不加分支、不加锁、不降级。宁可明确报错。
4. **一处根因**：不为了「保险」在多处重复校验。
5. 提交信息用中文：`<type>(cli):` / `<type>(sdk):` + 要点列表；提交前跑全量测试。

## 1. 总览

### 1.1 要修（22 项）

**纯 BUG（不改行为）**

| ID | 内容 | 位置 |
|---|---|---|
| L3 | KV 编辑器删除末项后回车 `TypeError` | `src/tui/config-wizard/kv-editor.tsx:44-48,95-101` |
| L6 | `SelectList` 索引越界后回车 `TypeError` | `src/tui/components.tsx:69-79` |
| L7 | 落盘失败按 `info` 上报 | `src/tui/chat-session.ts:453-459` |
| L8 | `/back` 撤回不落盘 | `src/tui/screens/chat-commands.ts:217-218` |
| L11 | 删除 Agent 不清理 `defaultAgent` → 启动死锁 | `src/tui/config-wizard/engine.ts:166-171` |
| L13 | stdout 无 EPIPE 处理 | `src/index.ts` |
| L15 | `/load` `/back` 条数预算少扣 2 行 | `src/tui/screens/chat-commands.ts:153,209` |
| L20 | `truncate` 按 UTF-16 切坏 emoji | `src/tui/screens/render.tsx:76-79` |
| L24 | e2e 断言与事实不符且被排除 | `src/__tests__/e2e.test.ts:174-181` |

**SDK 侧**

| ID | 内容 | 位置 |
|---|---|---|
| L2 + L31 | `EntityRepository.path()` 路径穿越（同时覆盖会话 id） | SDK `packages/sdk/src/shared/EntityRepository.ts:19` |

**行为变更**

| ID | 内容 |
|---|---|
| L14 + L16 | 菜单底部锚定 + 连续滚动 + `/` `@` 共用 |
| — | `↑`/`↓` 多行时移动光标，到首/末行才翻历史 |
| L17 | 输入区限高 8 行，窗口跟随光标 |
| L9 | `↑` 翻历史带图片（数据源统一到 `messages`） |
| L10 | 详情屏隐藏 `custom`、交互改成「恢复出厂设置」 |
| L18 | 粘贴文本 256KB 上限，超了报错 |
| L19 | `@` token 边界补 15 个全角标点 |
| L32 | 没有端点时禁止创建模型 |
| L4 + L4b | 坏 `mcp.json` 进屏报错、保存照常 |
| — | `/load` 列表只显示会话文件名 |
| — | `/save` 支持指定名字 + 重名二次确认 |
| — | 版本号 `alpha.30` + CHANGELOG |

### 1.2 不修（16 项）

| ID | 理由 |
|---|---|
| L1 | hook 残缺块清理：坏文件不兜底 |
| L5 | stdio 等 stdin EOF 是管道语义，不是缺陷 |
| L12 | `ai --save` 进 TUI 无损失 |
| L21 | tab 计宽为 0：Tab 是补全键，基本进不了输入 |
| L22 | 每轮全量落盘是有意的（崩溃不丢消息） |
| L23 | 高亮缓存键=整段代码：无实测问题 |
| L25 | 指针固定 `.tmp`：需同 tick 两次落盘 |
| L26 | `migrateDefinition` 非原子：一次性迁移 |
| L27 | `fs.glob` 无超时：git 路径有 5s 超时，兜底有 20000 条封顶 |
| L28 | `format-time` 无 `isValid`：只影响显示 |
| L29 | hook 短路早于残缺块：与 L1 同源 |
| L30 | 覆盖层并发悬挂：picker 打开时输入框失活 |
| L33 | `MAX_PASTED_IMAGES` 陈旧闭包：仅文案张数可能旧一位 |
| L34 | 剪贴板探测无缓存：缓存会掩盖「刚装了 wl-clipboard」 |
| L35 | `/update` 无超时：Ctrl+C 可退 |
| — | `@` 索引改按层扫描：**维持全量 fuzzy** |

### 1.3 参数

| 参数 | 值 |
|---|---|
| 输入区限高 | 8 行（超出显示含光标的窗口） |
| 菜单行数上限 | **无上限**，占满输入框上方可用空间，顶部溢出丢弃 |
| 菜单默认选中 | `hints[0]`（贴输入框那条） |
| 菜单滚动 | 连续滚动，选中项始终可见 |
| 粘贴文本上限 | 256KB，超了报错 |
| 全角标点 | `。 、 ！ ？ （ ） 《 》 【 】 〔 〕 「 」 『 』 … — ～` |
| 错误文案 | 事实 + 下一步（仅对用户能自己解决的错误） |
| 版本号 | `1.0.0-alpha.30` |

---

## 2. 第一批：纯 BUG（8 条）

每条独立提交，互不依赖。

### L3 · KV 编辑器删除末项后回车崩溃

**现状**：`remove()`（`kv-editor.tsx:44-48`）只提交，不重置 `index`；`Enter` 分支（`:95-101`）用 `entries[index - 1]!`，`index` 越界时 `entry` 是 `undefined`，`entry.key` 抛 `TypeError`。

**修法**：`remove()` 提交后钳制光标 —— `setIndex((i) => Math.min(i, entries.length))`。此处 `entries.length` 是删除前的旧值，正好等于删除后的最大合法 index。

**测试**：`src/tui/config-wizard.test.tsx` 加「3 项 → ↓ 到最后 → Ctrl+D → Enter」用例，先跑红。

### L6 · `SelectList` 索引越界后回车崩溃

**现状**：`index` 只在挂载时算一次（`useState(Math.min(initialIndex, …))`），列表项变短后不重置；回车用 `items[index].value`。

**修法**：渲染处取 `const safeIndex = Math.min(index, Math.max(items.length - 1, 0))`，高亮与 `onSelect` 都用 `safeIndex`。不改 state（避免 effect 依赖）。

**测试**：组件测试加「items 由 3 项变 1 项后按 Enter」用例。

### L7 · 落盘失败的语气

**现状**：`chat-session.ts:453-459` 的 `onError: (text) => this.notifier.onNotice(text, "info")`。

**修法**：tone 改 `"error"`。**不做**粘性通知（`MAX_NOTICE_HISTORY = 4` 保持不变）。

**测试**：断言通知 tone 为 `error`。

### L8 · `/back` 撤回不落盘

**现状**：`chat-commands.ts:217-218` 是 `rollbackTo(...)` 紧接 `exit({ restart: true, ... })`，中间没有 `save()`。

**修法**：`rollbackTo` 之后、`exit` 之前 `await session.save()`。注意 `save()` 走 `persistConversation`，会更新 last-session 指针，这是预期行为。

**测试**：撤回后读会话文件，断言被撤回的消息不在。

### L11 · 删除 Agent 后启动死锁

**现状**：`engine.ts:166-171` 的 `deleteAgent` 只删文件 + `markDirty`，不动 `config.defaultAgent`；`index.tsx:173` 的 `config.defaultAgent ?? agents[0]?.id` 在 `defaultAgent` 非空时不回退；`modelOf` 抛错 → `index.tsx:338-341` 打印后直接退出。

**修法**：`deleteAgent` 中若 `kind === "agent" && id === config.defaultAgent`，一并 `persist({ ...config, defaultAgent: undefined }, …)`。清空即可 —— `index.tsx:173` 的 `?? agents[0]?.id` 会接住。

**测试**：删掉默认 Agent 后 `resolveTarget()` 不抛错。

### L13 · stdout EPIPE

**现状**：`grep EPIPE src/` 为空；`stdio-runner.ts:181` 直接 `process.stdout.write(text)`。

**修法**：`src/index.ts` 顶部注册 `process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); })`。

**测试**：`ai "..." | head -1` 真机验证一次（属端到端，可用 `AI_ZEN_DIR=/tmp/...`）。

### L15 · picker 条数预算少扣 2 行

**现状**：两处 `Math.max(1, (rows ?? 24) - 8)`。但命令上下文的 `rows` 是**原始终端行数**，而布局用 `usableFrameRows(rows) = rows - 1`；overlay 模式 `bottomLines = pickerLines(n) + statusBarLines = (7 + n) + 2`。所以 `n_max` 应为 `rows - 10`。

**修法**：两处改成 `Math.max(1, rows - (pickerLines(0) + STATUS_BAR_LINES + 1))`，不要留魔数。

**测试**：边界条数下断言 `bottomLines <= usableFrameRows(rows)`。

### L20 · `truncate` 切坏 emoji

**现状**：`render.tsx:76-79` 用 `.length` / `.slice`（UTF-16 code unit）。

**修法**：改用 `graphemes()`：
```ts
const chars = graphemes(single);
return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : single;
```

**测试**：截断点落在 emoji 中间的用例，断言输出无孤立代理项。

### L24 · e2e 断言与事实不符

**现状**：`e2e.test.ts:174-181` 断言 `ai hook` 输出到 stderr 且退出码 1。实际 `index.ts:81-84` 写 stdout、退出码 0（1 只属于「未知子动作」分支）。且 `vitest.config.ts:8` 排除了该文件，永远不会红。

**修法**：断言改为 `expect(result.stdout).toContain("用法")` + `expect(result.exitCode).toBe(0)`。

**结论（已拍板）**：e2e **不**纳入 `npm test` —— 单独命令本来就有（`test:e2e` / `test:all`），
单测保持秒级。真正缺的只是发布门禁：`prepublishOnly` 以前只跑 `npm test`，e2e 从不参与，
已改成 `npm run test:all`。

---

## 3. 第二批：布局与交互

三条都在输入区/菜单，必须一起设计。

### L14 + L16 · 菜单底部锚定

**目标行为**

- `hints[0]` 紧贴输入框，`hints[1]` 在其上方，依次向上生长
- 可用高度 `H` = 输入框上方到屏幕顶端的全部空间，**不设行数上限**
- 放不下的从**顶部**丢弃
- 默认选中 `hints[0]`（最底部）
- `↑` = 选下一条（高亮视觉上移），`↓` = 选上一条（视觉下移）
- 选中项跑出窗口时**连续滚动**：窗口 `from = max(0, i - H + 1)`
- `/` 与 `@` 共用同一套组件

**实现要点**

1. **渲染层反转**，不改数据顺序：
   ```ts
   const visible = items.slice(from, from + H).reverse();
   ```
   `selected` 始终是 `items` 的下标，按键、滚动、测试都按数据顺序读。数据层反转会让 `selected` 与下标反向，映射散落三处，明确否决。

2. 抽出公共组件（替代 `SlashMenu` 与 `MentionMenu` 两套）：
   - `components.tsx` 新增底部锚定菜单，props 至少含 `items` / `selected` / `maxRows` / 每项的 label+hint 渲染
   - `@` 菜单保留「扫描中…」占位与目录尾斜杠

3. `chat.tsx:424` 的 `menuRows` 改为**实际渲染行数** `Math.min(候选数, H)`，喂给 `computeChatLayout` 的 `hintCount`。两者必须严格一致，否则输入框位移（历史上通知栏踩过）。

4. `chat.tsx:757-771` 的 `↑`/`↓` 分支：菜单打开时改为 `↑` → `+1`、`↓` → `-1`。

5. `mention.ts` 的 `MENTION_ROWS` 与 `menuWindow` 随之废弃（或改造成 `H` 驱动的版本）。

**测试**：菜单渲染行数、`hintCount` 与渲染行数一致、选中项滚动时始终可见、`↑`/`↓` 方向。

### 新增 · `↑`/`↓` 多行移动光标

**现状**：`↑`/`↓` 恒为历史（有菜单时归菜单），`Shift+↑/↓` 为滚动对话区，**没有任何组合移动输入光标上下行**；光标只能靠 `←` 一路退。

**目标行为**

- 输入内容 ≥ 2 行时，`↑`/`↓` 优先移动光标到上/下一行
- 光标已在首行按 `↑`、或在末行按 `↓` 时，才翻历史
- `Shift+↑/↓` 继续归滚动对话区

**实现要点**

- `use-input-editing.ts` 新增 `moveCursorUpRow` / `moveCursorDownRow`：按折行后的 `(row, col)` 推算目标行的同列位置，行长度不足时落到行尾
- 需要知道折行宽度（`layoutInput` 已有），或在 `chat.tsx` 层用 `inputLayout` 的结果换算后调用 `setCursor`

### L17 · 输入区限高 8 行

**现状**：`layout.ts:89` 的 `inputHeight = inputLines(...).length`，无上限。

**目标行为**

- 最多 8 行
- 窗口**跟随光标**（不是固定显示末尾）——`←` 在行首会退到上一行，光标能跑到第一行
- `from = Math.min(Math.max(0, cursorRow - N + 1), Math.max(0, total - N))`

**实现要点**

- `input.ts` 的 `inputLines` 继续返回全部行，另加窗口计算
- `layout.ts:89` 的 `inputHeight` 改用窗口长度
- `computeInputCursorPosition`（`input.ts:27-59`）的 `y` 里 `cursorRow` 换成 `cursorRow - from`
- 三处（`computeChatLayout` 的 `inputHeight`、`computeInputCursorPosition` 的 y、实际渲染行数）必须同源

**测试**：粘贴 20 行后光标在首行/末行时，渲染行数与硬件光标 y 都正确。

---

## 4. 第三批：会话闭环

### `/load` 列表只显示文件名

**现状**：`chat-commands.ts:162-165` 每行是 `label: c.preview || c.name` + `hint: formatShortTime(c.updatedAt)`；`ConversationSummary`（`conversation-repository.ts:118-126`）带 `name`/`preview`/`updatedAt`/`size`；`listConversations({ previewLimit })` 会解析会话文件取摘要。

**目标**：列表只显示会话文件名（`id`）。

**连带删除**

| 位置 | 内容 |
|---|---|
| `ConversationSummary` | `name` / `preview` / `updatedAt` / `size` 全部去掉，只剩 `id` |
| `conversationPreview()` | 整个函数删除 |
| `PREVIEW_MAX` | 删除 |
| `listConversations(options)` | 参数消失，只 `readdir` + `stat`，不 `read` 任何会话文件 |
| `chat-commands.ts:150-153` | `maxItems`/`previewLimit` 那套作废 |

**排序**：仍按 mtime 倒序（不显示时间 ≠ 不按时间排）。

**注意**：这条消灭的是「读」，不是「写」——每轮全量写 `messages` 仍然存在（L22 已定不修）。另外 `persistConversation`（`conversation-repository.ts:91`）那次「为拿 `createdAt` 而全量读」也随之删除；`createdAt` 改为创建时定、`persist` 不再更新，需处理 `Conversation.createdAt` 的必填语义。

### `/save` 支持指定名字

**现状**：`cmdSave`（`chat-commands.ts:142-149`）不接 `args`，`/save foo` 的 `foo` 被静默丢弃，永远用 `chat_<时间戳>`。

**目标**

- `/save <名字>` 把当前会话存为指定文件名
- `/save` 无参数时维持现状（时间戳 id）
- 目标名 == 当前 id → 直接保存
- 目标名已存在且 ≠ 当前 id → **弹二次确认**，确认后覆盖，取消则不写
- 名字必须过路径校验（复用 L2，见下）

**实现要点**

1. 名字校验：`conversationRepository` 的 `path()` 在 L2 修好后自动生效（`AtomicConversationRepository extends EntityRepository`）。**不要另写一套**。
2. 改名 = `fs.rename(<旧>.json, <新>.json)`，然后更新 `currentId` 与 last-session 指针。
3. 后续自动落盘走 `getId()`，会写到新文件，无需额外处理。

**注意两处行为差异**（L2 修完后依然存在，不是 bug）：
- 会话仓储 `write` 里 `fs.mkdir(dirname(target), { recursive: true })` 会建父目录 → `/save a/b` 能成功建子目录
- agent 仓储只 mkdir 自己那层 → 同名 id 会 ENOENT

### L9 · `↑` 带图片重发

**现状**：`use-input-editing.ts:89` 的 `history` 是独立 `string[]`，只存文本；图片在 `pastedImages`（`chat.tsx:172`），只有 `Ctrl+V` 能加。`↑` 回到带图消息时图片不恢复、无提示，直接回车会静默重发纯文本。

**目标**：`↑` 的数据源统一到 `session.messages` 的 user 消息，图片天然跟着。

**实现要点**

1. 筛 `Role.User`，从 `MessageContent` 提取文本（`messages-view.ts:13-25` 已有现成提取逻辑可复用）
2. `history` 状态改为从 `messages` 派生；`useInputEditing` 需要一个外部数据源（getter 或 props）
3. 图片还原：`image_url` 的 data URL 可解回 `{ base64, mime }`；**`file_id` 类型还原不了**（Files API 上传过的图本地没副本），这种情况只恢复文本

**行为差异（预期内，写进 CHANGELOG）**

- 斜杠命令不进 `messages`，`↑` 仍翻不到（与现在一致）
- 上下文裁剪标记 `omit` 的老消息会翻不到

---

## 5. 第四批：配置

### L10 · 详情屏隐藏 `custom`、交互改成「恢复出厂设置」

> 措辞校正：`custom` **不从 schema 里删** —— 字段一直在 JSON 里，SDK 靠它判断托管。
> 本次只删详情屏的那一行字段，并把交互换成「恢复出厂设置」。

**现状**：`fields.ts:233-248` 的 `custom` 开关。关掉自建模型的 `custom` → 不在出厂清单 → `syncManagedModels`（SDK `ConfigManager.ts:452-458`）下一轮读取时**静默删除该模型**。

**目标**

- 详情屏不再展示 `custom` 布尔字段
- 改为一个「恢复出厂设置」按钮：对出厂模型恢复出厂定义
- 自建模型不显示该按钮

**已核实的前提**（不需要额外改动）

- 自建模型创建时默认 `custom: true`（`config-editor.ts:262,302`）
- 改出厂模型任一字段会被 `customPatch`（`fields.ts:90-91`）自动标 `custom: true`
- 实现路径（已落地）：用 `DEFAULT_APP_CONFIG` 里同 id 的出厂定义**整条替换**当前条目
  （`restoreFactoryModel` / `restoreFactoryImageModel`），`custom` 随之消失 = 重新归 SDK 托管；
  默认 Agent 只把 `messages` 换回 `DEFAULT_AGENT_DEFINITION`（与 `ensureDefaultAgent` 语义一致）

**注意**：不动 SDK 的 `syncManagedModels`（原方案 (c) 已否决）。

### L32 · 没有端点时禁止创建模型

**现状**：`step-models.tsx:130-165`，`endpointId = config.endpoints[0]?.id ?? ""`，只显示一行提示但仍可创建，产出 `endpointId: ""` 的模型。

**修法**：`config.endpoints.length === 0` 时，`onSubmit` 直接 `setError(t(...))` 拒绝，不调用 `addModel`。

**文案**：事实 + 下一步 ——「没有可用的端点，请先在「端点」里添加一个」。同时考虑把「新建模型」入口在无端点时直接禁用（只做一处即可，避免重复校验）。

### L4 + L4b · 坏 `mcp.json`

**现状**：`readMcpConfigAt`（`config.ts:228-243`）把「文件不存在」和「解析失败」都返回 `{ mcpServers: {} }`；`writeMcpConfigAt` 会把结果整个覆盖。调用点：`use-wizard-host.ts:77`、`chat-commands.ts:591-592`。

**目标**

- 区分「不存在」（正常空配置）与「解析失败」（损坏）
- 损坏时**仍允许进编辑屏**，但明确提示「文件已损坏，无法读取」
- **保存照常** —— 用户看到提示后保存，产出的正是一个格式正确的新文件，这是修复而非覆盖丢数据

**实现要点**

- `readMcpConfigAt` 返回值能表达解析失败（如 `{ ok: false, error }`），调用侧把错误送进编辑屏
- 两个调用点同步处理（L4b 一并解决，无独立决策）
- 文案：事实，不带「怎么办」（用户已经知道要修文件）

---

## 6. 第五批：其余

### L18 · 粘贴文本上限

**现状**：`clipboard.ts:198-210` 的 `readClipboardText` 无上限（`MAX_CLIPBOARD_IMAGE_BYTES = 20MB` 只保护图片）。

**修法**：加 256KB 上限，超了报错，**不截断**。文案带下一步。

### L19 · 全角标点进 `BOUNDARY`

`mention.ts:35-39` 补：`。 、 ！ ？ （ ） 《 》 【 】 〔 〕 「 」 『 』 … — ～`

作用：中文行文里 `@src/tui/chat.tsx。这里有问题` 的 `。` 能收住 token，补全不吞掉后续文字、也不在写句子时乱弹菜单。

**已知代价**：文件名里真含这些字符时 token 会截断（与现有 `,` `;` 的处理同源，可接受）。

### 版本号

- `package.json` / `docs/manifest.json` → `1.0.0-alpha.30`
- `CHANGELOG.md` 分两段：**行为变更** / **修复**
- 行为变更必须点名：菜单底部锚定、`↑`/`↓` 多行移动光标、输入区限高、`↑` 带图重发、`/load` 只显示文件名、`/save` 支持命名、移除 `custom` 字段

---

## 7. SDK 批次：L2

**改动**：`packages/sdk/src/shared/EntityRepository.ts` 的 `path()`

```ts
protected path(id: string): string {
  const root = resolve(this.dir);
  const target = resolve(root, `${id}.json`);
  if (!target.startsWith(root + sep)) {
    throw new Error(`非法实体 id：${JSON.stringify(id)}`);
  }
  return target;
}
```

**必须做对的两点**

1. **`root + sep`，不是裸 `startsWith(root)`**：实测 `../agents-evil/x` 会归一化成 `<root>-evil/x.json`，裸判断放行。
2. **用 `resolve` 不用 `join`**：`resolve` 才会规范化绝对路径（`/etc/passwd` 被拦）。

**为什么放 `path()` 而不是 `write`/`delete`**：`list()` 走 `read()` → `path()`，而 `readdir` 得到的单层文件名不可能逃逸，所以不会像字符集白名单那样把列表搞崩。读写删全走这一处，天然自洽。

**测试**（先红后绿）：`AgentRepository.test.ts` 加三条 —— 普通 `../` 逃逸、兄弟目录前缀绕过（`<dir>-evil`）、`read`/`delete` 入口。注意测试要用**两级临时目录**，让逃逸目标落在 tmpdir 内，不污染 `/tmp` 根。

**门禁**：`startsWith(root + sep)` 拦不住 `x/../b`（归一化后落在 `<root>/b.json`，且会让 `fields.ts:446` 的重名检查失效）。**已知且接受**——危害只剩覆盖别的 agent 定义，`config.json` 已安全。

**结构性前置**：CLI 当前依赖 npm 上的 `agents-sdk@1.0.0-alpha.24`。**改 SDK 源码不影响 CLI 运行时**，必须 `pnpm publish --tag alpha`（SDK 仓规则：只用 pnpm，`scripts/check-publish-tool.mjs` 会拦 npm）→ CLI 升依赖 → 才真正生效。发布需单独授权。

---

## 8. 验证命令

```bash
# CLI：类型 + 全量单测
cd /home/ubuntu/projects/ai-zen/cli
npx tsc --noEmit -p tsconfig.test.json
npx vitest run

# CLI：构建 + 版本号
npm run build && node dist/index.js --version

# SDK
cd /home/ubuntu/projects/ai-zen/agents
pnpm run build-core && pnpm run build-sdk && pnpm test
```

端到端验证一律用隔离目录：`AI_ZEN_DIR=/tmp/...`，绝不碰 `~/.ai-zen/`。

## 9. 决策过程中被否决的方案（勿重蹈）

| 曾提出的方案 | 否决理由 |
|---|---|
| L5 加超时（首字节 1s / 空闲 5s） | 会截断正常数据（`curl 大文件 \| ai`），且等 EOF 本就是管道语义 |
| L5 有参数就不读 stdin | 砍特性，不是修 bug |
| L2 用字符集白名单正则 | 会误伤合法但非 ASCII 的 id；`resolve` + `startsWith` 更兼容 |
| L2/L31 把校验放 `path()` 之外的层 | `path()` 是唯一落盘口，放这里读写删自洽且不破坏 `list()` |
| L9 给 `history` 加图片字段 | 治标；`messages` 里本来就有完整数据，应统一数据源 |
| L10 改 SDK `syncManagedModels` | 改 SDK 要发版；CLI 隐藏字段已足够 |
| L14 菜单固定 8 行 | 用户要「占满可用空间、顶部丢弃」，不设上限 |
| L14 数据层反转数组 | `selected` 与下标反向，映射散落三处，易错 |
| L17 固定显示末尾 N 行 | 光标能退到第一行，必须窗口跟随光标 |
| L22 改增量写 | 每轮全量写是有意的（崩溃不丢消息） |
| `/save` 重名直接覆盖 / 自动加后缀 | 改为二次确认 |
| `@` 索引改按层扫描 + glob | 维持全量 fuzzy，接受索引上限 |
| L4 解析失败时拒绝保存 | 坏文件解析不出内容，保存即修复 |
| L1 检测残缺块后报错 | 坏文件不兜底 |
