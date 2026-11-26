/**
 * 表单的编辑状态机 —— 纯函数，不碰 ink。
 *
 * 面板（`overlays.tsx` 的 `FormOverlay`）只做三件事：把按键翻译成 {@link FormKey}、把状态画出来、
 * 把 {@link answerOf} 的结果交回去。所有「按一下该变成什么」的规矩都在这里，于是它们可以单测，
 * 而不用从键盘打到屏幕上去验。
 *
 * ## 值一律先当草稿存
 *
 * 文本与数字都按**字符串**存：用户敲到一半的 `3.` 不是一个合法数字，但它必须能显示出来。真的转
 * 成数字只在提交那一刻（{@link answerOf}）。
 *
 * ## 焦点与「选哪个」是两件事
 *
 * ↑ / ↓ / Tab 换字段；← / → 换枚举里选中的那一项（多选是移动项光标），空格切布尔与多选。
 * 混在一起的话，用户按 ↓ 想换字段、光标却在候选里走，而没有任何一处说得清它为什么这么动。
 */

import type { FormFieldView, FormSchemaView } from "../../session/types.js";

/** 编辑期间的草稿：文本/数字是字符串，布尔是布尔，多选是一组值 */
export type FormValues = Record<string, string | boolean | readonly string[]>;

export interface FormEditing {
  readonly values: FormValues;
  /** 当前焦点落在第几个字段（按 `properties` 的键顺序） */
  readonly focus: number;
  /**
   * 多选那一格内部的项光标（字段名 → 第几项）。
   *
   * 单选枚举不需要它：值本身就是选中的那一项。多选得分开记 —— 选中的是一组，而「空格切哪一项」
   * 得有一个位置。按字段存而不是只存全局一个：来回换字段时位置不该丢。
   */
  readonly cursors: Readonly<Record<string, number>>;
  /** 提交时校验没过的那一句；一改输入就清掉 */
  readonly error?: string;
}

/** 面板认得的按键：把 ink 的 `(input, key)` 收成这几样，剩下的都不算 */
export type FormKey =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "step"; delta: -1 | 1 }
  | { kind: "space" }
  | { kind: "text"; input: string }
  | { kind: "backspace" };

/** 字段名，按表里的顺序（焦点是这一串的下标） */
export function fieldNames(schema: FormSchemaView): string[] {
  return Object.keys(schema.properties);
}

/** 一个字段的显示名：`title` 优先，没有就用字段名 */
export function labelOf(name: string, field: FormFieldView): string {
  return field.title ?? name;
}

/**
 * 初始编辑状态：取表里的 `default`，没有就按类型给一个空草稿。
 *
 * 单选枚举给的是**第一项**：面板上它一开始就是高亮的（与选择器一致），用户按回车就是它 —— 这是
 * 一个界面缺省，不是替用户做决定：改起来只要按一下 ← →。
 */
export function initialEditing(schema: FormSchemaView): FormEditing {
  const values: Record<string, string | boolean | readonly string[]> = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    switch (field.type) {
      case "string":
        values[name] = field.default ?? field.enum?.[0] ?? "";
        break;
      case "number":
      case "integer":
        values[name] = field.default === undefined ? "" : String(field.default);
        break;
      case "boolean":
        values[name] = field.default ?? false;
        break;
      case "array":
        values[name] = field.default ?? [];
        break;
    }
  }
  return { values, focus: 0, cursors: {} };
}

/** 按一下键，得到新的编辑状态 */
export function applyFormKey(
  editing: FormEditing,
  schema: FormSchemaView,
  key: FormKey,
): FormEditing {
  const names = fieldNames(schema);
  if (names.length === 0) return editing;
  const name = names[Math.min(editing.focus, names.length - 1)]!;
  const field = schema.properties[name]!;
  // 改任何一种输入都清掉上一次的错误：那句是「上一版草稿」的结论
  const cleared: FormEditing =
    editing.error === undefined ? editing : { ...editing, error: undefined };

  switch (key.kind) {
    case "next":
      return { ...cleared, focus: (cleared.focus + 1) % names.length };
    case "prev":
      return { ...cleared, focus: (cleared.focus - 1 + names.length) % names.length };
    case "step":
      return step(cleared, name, field, key.delta);
    case "space":
      return toggle(cleared, name, field);
    case "backspace":
      return backspace(cleared, name, field);
    case "text":
      return type(cleared, name, field, key.input);
  }
}

