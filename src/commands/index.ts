/**
 * 命令层的对外出口 —— `runCommand` 与会话消失之后换到哪一段（`moveAfterGone`）。
 *
 * 屏幕（`tui/screens/chat.tsx`）只从这里取这两样，不从 `handlers.js` 深层 import —— 那个文件里
 * 有二十几个命令的 Agent（连 `npm` 子进程都拉进来），出口收窄之后，「屏幕用了命令层的什么」可以
 * 一次数清。
 *
 * 这个出口还是产物图检查的入口（`node scripts/check-imports.mjs dist/commands/index.js --forbid
 * ink --forbid react --forbid ./tui/`）：入口指向哪里，门禁就守哪里，指向屏幕真正 import 的那个
 * 文件，门禁才守得到真实存在的依赖边。
 *
 * 收尾那一条要留在出口上，是因为它由两条路发起 —— 命令层（`/delete`、`/ws delete`）与屏幕
 * （`session.removed` 说这一屏那一段被别处删掉了）。一句话只有一个出处，否则两条路上「换到哪
 * 一段、没地方可换时说什么」早晚会各写一套。
 *
 * 类型与解析函数不从这里转出：它们的出口就是 `handlers.ts` / `types.ts` 自己，多转一行只在向
 * 读者暗示一份不存在的外部契约。
 */

export { runCommand, moveAfterGone } from "./handlers.js";
