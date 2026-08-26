import chalk from "chalk";
import inquirer from "inquirer";
import { AgentNS } from "@ai-zen/agents-core";
import type { ConversationContext } from "../types.js";

/**
 * 手动任务迁移命令（/migrate）
 *
 * 与自动迁移（token 超限触发）复用同一条迁移链路与**同一个迁移服务实例**（`ctx.migrationService`）：
 * 保存旧对话 / 生成交接文档 / 开启新会话 / 落盘草稿均由服务钩子统一处理。
 *
 * 命令本身只负责入口校验与用户确认，随后委托给 `ctx.migrationService.migrate`。
 * 迁移非破坏性：旧对话在 onBeforeMigrate 中已保存到 conversations/，即使生成失败也可随时重试或继续当前对话。
 */
export async function handleMigrate(ctx: ConversationContext): Promise<void> {
  const agent = ctx.agent;

  // 1. 检查是否有可迁移的内容（至少存在一条用户消息，迁移文档需要"对话断点"）
  const hasUserMessage = agent.messages.some(
    (m) => m.role === AgentNS.Role.User,
  );
  if (!hasUserMessage) {
    console.log(
      chalk.yellow("\n📭 当前对话还没有可迁移的内容，请先开始对话。\n"),
    );
    ctx.input = "";
    return;
  }

  // 2. 用户确认（迁移会生成交接文档并开启新会话，提前告知影响）
  const { confirmMigrate } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmMigrate",
      message:
        "确定要对当前对话进行任务迁移吗？\n迁移将：生成交接文档 → 保存当前对话 → 开启新会话继续。",
      default: true,
    },
  ]);

  if (!confirmMigrate) {
    console.log(chalk.gray("已取消迁移\n"));
    ctx.input = "";
    return;
  }

  // 3. 执行迁移。保存旧对话、生成交接文档、开启新会话、落盘草稿
  //    均由共享的 migrationService 钩子统一处理（与自动迁移同一实例，行为一致）。
  //    迁移非破坏性：保存旧对话发生在 onBeforeMigrate，即使生成失败也可重试或继续当前对话。
  if (!ctx.migrationService) {
    console.error(chalk.red("\n❌ 迁移服务未初始化，无法执行迁移。\n"));
    ctx.input = "";
    return;
  }
  try {
    await ctx.migrationService.migrate({ agent });
  } catch (error: any) {
    console.error(chalk.red(`\n❌ 任务迁移失败: ${error?.message ?? error}\n`));
    console.log(
      chalk.yellow("💡 当前对话已保存，可稍后重试 /migrate，或继续当前对话。\n"),
    );
    ctx.input = "";
    return;
  }

  // 4. 完成提示由 onMigrated 钩子统一输出（开启新会话 + 落盘草稿 + 打印完成文案）
  ctx.input = "";
}
