/**
 * 生成阶段的**文案**层（中英由词典决定，这里只做分发）。
 *
 * 状态机本身（六态判定、谁还在跑）在 `@ai-zen/agents-server` 的
 * `service/progress/PhaseTracker`：服务端只发事实（`{ kind, tools }`），
 * 落到「连接中…」还是「Connecting…」是客户端的事 —— TUI 用中文、桌面端用英文、
 * 将来两端同时连一个服务时也不会互相污染。
 *
 * 同一条规矩在 `commands/registry.ts` 里已经用过一次（存 `descriptionKey`
 * 而不是文案），理由一致：文案一旦进了服务层，语言就成了进程级全局状态。
 */

import { t } from "./i18n/index.js";
import type { PhaseInfo } from "@ai-zen/agents-server";

/** 阶段对应的提示文案 */
export function phaseLabel(phase: PhaseInfo | null): string {
  if (!phase) return t("phase.working");
  switch (phase.kind) {
    case "connecting":
      return t("phase.connecting");
    case "queued":
      return t("phase.queued");
    case "thinking":
      return t("phase.thinking");
    case "streaming":
      return t("phase.streaming");
    case "tool-calling":
      return phase.tool ? t("phase.toolCallingWith", { name: phase.tool }) : t("phase.toolCalling");
    case "tool-waiting":
      // 并行时把还在跑的名字一起念出来（`tools` 已由读取方按结果状态筛过）
      return phase.tools?.length
        ? t("phase.toolWaitingWith", {
            name: phase.tools.join(t("common.listSeparator")),
          })
        : t("phase.toolWaiting");
  }
}