/** ← →：单选枚举换一项，多选移动项光标 */
function step(
  editing: FormEditing,
  name: string,
  field: FormFieldView,
  delta: -1 | 1,
): FormEditing {
  const options = enumValues(field);
  if (options === undefined || options.length === 0) return editing;

  if (field.type === "array") {
    const at = cursorOf(editing, name, field);
    return {
      ...editing,
      cursors: { ...editing.cursors, [name]: (at + delta + options.length) % options.length },
    };
  }

  const current = String(editing.values[name] ?? "");
  const at = Math.max(0, options.indexOf(current));
  const next = options[(at + delta + options.length) % options.length]!;
  return { ...editing, values: { ...editing.values, [name]: next } };
}

/** 多选那一格此刻指到第几项（越界时夹回表内） */
export function cursorOf(editing: FormEditing, name: string, field: FormFieldView): number {
  const options = enumValues(field) ?? [];
  const at = editing.cursors[name] ?? 0;
  return Math.min(Math.max(at, 0), Math.max(options.length - 1, 0));
}

/** 空格：布尔取反；多选把光标那一项加进去或拿出来；其余类型不认 */
function toggle(editing: FormEditing, name: string, field: FormFieldView): FormEditing {
  if (field.type === "boolean") {
    return { ...editing, values: { ...editing.values, [name]: !(editing.values[name] === true) } };
  }
  if (field.type === "array") {
    const options = field.items.enum;
    const target = options[cursorOf(editing, name, field)];
    if (target === undefined) return editing;
    const picked = (editing.values[name] as readonly string[] | undefined) ?? [];
    const next = picked.includes(target)
      ? picked.filter((item) => item !== target)
      : [...picked, target];
    return { ...editing, values: { ...editing.values, [name]: next } };
  }
  return editing;
}

/** 退格：只对草稿是字符串的那两种有意义 */
function backspace(editing: FormEditing, name: string, field: FormFieldView): FormEditing {
  if (field.type !== "string" && field.type !== "number" && field.type !== "integer")
    return editing;
  const current = String(editing.values[name] ?? "");
  return { ...editing, values: { ...editing.values, [name]: current.slice(0, -1) } };
}

/** 敲字：只对草稿是字符串的那两种有意义；数字那两种只收数字与负号小数点 */
function type(
  editing: FormEditing,
  name: string,
  field: FormFieldView,
  input: string,
): FormEditing {
  const isText = field.type === "string";
  const isNumber = field.type === "number" || field.type === "integer";
  if (!isText && !isNumber) return editing;
  if (isNumber && !/^[0-9.\-]+$/.test(input)) return editing;

  const current = String(editing.values[name] ?? "");
  const next = current + input;
  const capped =
    field.type === "string" && field.maxLength !== undefined
      ? next.slice(0, field.maxLength)
      : next;
  return { ...editing, values: { ...editing.values, [name]: capped } };
}

/** 一个字段的候选（单选枚举或多选枚举） */
export function enumValues(field: FormFieldView): readonly string[] | undefined {
  if (field.type === "string") return field.enum;
  if (field.type === "array") return field.items.enum;
  return undefined;
}

/** 一个字段候选的显示名（与 `enum` 一一对应；没给就用值本身） */
export function labelsOf(field: FormFieldView): readonly string[] {
  if (field.type === "string") return field.enumNames ?? field.enum ?? [];
  if (field.type === "array") return field.items.enumNames ?? field.items.enum;
  return [];
}

/** 提交的结果：要么是一份可以直接交出去的答案，要么是「哪一格不对、错在哪」 */
export type SubmitResult =
  { ok: true; content: Record<string, unknown> } | { ok: false; focus: number; reason: string };

/**
 * 把草稿收成一份 `accept` 的内容；不合表就说清是哪一格、为什么。
 *
 * 只校验这张表声明过的事（必填、枚举、类型、长度、范围与那四种 `format`），不引入 JSON Schema
 * 引擎 —— 宿主那一侧还会再验一遍，这里的作用是**别让用户提交一份注定被拒的东西**。
 */
