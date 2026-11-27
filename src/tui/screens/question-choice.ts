/**
 * 题 → 表单面板。宿主问过来一张表，这一层把它塞进覆盖层、等一个答复。
 *
 * 不再从 `choices` 里挑候选画成选择器：题的形状是一张表，而表可以是字符串、数字、布尔、
 * 多选，挑其中一个字段画出来等于替用户决定这一问只需要答这一格。所以交给 `FormOverlay`，
 * 它按表逐格画，单选枚举那一格自然就长成选择器。
 *
 * 面板交得全：`accept`（按了 `[同意]`，带内容）、`decline`（按了 `[拒绝]`，明确说不）、
 * `cancel`（按了 `[取消]`、Esc 或 Ctrl+C，没做决定）。这三态是 MCP elicitation 的规范动作，
 * 含义各不相同：服务器收到 `decline` 应停止该操作，收到 `cancel` 可以稍后再问。
 *
 * 返回 `null` 是另一种事：没人在答（这一屏没有面板），会话层据此把题干丢进通知栏。
 */

import type { FormAnswerView, QuestionView } from "../../session/types.js";
import type { ChatOverlays } from "./use-overlays.js";

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
