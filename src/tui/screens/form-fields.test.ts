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
  lineText,
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

const TEXTS = { empty: "（空）", submit: "提交", cancel: "取消" };

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

  it("上下箭头在「字段 + 提交 + 取消」之间环绕：末尾是取消", () => {
    const names = fieldNames(SCHEMA);
    const toSubmit = names.reduce<FormEditing>(
      (current) => press(current, [next]),
      initialEditing(SCHEMA),
    );
    expect(toSubmit.focus).toBe(names.length);

    // 提交之后是取消，再下一格回到第一格
    const toCancel = press(toSubmit, [next]);
    expect(toCancel.focus).toBe(names.length + 1);
    expect(press(toCancel, [next]).focus).toBe(0);
    expect(press(initialEditing(SCHEMA), [prev]).focus).toBe(names.length + 1);
  });

  it("回车按焦点说话：文本跳下一格、枚举展开、动作行才执行", () => {
    const names = fieldNames(SCHEMA);

    // 文本：回车 = 下一格（没有「先进编辑」这一步）
    const afterText = press(initialEditing(SCHEMA), [enter]);
    expect(afterText.mode).toBe("browsing");
    expect(fieldNames(SCHEMA)[afterText.focus]).toBe("body");

    // 枚举：回车 = 展开候选
    expect(press(focusOn("mode"), [enter]).mode).toBe("editing");

    const onSubmit = names.reduce<FormEditing>(
      (current) => press(current, [next]),
      initialEditing(SCHEMA),
    );
    expect(stepOf(onSubmit, enter)).toEqual({ kind: "submit" });
    expect(stepOf(press(onSubmit, [next]), enter)).toEqual({ kind: "cancel" });
  });

  it("浏览层的文本格直接收字（那一格在焦点上就是活的），枚举上敲字什么都不发生", () => {
    const typed = press(initialEditing(SCHEMA), [{ kind: "text", input: "x" }]);
    expect(typed.values.title).toBe("初稿x");

    // 枚举没有「打字」这回事
    const atMode = press(focusOn("mode"), [{ kind: "text", input: "z" }]);
    expect(atMode.values.mode).toBe("self");
  });

  it("Esc：收起时关掉整张表；枚举展开时只收起（值留着）", () => {
    expect(stepOf(initialEditing(SCHEMA), escape)).toEqual({ kind: "cancel" });

    const expanded = press(focusOn("mode"), [enter, next]);
    expect(expanded.values.mode).toBe("no");
    const collapsed = press(expanded, [escape]);
    expect(collapsed.mode).toBe("browsing");
    expect(collapsed.values.mode).toBe("no");
  });
});

