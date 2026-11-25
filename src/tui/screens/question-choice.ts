/**
 * 题的表单面板 —— 宿主问过来一张表单（到交接线、不可撤销的动作前确认、将来还有外部服务器发来的
 * elicitation），用户在面板上填。
 *
 * ## 画法只有一种：「一句问话 + 候选」
 *
 * 形状照抄 MCP elicitation 的 `requestedSchema`，而这一版面板只做**单选枚举那一格**：题的表里只要
 * 有一个 `type: "string"` 且带 `enum` 的字段，就把它的候选画成一份列表。交接三选一就是这种，
 * 也是目前唯一的出题方。
 *
 * 别的形状（自由文本、数字、布尔、多选）**暂时不画**：面板给不出一个诚实的输入面（终端里没有
 * 表单控件），硬拿列表去顶等于骗用户「只能从这几个里选」。真碰上就按 `cancel` 回给宿主 —— 那是
 * 三态里唯一诚实的答案：「我这边没法答」。
 *
 * ## 三态怎么落到面板上
 *
 * - 选中一项 → `accept`，内容就是 `{字段名: 选中的值}`；
 * - Esc / Ctrl+C → `cancel`（spec 的「用户关掉没作答」）。**哪个候选等于退路不再由题声明** ——
 *   那件事归消费者解释：交接那一道题拿到 `cancel` 就当「不交接」，外部服务器拿到 `cancel` 就照
 *   spec 回它一个 cancel。以前那一格 `cancelValue` 存在的唯一理由，正是把这件事提前塞进题里。
 *
 * 返回 `null` 是另一种事：**没人在答**（没有面板）。会话层据此把题干丢进通知栏、不作答，题继续
 * 挂着等人。
 */

import type { FormAnswerView, FormFieldView, QuestionView } from "../../session/types.js";
import type { ChatOverlays } from "./use-overlays.js";

/** 面板能画出来的那张表的形状：字段名 + 候选（值/显示名） */
interface PickableField {
  name: string;
  options: readonly { value: string; label: string }[];
}

/**
 * 在这张表里找那一格能画成列表的字段。
 *
 * 只要「字符串 + 带了 enum」那一种；带多个这种字段时不挑一个硬画（挑哪个都是替用户决定），
 * 而是回 `undefined` —— 调用方据此按 `cancel` 作答。
 */
function pickableField(question: QuestionView): PickableField | undefined {
  const entries = Object.entries(question.requestedSchema.properties).filter(
    (entry): entry is [string, Extract<FormFieldView, { type: "string" }>] => {
      const field = entry[1];
      return field.type === "string" && field.enum !== undefined;
    },
  );
  if (entries.length !== 1) return undefined;

  const [name, field] = entries[0];
  const values = field.enum ?? [];
  return {
    name,
    options: values.map((value, index) => ({
      value,
      // 显示名与值一一对应；没给显示名就用值本身（`enumNames` 缺项时不猜别的）
      label: field.enumNames?.[index] ?? value,
    })),
  };
}

/**
 * 弹出「这道题」并等用户作答。
 *
 * @param setPickerState 会话屏的 picker 状态 setter（TUI 用 `PickerOverlay` 渲染）
 * @param question 宿主给的那张表
 */
export function chooseQuestionAnswer(
  setPickerState: ChatOverlays["setPickerState"],
  question: QuestionView,
): Promise<FormAnswerView | null> {
  const field = pickableField(question);
  if (field === undefined) {
    // 这一版画不出这张表：照三态回一个 cancel，而不是编一个「用户选了第一项」
    return Promise.resolve({ action: "cancel" });
  }

  return new Promise<FormAnswerView | null>((resolve) => {
    setPickerState({
      title: question.message,
      // 候选顺序即宿主给的顺序，不重排
      items: field.options.map((option) => ({ value: option.value, label: option.label })),
      // 关掉面板 = cancel（三态里「用户关掉没作答」那一格），不是「替用户选一个」
      resolve: (value) =>
        resolve(value === null ? { action: "cancel" } : accept(field.name, value)),
    });
  });
}

/** 选中一项：`accept` + 那一格的内容 */
function accept(name: string, value: string): FormAnswerView {
  return { action: "accept", content: { [name]: value } };
}
