import chalk from "chalk";
import inquirer from "inquirer";
import { writeConversation, deleteDraft } from "@ai-zen/agents-sdk";
import { CONVERSATIONS_DIR, DRAFTS_DIR } from "../config.js";
import type { ConversationContext } from "../types.js";

export async function handleExit(ctx: ConversationContext): Promise<void> {
  const agent = ctx.agent;
  if (agent.messages.length > 1) {
    const { saveBeforeExit } = await inquirer.prompt([
      {
        type: "confirm",
        name: "saveBeforeExit",
        message: "退出前是否保存当前对话?",
        default: true,
      },
    ]);

    if (saveBeforeExit) {
      try {
        const id = ctx.currentId || ctx.currentName.replace(/[\\/:*?"<>|]/g, "_");
        writeConversation(CONVERSATIONS_DIR, {
          id,
          agentId: ctx.agentId || "default",
          modelId: ctx.modelId,
          messages: agent.messages,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        console.log(chalk.green(`\n✅ 对话已保存: ${ctx.currentName} (ID: ${id})\n`));
        deleteDraft(DRAFTS_DIR);
      } catch (error) {
        console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
      }
    }
  }
  ctx.running = false;
}
