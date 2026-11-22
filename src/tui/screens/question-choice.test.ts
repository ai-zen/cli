/**
 * 问题作答面板 —— 「宿主问一道题，用户在面板上答」这条路上客户端只做两件事：
 * 把 `QuestionView` 摆上面板、把选中的 `value` 交回去。
 *
 * 所以这一组咬死三件事：
 *   1. 标题与候选**照抄宿主**（顺序也不重排：三选一的先后是产品定的）；
 *   2. 补充说明走 `detail`（有才给）；
 *   3. 放弃（Esc / resolve(null)）返回 `null` —— 那是「不作答」，不是「选了第一个」。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import type { QuestionView } from "../../session/types.js";
import { chooseQuestionAnswer } from "./question-choice.js";
import type { ChatOverlays } from "./use-overlays.js";

beforeEach(() => setLocale("zh"));

/**
 * 一个字面量问题对象（宿主 `question.list` 的一行：`message` + `choices` + `blocking`）。
 *
 * 这一版没有 `prompt` / `options` / `kind` / `state` 那几格了：题干是成品句，候选是
 * 「值 + 显示名」，答完即消失（所以也没有状态可读）。
 */
const handoffQuestion = (): QuestionView => ({
  id: "q1",
  sessionId: "c1",
  message: "上下文已用 92%，要交接吗？",
  choices: [
    { value: "self", label: "原 agent 自交接" },
    { value: "summary", label: "独立摘要" },
    { value: "decline", label: "不交接" },
  ],
  blocking: true,
  // 时间一律 epoch 毫秒（宿主的口径）
  createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
});

/** 捕获到的那份 picker 状态（面板上要印的东西都在这三个字段里） */
interface CapturedPicker {
  title: string;
  items: { value: string; label: string; hint?: string }[];
  resolve: (value: string | null) => void;
}

/**
 * 捕获 pickerState 的假 setter（`chooseQuestionAnswer` 以「值」形式调用它）。
 *
 * 与真实 hook 同一条规矩：函数式更新也照做（`setState(prev => …)` 的写法在这里同样成立）。
 */
function makePicker() {
  let state: CapturedPicker | null = null;
  const setPickerState = ((value: unknown) => {
    state =
      typeof value === "function"
        ? (value as (prev: CapturedPicker | null) => CapturedPicker | null)(state)
        : (value as CapturedPicker | null);
  }) as ChatOverlays["setPickerState"];
  return { setPickerState, get: () => state! };
}

describe("chooseQuestionAnswer（问题对象 → 面板 → 选中的 value）", () => {
  it("标题与候选照抄宿主，顺序不重排", async () => {
    const { setPickerState, get } = makePicker();
    void chooseQuestionAnswer(setPickerState, handoffQuestion());
    const picker = get();
    expect(picker.title).toBe("上下文已用 92%，要交接吗？");
    expect(picker.items.map((item) => item.value)).toEqual(["self", "summary", "decline"]);
    expect(picker.items[0]!.label).toBe("原 agent 自交接");
    expect(picker.items[2]!.label).toBe("不交接");
  });

  it("候选的补充说明：这一版没有 detail 这一层（候选只有值 + 显示名，不给 hint）", () => {
    const { setPickerState, get } = makePicker();
    void chooseQuestionAnswer(setPickerState, handoffQuestion());
    // 宿主这一版不再给每项的补充说明，于是面板也不该凭空写一条
    expect(get().items.map((item) => item.hint)).toEqual([undefined, undefined, undefined]);
  });

  it("选中即返回那个 value（原样，不做映射）", async () => {
    for (const value of ["self", "summary", "decline"]) {
      const { setPickerState, get } = makePicker();
      const answer = chooseQuestionAnswer(setPickerState, handoffQuestion());
      get().resolve(value);
      await expect(answer).resolves.toBe(value);
    }
  });

  it("放弃（resolve(null)）→ null：这是「不作答」，不是「选了第一个」", async () => {
    const { setPickerState, get } = makePicker();
    const answer = chooseQuestionAnswer(setPickerState, handoffQuestion());
    get().resolve(null);
    await expect(answer).resolves.toBeNull();
  });

  it("确认类问题一样走这条路（题干与候选怎么来不影响面板）", () => {
    const confirm: QuestionView = {
      ...handoffQuestion(),
      id: "q2",
      message: "删除这段会话？",
      choices: [
        { value: "yes", label: "删除" },
        { value: "no", label: "取消" },
      ],
    };
    const { setPickerState, get } = makePicker();
    void chooseQuestionAnswer(setPickerState, confirm);
    expect(get().title).toBe("删除这段会话？");
    expect(get().items.map((item) => item.value)).toEqual(["yes", "no"]);
  });
});
