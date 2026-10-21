import {
  HandoffService,
  type HandoffContext,
  type HandoffMode,
} from "@ai-zen/agents-sdk";
import {
  saveConversation,
  conversationRepository,
  generateConversationId,
} from "./conversation-repository.js";
import { writeLastSession } from "./session-pointer.js";
import { PROJECT_HANDOFFS_DIR } from "./config.js";
import { listSkillDirs } from "./agent-creator.js";
import type { ConversationContext } from "./types.js";

/** 执行者的中文名（供提示文案使用） */
export function describeMode(mode: HandoffMode): string {
  return mode === "self" ? "原 agent 自交接" : "独立摘要";
}

/**
 * 创建 CLI 交接服务实例（自动迁移与 `/migrate` / `/handoff` 共用同一个实例）。
 *
 * 分工：
 *   - **SDK**：`handoff()`（停工 → 写文档 → 校验 → 失败降级）与 `migrate()`（+ 清历史、注入断点）；
 *   - **CLI（本函数）**：只补产品侧副作用——进度提示、旧会话存档、新会话落盘与指针更新。
 *
 * @param ctx 当前会话上下文（先建后回填 handoffService；钩子直接引用该对象）
 */
export function createHandoffService(
  ctx: ConversationContext,
  options: {
    log?: (text: string) => void;
    /** 交接文档目录；默认项目级 `<cwd>/.ai-zen/handoffs`（测试/多工作区可覆盖） */
    handoffDir?: string;
  } = {},
): HandoffService {
  // 进度/结果一律经 `log` 上报（TUI 走 Ink notice 块），不直接 console.log 污染画面
  const log = options.log ?? (() => {});

  return new HandoffService({
    // 交接文档落在项目内，便于随仓库共享与评审
    handoffDir: options.handoffDir ?? PROJECT_HANDOFFS_DIR,
    // CLI 采用物理剔除模式：迁移后不保留历史消息，仅保留系统提示 + 交接断点
    strategy: "prune",
    // 交接模板的唯一真相源：磁盘上的 handoff Skill（出厂随 SDK 释放，可被项目级覆盖）
    skillDirs: listSkillDirs(),
    onBeforeHandoff: (hctx: HandoffContext) => {
      const isAuto = hctx.promptTokens != null && hctx.handoffTokens != null;
      if (isAuto) {
        log(
          `📋 检测到上下文即将超限（${hctx.promptTokens}/${hctx.handoffTokens} tokens），正在交接（${describeMode(hctx.requestedMode)}）…`,
        );
      } else {
        log(`📋 正在编写任务交接文档（${describeMode(hctx.requestedMode)}）…`);
      }
    },
    onHandoff: async (hctx: HandoffContext) => {
      // 降级时告知用户：请求的执行者与实际执行者不一致
      if (hctx.mode !== hctx.requestedMode) {
        log(`⚠️ ${describeMode(hctx.requestedMode)}未能产出文档，已降级为${describeMode(hctx.mode)}`);
      }
      log(`📄 交接文档：${hctx.handoffPath}`);

      // 迁移前（历史尚未剔除）保存旧对话：此时已包含交接回合，可完整审计
      if (hctx.migrating) {
        await saveConversation(ctx);
        log(`✅ 原对话已保存：${ctx.currentName}`);
      }
    },
    onMigrated: async (hctx: HandoffContext) => {
      // 清空「最近一次用量」：prune 已把上下文物理重置（仅留系统提示 + 交接断点），
      // 但 lastUsage 仍是迁移前/交接回合的 prompt_tokens。若不清理，下一次发送时
      // ContextGuardPlugin（`onInnerLoopStart` 以 tokenThresholds.guard 为硬上限）会拿这个
      // 陈旧值判定，立即抛出「上下文严重超限」而中断——用户表现为「迁移完成后第一条
      // 消息就被总上下文保护插件拦截」。置空后护栏首轮无据可查而放行，待下一次响应
      // 以真实（已大幅缩小的）用量回填。
      hctx.agent.lastUsage = undefined;

      // 迁移开启新会话：分配新的会话 id 与名称
      const id = generateConversationId();
      ctx.currentId = id;
      ctx.currentName = id;

      log(`🚀 任务迁移完成，已开启新会话（共 ${hctx.agent.messages.length} 条消息）`);
      log("💡 新助手会先读取交接文档，随后即可继续推进任务。");

      // 迁移后立即把新开场白落盘为独立会话文件，并更新「上一轮会话 id」指针，
      // 避免迁移发生在 onAfterSend（ConversationPersistPlugin 的 onInnerLoopEnd
      // 已不再触发）导致迁移后的新对话未被及时落盘、用户中途退出时丢失。
      try {
        const existing = await conversationRepository.read(id);
        const now = new Date().toISOString();
        await conversationRepository.write({
          id,
          agentId: ctx.agentId || "default",
          messages: hctx.agent.messages,
          cwd: process.cwd(),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        await writeLastSession(process.cwd(), id);
      } catch (err: any) {
        log(`⚠️ 迁移后会话落盘失败：${err?.message ?? err}`);
      }
    },
  });
}
