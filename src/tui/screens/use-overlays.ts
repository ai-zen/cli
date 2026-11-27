// 选择覆盖层 —— 「弹一个、选一个、再关掉」的唯一实现
//
// 契约只有一条：调用方给一个 `resolve` 回调，拿到一个 Promise，用户在选择器上作答后
// Promise 才结算。这正是命令处理器能写成 `const picked = await pick(...)` 的原因。
//
// 这套 `resolve` 生命周期单独成模块的理由：埋在会话屏里就既没法单测（要从键盘打到命令层
// 才能碰到），也容易被后加的 `setState` 写出「先清状态、后调 resolve」的竞态。收在这里：
//   · 关状态与调 resolve 在同一次函数式更新里完成，不会读到过期状态；
//   · 已经是 `null` 时重复 resolve 是安全空操作（Esc 连按不会抛错）。
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { FormAnswerView, FormSchemaView } from "../../session/types.js";
import type { FormAction } from "./form-fields.js";
import type { SelectItem } from "../components.js";

/** 选择器请求：`items` 上屏，用户选中 / 取消后由 `resolve` 兑现（取消为 `null`） */
export interface PickerState {
  title: string;
  items: SelectItem<string>[];
  resolve: (value: string | null) => void;
}

/**
 * 表单请求：一张表上屏，用户填完（或取消）后由 `resolve` 兑现。
 *
 * 与选择器分开两个槽而不是一个联合：两者画的东西、认的按键、兑现的值都不是同一件事，而同一个
 * 槽只会让每一处都得先判「现在是哪一种」。
 */
export interface FormState {
  title: string;
  schema: FormSchemaView;
  /** 这道题允许交哪几态（出题方给的；不给就是三态齐全） */
  actions?: readonly FormAction[];
  /** `null` = 没答（题还挂着），不是「用户说了不」 */
  resolve: (answer: FormAnswerView | null) => void;
}

export interface ChatOverlays {
  pickerState: PickerState | null;
  /** 命令层推送选择器用（`runCommand` / `chooseQuestionAnswer` 的入参类型） */
  setPickerState: Dispatch<SetStateAction<PickerState | null>>;
  /** 作答：兑现 Promise 并关掉选择器（没有选择器时为空操作） */
  resolvePicker: (value: string | null) => void;
  formState: FormState | null;
  /** 会话层推表单用（`chooseQuestionAnswer` 的入参类型） */
  setFormState: Dispatch<SetStateAction<FormState | null>>;
  /** 表单作答：兑现 Promise 并关掉面板（没有表单时为空操作） */
  resolveForm: (answer: FormAnswerView | null) => void;
}

export function useChatOverlays(): ChatOverlays {
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);

  // 用函数式更新而不是闭包里的 `pickerState`：连按两下 Esc / 两个键同一帧到达时，
  // 第二次更新仍能看到「已被第一次清掉」的真实状态，不会重复 resolve。
  const resolvePicker = useCallback((value: string | null) => {
    setPickerState((ps) => {
      ps?.resolve(value);
      return null;
    });
  }, []);

  // 同一条理由（同一个竞态在选择器上踩过一次）
  const resolveForm = useCallback((answer: FormAnswerView | null) => {
    setFormState((fs) => {
      fs?.resolve(answer);
      return null;
    });
  }, []);

  return { pickerState, setPickerState, resolvePicker, formState, setFormState, resolveForm };
}
