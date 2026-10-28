// 覆盖层（确认框 / 选择器）—— 「弹一个、答一个、再关掉」的唯一实现
//
// 两种覆盖层共用同一套契约：调用方给一个 `resolve` 回调，拿到一个 Promise，
// **用户在覆盖层上作答后 Promise 才结算**。这正是命令处理器能写成
// `const ok = await confirm(...)` 的原因。
//
// 从 `chat.tsx` 抽出来的理由：这套 `resolve` 生命周期被埋在 God Component 里，
// 既没法单测（要从键盘打到命令层才能碰到），也容易被下一个人的 `setState` 写出
// 「先清状态、后调 resolve」的竞态。抽出来后：
//   · 关状态与调 resolve 在**同一次**函数式更新里完成，不会读到过期状态；
//   · 已经是 `null` 时重复 resolve 是安全空操作（Esc 连按不会炸）。
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { SelectItem } from "../components.js";

/** 确认框请求：`question` 上屏，用户作答后由 `resolve` 结算 */
export interface ConfirmState {
  question: string;
  resolve: (value: boolean) => void;
}

/** 选择器请求：`items` 上屏，用户选中 / 取消后由 `resolve` 结算（取消为 `null`） */
export interface PickerState {
  title: string;
  items: SelectItem<string>[];
  resolve: (value: string | null) => void;
}

export interface ChatOverlays {
  confirmState: ConfirmState | null;
  pickerState: PickerState | null;
  /** 命令层推送覆盖层用（`runCommand` / `chooseHandoffMode` 的入参类型） */
  setConfirmState: Dispatch<SetStateAction<ConfirmState | null>>;
  setPickerState: Dispatch<SetStateAction<PickerState | null>>;
  /** 作答：结算 Promise 并关掉覆盖层（无覆盖层时为空操作） */
  resolveConfirm: (value: boolean) => void;
  resolvePicker: (value: string | null) => void;
}

export function useChatOverlays(): ChatOverlays {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [pickerState, setPickerState] = useState<PickerState | null>(null);

  // 用函数式更新而不是闭包里的 `confirmState`：连按两下 Esc / 两个键同一帧到达时，
  // 第二次更新仍能看到「已被第一次清掉」的真实状态，不会重复 resolve。
  const resolveConfirm = useCallback((value: boolean) => {
    setConfirmState((cs) => {
      cs?.resolve(value);
      return null;
    });
  }, []);

  const resolvePicker = useCallback((value: string | null) => {
    setPickerState((ps) => {
      ps?.resolve(value);
      return null;
    });
  }, []);

  return { confirmState, pickerState, setConfirmState, setPickerState, resolveConfirm, resolvePicker };
}