export function answerOf(schema: FormSchemaView, values: FormValues): SubmitResult {
  const names = fieldNames(schema);
  const required = new Set(schema.required ?? []);

  for (const [index, name] of names.entries()) {
    const field = schema.properties[name]!;
    const value = values[name];
    const problem = checkField(field, value, required.has(name));
    if (problem !== undefined)
      return { ok: false, focus: index, reason: `${labelOf(name, field)}：${problem}` };
  }

  const content: Record<string, unknown> = {};
  for (const name of names) {
    const field = schema.properties[name]!;
    const value = values[name];
    if (field.type === "number" || field.type === "integer") {
      // 空串 = 没填：非必填时这一格就不交上去（交一个 `NaN` 只会让宿主那边报错）
      if (value === "") continue;
      content[name] = Number(value);
    } else if (field.type === "array") {
      content[name] = [...((value as readonly string[] | undefined) ?? [])];
    } else if (field.type === "boolean") {
      content[name] = value === true;
    } else {
      content[name] = String(value ?? "");
    }
  }
  return { ok: true, content };
}

/** 一格的检查；没问题回 `undefined`（原因文案在产生处渲染，键由调用方拼） */
function checkField(field: FormFieldView, value: unknown, required: boolean): string | undefined {
  switch (field.type) {
    case "string": {
      const text = typeof value === "string" ? value : "";
      if (required && text.length === 0) return "必填";
      if (!required && text.length === 0) return undefined;
      if (field.minLength !== undefined && text.length < field.minLength) return "太短";
      if (field.maxLength !== undefined && text.length > field.maxLength) return "太长";
      if (field.enum !== undefined && !field.enum.includes(text)) return "不在候选里";
      return formatProblem(field.format, text);
    }
    case "number":
    case "integer": {
      const text = String(value ?? "");
      if (text.length === 0) return required ? "必填" : undefined;
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return "不是数字";
      if (field.type === "integer" && !Number.isInteger(parsed)) return "不是整数";
      if (field.minimum !== undefined && parsed < field.minimum) return "小于下限";
      if (field.maximum !== undefined && parsed > field.maximum) return "大于上限";
      return undefined;
    }
    case "boolean":
      return undefined;
    case "array": {
      const picked = (value as readonly string[] | undefined) ?? [];
      if (required && picked.length === 0) return "必选";
      if (!picked.every((item) => field.items.enum.includes(item))) return "有不在候选里的项";
      if (field.minItems !== undefined && picked.length < field.minItems) return "项数太少";
      if (field.maxItems !== undefined && picked.length > field.maxItems) return "项数太多";
      return undefined;
    }
  }
}

/** 那四种 `format` 的轻量检查：只挡明显不是的东西，不追求 RFC 级严格 */
function formatProblem(
  format: "email" | "uri" | "date" | "date-time" | undefined,
  text: string,
): string | undefined {
  switch (format) {
    case undefined:
      return undefined;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? undefined : "不是邮箱地址";
    case "uri":
      return /^[a-z][a-z0-9+.-]*:\S*$/i.test(text) ? undefined : "不是链接";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? undefined : "不是 YYYY-MM-DD";
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? undefined : "不是 ISO 时刻";
  }
}

// ---------------------------------------------------------------------------
// 画什么：把表和草稿摊成一行行
// ---------------------------------------------------------------------------

/**
 * 面板上的一行。
 *
 * 渲染只看这三格：`text` 是成品（已经是「标记 + 标签 + 值」），`focused` 决定上不上色，
 * `error` 决定那是不是校验失败那一句。样式与折行交给 Ink，这里不碰终端宽度。
 */
export interface FormLine {
  readonly text: string;
  readonly focused?: boolean;
  readonly error?: boolean;
}

/**
 * 一个字段占几行。
 *
 * 文本/数字/布尔各一行；两种枚举是**一列**——标签一行，每个候选各一行（与多选同一个形状，
 * 只是括号用圆括号）。布局按它预留高度，所以它与 {@link formLines} 必须同一套数法。
 */
export function fieldRows(field: FormFieldView): number {
  const options = enumValues(field);
  return options === undefined ? 1 : options.length + 1;
}

