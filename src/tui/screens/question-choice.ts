/**
 * 题 → 表单面板。宿主问过来一张表，这一层把它塞进覆盖层、等一个答复。
 *
 * ## 为什么不再挑「单选题」那条近路
 *
 * 以前这里从 `choices` 里挑候选、画成选择器。现在题的形状就是一张表，而表可以是字符串/数字/
 * 布尔/多选 —— 挑其中一个字段画出来，等于替用户决定「这一问只需要答这个」。所以一律交给
 * `FormOverlay`：它按表逐格画，单选枚举那一格自然就长成以前那样。
 *
 * ## 三态怎么来
 *
 * 面板交出 `accept`（带内容）或 `cancel`（Esc / Ctrl+C，关掉没作答）。`decline` 这一档留给
 * 有「拒绝」这个明确动作的场景（未来的 MCP elicitation 会让服务器自己给一个），我们内部的题
 * 用不上 —— 交接那道题的「不交接」是一个选项，不是拒绝。
 *
 * 返回 `null` 是另一种事：**没人在答**（这一屏没有面板），会话层据此把题干丢进通知栏。
 */

import type { FormAnswerView, QuestionView } from "../../session/types.js";
import type { ChatOverlays } from "./use-overlays.js";

/**
 * 弹出「这张表」并等用户填完。
 *
 * @param setFormState 会话屏的覆盖层状态 setter（TUI 用 `FormOverlay` 渲染）
 * @param question 宿主给的那张表
 */
export function chooseQuestionAnswer(
  setFormState: ChatOverlays["setFormState"],
  question: QuestionView,
): Promise<FormAnswerView | null> {
  return new Promise<FormAnswerView | null>((resolve) => {
    setFormState({
      title: question.message,
      schema: question.requestedSchema,
      resolve: (answer) => resolve(answer),
    });
  });
}
