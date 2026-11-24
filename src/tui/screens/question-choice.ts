/**
 * 问题对象的作答面板 —— 宿主问过来一道题（到交接线 / 不可撤销的动作前确认），用户在面板上答。
 *
 * ## 选项与文案都来自宿主
 *
 * 三选一（自交接 / 独立摘要 / 不交接）在过去是客户端自己编的一份词表（`commands/handlers.ts` 的
 * `handoffModeItems`，已删）。新契约把**问题**变成了一等对象（`QuestionView`：`message` /
 * `choices[]` / `blocking` / `cancelValue`），于是这里只剩下「怎么上屏」：标题是 `question.message`，
 * 候选是 `choices[].label`，提交回去的是 `choices[].value`。宿主换个说法、加一个候选，这一屏跟着变，
 * 客户端不必改一行。
 *
 * ## 「关掉面板」等于什么，由宿主说
 *
 * Esc / Ctrl+C 在覆盖层里是「关掉」（`overlays.tsx` 的 `onPick(null)`）。关掉之后算答了什么，
 * 这一层**不猜**：题上带 `cancelValue` 就按它作答（交接那道题带的是 `"no"`，即「不交接」——
 * 那一题没有「不作答」这个去处，题一挂这一段就一直等在它上面）；没带就返回 `null`，也就是
 * 真·不作答，题继续挂着等人答。
 *
 * 不按「最后一个候选」之类的**位置**去推断，是因为位置是排版的偶然：顺序一变，语义就静默地变了，
 * 而这里不会红、也不会有一条用例会红（`AGENTS.md` 的「禁止隐式兜底」）。
 *
 * ## 这里是唯一的作答入口
 *
 * 返回 `Promise<string | null>`：选中（或题声明的退路）= 那个 `value`，真·不作答 = `null`。
 * `null` 时**不作答** —— 题会一直挂着，宿主随后以 `question_pending` 拒绝发送（PRD D23），那是
 * 实话；替用户选一个选项等于替他决定「要不要交接、交接去哪」。
 *
 * 覆盖层状态是渲染层的东西（`useChatOverlays` 的 picker），所以「弹出来并等一个答案」包成
 * Promise 的这几行留在这里，与命令层的 `pick` 同一套机制（关状态与结算在同一次函数式更新里
 * 完成，连按两下 Esc 不会重复 resolve）。
 */

import type { QuestionView } from "../../session/types.js";
import type { ChatOverlays } from "./use-overlays.js";

/**
 * 弹出「这道题」并等用户作答；放弃时返回 `null`（= 不作答，题仍然挂着）。
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
      // 关掉面板：题声明了退路就按它作答（那边知道哪个候选是退路），没声明才是真·不作答
      resolve: (value) => resolve(value ?? question.cancelValue ?? null),
    });
  });
}
