/**
 * 表单面板 —— 「宿主问一张表，用户在面板上填」这条路上，客户端只做两件事：把表里那一格**能画成
 * 列表**的枚举摆上面板、把选中的值包成一次 `accept` 交回去。
 *
 * 所以这一组咬死五件事：
 *   1. 标题与候选**照抄宿主**（顺序也不重排：三选一的先后是产品定的）；
 *   2. 选中 = `accept` + `{字段名: 值}`，字段名取自表，不是写死的 `mode`；
 *   3. **关掉面板（Esc / resolve(null)）= `cancel`**：三态里「用户关掉没作答」那一格。哪个候选
 *      等于退路不再由题声明 —— 那件事归消费者解释（交接那一道题拿到 cancel 就当「不交接」）；
 *   4. 表里**没有**能画成列表的字段（自由文本 / 数字 / 布尔）→ 立刻回 `cancel`，不弹面板；
 *   5. 能画的字段**不止一格** → 同样回 `cancel`：挑其中一格画出来就是替用户决定问什么。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import type { QuestionView } from "../../session/types.js";
import { chooseQuestionAnswer } from "./question-choice.js";
import type { ChatOverlays } from "./use-overlays.js";

beforeEach(() => setLocale("zh"));

/** 交接那道题：一个单选枚举字段（宿主那一侧就是这么出题的） */
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

describe("chooseQuestionAnswer（表单 → 面板 → 一次作答）", () => {
  it("标题与候选照抄宿主，顺序不重排", () => {
    const { setPickerState, get } = makePicker();
    void chooseQuestionAnswer(setPickerState, handoffQuestion());
    const picker = get();
    expect(picker.title).toBe("上下文已用 92%，要交接吗？");
    expect(picker.items.map((item) => item.value)).toEqual(["self", "summary", "no"]);
    expect(picker.items[0]!.label).toBe("原 agent 自交接");
    expect(picker.items[2]!.label).toBe("不交接");
  });

  it("候选只有值 + 显示名，不给 hint", () => {
    const { setPickerState, get } = makePicker();
    void chooseQuestionAnswer(setPickerState, handoffQuestion());
    expect(get().items.map((item) => item.hint)).toEqual([undefined, undefined, undefined]);
  });

  it("选中 = accept + 表里那一格的内容（字段名取自表）", async () => {
    for (const value of ["self", "summary", "no"]) {
      const { setPickerState, get } = makePicker();
      const answer = chooseQuestionAnswer(setPickerState, handoffQuestion());
      get().resolve(value);
      await expect(answer).resolves.toEqual({ action: "accept", content: { mode: value } });
    }
  });

  it("关掉面板（Esc / resolve(null)）= cancel，不是替用户选一个", async () => {
    const { setPickerState, get } = makePicker();
    const answer = chooseQuestionAnswer(setPickerState, handoffQuestion());
    get().resolve(null);
    await expect(answer).resolves.toEqual({ action: "cancel" });
  });

  it("确认类问题一样走这条路（题干与候选怎么来不影响面板）", async () => {
    const confirm: QuestionView = {
      ...handoffQuestion(),
      id: "q2",
      message: "删除这段会话？",
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "string", enum: ["yes", "no"], enumNames: ["删除", "取消"] },
        },
        required: ["confirm"],
      },
    };
    const { setPickerState, get } = makePicker();
    const answer = chooseQuestionAnswer(setPickerState, confirm);
    expect(get().title).toBe("删除这段会话？");
    expect(get().items.map((item) => item.value)).toEqual(["yes", "no"]);
    get().resolve("yes");
    await expect(answer).resolves.toEqual({ action: "accept", content: { confirm: "yes" } });
  });

  it("没有能画成列表的字段（自由文本）→ 立刻 cancel，不弹面板", async () => {
    const freeText: QuestionView = {
      ...handoffQuestion(),
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string", title: "叫什么名字？" } },
        required: ["name"],
      },
    };
    // 面板一次都不该被打开
    let opened = 0;
    const setPickerState = ((_value: unknown) => {
      opened += 1;
    }) as ChatOverlays["setPickerState"];

    await expect(chooseQuestionAnswer(setPickerState, freeText)).resolves.toEqual({
      action: "cancel",
    });
    expect(opened).toBe(0);
  });

  it("能画的字段不止一格 → 也回 cancel（挑一格画就是替用户决定问什么）", async () => {
    const twoEnums: QuestionView = {
      ...handoffQuestion(),
      requestedSchema: {
        type: "object",
        properties: {
          a: { type: "string", enum: ["x", "y"] },
          b: { type: "string", enum: ["1", "2"] },
        },
      },
    };
    const { setPickerState } = makePicker();
    await expect(chooseQuestionAnswer(setPickerState, twoEnums)).resolves.toEqual({
      action: "cancel",
    });
  });
});
