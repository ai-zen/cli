/**
 * 主菜单
 */

import { createRequire } from "module";
import chalk from "chalk";
import inquirer from "inquirer";
import { readDraft } from "@ai-zen/agents-sdk";
import { startNewConversation, continueConversation, continueDraft } from "./start-conversation.js";
import { manageConversations } from "./conversations.js";
import { manageAgentsInteractive } from "./agents.js";
import { showInteractiveConfig } from "./config.js";
import { DRAFTS_DIR } from "../config.js";
import { formatMessageTime } from "../format-time.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

export async function showMainMenu(): Promise<void> {
  console.log(chalk.blue.bold(`\n🤖 AI-Zen CLI v${version}\n`));

  const draft = readDraft(DRAFTS_DIR);

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
