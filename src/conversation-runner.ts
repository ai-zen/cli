/**
 * 对话运行器 — CLI 对话主循环
 *
 * 使用 SDK 的 SdkAgent + 插件驱动对话。
 * CLI 层只负责：流式渲染、命令处理、UI 交互。
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { AgentNS } from "@ai-zen/agents-core";
import {
  AutoMigratePlugin,
  AutoRefreshToolsPlugin,
  ContextGuardPlugin,
} from "@ai-zen/agents-sdk";
import { DeltaRenderer } from "./delta-renderer.js";
import { createAgent } from "./agent-creator.js";
import { readConfig } from "./config.js";
import { CwdTrackerPlugin } from "./cwd-tracker-plugin.js";
import { DraftPlugin } from "./draft-plugin.js";
import { saveConversation } from "./conversation-repository.js";
import { createMigrationService } from "./migration-service.js";
import { ensureEndpointConfig } from "./config-wizard.js";
import type { ConversationContext } from "./types.js";
import { formatShortTime } from "./format-time.js";
import { dispatchCommand, getCommandNames } from "./conversation-commands/index.js";

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
        await saveConversation(ctx);
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
  const agent = await createAgent({ messages, agentId });

  // 会话上下文：先创建基础字段（迁移服务实例随后装配并回填 migrationService）
  const ctx: ConversationContext = {
    agent,
    input: "",
    currentName: conversationName || `对话_${formatShortTime(new Date().toISOString())}`,
    currentId: conversationId,
    modelId,
    agentId,
    running: true,
  };

  // ============ 插件注册 ============

  // 1. cwdTracker — 追踪工作目录变化，动态通知 Agent
  agent.use(new CwdTrackerPlugin());

  // 2. autoRefreshTools — 每次 send 前刷新文件系统工具
  agent.use(new AutoRefreshToolsPlugin());

  // 3. draftPlugin — 每次 send 后自动保存草稿（CLI 产品特性，不依赖 SDK；始终写入 _current.json，统一草稿检测入口）
  agent.use(new DraftPlugin({
    agentId: agentId || "default",
    modelId,
    cwd: process.cwd(),
  }));

  // 4/5. contextGuard 与 autoMigrate 的前置准备（读取模型最大上下文 token）
  const config = await readConfig();
  const modelConfig = config.models.find((m) => m.id === modelId);
  const maxTokens = modelConfig?.maxContextTokens ?? (modelConfig?.maxContextChars ? Math.floor(modelConfig.maxContextChars / 4) : undefined);

  // 迁移服务实例：自动迁移（AutoMigratePlugin）与手动迁移（/migrate 命令）共用同一实例。
  // 迁移前后处理（保存旧对话 / 开启新会话 / 落盘草稿）统一收敛到 src/migration-service.ts。
  const migrationService = createMigrationService(ctx);
  ctx.migrationService = migrationService;

  if (maxTokens && maxTokens > 0) {
    // contextGuard — 请求前检测用量，严重超限（> maxTokens×1.5）时抛 ContextOverflowError 中断对话。
    //    作为安全护栏置于迁移插件之前：防止读入超大文件等突发超限在迁移生效前撑爆上下文。
    agent.use(new ContextGuardPlugin({ maxTokens }));

    // autoMigrate — 检测 token 超限时自动迁移。仅负责触发（何时迁移），实际迁移委托给共享的 migrationService。
    agent.use(new AutoMigratePlugin({ service: migrationService, maxTokens }));
  }

  // 初始化所有插件
  await agent.init();

  const cmdList = getCommandNames().map((c) => `/${c}`).join(", ");
  console.log(chalk.blue.bold(`💬 对话已开始 (输入 ${cmdList} 查看和操作)\n`));

  // ============ 流式渲染器 ============

  const renderer = new DeltaRenderer({
    reasoningHeader: "\n\n💭 思考中...\n",
    contentHeader: "\n\n💭 回答中...\n",
    reasoningStyle: chalk.blue,
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
