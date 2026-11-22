/**
 * 问题对象的作答面板 —— 宿主问过来一道题（到交接线 / 不可撤销的动作前确认），用户在面板上答。
 *
 * ## 选项与文案都来自宿主
 *
 * 三选一（自交接 / 独立摘要 / 不交接）在过去是客户端自己编的一份词表（`commands/types.ts` 的
 * `handoffModeItems`）。新契约把**问题**变成了一等对象（`QuestionView`：`prompt` / `options[]`
 * / `blocking` / `kind`），于是这里只剩下「怎么上屏」：标题是 `prompt.message`，候选是
 * `options[].label.message`，补充说明是 `options[].detail.message`，提交回去的是
 * `options[].value`。宿主换个说法、加一个候选，这一屏跟着变，客户端不必改一行。
 *
 * ## 这里是唯一的作答入口
 *
 * 返回 `Promise<string | null>`：选中 = 那个 `value`，Esc / 放弃 = `null`。`null` 时**不作答**
 * —— 题会一直挂着，宿主随后以 `question_pending` 拒绝发送（PRD D23），那是实话；替用户选一个
 * 选项等于替他决定「要不要交接、交接去哪」。
 *
 * 覆盖层状态是渲染层的东西（`useChatOverlays` 的 picker），所以「弹出来并等一个答案」包成
 * Promise 的这几行留在这里，与命令层的 `pick` 同一套机制（关状态与结算在同一次函数式更新里
 * 完成，连按两下 Esc 不会重复 resolve）。
 */

import type { QuestionView } from "../../session/types.js";
import type { ChatOverlays } from "./use-overlays.js";

/**
 * 弹出「这道题」并等用户作答；放弃时返回 `null`（= 不作答）。
 *
 * @param setPickerState 会话屏的 picker 状态 setter（TUI 用 `PickerOverlay` 渲染）
 * @param question 宿主给的问题对象（候选顺序即宿主给的顺序，不重排）
 */
export function chooseQuestionAnswer(
  setPickerState: ChatOverlays["setPickerState"],
  question: QuestionView,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    setPickerState({
      title: question.message,
      // 候选是宿主给的（`choices`：值 + 显示名），顺序即宿主给的顺序，不重排
      items: question.choices.map((choice) => ({ value: choice.value, label: choice.label })),
      resolve,
    });
  });
}
