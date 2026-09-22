import chalk from "chalk";
import { ConversationContext } from "../types.js";
import { COMMAND_LABEL_WIDTH, getCommandHints } from "./registry.js";

export async function handleHelp(ctx: ConversationContext): Promise<void> {
  console.log(chalk.blue.bold("\n📖 可用命令:\n"));

  for (const hint of getCommandHints()) {
    console.log(
      `  ${chalk.cyan(hint.label.padEnd(COMMAND_LABEL_WIDTH))}${chalk.gray(hint.description)}`,
    );
  }

  console.log();
}
