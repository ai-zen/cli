/**
 * 题 → 表单覆盖层这一跳。规矩只有两条：把宿主的表原样塞进覆盖层；把面板交出来的答复原样交给
 * 会话层（`accept` 带内容、`cancel` 是关掉没作答）。
 *
 * 面板本身怎么画、按键怎么变，测在 `form-fields.test.ts`（纯状态机）与 `chat.test.tsx`
 * （打键盘的端到端）里 —— 这一层不该重复那两处的事。
 */
import { describe, expect, it } from "vitest";
import type { QuestionView } from "../../session/types.js";
import { chooseQuestionAnswer } from "./question-choice.js";
import type { ChatOverlays, FormState } from "./use-overlays.js";

/** 交接那道题：一个单选枚举字段 */
const handoffQuestion = (): QuestionView => ({
  id: "q1",
  sessionId: "c1",
  message: "上下文已用 92%，要交接吗？",
  requestedSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        title: "用哪种方式交接？",
        enum: ["self", "summary", "no"],
        enumNames: ["原 agent 自交接", "独立摘要", "不交接"],
      },
    },
    required: ["mode"],
  },
  blocking: true,
  createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
});

/** 捕获覆盖层状态的假 setter（与真实 hook 同一套「值 / 函数式更新」两种写法） */
function makeOverlay() {
  let state: FormState | null = null;
  const setFormState = ((value: unknown) => {
    state =
      typeof value === "function"
        ? (value as (prev: FormState | null) => FormState | null)(state)
        : (value as FormState | null);
  }) as ChatOverlays["setFormState"];
  return { setFormState, get: () => state };
}

describe("chooseQuestionAnswer（题 → 表单覆盖层）", () => {
  it("把题的表原样塞进覆盖层（题干就是标题）", () => {
    const { setFormState, get } = makeOverlay();
    void chooseQuestionAnswer(setFormState, handoffQuestion());

    const form = get()!;
    expect(form.title).toBe("上下文已用 92%，要交接吗？");
    expect(form.schema).toEqual(handoffQuestion().requestedSchema);
  });

  it("面板交出来的答复原样交给会话层", async () => {
    const { setFormState, get } = makeOverlay();
    const answer = chooseQuestionAnswer(setFormState, handoffQuestion());

    get()!.resolve({ action: "accept", content: { mode: "self" } });
    await expect(answer).resolves.toEqual({ action: "accept", content: { mode: "self" } });
  });

  it("关掉面板（Esc）：交的是 cancel", async () => {
    const { setFormState, get } = makeOverlay();
    const answer = chooseQuestionAnswer(setFormState, handoffQuestion());

    get()!.resolve({ action: "cancel" });
    await expect(answer).resolves.toEqual({ action: "cancel" });
  });
});
