/**
 * 表单的编辑状态机（纯函数）。
 *
 * 这一组钉住的是「按一下该变成什么」，按面板的两层分开：
 *
 * - **浏览层**：↑ ↓ 在「各个字段 + 最后那个提交项」之间走，回车落到某一项上；
 * - **编辑层**：落在字段上之后，箭头动的是候选，回车/Esc 退回浏览层（值留着）。
 *
 * 面板（`overlays.tsx`）只把这些搬上屏 —— 于是这些规矩能在这里一条条验，不必从键盘打到屏幕上。
 */
import { describe, expect, it } from "vitest";

import type { FormSchemaView } from "../../session/types.js";
import {
  answerOf,
  applyFormKey,
  cursorOf,
  fieldNames,
  formLines,
  initialEditing,
  schemaRows,
  type FormEditing,
  type FormKey,
  type FormStep,
} from "./form-fields.js";

/** 一张什么形状都有的表：文本、必填文本、数字、整数（带范围）、布尔、单选、多选 */
const SCHEMA: FormSchemaView = {
  type: "object",
  properties: {
    title: { type: "string", title: "标题", default: "初稿" },
    body: { type: "string", title: "正文", maxLength: 5 },
    count: { type: "number", title: "数量", minimum: 1, maximum: 10 },
    whole: { type: "integer", title: "整数" },
    flag: { type: "boolean", title: "开关" },
    mode: { type: "string", title: "方式", enum: ["self", "no"], enumNames: ["自己", "不"] },
    tags: {
      type: "array",
      title: "标签",
      items: { type: "string", enum: ["a", "b"] },
      maxItems: 1,
    },
  },
  required: ["mode"],
};

/** 文本 TABLE：两种枚举各三个候选，用来验「同一个形状，只差一对括号」 */
const PICKS: FormSchemaView = {
  type: "object",
  properties: {
    mode: { type: "string", title: "单选", enum: ["a", "b", "c"], enumNames: ["甲", "乙", "丙"] },
    tags: { type: "array", title: "多选", items: { type: "string", enum: ["x", "y", "z"] } },
    note: { type: "string", title: "备注" },
  },
};

const TEXTS = { empty: "（空）", submit: "提交" };

/** 按一串键，只取「状态」那一路（提交/取消由面板接） */
const press = (
  editing: FormEditing,
  keys: FormKey[],
  schema: FormSchemaView = SCHEMA,
): FormEditing =>
  keys.reduce<FormEditing>((current, key) => {
    const step = applyFormKey(current, schema, key);
    if (step.kind !== "state") throw new Error(`这一下不是状态变化：${step.kind}`);
    return step.editing;
  }, editing);

const stepOf = (editing: FormEditing, key: FormKey, schema: FormSchemaView = SCHEMA): FormStep =>
  applyFormKey(editing, schema, key);

const next = { kind: "next" } as const;
const prev = { kind: "prev" } as const;
const enter = { kind: "enter" } as const;
const escape = { kind: "escape" } as const;

/** 把焦点挪到某个字段上（浏览层一格一格走 —— 数下标太容易数错一格） */
const focusOn = (
  name: string,
  editing = initialEditing(SCHEMA),
  schema: FormSchemaView = SCHEMA,
): FormEditing => {
  let current = editing;
  for (let turn = 0; turn < fieldNames(schema).length; turn += 1) {
    if (fieldNames(schema)[current.focus] === name) return current;
    current = press(current, [next], schema);
  }
  throw new Error(`表里没有字段 ${name}`);
};

/** 进编辑层：焦点在某个字段上时按回车 */
const editing = (name: string, schema: FormSchemaView = SCHEMA, base?: FormEditing) =>
  press(focusOn(name, base ?? initialEditing(schema), schema), [enter], schema);

