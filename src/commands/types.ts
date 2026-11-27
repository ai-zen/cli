/**
 * 命令层与覆盖层之间的**共享词汇**。
 *
 * ## 为什么这些东西住在 `commands/` 而不是 `tui/`
 *
 * 它们每一件都同时被两边用到，而 `tui/` 是**叶子**（全仓除它自己以外没有文件 import 它）：
 *
 *   · `SelectItem` —— 命令层**产出**选项（`/model`、`/load`、`/back`、`/think` 各拼一份），
 *     覆盖层**渲染**它。它是这条边界的形状，不是某一侧的私有类型；
 *   · 交接方式三选一 —— **两边都不在了**：题由宿主出（`HandoffService.startAsked`），命令层只说
 *     哪一档、覆盖层只渲染宿主发来的 `QuestionView`（`tui/screens/question-choice.ts`）；
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

import type { McpEditableScope } from "../config.js";

/** 选择器 InboxEntry：`value` 原样回到 `pick()` 的答案里（命令层自己解释它的含义） */
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
export type WizardEntryStep =
  | { kind: "menu" }
  | { kind: "mcp"; scope: McpEditableScope }
  /**
   * 直达某个端点的密钥屏（`field` 收窄成 `apiKey`：命令层只打这一个目标）。
   *
   * 它存在的原因：`/model` 选中的模型若属于一家还没配密钥的服务商，切换前得先把钥匙补上
   * —— 与首启引导、`/key` 是同一屏，不是第三条路。
   */
  | { kind: "edit"; field: "apiKey"; endpointId: string };
