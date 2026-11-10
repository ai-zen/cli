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
