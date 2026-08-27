import chalk from "chalk";
import { TaskMigrationService, type MigrationContext } from "@ai-zen/agents-sdk";
import { saveConversation } from "./conversation-repository.js";
import { draftRepository } from "./draft-repository.js";
import { formatShortTime } from "./format-time.js";
import type { ConversationContext } from "./types.js";

/**
 * 创建 CLI 迁移服务实例（自动迁移与手动迁移共用同一个实例）。
 *
 * 迁移前后处理统一收敛于此：保存旧对话 / 开启新会话 / 落盘草稿。
 * 自动迁移由 AutoMigratePlugin 触发，手动迁移由 /migrate 命令触发，
 * 两者都委托给本服务实例的 migrate()，从而保证行为一致、避免重复实现。
 *
 * @param ctx 当前会话上下文（先建后回填 migrationService；钩子直接引用该对象）
 */
export function createMigrationService(
  ctx: ConversationContext,
): TaskMigrationService {
  return new TaskMigrationService({
    // CLI 采用物理剔除模式：迁移后不保留历史消息，仅保留系统提示 + 交接断点。
    strategy: "prune",
    onBeforeMigrate: async (mctx: MigrationContext) => {
      // 自动迁移由 AutoMigratePlugin 传入 promptTokens/maxTokens；手动迁移为 undefined。
      const isAuto = mctx.promptTokens != null && mctx.maxTokens != null;
      if (isAuto) {
        console.log(
          chalk.yellow.bold(
            `\n📋 检测到上下文即将超限（${mctx.promptTokens}/${mctx.maxTokens} tokens），正在自动生成交接文档以延续对话...\n`,
          ),
        );
      } else {
        console.log(chalk.yellow.bold(`\n📋 正在生成任务交接文档...\n`));
      }
      // 迁移前 agent.messages 仍是完整旧历史，先保存旧对话
      await saveConversation(ctx);
      console.log(chalk.gray(`  ✅ 原对话已保存: ${ctx.currentName}`));
    },
    onMigrated: async (mctx: MigrationContext) => {
      ctx.currentName = `对话_${formatShortTime(new Date().toISOString())}`;
      ctx.currentId = undefined;

      console.log(
        chalk.green.bold(
          `\n🚀 任务迁移完成！已开启新会话，共 ${mctx.agent.messages.length} 条消息。\n`,
        ),
      );
      console.log(
        chalk.gray("💡 你可以继续提问，新助手已通过交接文档了解之前的全部工作。\n"),
      );

      // 迁移后立即把新开场白保存为草稿（_current.json），
      // 避免迁移发生在 onAfterSend（DraftPlugin 的 onInnerLoopEnd 已不再触发）
      // 导致迁移后的新对话未被及时落盘，用户中途退出时丢失迁移后的开场白。
      try {
        await draftRepository.write({
          conversationId: ctx.currentId, // undefined → 写入 _current.json
          agentId: ctx.agentId || "default",
          modelId: ctx.modelId,
          messages: mctx.agent.messages,
          cwd: process.cwd(),
          updatedAt: new Date().toISOString(),
        });
      } catch (err: any) {
        console.warn(`[draft] 迁移后保存草稿失败: ${err?.message ?? err}`);
      }
    },
  });
}
