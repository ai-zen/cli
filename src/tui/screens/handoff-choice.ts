/**
 * 交接方式三选一 —— **自动迁移**那条路上的选择器（服务端提问 → 用户在面板上选）。
 *
 * ## 为什么选项本身不在这里
 *
 * 选项与文案（`handoffModeItems`）住在 `commands/types.ts`：手动 `/migrate`、`/handoff` 在
 * 命令层问同一句话，自动迁移在渲染层问同一句话 —— 一份定义、两处调用。命令层不能 import
 * `tui/`（那是叶子，判据是产物图），所以共享词汇只能落在 `commands/` 那一侧。
 *
 * ## 这里只剩「怎么上屏」
 *
 * 覆盖层状态是渲染层的东西（`useChatOverlays` 的 picker），所以把「弹出来并等一个答案」包成
 * Promise 的那几行留在这里，与 `pick` / `confirm` 同一套机制（关状态与结算在同一次函数式更新
 * 里完成，连按两下 Esc 不会重复 resolve）。
 */

import type { Dispatch, SetStateAction } from "react";
import type { HandoffMode } from "@ai-zen/agents-sdk";
import type { SelectItem } from "../components.js";
import { handoffModeItems, toHandoffMode } from "../../commands/types.js";

/** 选择器状态（与 `ChatOverlays` 的 `pickerState` 结构一致） */
export interface HandoffPickerState {
  title: string;
  items: SelectItem<string>[];
  resolve: (value: string | null) => void;
}

export type SetHandoffPicker = Dispatch<SetStateAction<HandoffPickerState | null>>;

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
      resolve: (value) => resolve(toHandoffMode(value)),
    });
  });
}
