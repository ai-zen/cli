/**
 * 主菜单
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { startNewConversation, continueConversation, continueDraft } from "./start-conversation.js";
import { manageConversations } from "./conversations.js";
import { manageAgentsInteractive } from "./agents.js";
import { showInteractiveConfig } from "./config.js";
import { formatMessageTime } from "../format-time.js";
import { draftRepository } from "../draft-repository.js";
import { CLI_VERSION, SDK_VERSION, CORE_VERSION } from "../version.js";

export async function showMainMenu(): Promise<void> {
  console.log(
    chalk.blue.bold(
      `\n🤖 AI-Zen CLI v${CLI_VERSION} · SDK ${SDK_VERSION} · Core ${CORE_VERSION}\n`,
    ),
  );

  const draft = await draftRepository.read();

  const choices: { name: string; value: string }[] = [];

  if (draft) {
    choices.push(
      {
        name: `▶️  继续上次未完成的对话 (${formatMessageTime(draft.messages.length, draft.updatedAt)})`,
        value: "continue-draft",
      },
      { name: "💬 开始新对话（未完成的对话将被存档）", value: "chat" },
    );
  } else {
    choices.push({ name: "💬 开始新对话", value: "chat" });
  }

  choices.push(
    { name: "📂 继续已保存的对话", value: "continue" },
    { name: "📋 管理已保存的对话", value: "manage-convs" },
    { name: "🤖 管理 Agents", value: "manage-agents" },
    { name: "⚙️  配置管理", value: "config" },
    { name: "❌ 退出", value: "exit" },
  );

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "请选择操作:",
      choices,
    },
  ]);

  switch (action) {
    case "continue-draft":
      await continueDraft();
      break;
    case "chat":
      await startNewConversation();
      break;
    case "continue":
      await continueConversation();
      break;
    case "manage-convs":
      await manageConversations();
      break;
    case "manage-agents":
      await manageAgentsInteractive();
      break;
    case "config":
      await showInteractiveConfig();
      break;
    case "exit":
      console.log(chalk.blue("\n👋 再见！\n"));
      process.exit(0);
  }
}
