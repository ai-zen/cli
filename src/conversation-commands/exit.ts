import chalk from "chalk";
import inquirer from "inquirer";
import { conversationRepository } from "../conversation-repository.js";
import { draftRepository } from "../draft-repository.js";
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
        await conversationRepository.write({
          id,
          agentId: ctx.agentId || "default",
          modelId: ctx.modelId,
          messages: agent.messages,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        console.log(chalk.green(`\n✅ 对话已保存: ${ctx.currentName} (ID: ${id})\n`));
        await draftRepository.delete();
      } catch (error) {
        console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
      }
    }
  }
  ctx.running = false;
}
