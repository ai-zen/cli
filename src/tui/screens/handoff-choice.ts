/**
 * 交接方式三选一 —— 自动迁移与手动 `/migrate`、`/handoff` 共用同一套「谁写交接文档」选择器。
 *
 * 三个选项（统一交互，避免自动用选择器、手动却用 yes/no 确认的不一致）：
 *   1. 当前会话自己写交接文档（`self`）—— 原会话用工具核实并撰写，**保真**；
 *   2. 单独 Agent 写交接文档（`summary`）—— 历史序列化后单次独立生成（独立摘要），
 *      更快更省，但**不核实磁盘状态**；
 *   3. 不交接 —— 返回 `null`，跳过本次交接 / 迁移。
 *
 * 本模块只负责「弹选择器 + 把选择映射为 `HandoffMode | null`」，不触达任何执行逻辑，
 * 便于自动与手动两条链路复用同一份选项 / 文案。
 */

import type { Dispatch, SetStateAction } from "react";
import type { HandoffMode } from "@ai-zen/agents-sdk";
import type { SelectItem } from "../components.js";
import { t } from "../../i18n/index.js";

/** 选择器状态（与 Chat / ChatCommandHost 的 `pickerState` 结构一致） */
export interface HandoffPickerState {
  title: string;
  items: SelectItem<string>[];
  resolve: (value: string | null) => void;
}

export type SetHandoffPicker = Dispatch<SetStateAction<HandoffPickerState | null>>;

/** 「不交接」的哨兵值（区别于 `self` / `summary` 两个执行者） */
export const HANDOFF_SKIP = "__skip__";

/**
 * 三选一选项。
 * `label` 贴近用户措辞，`hint` 交代取舍：保真 vs 省算力、是否核实文件。
 */
export function handoffModeItems(): SelectItem<string>[] {
  return [
    { label: t("handoff.modeSelf"), value: "self", hint: t("handoff.modeSelfHint") },
    { label: t("handoff.modeSummary"), value: "summary", hint: t("handoff.modeSummaryHint") },
    { label: t("handoff.modeSkip"), value: HANDOFF_SKIP, hint: t("handoff.modeSkipHint") },
  ];
}

/**
 * 弹出「交接方式」三选一，返回所选执行者；选择「不交接」或按 Esc 取消时返回 `null`。
 *
 * @param setPickerState 调用方的 picker 状态 setter（TUI 用 PickerOverlay 渲染）
 * @param title 选择器标题（自动 / 手动可传入各自的上下文文案）
 */
export function chooseHandoffMode(
  setPickerState: SetHandoffPicker,
  title: string,
): Promise<HandoffMode | null> {
  return new Promise<HandoffMode | null>((resolve) => {
    setPickerState({
      title,
      items: handoffModeItems(),
      resolve: (value) => resolve(value === "self" || value === "summary" ? value : null),
    });
  });
}