describe("表单：编辑层", () => {
  it("文本收字、退格删字；`maxLength` 满了就不再长（不必先进编辑）", () => {
    const atBody = focusOn("body");
    expect(atBody.mode).toBe("browsing");

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
    const typed = press(focusOn("count"), [
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

  it("布尔：浏览层回车与空格都能直接切换（它没有可编辑的第二层）", () => {
    const atFlag = focusOn("flag");
    const on = press(atFlag, [enter]);
    // 还在浏览层：布尔没有第二个状态可进
    expect(on.mode).toBe("browsing");
    expect(on.values.flag).toBe(true);
    expect(press(on, [enter]).values.flag).toBe(false);

    // 空格同义：一个开关要「先进去再按空格」是没道理的
    expect(press(atFlag, [{ kind: "space" }]).values.flag).toBe(true);
    expect(press(atFlag, [{ kind: "space" }, { kind: "space" }]).values.flag).toBe(false);
  });

  it("浏览层的空格只对布尔有意义：别的字段一格都不动", () => {
    const atTitle = initialEditing(SCHEMA);
    const after = press(atTitle, [{ kind: "space" }]);
    expect(after.values.title).toBe("初稿");
    expect(after.mode).toBe("browsing");
  });

  it("只有一个字段的表：打开就进编辑层（先按一次回车才肯收字是白按一下）", () => {
    const single: FormSchemaView = {
      type: "object",
      properties: { name: { type: "string", title: "名字" } },
    };
    expect(initialEditing(single).mode).toBe("editing");

    // 布尔也一样：单项表里回车是交卷，切换归空格
    const onlyBool: FormSchemaView = {
      type: "object",
      properties: { flag: { type: "boolean", title: "开关" } },
    };
    expect(initialEditing(onlyBool).mode).toBe("editing");
  });

  it("枚举展开后回车收起（不提交）：值留着", () => {
    const done = press(editing("mode"), [next, enter]);
    expect(done.mode).toBe("browsing");
    expect(done.values.mode).toBe("no");
    expect(fieldNames(SCHEMA)[done.focus]).toBe("mode");
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
  it("浏览层一格一行：值写显示名；动作在空行之后，各自带方括号", () => {
    const lines = formLines(PICKS, initialEditing(PICKS), TEXTS).map(lineText);

    expect(lines).toEqual([
      // 行首那一格说的是「能不能展开」：`+` 能、`-` 不能（焦点靠颜色，不占字符）
      "+ 单选：甲",
      "+ 多选：（空）",
      "- 备注：（空）",
      // 动作之前那一行是空的：它们是对整张表做的事，与上面那几格不是同一类
      "",
      "[提交]",
      "[取消]",
    ]);
  });

  it("必填字段标签后面跟一个星号（渲染时它是红色的）", () => {
    const required: FormSchemaView = {
      type: "object",
      properties: {
        name: { type: "string", title: "名字" },
        note: { type: "string", title: "备注" },
      },
      required: ["name"],
    };
    const [first, second] = formLines(required, initialEditing(required), TEXTS);

    // 有焦点的那一格是活的：只画光标，不写「（空）」
    expect(lineText(first!)).toBe("- 名字 *：▏");
    expect(first!.star).toBe(true);
    expect(lineText(second!)).toBe("- 备注：（空）");
    expect(second!.star).toBeUndefined();
  });

  it("编辑中的文本格不写「（空）」：那儿只有一个光标", () => {
    const schema: FormSchemaView = {
      type: "object",
      properties: { name: { type: "string", title: "名字" } },
    };
    // 只有一个字段的表打开就是编辑层，光标在那儿
    const lines = formLines(schema, initialEditing(schema), TEXTS).map(lineText);
    expect(lines[0]).toBe("- 名字：▏");
  });

  it("进编辑之后枚举才展开：单选 `(o)`、多选 `[x]`，同一个形状只差一对括号", () => {
    const atMode = editing("mode", PICKS);
    const lines = formLines(PICKS, atMode, TEXTS).map(lineText);

    expect(lines[0]).toBe("+ 单选");
    expect(lines[1]).toBe("     (o) 甲");
    expect(lines[2]).toBe("     ( ) 乙");
    expect(lines[3]).toBe("     ( ) 丙");

    const backToBrowsing = press(atMode, [escape], PICKS);
    const multi = formLines(
      PICKS,
      press(focusOn("tags", backToBrowsing, PICKS), [enter], PICKS),
      TEXTS,
    ).map(lineText);
    expect(multi).toContain("   > [ ] x");
    expect(multi).toContain("     [ ] y");
  });

  it("动作被选中时带标记：提交与取消各一行，颜色由 `tone` 说", () => {
    const atSubmit = fieldNames(PICKS).reduce<FormEditing>(
      (current) => press(current, [next], PICKS),
      initialEditing(PICKS),
    );
    const submitted = formLines(PICKS, atSubmit, TEXTS).slice(-2);
    expect(submitted[0]).toMatchObject({ text: "[提交]", focused: true, tone: "submit" });
    expect(submitted[1]).toMatchObject({ text: "[取消]", focused: false, tone: "cancel" });

    const atCancel = press(atSubmit, [next], PICKS);
    expect(formLines(PICKS, atCancel, TEXTS).at(-1)).toMatchObject({
      text: "[取消]",
      focused: true,
      tone: "cancel",
    });
  });

  it("行数：字段数 + 空行 + 两个动作", () => {
    expect(schemaRows(PICKS)).toBe(fieldNames(PICKS).length + 3);
    expect(formLines(PICKS, initialEditing(PICKS), TEXTS)).toHaveLength(schemaRows(PICKS));
  });

  it("放不下就滚动：窗口跟着焦点走，被截掉的那一头各说一句", () => {
    // 编辑 tags（三个候选）：字段 1 + 候选 3 + 备注 1 + 空行 1 + 动作 2 = 8 行，窗只给 4 行
    const lines = formLines(PICKS, editing("tags", PICKS), TEXTS, 4);

    expect(lines).toHaveLength(4);
    expect(lines.some((line) => lineText(line).includes("多选"))).toBe(true);
    expect(lineText(lines.at(-1)!)).toContain("下面还有");

    // 焦点在最末（取消）：换另一头
    const atCancel = fieldNames(PICKS).reduce<FormEditing>(
      (current) => press(current, [next], PICKS),
      initialEditing(PICKS),
    );
    const tail = formLines(PICKS, press(atCancel, [next], PICKS), TEXTS, 2);
    expect(lineText(tail[0]!)).toContain("上面还有");
  });

  it("校验失败那句排在最后（不参与滚动窗口的居中）", () => {
    const lines = formLines(PICKS, { ...initialEditing(PICKS), error: "单选：必填" }, TEXTS);
    expect(lines.at(-1)).toEqual({ text: "单选：必填", tone: "error" });
  });
});

describe("表单：单项表", () => {
  /** 一道只有三个候选的单选题（交接那道就是这个形状） */
  const ONE_CHOICE: FormSchemaView = {
    type: "object",
    properties: {
      mode: {
        type: "string",
        title: "方式",
        enum: ["self", "summary", "no"],
        enumNames: ["自己", "独立", "不"],
      },
    },
    required: ["mode"],
  };

  it("打开就在编辑层、不画动作行（回车就是交卷）", () => {
    const lines = formLines(ONE_CHOICE, initialEditing(ONE_CHOICE), TEXTS).map(lineText);

    expect(lines).toEqual(["+ 方式 *", "     (o) 自己", "     ( ) 独立", "     ( ) 不"]);
    expect(schemaRows(ONE_CHOICE)).toBe(4);
  });

  it("回车就是提交，Esc 就是关掉（没有浏览层那一跳）", () => {
    const editing = initialEditing(ONE_CHOICE);
    expect(stepOf(editing, enter, ONE_CHOICE)).toEqual({ kind: "submit" });
    expect(stepOf(editing, escape, ONE_CHOICE)).toEqual({ kind: "cancel" });
  });

  it("↑ ↓ 直接换候选（不必先「进格」）", () => {
    const editing = initialEditing(ONE_CHOICE);
    expect(press(editing, [next], ONE_CHOICE).values.mode).toBe("summary");
    expect(press(editing, [prev], ONE_CHOICE).values.mode).toBe("no");
  });

  it("单项是布尔时：回车交卷、空格切换", () => {
    const only: FormSchemaView = {
      type: "object",
      properties: { flag: { type: "boolean", title: "开关" } },
    };
    const editing = initialEditing(only);
    // 回车不再「切过去」—— 单项表里它只有一个意思：交卷
    expect(stepOf(editing, enter, only)).toEqual({ kind: "submit" });
    expect(press(editing, [{ kind: "space" }], only).values.flag).toBe(true);
  });
});
