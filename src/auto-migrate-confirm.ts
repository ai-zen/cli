/**
 * 自动迁移的「执行者选择」入口（CLI 层）。
 *
 * 背景：SDK 的 `AutoMigratePlugin` 在 `usage.prompt_tokens` 超过阈值时触发迁移，
 * 但「谁来写交接文档」是产品决策——保真度高的**原 agent 自交接**，还是便宜的**独立摘要**。
 * SDK 已把该决策抽象为 `resolveMode` 回调，CLI 在这里把它接到「用户三选一」上：
 * 原 agent 自交接 / 独立摘要 / 跳过本次迁移。
 *
 * 边界（保持 SDK 的分工，不重复实现「何时迁移」的语义）：
 *   - **何时迁移**：`AutoMigratePlugin`（阈值判断 + busy 让行）；
 *   - **用什么执行者**：本模块的 `resolveMode`；
 *   - **实际怎么交接**：共享的 `HandoffService`（与 `/migrate`、`/handoff` 同一条链路）。
 *
 * 交互约定：
 *   - 仅在 stdin 与 stdout **均为 TTY**（人类交互终端）时询问；
 *   - 非交互环境（管道、重定向、e2e 脚本）没有选择通道，直接按 `defaultMode` 迁移，
 *     不阻塞等待输入、不额外输出，管道语义不变；
 *   - 选择器默认高亮 `self`（保真），Esc/取消 = 跳过本次迁移，不影响当前对话
 *     （历史未被剔除）；只要仍处于超限状态，下次发送后还会再问。
 */

import {
  AutoMigratePlugin,
  type AutoMigrateTriggerInfo,
  type HandoffMode,
  type HandoffService,
} from "@ai-zen/agents-sdk";

export interface AutoMigrateModeOptions {
  /** 交接服务实例（与 `/migrate`、`/handoff` 共用同一实例） */
  service: HandoffService;
  /** 触发迁移的上下文阈值 */
  maxTokens: number;
  /**
   * 用户的执行者选择（由调用方注入：TUI 用选择器浮层）。
   * 返回 `null` 表示跳过本次迁移。
   */
  choose: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
  /** 非交互环境下的执行者，默认 `self` */
  defaultMode?: HandoffMode;
  /** 是否需要向用户确认；默认「stdin 与 stdout 均为 TTY」。可注入，便于单测 */
  shouldConfirm?: () => boolean;
  /** 输出信息（如「已跳过本次迁移」）；由调用方注入（TUI 走 Ink notice），默认丢弃 */
  log?: (text: string) => void;
}

/** 默认交互判定：仅当 stdin 与 stdout 均为 TTY 时才具备选择通道 */
export function canPromptUser(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** 构造带「执行者选择」的自动迁移插件 */
export function createAutoMigratePlugin(options: AutoMigrateModeOptions): AutoMigratePlugin {
  const {
    service,
    maxTokens,
    choose,
    defaultMode = "self",
    shouldConfirm = canPromptUser,
    log = () => {},
  } = options;

  return new AutoMigratePlugin({
    service,
    maxTokens,
    resolveMode: async (info) => {
      // 非交互环境：没有选择通道，按默认执行者迁移（不阻塞、不额外输出）
      if (!shouldConfirm()) return defaultMode;

      const mode = await choose(info);
      if (mode == null) {
        // 合并为单条：notice 通道只保留最新一条，拆成两行会被后者覆盖
        log(
          "⏭️ 已跳过本次任务迁移；可随时输入 /migrate 手动迁移，若继续增长至严重超限对话会被安全护栏中断。",
        );
        return null;
      }
      return mode;
    },
  });
}
