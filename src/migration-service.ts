import { TaskMigrationService, type MigrationContext } from "@ai-zen/agents-sdk";
import {
  saveConversation,
  conversationRepository,
  generateConversationId,
} from "./conversation-repository.js";
import { writeLastSession } from "./session-pointer.js";
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
  options: { log?: (text: string) => void } = {},
): TaskMigrationService {
  // 进度/结果一律经 `log` 上报（TUI 走 Ink notice 块），不再直接 console.log 污染画面
  const log = options.log ?? (() => {});
  return new TaskMigrationService({
    // CLI 采用物理剔除模式：迁移后不保留历史消息，仅保留系统提示 + 交接断点。
    strategy: "prune",
    onBeforeMigrate: async (mctx: MigrationContext) => {
      // 自动迁移由 AutoMigratePlugin 传入 promptTokens/maxTokens；手动迁移为 undefined。
      const isAuto = mctx.promptTokens != null && mctx.maxTokens != null;
      log(
        isAuto
          ? `📋 检测到上下文即将超限（${mctx.promptTokens}/${mctx.maxTokens} tokens），正在自动生成交接文档以延续对话…`
          : "📋 正在生成任务交接文档…",
      );
      // 迁移前 agent.messages 仍是完整旧历史，先保存旧对话
      await saveConversation(ctx);
      log(`✅ 原对话已保存：${ctx.currentName}`);
    },
    onMigrated: async (mctx: MigrationContext) => {
      // 迁移开启新会话：分配新的会话 id 与名称
      const id = generateConversationId();
      ctx.currentId = id;
      ctx.currentName = id;

      log(`🚀 任务迁移完成，已开启新会话（共 ${mctx.agent.messages.length} 条消息）`);
      log("💡 新助手已通过交接文档了解此前的工作，可继续提问。");

      // 迁移后立即把新开场白落盘为独立会话文件，并更新「上一轮会话 id」指针，
      // 避免迁移发生在 onAfterSend（ConversationPersistPlugin 的 onInnerLoopEnd
      // 已不再触发）导致迁移后的新对话未被及时落盘、用户中途退出时丢失。
      try {
        const existing = await conversationRepository.read(id);
        const now = new Date().toISOString();
        await conversationRepository.write({
          id,
          agentId: ctx.agentId || "default",
          modelId: ctx.modelId,
          messages: mctx.agent.messages,
          cwd: process.cwd(),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        await writeLastSession(id);
      } catch (err: any) {
        log(`⚠️ 迁移后会话落盘失败：${err?.message ?? err}`);
      }
    },
  });
}
