import {
  HandoffService,
  type HandoffContext,
  type HandoffMode,
} from "@ai-zen/agents-sdk";
import {
  saveConversation,
  persistConversation,
  generateConversationId,
} from "./conversation-repository.js";
import { projectDirs } from "./config.js";
import { listSkillDirs } from "./agent-creator.js";
import type { ConversationContext } from "./types.js";
import { t } from "./i18n/index.js";

/** 执行者的中文名（供提示文案使用） */
export function describeMode(mode: HandoffMode): string {
  return mode === "self" ? t("handoff.mode.self") : t("handoff.mode.summary");
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
    handoffDir: options.handoffDir ?? projectDirs().handoffs,
    // CLI 采用物理剔除模式：迁移后不保留历史消息，仅保留系统提示 + 交接断点
    strategy: "prune",
    // 交接模板的唯一真相源：磁盘上的 handoff Skill（出厂随 SDK 释放，可被项目级覆盖）
    skillDirs: listSkillDirs(),
    onBeforeHandoff: (hctx: HandoffContext) => {
      const { promptTokens, handoffTokens } = hctx;
      const isAuto = promptTokens != null && handoffTokens != null;
      if (isAuto) {
        log(
          t("handoff.autoDetected", {
            used: promptTokens,
            limit: handoffTokens,
            mode: describeMode(hctx.requestedMode),
          }),
        );
      } else {
        log(t("handoff.writing", { mode: describeMode(hctx.requestedMode) }));
      }
    },
    onHandoff: async (hctx: HandoffContext) => {
      // 降级时告知用户：请求的执行者与实际执行者不一致
      if (hctx.mode !== hctx.requestedMode) {
        log(
          t("handoff.degraded", {
            requested: describeMode(hctx.requestedMode),
            mode: describeMode(hctx.mode),
          }),
        );
      }
      log(t("handoff.path", { path: hctx.handoffPath }));

      // 迁移前（历史尚未剔除）保存旧对话：此时已包含交接回合，可完整审计
      if (hctx.migrating) {
        await saveConversation(ctx);
        log(t("handoff.savedConversation", { name: ctx.currentName }));
      }
    },
    onMigrated: async (hctx: HandoffContext) => {
      // 不再清理 lastUsage：它是从 messages 派生的只读值，prune 换了 messages 后
      // 自动就没有旧用量了。交接/迁移回合自身的护栏让行由
      // `ContextGuardPlugin.isSuspended`（接线 `() => handoffService.busy`）负责。

      // 迁移开启新会话：分配新的会话 id 与名称
      const id = generateConversationId();
      ctx.currentId = id;
      ctx.currentName = id;

      log(t("handoff.migrated", { n: hctx.agent.messages.length }));
      log(t("handoff.migratedHint"));

      // 迁移后立即把新开场白落盘为独立会话文件，并更新「上一轮会话 id」指针，
      // 避免迁移发生在 onAfterSend（ConversationPersistPlugin 的 onInnerLoopEnd
      // 已不再触发）导致迁移后的新对话未被及时落盘、用户中途退出时丢失。
      try {
        await persistConversation({
          id,
          agentId: ctx.agentId,
          messages: hctx.agent.messages,
        });
      } catch (err: any) {
        log(t("handoff.persistFailed", { error: err?.message ?? err }));
      }
    },
  });
}
