/**
 * 命令层与覆盖层之间的**共享词汇**。
 *
 * ## 为什么这些东西住在 `commands/` 而不是 `tui/`
 *
 * 它们每一件都同时被两边用到，而 `tui/` 是**叶子**（除它自己以外全仓不许 import 它）：
 *
 *   · `SelectItem` —— 命令层**产出**选项（`/model`、`/load`、`/back` 各自拼一份），
 *     覆盖层**渲染**它。它是这条边界的形状，不是某一侧的私有类型；
 *   · 交接方式三选一（`HANDOFF_SKIP` / `handoffModeItems`）—— 手动 `/migrate`、`/handoff`
 *     与**自动**迁移（服务端提问）共用同一套选项与文案，而前者在命令层、后者在渲染层；
 *   · `WizardEntryStep` —— 命令层能打开的向导入口步（`/config` 的菜单、`/mcp` 的那一屏）。
 *
 * 放在这里之后，「命令层 import 渲染层」这条越界在**类型层**就不存在了：`SelectItem` 与
 * `WizardEntryStep` 都只是 `import type`，产物里一行都没有。
 *
 * ## 为什么 `SelectItem` 不带渲染细节
 *
 * 它只有「标签 / 值 / 提示 / 图标」四样 —— 全都是**内容**，没有颜色、没有行数。宽度裁剪与
 * 单行约束在覆盖层里做（`tui/components.tsx` 的 `fitItem`）：那些是终端宽度的事实，命令层
 * 连 `columns` 都不该知道。
 */

import type { HandoffMode } from "@ai-zen/agents-sdk";
import type { McpScope } from "../config.js";
import { t } from "../i18n/index.js";

/** 选择器条目：`value` 原样回到 `pick()` 的答案里（命令层自己解释它的含义） */
export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
  icon?: string;
}

/**
 * 命令层能打开的向导入口步。
 *
 * 为什么只声明这两种：完整的 `WizardStep` 联合住在渲染层（`tui/config-wizard/types.ts`），
 * 而命令层只打两个口子 —— 配置中心菜单（`/config`）与 MCP 屏（`/mcp`）。这里声明「我能
 * 打开什么」，而不是把整个联合搬过来：后者会让命令层的类型面跟着向导每一次改版一起动，
 * 而它一个字段都不读（原样转手给宿主）。
 *
 * 它与渲染层的 `WizardStep` 是子集关系，所以宿主那个 `(step: WizardStep) => Promise<void>`
 * 可以直接当 `(step: WizardEntryStep) => Promise<void>` 用（参数逆变）。
 */
export type WizardEntryStep = { kind: "menu" } | { kind: "mcp"; scope: McpScope };

/** 「不交接」的哨兵值（区别于 `self` / `summary` 两个执行者） */
export const HANDOFF_SKIP = "__skip__";

/**
 * 交接方式三选一。
 *
 * `label` 贴近用户措辞，`hint` 交代取舍：保真 vs 省算力、是否核实文件。文案在这里只写一份
 * —— 自动迁移（服务端问「用哪种方式」）与手动 `/migrate`、`/handoff` 问的是同一句话。
 */
export function handoffModeItems(): SelectItem<string>[] {
  return [
    { label: t("handoff.modeSelf"), value: "self", hint: t("handoff.modeSelfHint") },
    { label: t("handoff.modeSummary"), value: "summary", hint: t("handoff.modeSummaryHint") },
    { label: t("handoff.modeSkip"), value: HANDOFF_SKIP, hint: t("handoff.modeSkipHint") },
  ];
}

/**
 * 选择器答案 → 交接执行者。
 *
 * `null`（Esc 取消）、`HANDOFF_SKIP`（选「不交接」）与任何意外值都归到 `null`：调用方只需
 * 分辨「交接 / 不交接」两件事，而协议里只有 `self` / `summary` 两个合法值。
 */
export function toHandoffMode(value: string | null): HandoffMode | null {
  return value === "self" || value === "summary" ? value : null;
}
