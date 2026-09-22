import { ConversationContext, CommandHandler } from "../types.js";
import { getCommandHints } from "./registry.js";
import { handleExit } from "./exit.js";
import { handleSave } from "./save.js";
import { handleNew } from "./new.js";
import { handleBack } from "./back.js";
import { handleEditor } from "./editor.js";
import { handleClear } from "./clear.js";
import { handleHelp } from "./help.js";
import { handleMigrate } from "./migrate.js";

/**
 * 命令处理函数表
 * key 为主命令名（不含 / 前缀），命令名/别名/说明的声明见 ./registry.ts
 */
const handlers: Record<string, CommandHandler> = {
  exit: handleExit,
  save: handleSave,
  new: handleNew,
  back: handleBack,
  editor: handleEditor,
  clear: handleClear,
  help: handleHelp,
  migrate: handleMigrate,
};

/**
 * 命令注册表
 * key 为命令名称（不含 / 前缀，含别名），value 为处理函数
 * 别名按 registry 自动展开：新增别名只需改动 ./registry.ts
 */
const commands: Record<string, CommandHandler> = {};
for (const hint of getCommandHints()) {
  const primary = hint.names[0];
  const handler = handlers[primary];
  if (!handler) {
    throw new Error(
      `对话命令 "${primary}" 已在 conversation-commands/registry.ts 声明，但未注册处理函数`,
    );
  }
  for (const name of hint.names) commands[name] = handler;
}

/** 全部命令名（含别名，升序） */
export { getCommandNames } from "./registry.js";

/**
 * 判断输入是否为命令（以 / 开头）
 */
export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

/**
 * 分发命令
 * @returns true 表示是命令且已处理，false 表示不是命令
 */
export async function dispatchCommand(
  ctx: ConversationContext,
): Promise<boolean> {
  const input = ctx.input;

  if (!isCommand(input)) return false;

  // 去掉 / 前缀，取命令名
  const cmdName = input.slice(1).toLowerCase().trim();
  const handler = commands[cmdName];

  if (!handler) {
    console.log(`\n❌ 未知命令: ${input}  (输入 /help 查看可用命令)\n`);
    ctx.input = "";
    return true;
  }

  await handler(ctx);
  return true;
}
