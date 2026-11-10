/**
 * 命令层的对外出口 —— 只有 `runCommand`。
 *
 * 屏幕（`tui/screens/chat.tsx`）只从这里拿这一样东西，**不**从 `handlers.js` 深层 import
 * —— 那个文件里有 19 个命令的执行体（连 `npm` 子进程都拉进来），出口收窄之后，「屏幕用了
 * 命令层的什么」是一眼可数的。
 *
 * 为什么这个出口值得存在（而不只是好习惯）：它是产物图检查的**入口**
 * （`node scripts/check-imports.mjs dist/commands/index.js --forbid ink --forbid react
 * --forbid ./tui/`）。入口指向哪里，门禁就守哪里 —— 让它指向「屏幕真正 import 的那个文件」，
 * 门禁才在守真实存在的依赖边。
 *
 * 曾经这里还转出过一堆类型（`ChatCommandHost` / `SelectItem` / `WizardEntryStep` …）与
 * 三个 `parse*`（`parseModelSelection` 等）。它们的消费者要么直接 import
 * `commands/types.js`（`tui/` 侧的 `SelectItem` / `handoffModeItems`），要么根本没有 ——
 * 转出的每一行都在向读者暗示一份**不存在的外部契约**。类型与解析函数的出口就是
 * `handlers.ts` / `types.ts` 自己。
 */

export { runCommand } from "./handlers.js";
