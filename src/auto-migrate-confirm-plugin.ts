/**
 * AutoMigrateConfirmPlugin — 自动迁移「二次确认」插件（CLI 层）。
 *
 * 背景：SDK 的 `AutoMigratePlugin` 在 `usage.prompt_tokens` 超过阈值时**静默**触发迁移，
 * 而迁移会保存当前对话并以交接文档开启新会话。为让用户对这次「上下文切换」有知情权与
 * 否决权，CLI 在自动迁移前补一道二次确认。
 *
 * 职责边界（沿用 SDK 的分工，不重复实现「何时迁移」的语义）：
 *   - 是否触发：本插件先向用户确认，得到许可后委托基类的 `onAfterSend` 完成阈值判断与迁移调用；
 *   - 实际迁移：仍由共享的 `TaskMigrationService` 实例执行（与 /migrate 手动迁移同一条链路）。
 *   因此本插件的增量仅有一处：在超阈值与调用迁移之间插入一次确认。
 *
 * 交互约定：
 *   - 仅在 stdin 与 stdout **均为 TTY**（人类交互终端）时询问；
 *   - 非交互环境（管道、重定向、e2e 脚本）没有确认通道，保持既有行为——直接自动迁移，
 *     不阻塞等待输入、不额外输出，管道语义不变；
 *   - 确认框默认「是」（回车即迁移），与 /migrate 手动迁移的默认值保持一致；
 *   - 用户拒绝时仅跳过**本次**迁移，不记录任何隐式状态：只要仍处于超限状态，下次发送后
 *     会再次询问；跳过不影响当前对话（历史未被剔除，语义与迁移前一致）。
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { AutoMigratePlugin } from "@ai-zen/agents-sdk";
import type { SendContext, TaskMigrationService } from "@ai-zen/agents-sdk";

/** 触发自动迁移时的用量信息（供确认文案与自定义询问实现使用） */
export interface AutoMigrateTriggerInfo {
  /** 当前 prompt token 用量 */
  promptTokens: number;
  /** 上下文阈值（当前模型的 maxContextTokens） */
  maxTokens: number;
}

export interface AutoMigrateConfirmOptions {
  /** 迁移服务实例（与手动迁移 /migrate 共用同一实例） */
  service: TaskMigrationService;
  /** 触发迁移的上下文阈值 */
  maxTokens: number;
  /** 是否需要向用户确认；默认「stdin 与 stdout 均为 TTY」。可注入，便于单测 */
  shouldConfirm?: () => boolean;
  /** 确认实现；默认为 inquirer 确认框。可注入，便于单测 */
  confirm?: (info: AutoMigrateTriggerInfo) => Promise<boolean>;
}

/** 默认交互判定：仅当 stdin 与 stdout 均为 TTY 时才具备确认通道 */
export function canPromptUser(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * 默认确认实现：inquirer 确认框。
 * 默认「是」——回车即迁移，保持自动迁移的既有默认行为不被阻塞。
 */
export async function confirmAutoMigrate(
  info: AutoMigrateTriggerInfo,
): Promise<boolean> {
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: "confirm",
      name: "confirmed",
      message:
        `检测到上下文即将超限（${info.promptTokens}/${info.maxTokens} tokens），是否立即执行任务迁移？\n` +
        "迁移将：生成交接文档 → 保存当前对话 → 开启新会话继续。",
      default: true,
    },
  ]);

  return Boolean(confirmed);
}

/**
 * 自动迁移二次确认插件。
 *
 * 继承 SDK 的 `AutoMigratePlugin` 以复用其触发语义（阈值判断 + 委托共享迁移服务），
 * 仅在「超阈值」与「调用迁移」之间插入一次用户确认。
 */
export class AutoMigrateConfirmPlugin extends AutoMigratePlugin {
  private readonly confirmOptions: AutoMigrateConfirmOptions;

  constructor(options: AutoMigrateConfirmOptions) {
    super({ service: options.service, maxTokens: options.maxTokens });
    this.confirmOptions = options;
  }

  async onAfterSend(ctx: SendContext): Promise<void> {
    const {
      maxTokens,
      shouldConfirm = canPromptUser,
      confirm = confirmAutoMigrate,
    } = this.confirmOptions;

    const promptTokens = ctx.agent.lastUsage?.prompt_tokens;

    // 未超阈值（或无用量信息）：无需询问，交由基类按原语义处理
    if (promptTokens == null || promptTokens <= maxTokens) {
      await super.onAfterSend(ctx);
      return;
    }

    // 非交互环境：没有确认通道，保持既有「静默自动迁移」行为，不阻塞、不额外输出
    if (!shouldConfirm()) {
      await super.onAfterSend(ctx);
      return;
    }

    const confirmed = await confirm({ promptTokens, maxTokens });
    if (!confirmed) {
      console.log(chalk.yellow("\n⏭️ 已跳过本次任务迁移，继续当前对话。\n"));
      console.log(
        chalk.gray(
          "💡 上下文仍接近上限：可随时输入 /migrate 手动迁移；若继续增长至严重超限，对话会被安全护栏中断。\n",
        ),
      );
      return;
    }

    // 用户已确认：交由基类完成「触发 + 委托共享迁移服务」的原逻辑
    await super.onAfterSend(ctx);
  }
}