describe("表单：浏览层", () => {
  it("初值取表里的 default，落在第一格、而且还在浏览层", () => {
    const editing = initialEditing(SCHEMA);

    expect(editing.values.title).toBe("初稿");
    expect(editing.values.mode).toBe("self");
    expect(editing.values.flag).toBe(false);
    expect(editing.values.tags).toEqual([]);
    expect(editing.focus).toBe(0);
    expect(editing.mode).toBe("browsing");
  });

  it("上下箭头在「字段 + 提交项」之间环绕：提交项是最后一格", () => {
    const names = fieldNames(SCHEMA);
    const toSubmit = names.reduce<FormEditing>(
      (current) => press(current, [next]),
      initialEditing(SCHEMA),
    );
    expect(toSubmit.focus).toBe(names.length);
    // 再往下就是回到第一格
    expect(press(toSubmit, [next]).focus).toBe(0);
    expect(press(initialEditing(SCHEMA), [prev]).focus).toBe(names.length);
  });

  it("回车落在字段上进编辑层；落在提交项上就是该交卷了", () => {
    const names = fieldNames(SCHEMA);
    const onField = press(initialEditing(SCHEMA), [enter]);
    expect(onField.mode).toBe("editing");

    const onSubmit = names.reduce<FormEditing>(
      (current) => press(current, [next]),
      initialEditing(SCHEMA),
    );
    expect(stepOf(onSubmit, enter)).toEqual({ kind: "submit" });
  });

  it("浏览层不认字：敲一下不会顺手改掉某一格", () => {
    const typed = press(initialEditing(SCHEMA), [{ kind: "text", input: "x" }]);
    expect(typed.values.title).toBe("初稿");
  });

  it("Esc：浏览层关掉整张表；编辑层只退一层（值留着）", () => {
    expect(stepOf(initialEditing(SCHEMA), escape)).toEqual({ kind: "cancel" });

    const inField = press(focusOn("body"), [enter, { kind: "text", input: "a" }]);
    const back = press(inField, [escape]);
    expect(back.mode).toBe("browsing");
    expect(back.values.body).toBe("a");
  });
});

describe("表单：编辑层", () => {
  it("文本收字、退格删字；`maxLength` 满了就不再长", () => {
    const atBody = editing("body");
    expect(atBody.mode).toBe("editing");

    const typed = press(atBody, [
      { kind: "text", input: "a" },
      { kind: "text", input: "b" },
      { kind: "backspace" },
      { kind: "text", input: "x" },
    ]);
    expect(typed.values.body).toBe("ax");

    const long = press(
      atBody,
      Array.from({ length: 8 }, () => ({ kind: "text", input: "z" }) as FormKey),
    );
    expect(String(long.values.body)).toHaveLength(5);
  });

  it("数字那两格只收数字、负号与小数点（字母敲不进去）", () => {
    const typed = press(editing("count"), [
      { kind: "text", input: "1" },
      { kind: "text", input: "a" },
      { kind: "text", input: "." },
      { kind: "text", input: "5" },
    ]);
    expect(typed.values.count).toBe("1.5");
  });

  it("单选枚举：回车进来之后 ↑ ↓（或 ← →）换候选", () => {
    const atMode = editing("mode");

    expect(press(atMode, [next]).values.mode).toBe("no");
    // 环绕
    expect(press(atMode, [prev]).values.mode).toBe("no");
    // 左右箭头是同一个动作
    expect(press(atMode, [{ kind: "step", delta: 1 }]).values.mode).toBe("no");
  });

  it("多选：↑ ↓ 移项光标、空格勾上或取消（项光标按字段各自记）", () => {
    const atTags = editing("tags");
    const second = press(atTags, [next]);
    expect(cursorOf(second, "tags", SCHEMA.properties.tags!)).toBe(1);

    const picked = press(second, [{ kind: "space" }]);
    expect(picked.values.tags).toEqual(["b"]);
    expect(press(picked, [{ kind: "space" }]).values.tags).toEqual([]);
  });

  it("布尔：空格取反", () => {
    expect(press(editing("flag"), [{ kind: "space" }]).values.flag).toBe(true);
  });

  it("回车退出编辑层（不提交）：值留着，焦点还在这一格", () => {
    const done = press(editing("body"), [{ kind: "text", input: "a" }, enter]);
    expect(done.mode).toBe("browsing");
    expect(done.values.body).toBe("a");
    expect(fieldNames(SCHEMA)[done.focus]).toBe("body");
  });

  it("改一下输入就清掉上一次的错误（那句属于上一版草稿）", () => {
    const failed: FormEditing = { ...initialEditing(SCHEMA), error: "正文：太长" };
    expect(press(failed, [{ kind: "text", input: "a" }]).error).toBeUndefined();
  });
});

