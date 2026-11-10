# AGENTS.md —— 本仓的写法约定

给在这一仓里改代码的人（和 Agent）。只写**判据**，不复述代码。

---

## 命名规约：`*Context` / `*Deps` / `*Props` 三条判据

这三条来自一次真实的清理：本仓曾经「Context」一窝蜂 —— `ScrollKeyContext` /
`FieldBuilderContext` 是 React 侧的注入点（能被组件存下来），而 `SendContext` /
`ToolCallContext` 是**一次调用内**有效的钩子载荷（存下来就是 bug）。同一个词指两件相反的
事，于是「这个 ctx 能不能存」每次都得点回去看定义。

| 后缀 | 只用于 | 例子 |
|------|--------|------|
| `Context` | **一次调用内**有效的钩子 / 处理器载荷，**不该被存下来** | core 的 `SendContext` / `ToolCallContext`、命令层的 `CommandContext` |
| `Deps`    | 注入进来的协作者或状态容器（`useRef` 那种也算） | `ChatDeps`、`ToolEnvDeps`、`FieldBuilderDeps`、`RemoteChatSessionDeps` |
| `Props`   | React 组件的入参 | `ConfigWizardProps`、`ChatProps` |

判据的用法：写完一个 `interface XxxYyy`，先问「它活多久」——跨调用存活的注入物是 `Deps`，
只活在这一次调用里的是 `Context`，是组件入参的是 `Props`。**不要求**所有类型都带这三个
后缀（`SubAgentView` / `RestoreOutcome` 这类纯数据不需要），但带上了就必须符合上表。

### 为什么它在这里而不是在某个 `.ts` 里

这段规约原本住在 `src/types.ts` 的文件头 —— 而那个文件除了三条 `export type` 转出之外
零引用（`export * from "@ai-zen/agents-sdk"` 的几个别名，全仓无人 import）。代码可以删，
**判据不能跟着一起埋掉**：它是下一个起名的人唯一能看到的依据。

---

## 边界：`tui/` 是叶子

除 `tui/` 自己以外，全仓**不许** import `tui/`（唯一例外是 `src/index.ts` 里那句
`await import("./tui/index.js")` —— 那是 TUI 入口本身）。

判据不是路径 grep（改个 import 写法就绿了），而是**产物 import 图**：

```bash
npm run build
node scripts/check-imports.mjs dist/stdio.js --forbid tui/
```

会话层（`session.ts`）、命令元数据（`commands/registry.ts`）、纯文本度量（`text.ts`）、
token 速率（`session-rate.ts`）、通知/阶段文案（`session-notice.ts` / `session-phase.ts`）
都在 `tui/` 外面，正是为了让上面这条能被**结构**保证，而不是靠一句「这条链上恰好没有 React」。

---

## 目录图：什么在 `tui/` 里面，什么在外面

```
src/
  index.ts         分发器（唯一的动态 import `./tui/index.js` 的地方）
  mode.ts          调用形态判定（纯）
  stdio.ts         管道模式（一次性调用；自己造一条连接）
  session.ts       会话层：连接 + 命令族 + 把 SessionStream.state 交给界面
  session/types.ts 会话契约（ChatSessionLike / ChatSessionNotifier / ChatSessionOptions）
  session-rate.ts  token 速率（纯）
  session-notice.ts / session-phase.ts  机器码 → 文案（纯）
  text.ts          纯文本度量（stripCwdNote / displayWidth / truncate / usableFrameRows …）
  commands/
    registry.ts    命令元数据（名字 / 别名 / 说明 / 是否阻塞输入）
    types.ts       命令层与覆盖层共享的词汇（SelectItem / 交接方式三选一 / 向导入口步）
    handlers.ts    19 条命令的执行体（表驱动）
    index.ts       出口：只导 runCommand 与公共类型（同时也是产物图门禁的入口）
  tui/             只管渲染与输入（ink）：组件、屏幕、布局、主题、配置向导
```

判据一句话：**`tui/` 之外的东西不认识「帧」**。它们可以知道「终端多宽多高」（`text.ts` 的
度量），但不能知道「这一帧谁上屏」—— 因为前者是事实，后者是渲染决定。

`tui/` 里**可以** import 外面的东西（它是最上层），反之绝对不行。两个方向不对称，这是「叶子」
这个词在这里的全部含义。

## 四条门禁各守什么

`npm run test:all` 按顺序跑这四个，任何一个红了都不算过：

| 命令 | 守的是什么 | 红了通常意味着 |
|---|---|---|
| `tsc --noEmit -p tsconfig.test.json` | 类型（含用例的类型级断言） | 契约改了没同步；用例期望的字段没了 |
| `vitest run` | 行为（789+ 例） | 行为回归；**用例数下降必须能解释**（测的是被删掉的旧实现？） |
| `npm run build` + `npm run check:imports` | **产物 import 图**：三个入口（`commands/index.js` / `session.js` / `stdio.js`）的运行期依赖里不许有 `ink`、`react`、`./tui/` | 有人在「不该有 UI」的层里用了 UI，或者为了一个纯函数把带 ink 的模块拖了进来 |
| `vitest run --config vitest.e2e.config.ts` | 真进程 + 真服务端（`dist/index.js` 跑起来） | 组装根改了（连接从哪来、模式分发）；只有真跑才看得见 |

`check:imports` 为什么必须在 `build` **之后**：它读的是 `dist/*.js`。路径 grep 会被「改个
import 写法」骗过去（`from "./render.js"` 改个名字就绿了），而 `render.js` 头顶那句
`import { Text } from "ink"` 照样把 ink 拖进依赖图。判据要落在**编译产物**上。

## 为什么 `tui/` 要当叶子

两个具体的坏结果，都真的发生过：

1. **`ai "…"` 会不会 OOM 取决于某个文件的 import 图**。`index.ts` 里 `NODE_ENV ||= "production"`
   必须早于 React 求值（DEV 版 reconciler 的 `performance.measure()` 缓冲无界增长，长会话能把堆
   顶爆）。`stdio.ts` 被 `index.ts` **静态** import，所以它的整条依赖链上出现 React/Ink，那一行
   就白写了 —— 而这条约束以前只靠一句注释（「这条链上今天恰好没有 React」）维持。
2. **命令层悄悄拿到渲染状态**。`chat-commands.ts` 曾经收着 `setPickerState` / `setConfirmState`
   两个原始 React setter —— 于是「弹个选择器」被写成了「改一块渲染状态」，那段代码在没有 React
   的宿主里根本跑不起来。现在它是 `pick()` / `confirm()` 两个 Promise，命令层只知道「问、等答案」。

所以「`tui/` 是叶子」不是洁癖：它把「换源 / 换宿主 / 换渲染」的自由留给上层，把「不能有 UI」
这条纪律变成**结构**（产物图）而不是**记忆**（注释）。
