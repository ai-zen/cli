/**
 * 表单的编辑状态机（纯函数）。
 *
 * 这一组钉住的是「按一下该变成什么」：焦点怎么走、枚举怎么换、多选怎么勾、草稿怎么改，以及提交
 * 那一刻的校验与类型转换。面板（`overlays.tsx`）只把这些搬上屏 —— 所以这些规矩能在这里一条条验，
 * 不必从键盘打到屏幕上去。
 */
import { describe, expect, it } from "vitest";

import type { FormSchemaView } from "../../session/types.js";
import {
  answerOf,
  applyFormKey,
  cursorOf,
  fieldNames,
  fieldRows,
  formLines,
  initialEditing,
  schemaRows,
  type FormEditing,
  type FormKey,
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

const press = (editing: FormEditing, ...keys: FormKey[]): FormEditing =>
  keys.reduce((current, key) => applyFormKey(current, SCHEMA, key), editing);

/** 把焦点挪到某个字段上（按 `next` 一格一格走 —— 数下标太容易数错一格） */
const focusOn = (
  name: string,
  editing = initialEditing(SCHEMA),
  schema: FormSchemaView = SCHEMA,
): FormEditing => {
  let current = editing;
  for (let step = 0; step < fieldNames(schema).length; step += 1) {
    if (fieldNames(schema)[current.focus] === name) return current;
    current = applyFormKey(current, schema, { kind: "next" });
  }
  throw new Error(`表里没有字段 ${name}`);
};

describe("表单：初值与焦点", () => {
  it("取表里的 default；单选枚举从第一项开始（面板上它就是高亮的）", () => {
    const editing = initialEditing(SCHEMA);

    expect(editing.values.title).toBe("初稿");
    expect(editing.values.body).toBe("");
    expect(editing.values.count).toBe("");
    expect(editing.values.flag).toBe(false);
    expect(editing.values.mode).toBe("self");
    expect(editing.values.tags).toEqual([]);
    expect(editing.focus).toBe(0);
  });

  it("字段顺序就是表里 `properties` 的顺序；焦点在两个方向环绕", () => {
    const names = fieldNames(SCHEMA);
    expect(names[0]).toBe("title");

    const last = press(initialEditing(SCHEMA), { kind: "prev" });
    expect(names[last.focus]).toBe(names.at(-1));

    const wrapped = press(last, { kind: "next" });
    expect(wrapped.focus).toBe(0);
  });
});

describe("表单：改值", () => {
  it("文本收字、退格删字；`maxLength` 满了就不再长", () => {
    const atBody = focusOn("body");
    expect(fieldNames(SCHEMA)[atBody.focus]).toBe("body");

    const typed = press(
      atBody,
      { kind: "text", input: "a" },
      { kind: "text", input: "b" },
      { kind: "backspace" },
      { kind: "text", input: "x" },
    );
    expect(typed.values.body).toBe("ax");

    // maxLength = 5：再敲就顶住了
    const long = press(
      atBody,
      ...Array.from({ length: 8 }, () => ({ kind: "text", input: "z" }) as FormKey),
    );
    expect(String(long.values.body)).toHaveLength(5);
  });

  it("数字那两格只收数字、负号与小数点（字母敲不进去）", () => {
    const atCount = focusOn("count");
    expect(fieldNames(SCHEMA)[atCount.focus]).toBe("count");

    const typed = press(
      atCount,
      { kind: "text", input: "1" },
      { kind: "text", input: "a" },
      { kind: "text", input: "." },
      { kind: "text", input: "5" },
    );
    expect(typed.values.count).toBe("1.5");
  });

  it("单选枚举 ← / → 换一项，环绕", () => {
    const atMode = focusOn("mode");
    expect(fieldNames(SCHEMA)[atMode.focus]).toBe("mode");

    expect(press(atMode, { kind: "step", delta: 1 }).values.mode).toBe("no");
    expect(press(atMode, { kind: "step", delta: -1 }).values.mode).toBe("no");
  });

  it("布尔空格取反；多选 ← → 移项光标、空格勾选／取消，项光标按字段各自记", () => {
    const atFlag = focusOn("flag");
    expect(fieldNames(SCHEMA)[atFlag.focus]).toBe("flag");
    expect(press(atFlag, { kind: "space" }).values.flag).toBe(true);

    // 多选在 mode 后面一格：从 flag 走两格（中间隔着单选 mode）
    const atTags = press(atFlag, { kind: "next" }, { kind: "next" });
    expect(fieldNames(SCHEMA)[atTags.focus]).toBe("tags");

    const second = press(atTags, { kind: "step", delta: 1 });
    expect(cursorOf(second, "tags", SCHEMA.properties.tags!)).toBe(1);

    const picked = press(second, { kind: "space" });
    expect(picked.values.tags).toEqual(["b"]);

    // 再按一次取消勾选
    expect(press(picked, { kind: "space" }).values.tags).toEqual([]);
  });

  it("改一下输入就清掉上一次的错误（那句属于上一版草稿）", () => {
    const failed: FormEditing = { ...initialEditing(SCHEMA), error: "正文：太长" };
    expect(press(failed, { kind: "text", input: "a" }).error).toBeUndefined();
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

  it("必填没填、数字不像数字、整数带了小数、超出范围、太长、多选超项数：各回一格并指出是哪一格", () => {
    const submit = (values: Record<string, string | boolean | readonly string[]>) =>
      answerOf(SCHEMA, { ...initialEditing(SCHEMA).values, ...values });

    const missing = submit({ mode: "" });
    expect(missing).toMatchObject({ ok: false, focus: fieldNames(SCHEMA).indexOf("mode") });

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
    const schema: FormSchemaView = {
      type: "object",
      properties: { note: { type: "string" } },
    };
    const result = answerOf(schema, { note: "" });
    expect(result).toEqual({ ok: true, content: { note: "" } });
  });
});

// ---------------------------------------------------------------------------
// 画什么（`fieldRows` / `formLines`）
// ---------------------------------------------------------------------------

/** 单一枚举 + 多选枚举，两者都三个候选：用来验「同一个形状，只差一对括号」 */
const PICKS: FormSchemaView = {
  type: "object",
  properties: {
    mode: { type: "string", title: "单选", enum: ["a", "b", "c"], enumNames: ["甲", "乙", "丙"] },
    tags: { type: "array", title: "多选", items: { type: "string", enum: ["x", "y", "z"] } },
    note: { type: "string", title: "备注" },
  },
};

describe("表单：摊成一行行", () => {
  it("两种枚举都竖着列：单选 `(o)`、多选 `[x]`，其余一行", () => {
    const editing = focusOn("mode", initialEditing(PICKS), PICKS);
    const lines = formLines(PICKS, editing, "（空）").map((line) => line.text);

    // 单选：标签一行 + 三个候选各一行；选中的是第一项
    expect(lines[0]).toBe("❯ 单选");
    // 三个空格缩进 + 一个项光标位（单选没有项光标，留空）+ 括号
    expect(lines[1]).toBe("     (o) 甲");
    expect(lines[2]).toBe("     ( ) 乙");

    // 多选：同一个形状，括号换成方括号（没勾任何一项）
    expect(lines).toContain("     [ ] x");
    expect(lines).toContain("     [ ] y");
  });

  it("多选聚焦时项光标在某一项上（空格切它）", () => {
    let editing = focusOn("tags", initialEditing(PICKS), PICKS);
    editing = applyFormKey(editing, PICKS, { kind: "step", delta: 1 });
    editing = applyFormKey(editing, PICKS, { kind: "space" });

    const lines = formLines(PICKS, editing, "（空）").map((line) => line.text);
    // 光标落在第二项，并且它被勾上了
    expect(lines).toContain("   ❯ [x] y");
    expect(lines).toContain("     [ ] x");
  });

  it("一行一个字段的那几种：布尔用方括号、空文本写「（空）」、焦点格带游标", () => {
    const editing = focusOn("note", initialEditing(PICKS), PICKS);
    const lines = formLines(PICKS, editing, "（空）").map((line) => line.text);
    expect(lines).toContain("❯ 备注：（空）▏");
  });

  it("行数：文本/数字/布尔各一行，枚举是「标签 + 每个候选一行」", () => {
    expect(fieldRows(PICKS.properties.mode!)).toBe(4);
    expect(fieldRows(PICKS.properties.note!)).toBe(1);
    expect(schemaRows(PICKS)).toBe(4 + 4 + 1);
  });

  it("放不下就滚动：窗口跟着焦点走，被截掉的头尾各说一句", () => {
    const editing = focusOn("tags", initialEditing(PICKS), PICKS);
    const lines = formLines(PICKS, editing, "（空）", 4);

    expect(lines).toHaveLength(4);
    // 焦点那一块在窗口里（滚动是对准它的）
    expect(lines.some((line) => line.text.includes("多选"))).toBe(true);
    // 两头都被截掉了就各说一句，不静默丢行
    expect(lines[0]!.text).toContain("上面还有");
    expect(lines.at(-1)!.text).toContain("下面还有");
  });

  it("校验失败那句排在最后（不参与滚动窗口的居中）", () => {
    const editing = { ...initialEditing(PICKS), error: "单选：必填" };
    const lines = formLines(PICKS, editing, "（空）");
    const last = lines.at(-1)!;
    expect(last).toEqual({ text: "单选：必填", error: true });
  });
});
