// 选择覆盖层 —— 「弹一个、选一个、再关掉」的唯一实现
//
// 契约只有一条：调用方给一个 `resolve` 回调，拿到一个 Promise，**用户在选择器上作答后
// Promise 才结算**。这正是命令处理器能写成 `const picked = await pick(...)` 的原因。
//
// 这套 `resolve` 生命周期单独成模块的理由：埋在会话屏里就既没法单测（要从键盘打到命令层
// 才能碰到），也容易被下一个人的 `setState` 写出「先清状态、后调 resolve」的竞态。收在这里：
//   · 关状态与调 resolve 在**同一次**函数式更新里完成，不会读到过期状态；
//   · 已经是 `null` 时重复 resolve 是安全空操作（Esc 连按不会炸）。
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { SelectItem } from "../components.js";

/** 选择器请求：`items` 上屏，用户选中 / 取消后由 `resolve` 兑现（取消为 `null`） */
export interface PickerState {
  title: string;
  items: SelectItem<string>[];
  resolve: (value: string | null) => void;
}

export interface ChatOverlays {
  pickerState: PickerState | null;
  /** 命令层推送选择器用（`runCommand` / `chooseQuestionAnswer` 的入参类型） */
  setPickerState: Dispatch<SetStateAction<PickerState | null>>;
  /** 作答：兑现 Promise 并关掉选择器（没有选择器时为空操作） */
  resolvePicker: (value: string | null) => void;
}

export function useChatOverlays(): ChatOverlays {
  const [pickerState, setPickerState] = useState<PickerState | null>(null);

  // 用函数式更新而不是闭包里的 `pickerState`：连按两下 Esc / 两个键同一帧到达时，
  // 第二次更新仍能看到「已被第一次清掉」的真实状态，不会重复 resolve。
  const resolvePicker = useCallback((value: string | null) => {
    setPickerState((ps) => {
      ps?.resolve(value);
      return null;
    });
  }, []);

  return { pickerState, setPickerState, resolvePicker };
}
