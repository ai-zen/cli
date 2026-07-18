import chalk from "chalk";
import inquirer from "inquirer";
import { AgentNS, Message } from "@ai-zen/agents-core";
import { ConversationRepository, DraftRepository } from "@ai-zen/agents-sdk";
import { formatShortTime } from "../format-time.js";
import { CONVERSATIONS_DIR, DRAFTS_DIR } from "../config.js";
import { ConversationContext } from "../types.js";

const conversationRepo = new ConversationRepository(CONVERSATIONS_DIR);
const draftRepo = new DraftRepository(DRAFTS_DIR);

export async function handleNew(ctx: ConversationContext): Promise<void> {
  const agent = ctx.agent;
  const { confirmNew } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmNew",
      message: "确定要开始新对话吗？当前对话将丢失。",
      default: false,
    },
  ]);

  if (!confirmNew) {
    console.log(chalk.gray("已取消\n"));
    return;
  }

  // 将当前草稿存档（如果有），避免丢失
  const draft = draftRepo.read();
  if (draft && draft.messages.length > 1) {
    const name = `草稿-${formatShortTime(draft.updatedAt)}`;
    const id = name.replace(/[\\/:*?"<>|]/g, "_");
    conversationRepo.write({
      id,
      agentId: draft.agentId || "default",
      modelId: draft.modelId,
      messages: draft.messages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(chalk.gray(`📦 当前对话已存档: ${name}\n`));
    draftRepo.delete();
  }

  // 重置为 Agent 定义的初始消息（system prompt + few-shot 示例等）
  agent.messages = (agent.definition.messages as AgentNS.Message[]).map((m) => new Message(m));

  // 更新上下文状态
  ctx.currentName = `对话_${formatShortTime(new Date().toISOString())}`;
  ctx.currentId = undefined;
  ctx.input = "";

  console.log(chalk.blue.bold("\n🆕 新会话已开始\n"));
}