describe("表单：提交", () => {
  it("按表的声明收成内容：数字转成数字、空数字不交、布尔与多选原样", () => {
    const editing: FormEditing = {
      ...initialEditing(SCHEMA),
      values: { ...initialEditing(SCHEMA).values, count: "3", whole: "", flag: true, tags: ["a"] },
    };

    const result = answerOf(SCHEMA, editing.values);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toEqual({
      title: "初稿",
      body: "",
      count: 3,
      flag: true,
      mode: "self",
      tags: ["a"],
    });
  });

  it("必填没填、数字不像数字、整数带小数、超范围、太长、多选超项数：各回一格并指出是哪一格", () => {
    const submit = (values: Record<string, string | boolean | readonly string[]>) =>
      answerOf(SCHEMA, { ...initialEditing(SCHEMA).values, ...values });

    expect(submit({ mode: "" })).toMatchObject({
      ok: false,
      focus: fieldNames(SCHEMA).indexOf("mode"),
    });
    expect(submit({ count: "abc" })).toMatchObject({ ok: false, focus: 2 });
    expect(submit({ whole: "1.5" })).toMatchObject({ ok: false, focus: 3 });
    expect(submit({ count: "11" })).toMatchObject({ ok: false, focus: 2 });
    expect(submit({ body: "一二三四五六" })).toMatchObject({ ok: false, focus: 1 });
    expect(submit({ tags: ["a", "b"] })).toMatchObject({ ok: false, focus: 6 });
  });

  it("`format` 那四种只挡明显不是的东西", () => {
    const schema: FormSchemaView = {
      type: "object",
      properties: {
        mail: { type: "string", format: "email" },
        link: { type: "string", format: "uri" },
        day: { type: "string", format: "date" },
        at: { type: "string", format: "date-time" },
      },
    };
    const ok = answerOf(schema, {
      mail: "a@b.co",
      link: "https://x.dev",
      day: "2026-11-25",
      at: "2026-11-25T08:00:00Z",
    });
    expect(ok.ok).toBe(true);

    expect(answerOf(schema, { mail: "ab.co", link: "x", day: "11/25", at: "早上" }).ok).toBe(false);
  });

  it("非必填的空文本照样交上去（空串是一个值，不是「没填」）", () => {
    const schema: FormSchemaView = { type: "object", properties: { note: { type: "string" } } };
    expect(answerOf(schema, { note: "" })).toEqual({ ok: true, content: { note: "" } });
  });
});

describe("表单：摊成一行行", () => {
  it("浏览层一格一行：值写显示名，最后一格是提交项", () => {
    const lines = formLines(PICKS, initialEditing(PICKS), TEXTS).map((line) => line.text);

    expect(lines).toEqual(["❯ 单选：甲", "  多选：（空）", "  备注：（空）", "  提交"]);
  });

  it("进编辑之后枚举才展开：单选 `(o)`、多选 `[x]`，同一个形状只差一对括号", () => {
    const atMode = editing("mode", PICKS);
    const lines = formLines(PICKS, atMode, TEXTS).map((line) => line.text);

    expect(lines[0]).toBe("▸ 单选");
    expect(lines[1]).toBe("     (o) 甲");
    expect(lines[2]).toBe("     ( ) 乙");
    expect(lines[3]).toBe("     ( ) 丙");

    const atTags = press(atMode, [escape], PICKS);
    const multi = formLines(
      PICKS,
      press(focusOn("tags", atTags, PICKS), [enter], PICKS),
      TEXTS,
    ).map((line) => line.text);
    expect(multi).toContain("   ❯ [ ] x");
    expect(multi).toContain("     [ ] y");
  });

  it("提交项被选中时带标记（那是交卷那一下落的地方）", () => {
    const atSubmit = fieldNames(PICKS).reduce<FormEditing>(
      (current) => press(current, [next], PICKS),
      initialEditing(PICKS),
    );
    expect(formLines(PICKS, atSubmit, TEXTS).at(-1)!.text).toBe("❯ 提交");
  });

  it("行数：浏览层是「字段数 + 提交项」", () => {
    expect(schemaRows(PICKS)).toBe(4);
    expect(formLines(PICKS, initialEditing(PICKS), TEXTS)).toHaveLength(4);
  });

  it("放不下就滚动：窗口跟着焦点走，被截掉的那一头各说一句", () => {
    // 编辑 tags（三个候选）：整块 1 + 4 + 1 + 1 = 7 行，窗只给 4 行
    const atTags = editing("tags", PICKS);
    const lines = formLines(PICKS, atTags, TEXTS, 4);

    expect(lines).toHaveLength(4);
    // 焦点那一块在窗口里（滚动是对准它的）
    expect(lines.some((line) => line.text.includes("多选"))).toBe(true);
    // 焦点靠前，于是尾部被截掉
    expect(lines.at(-1)!.text).toContain("下面还有");

    // 焦点靠后（最后的提交项）：换另一头
    const atSubmit = fieldNames(PICKS).reduce<FormEditing>(
      (current) => press(current, [next], PICKS),
      initialEditing(PICKS),
    );
    const tail = formLines(PICKS, atSubmit, TEXTS, 2);
    expect(tail[0]!.text).toContain("上面还有");
  });

  it("校验失败那句排在最后（不参与滚动窗口的居中）", () => {
    const lines = formLines(PICKS, { ...initialEditing(PICKS), error: "单选：必填" }, TEXTS);
    expect(lines.at(-1)).toEqual({ text: "单选：必填", error: true });
  });
});
