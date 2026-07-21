/**
 * 对话运行器 — CLI 对话主循环
 *
 * 使用 SDK 的 SdkAgent + 插件驱动对话。
 * CLI 层只负责：流式渲染、命令处理、UI 交互。
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { AgentNS } from "@ai-zen/agents-core";
import type { SdkAgent } from "@ai-zen/agents-sdk";
import {
  AutoMigratePlugin,
  AutoDraftPlugin,
  AutoRefreshToolsPlugin,
  ConversationRepository,
} from "@ai-zen/agents-sdk";
import { DeltaRenderer } from "./delta-renderer.js";
import { createAgent, createMigrationAgent } from "./agent-creator.js";
import { readConfig, CONVERSATIONS_DIR, DRAFTS_DIR } from "./config.js";
import { CwdTrackerPlugin } from "./cwd-tracker-plugin.js";
import { ensureEndpointConfig } from "./config-wizard.js";
import type { ConversationContext } from "./types.js";
import { formatShortTime } from "./format-time.js";
import { dispatchCommand, getCommandNames } from "./conversation-commands/index.js";

const conversationRepo = new ConversationRepository(CONVERSATIONS_DIR);

/** 保存当前对话到 conversations 目录 */
function saveCurrentConversation(
  name: string,
  messages: AgentNS.Message[],
  modelId: string,
  existingId?: string,
  agentId?: string,
): string {
  const id = existingId || name.replace(/[\\/:*?"<>|]/g, "_");
  conversationRepo.write({
    id,
    agentId: agentId || "default",
    modelId,
    messages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

// ==================== 发送消息 ====================

async function sendAndStream(ctx: ConversationContext): Promise<void> {
  console.log(chalk.green.bold("\n🤖 AI:"));

  try {
    const messages = await ctx.agent.send(ctx.input);
    process.stdout.write("\n\n");

    const lastMessage = messages.at(-1);

    if (lastMessage?.status === "error") {
      console.error(chalk.red(`\n❌ 发生错误: ${JSON.stringify(lastMessage)}\n`));
      try {
        saveCurrentConversation(ctx.currentName, ctx.agent.messages, ctx.modelId, ctx.currentId, ctx.agentId);
        console.log(chalk.yellow(`💾 错误时对话已自动保存: ${ctx.currentName}\n`));
      } catch (saveError) {
        console.error(chalk.red(`❌ 自动保存失败: ${saveError}\n`));
      }
      return;
    }

    if (lastMessage?.role === AgentNS.Role.Assistant && Array.isArray(lastMessage.content)) {
      for (const section of lastMessage.content) {
        if (section.type === "image_url")
          console.log(chalk.yellow(`[图片: ${section.image_url.url}]`));
      }
    }

    console.log();
  } catch (error: any) {
    process.stdout.write(chalk.red(`\n❌ 请求错误: ${error?.message || error}\n`));
    if (error.message?.includes("API Key") || error.message?.includes("401") || error.message?.includes("403")) {
      console.log(chalk.yellow("💡 提示: 请使用 'aiz config set-key' 设置正确的 API Key\n"));
    }
  }
}

// ==================== 对话主循环 ====================

export interface RunConversationOptions {
  modelId: string;
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
  query?: string;
}

export async function runConversation(options: RunConversationOptions): Promise<void> {
  const { modelId, agentId, messages, conversationId, conversationName, query } = options;

  // 确保端点配置完整（如 API Key 已设置）
  await ensureEndpointConfig(modelId);

  // 在 runConversation 内部创建 agent
  const agent = createAgent({ messages, agentId });

  // ============ 插件注册 ============

  // 1. cwdTracker — 追踪工作目录变化，动态通知 Agent
  agent.use(new CwdTrackerPlugin());

  // 2. autoRefreshTools — 每次 send 前刷新文件系统工具
  agent.use(new AutoRefreshToolsPlugin());

  // 2. autoDraft — 每次 send 后自动保存草稿
  agent.use(new AutoDraftPlugin({
    draftsDir: DRAFTS_DIR,
    agentId: agentId || "default",
    modelId,
    conversationId,
    cwd: process.cwd(),
  }));

  // 3. autoMigrate — 检测 token 超限时自动迁移
  const migrationAgent = createMigrationAgent(modelId);
  const config = readConfig();
  const modelConfig = config.models.find((m) => m.id === modelId);
  const maxTokens = modelConfig?.maxContextTokens ?? (modelConfig?.maxContextChars ? Math.floor(modelConfig.maxContextChars / 4) : undefined);
  if (maxTokens && maxTokens > 0) {
    agent.use(new AutoMigratePlugin({
      maxTokens,
      migrationAgent,
      onBeforeMigrate: (promptTokens: number, maxTokens: number) => {
        console.log(chalk.yellow.bold(`\n📋 检测到上下文即将超限（${promptTokens}/${maxTokens} tokens），正在自动生成交接文档以延续对话...\n`));
      },
      onHandoff: (handoffDoc: string, agent: SdkAgent) => {
        saveCurrentConversation(ctx.currentName, agent.messages, ctx.modelId, ctx.currentId, ctx.agentId);
        console.log(chalk.gray(`  ✅ 原对话已保存: ${ctx.currentName}`));

        // SDK 的 AutoMigratePlugin 已在内部替换 agent 消息，
        // 此处无需手动创建新 agent
        ctx.currentName = `对话_${formatShortTime(new Date().toISOString())}`;
        ctx.currentId = undefined;

        console.log(chalk.green.bold(`\n🚀 任务迁移完成！已保存当前对话并开启新会话，共 ${agent.messages.length} 条消息。\n`));
        console.log(chalk.gray("💡 你可以继续提问，新助手已通过交接文档了解之前的全部工作。\n"));
      },
    }));
  }

  // 初始化所有插件
  await agent.init();

  const cmdList = getCommandNames().map((c) => `/${c}`).join(", ");
  console.log(chalk.blue.bold(`💬 对话已开始 (输入 ${cmdList} 查看和操作)\n`));

  const ctx: ConversationContext = {
    agent,
    input: "",
    currentName: conversationName || `对话_${formatShortTime(new Date().toISOString())}`,
    currentId: conversationId,
    modelId,
    agentId,
    running: true,
  };

  // ============ 流式渲染器 ============

  const renderer = new DeltaRenderer({
    reasoningHeader: "\n\n💭 思考中...\n",
    contentHeader: "\n\n💭 回答中...\n",
    reasoningStyle: chalk.blue,
    contentStyle: chalk.white,
  });

  const onRun = () => { renderer.reset(); };

  const onChunk = (chunk: AgentNS.StreamResponseData) => {
    if (!chunk?.choices?.[0]?.delta) return;
    const delta = chunk.choices[0].delta;
    const fr = chunk.choices[0].finish_reason ?? null;
    renderer.render(delta, fr);
  };

  const onError = (error: any) => {
    process.stdout.write(chalk.red(`\n❌ 错误: ${error?.message || error}\n`));
  };

  // ============ 子 Agent 渲染 ============

  const onSubAgent = (event: { agent: any; ctx: any }) => {
    const subAgent = event.agent;
    const toolName = event.ctx?.function_call?.name || "子任务";

    process.stdout.write(chalk.yellow.bold(`\n  🧩 ${toolName}:\n`));
    subAgent.events.on("open", onRun);
    subAgent.events.on("chunk", onChunk);
    subAgent.events.on("error", onError);
  };

  const onSubAgentEnd = ({ ctx: subCtx }: { agent: any; ctx: any }) => {
    const toolName = subCtx.function_call?.name || "子任务";
    process.stdout.write(chalk.gray(`\n    ✅ ${toolName} 完成\n`));
  };

  // ============ 注册事件 ============

  ctx.agent.events.on("open", onRun);
  ctx.agent.events.on("chunk", onChunk);
  ctx.agent.events.on("error", onError);
  ctx.agent.events.on("sub-agent", onSubAgent);
  ctx.agent.events.on("sub-agent-end", onSubAgentEnd);

  // ============ 初始消息 ============

  if (query) {
    ctx.input = query;
    console.log(chalk.cyan("💬 你: ") + query + "\n");
    await sendAndStream(ctx);
  }

  // ============ 主循环 ============

  while (ctx.running) {
    const { question } = await inquirer.prompt([
      {
        type: "input",
        name: "question",
        message: chalk.cyan("你:"),
        prefix: "💬",
      },
    ]);

    ctx.input = question.trim();
    if (!ctx.input) continue;

    const handled = await dispatchCommand(ctx);
    if (handled) {
      if (ctx.shouldSend) {
        ctx.shouldSend = false;
        console.log(chalk.cyan("💬 你: ") + ctx.input + "\n");
      } else {
        continue;
      }
    }

    if (!ctx.input) continue;

    await sendAndStream(ctx);
  }

  ctx.agent.events.off("open", onRun);
  ctx.agent.events.off("chunk", onChunk);
  ctx.agent.events.off("error", onError);
  ctx.agent.events.off("sub-agent", onSubAgent);
  ctx.agent.events.off("sub-agent-end", onSubAgentEnd);

  console.log(chalk.blue.bold("\n👋 再见！\n"));
}
