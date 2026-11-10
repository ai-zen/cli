/**
 * 命令层的对外出口。
 *
 * 屏幕（`tui/screens/chat.tsx`）只从这里拿两样东西：`runCommand` 与那几份类型。**不**从
 * `handlers.js` 深层 import —— 那个文件里有 19 个命令的执行体（连 `npm` 子进程都拉进来），
 * 出口收窄之后，「屏幕用了命令层的什么」是一眼可数的。
 *
 * 为什么这个出口值得存在（而不只是好习惯）：它是产物图检查的**入口**
 * （`node scripts/check-imports.mjs dist/commands/index.js --forbid ink --forbid react
 * --forbid ./tui/`）。入口指向哪里，门禁就守哪里 —— 让它指向「屏幕真正 import 的那个文件」，
 * 门禁才在守真实存在的依赖边。
 */

export { runCommand, parseHandoffMode, parseHandoffSelection } from "./handlers.js";
export type { ChatCommandHost, CommandContext, HandoffSelection, ModelScope, ModelSelection } from "./handlers.js";
export { parseModelSelection } from "./handlers.js";
export { HANDOFF_SKIP, handoffModeItems, toHandoffMode } from "./types.js";
export type { SelectItem, WizardEntryStep } from "./types.js";