/** 整张表占几行（不算校验失败那一句） */
export function schemaRows(schema: FormSchemaView): number {
  return Object.values(schema.properties).reduce((sum, field) => sum + fieldRows(field), 0);
}

/**
 * 把表和草稿摊成一行行。
 *
 * ## 两种枚举都竖着排，只差一对括号
 *
 * 单选 `(o) 名字` / `( ) 别的`，多选 `[x] 名字` / `[ ] 别的` —— 同一个形状，括号不同。横排
 * `◀ … ▶` 那一版在多选上没法表达（多选是集合），两种枚举长得不一样会让人以为它们是两种控件。
 *
 * ## 放不下就滚动
 *
 * 候选一多（十个标签、二十个服务器）整块会顶穿屏幕，所以给 `maxRows` 就只画窗口里那一段：
 * 窗口跟着焦点走，被截掉的头部与尾部各用一句 `…` 说明还有东西 —— 不静默丢行。
 */
export function formLines(
  schema: FormSchemaView,
  editing: FormEditing,
  emptyLabel: string,
  maxRows?: number,
): FormLine[] {
  const lines: FormLine[] = [];
  /** 焦点那一块的第一行在 `lines` 里的下标（滚动要对准它） */
  let focusAt = 0;

  for (const [index, name] of fieldNames(schema).entries()) {
    const field = schema.properties[name]!;
    const focused = index === editing.focus;
    const marker = focused ? "❯" : " ";
    if (focused) focusAt = lines.length;

    const options = enumValues(field);
    if (options === undefined) {
      lines.push({
        text: `${marker} ${labelOf(name, field)}：${valueText(field, editing.values[name], emptyLabel)}${focused && isTextual(field) ? "▏" : ""}`,
        focused,
      });
      continue;
    }

    // 枚举：标签一行，候选各一行（缩进两格对齐在标记后面）
    lines.push({ text: `${marker} ${labelOf(name, field)}`, focused });
    const labels = labelsOf(field);
    const picked =
      field.type === "array" ? ((editing.values[name] as readonly string[] | undefined) ?? []) : [];
    const cursor = cursorOf(editing, name, field);
    for (const [at, option] of options.entries()) {
      const mark =
        field.type === "array"
          ? picked.includes(option)
            ? "[x]"
            : "[ ]"
          : String(editing.values[name] ?? "") === option
            ? "(o)"
            : "( )";
      // 多选要一个项光标（空格切哪一项）；单选不需要，选中的那个就是光标
      const pointer = focused && field.type === "array" && at === cursor ? "❯" : " ";
      lines.push({ text: `   ${pointer} ${mark} ${labels[at] ?? option}`, focused });
    }
  }

  if (editing.error !== undefined) lines.push({ text: editing.error, error: true });
  return clip(lines, focusAt, maxRows);
}

/** 文本/数字那种「正在输入」的游标只画在有焦点的那一格上 */
function isTextual(field: FormFieldView): boolean {
  return field.type === "string" || field.type === "number" || field.type === "integer";
}

/** 一格里现在的值长什么样（枚举走各自的括号，这里只处理一行的那些） */
function valueText(field: FormFieldView, value: unknown, emptyLabel: string): string {
  if (field.type === "boolean") return value === true ? "[x]" : "[ ]";
  const text = String(value ?? "");
  return text.length === 0 ? emptyLabel : text;
}

/** 只留窗口里那一段，头尾被截掉就各放一句 `…` */
function clip(lines: FormLine[], focusAt: number, maxRows: number | undefined): FormLine[] {
  if (maxRows === undefined || lines.length <= maxRows || maxRows <= 0) return lines;

  // 焦点那一块尽量居中，再夹回两端
  const half = Math.floor((maxRows - 1) / 2);
  const start = Math.min(Math.max(0, focusAt - half), lines.length - maxRows);
  const slice = lines.slice(start, start + maxRows);
  if (start > 0) slice[0] = { text: `   …（上面还有 ${start} 行）` };
  const below = lines.length - (start + maxRows);
  if (below > 0) slice[slice.length - 1] = { text: `   …（下面还有 ${below} 行）` };
  return slice;
}
