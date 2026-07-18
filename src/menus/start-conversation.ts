/**
 * 对话启动菜单
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { AgentNS } from "@ai-zen/agents-core";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import {
  listAgents,
  readAgent,
  readConversation,
  writeConversation,
  readDraft,
  deleteDraft,
} from "@ai-zen/agents-sdk";
import { runConversation } from "../conversation-runner.js";
import { readConfig, AGENTS_DIR, CONVERSATIONS_DIR, DRAFTS_DIR } from "../config.js";
import { formatRelativeTime, formatShortTime, formatFileSize, formatMessageTime } from "../format-time.js";
import { getConversationsList } from "./conversations.js";

/**
 * 开始新对话
 */
export async function startNewConversation(query?: string): Promise<void> {
  try {
    const config = readConfig();
    const agents = listAgents(AGENTS_DIR);
    let agentId: string | undefined;
    let modelId: string | undefined;

    if (agents.length === 1) {
      const agent = agents[0];
      agentId = agent.id;
      if (agent.modelId) modelId = agent.modelId;
    } else if (agents.length > 1) {
      const defaultAgent = config.defaultAgent ? readAgent(AGENTS_DIR, config.defaultAgent) : undefined;
      const { selectedAgentId } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedAgentId",
          message: "选择 Agent (或选「不使用」或「取消」):",
          choices: [
            ...agents.map((a: AgentDefinition) => ({
              name: `${a.name}${defaultAgent?.id === a.id ? " (默认)" : ""}`,
              value: a.id,
            })),
            { name: "🚫 不使用 Agent", value: "__none__" },
            { name: "🔙 取消", value: "__cancel__" },
          ],
        },
      ]);
      if (selectedAgentId === "__cancel__") return;
      if (selectedAgentId !== "__none__") {
        const agent = readAgent(AGENTS_DIR, selectedAgentId);
        if (agent) {
          agentId = agent.id;
          if (agent.modelId) modelId = agent.modelId;
        }
      }
    }

    if (!modelId) {
      if (config.defaultModel) {
        modelId = config.defaultModel;
        const defaultModel = config.models.find((m) => m.id === modelId);
        console.log(chalk.gray(`使用默认模型: ${defaultModel?.name} (${modelId})`));
      } else {
        const { selectedModelId } = await inquirer.prompt([
          {
            type: "list",
            name: "selectedModelId",
            message: "选择模型（未配置默认模型）:",
            choices: [
              ...config.models.map((m) => ({
                name: `${m.name} (${m.id})`,
                value: m.id,
              })),
              { name: "🔙 取消", value: "__cancel__" },
            ],
          },
        ]);
        if (selectedModelId === "__cancel__") return;
        modelId = selectedModelId;
      }
    }

    // 选完 Agent/模型后，进入对话前，将草稿归档
    const draft = readDraft(DRAFTS_DIR);
    if (draft) {
      try {
        const draftName = `草稿-${formatShortTime(draft.updatedAt)}`;
        const conv = {
          id: draftName.replace(/[\\/:*?"<>|]/g, "_"),
          agentId: draft.agentId || "default",
          modelId: draft.modelId,
          messages: draft.messages,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        writeConversation(CONVERSATIONS_DIR, conv);
        console.log(chalk.green(`📦 草稿已自动保存为对话存档: "${draftName}" (${formatMessageTime(draft.messages.length, draft.updatedAt)})\n`));
        deleteDraft(DRAFTS_DIR);
      } catch (error) {
        console.error(chalk.red(`❌ 草稿自动存档失败: ${error}\n`));
        console.log(chalk.yellow("⚠️  草稿保留在文件中，下次启动仍可恢复\n"));
      }
    }

    await runConversation({ modelId: modelId!, agentId, query });
  } catch (error: any) {
    console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
  }
}

/**
 * 继续草稿对话
 */
export async function continueDraft(): Promise<void> {
  const draft = readDraft(DRAFTS_DIR);
  if (!draft) {
    console.log(chalk.yellow("\n📭 没有未完成的对话\n"));
    return;
  }

  try {
    console.log(
      chalk.green(
        `\n✅ 已恢复上次未完成的对话 (${formatMessageTime(draft.messages.length, draft.updatedAt)})\n`,
      ),
    );

    await runConversation({
      modelId: draft.modelId,
      agentId: draft.agentId,
      messages: draft.messages as AgentNS.Message[],
    });
  } catch (error: any) {
    console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
  }
}

/**
 * 继续已保存的对话
 */
export async function continueConversation(): Promise<void> {
  const conversations = getConversationsList();
  if (conversations.length === 0) {
    console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
    return;
  }

  const { convId } = await inquirer.prompt([
    {
      type: "list",
      name: "convId",
      message: "选择对话:",
      choices: [
        ...conversations.map((c) => ({
          name: `${c.name} (${formatRelativeTime(c.updatedAt)}, ${formatFileSize(c.size || 0)})`,
          value: c.id,
        })),
        { name: "🔙 取消", value: "__cancel__" },
      ],
    },
  ]);

  if (convId === "__cancel__") return;

  try {
    const conversation = readConversation(CONVERSATIONS_DIR, convId);
    if (!conversation) {
      console.log(chalk.red(`\n❌ 对话 "${convId}" 不存在\n`));
      return;
    }
    console.log(chalk.green(`\n✅ 已加载对话: ${conversation.id}\n`));

    await runConversation({
      modelId: conversation.modelId,
      agentId: conversation.agentId,
      messages: conversation.messages as AgentNS.Message[],
      conversationId: conversation.id,
      conversationName: conversation.id,
    });
  } catch (error: any) {
    console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
  }
}
