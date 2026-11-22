/**
 * 命令层的对外出口 —— `runCommand` 与「会话没了之后往哪儿去」那一条。
 *
 * 屏幕（`tui/screens/chat.tsx`）只从这里拿这两样东西，**不**从 `handlers.js` 深层 import
 * —— 那个文件里有二十几个命令的执行体（连 `npm` 子进程都拉进来），出口收窄之后，「屏幕用了
 * 命令层的什么」是一眼可数的。
 *
 * 为什么这个出口值得存在（而不只是好习惯）：它是产物图检查的**入口**
 * （`node scripts/check-imports.mjs dist/commands/index.js --forbid ink --forbid react
 * --forbid ./tui/`）。入口指向哪里，门禁就守哪里 —— 让它指向「屏幕真正 import 的那个文件」，
 * 门禁才在守真实存在的依赖边。
 *
 * 为什么收尾那一条要在出口上：它由**两条路**发起 —— 命令层（`/delete`、`/ws delete`）与屏幕
 * （`session.removed` 说这一屏那一段被别处删掉了）。一句话只有一个出处，否则两条路上「换到
 * 哪一段、没地方可换时说什么」早晚会各写一套。
 *
 * 类型与解析函数不从这里转出：它们的出口就是 `handlers.ts` / `types.ts` 自己，
 * 多转一行只在向读者暗示一份**不存在的外部契约**。
 */

export { runCommand, moveAfterGone } from "./handlers.js";
