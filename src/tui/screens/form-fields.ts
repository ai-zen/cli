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
 * ## 两级：先选一项，再编辑那一项
 *
 * 打开时是**浏览**：↑ / ↓ 在「各个字段 + 最后那个提交项」之间走，回车落到某一项上。
 *
 *   · 落在字段上 → 进**编辑**（`mode: "editing"`）：文本/数字敲字、布尔与多选按空格切、
 *     单选与多选↑ / ↓（← / → 也行）换候选 —— 这一层里的上下箭头动的是候选，不是字段；
 *   · 落在提交上 → 校验并交出内容。
 *
 * 编辑里按回车或 Esc 都退回浏览（值留着）：回车不提交，是因为提交是一件要说清的事
 * （表单末尾那一项），误按回车把一份半成品交出去比多按一下坏得多。
 */

import type { FormFieldView, FormSchemaView } from "../../session/types.js";

/** 编辑期间的草稿：文本/数字是字符串，布尔是布尔，多选是一组值 */
export type FormValues = Record<string, string | boolean | readonly string[]>;

/** 面板现在在哪一层 */
export type FormMode = "browsing" | "editing";

export interface FormEditing {
  readonly values: FormValues;
  /** 浏览器层在「各个字段 + 提交项」之间走，编辑层停留在某一个字段上 */
  readonly mode: FormMode;
  /**
   * 当前焦点落在第几个**项**上（`properties` 的键顺序，最后一项是提交）。
   *
   * 提交项的下标是 `fieldNames(schema).length` —— 它与字段共用这一个下标，于是上下箭头
   * 只需要管一条线。
   */
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
  | { kind: "backspace" }
  | { kind: "enter" }
  | { kind: "escape" };

/**
 * 按一下之后发生在**面板**上的三种事。
 *
 * 为什么不让状态机自己提交：提交要把 `values` 交给 `answerOf`，而校验失败的结果又要回到面板上
 * （焦点跳到那一格、说一句为什么）。于是状态机只说「该交卷了」，由面板去算、再决定回哪一层。
 */
export type FormStep =
  { kind: "state"; editing: FormEditing } | { kind: "submit" } | { kind: "cancel" };

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
  // 只有一个字段的表直接站在编辑层：整张表就这一格，让人先按一次回车才肯收字是白按一下。
  // 布尔也一样 —— 单项表里回车是「交卷」，切换归空格（见 `applyFormKey`）。
  const single = fieldNames(schema).length === 1;
  return { values, mode: single ? "editing" : "browsing", focus: 0, cursors: {} };
}

/** 按一下键，得到新的编辑状态 */
export function applyFormKey(editing: FormEditing, schema: FormSchemaView, key: FormKey): FormStep {
  const names = fieldNames(schema);
  // 两个动作与字段共用那条焦点线：提交的下标是字段个数，取消紧随其后
  const submitAt = names.length;
  const cancelAt = submitAt + 1;
  // 改任何一种输入都清掉上一次的错误：那句是「上一版草稿」的结论
  const cleared: FormEditing =
    editing.error === undefined ? editing : { ...editing, error: undefined };

  const slots = cancelAt + 1;
  const move = (delta: 1 | -1): FormStep => ({
    kind: "state",
    editing: { ...cleared, focus: (cleared.focus + delta + slots) % slots },
  });

  if (fieldNames(schema).length === 1) {
    // 单项表没有「浏览层」这一层：动作按钮也不画，于是回车与 Esc 各归各的去处。
    // 列在这里先判，是因为下面那套「两格动作 + 环绕」在单项表上全都不成立。
    const name = names[0]!;
    const field = schema.properties[name]!;
    switch (key.kind) {
      case "enter":
        return { kind: "submit" };
      case "escape":
        return { kind: "cancel" };
      case "space":
        return { kind: "state", editing: toggle(cleared, name, field) };
      case "next":
      case "prev":
        // 候选只有一个字段可走：↑ ↓ 就在这里换候选（不必先进哪一层）
        return {
          kind: "state",
          editing: advance(cleared, name, field, key.kind === "next" ? 1 : -1),
        };
      case "step":
        return { kind: "state", editing: step(cleared, name, field, key.delta) };
      case "backspace":
        return { kind: "state", editing: backspace(cleared, name, field) };
      case "text":
        return { kind: "state", editing: type(cleared, name, field, key.input) };
    }
  }

  if (key.kind === "escape") {
    // 编辑里退一层（值留着）；浏览里就是关掉整张表
    return cleared.mode === "editing"
      ? { kind: "state", editing: { ...cleared, mode: "browsing" } }
      : { kind: "cancel" };
  }

  if (cleared.mode === "browsing") {
    switch (key.kind) {
      case "next":
        return move(1);
      case "prev":
        return move(-1);
      case "enter": {
        // 两个动作各有去处
        if (cleared.focus === submitAt) return { kind: "submit" };
        if (cleared.focus === cancelAt) return { kind: "cancel" };

        // 布尔没有可编辑的东西：它的「进这一格」就是按一下切过去，切完还留在浏览层
        const field = schema.properties[names[cleared.focus]!];
        if (field !== undefined && field.type === "boolean") {
          return { kind: "state", editing: toggle(cleared, names[cleared.focus]!, field) };
        }
        return { kind: "state", editing: { ...cleared, mode: "editing" } };
      }
      default:
        // 浏览层不认字：字要在编辑层里敲（否则「按着说话」会顺手改掉某一格）
        return { kind: "state", editing: cleared };
    }
  }

  // ---- 编辑层：焦点一定落在某个字段上 ----
  if (names.length === 0) return { kind: "state", editing: { ...cleared, mode: "browsing" } };
  const name = names[Math.min(cleared.focus, names.length - 1)]!;
  const field = schema.properties[name]!;

  switch (key.kind) {
    case "enter":
      return { kind: "state", editing: { ...cleared, mode: "browsing" } };
    case "next":
      // 编辑枚举时上下箭头动的是候选（用户在这里按 ↓ 想知道的是「下一项是什么」）
      return { kind: "state", editing: advance(cleared, name, field, 1) };
    case "prev":
      return { kind: "state", editing: advance(cleared, name, field, -1) };
    case "step":
      return { kind: "state", editing: step(cleared, name, field, key.delta) };
    case "space":
      return { kind: "state", editing: toggle(cleared, name, field) };
    case "backspace":
      return { kind: "state", editing: backspace(cleared, name, field) };
    case "text":
      return { kind: "state", editing: type(cleared, name, field, key.input) };
  }
}

/**
 * 编辑层里的 ↑ / ↓：枚举上就是「上一个 / 下一个候选」。
 *
 * 单选换的是**值**；多选换的是**项光标**（要不要勾由空格说）。文本/数字/布尔没有候选可换 ——
 * 那三种在编辑层里上下箭头什么都不做：把「↓」解释成「离开这一格」会让正在打字的人莫名其妙
 * 地跳出输入。
 */
function advance(
  editing: FormEditing,
  name: string,
  field: FormFieldView,
  delta: -1 | 1,
): FormEditing {
  return enumValues(field) === undefined ? editing : step(editing, name, field, delta);
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
  /** 星号之前那一段（通常是 `标记 + 标签`）；动作行是 `[提交]` 这种整块 */
  readonly text: string;
  /** 必填标记：这一行在 `text` 后面跟一个红色的 `*` */
  readonly star?: boolean;
  /** 星号之后那一段（`：值`）；必填与非必填都要拼上它 */
  readonly rest?: string;
  readonly focused?: boolean;
  /** 动作行与错误行的固定颜色（焦点只改标记，不改颜色） */
  readonly tone?: "submit" | "cancel" | "error";
}

/** 一行拍平之后的文字（用例与日志读它；上色是渲染那一层的事） */
export function lineText(line: FormLine): string {
  return `${line.text}${line.star === true ? " *" : ""}${line.rest ?? ""}`;
}

/**
 * 一个字段占几行（**浏览层**：一行）。
 *
 * 只有进编辑、而且那一个是枚举时才会展开成「标签 + 每个候选一行」。布局按浏览层预留 ——
 * 展开多出来的那几行由覆盖层自己滚动（见 {@link formLines} 的 `maxRows`）。
 */
export function fieldRows(): number {
  return 1;
}

/**
 * 整张表占几行。
 *
 * 多项表：每个字段一行 + 空行 + 提交 + 取消。
 * 单项表：只有那一格（枚举连候选一起算）—— 它没有动作行，回车就是交卷。
 */
export function schemaRows(schema: FormSchemaView): number {
  const names = fieldNames(schema);
  if (names.length === 1) {
    const field = schema.properties[names[0]!]!;
    return 1 + (enumValues(field)?.length ?? 0);
  }
  return names.length + ACTION_ROWS + 1;
}

/** 动作行的个数（提交、取消），以及它们前面的那一空行 */
const ACTION_ROWS = 2;

/** 面板上要印的两句话（文案由调用方给：`formLines` 是纯函数，不碰 i18n） */
export interface FormTexts {
  /** 空值的写法，例如「（空）」 */
  readonly empty: string;
  /** 提交那个动作的显示名（渲染成 `[提交]`） */
  readonly submit: string;
  /** 取消那个动作的显示名（渲染成 `[取消]`） */
  readonly cancel: string;
}

/**
 * 把表和草稿摊成一行行。
 *
 * ## 两层长得不一样
 *
 * 浏览层一格一行，右边直接写出当前值（`单选：第一项` / `多选：甲、乙`）—— 一眼能扫完；
 * 进了编辑、而且那格是枚举时，才在它下面列一列候选：单选 `(o) 名字`，多选 `[x] 名字`。
 * 两种枚举同一个形状，只差一对括号。
 *
 * 最后一律是**提交项**：回车落在它上面才交卷。它和字段共用同一条焦点线（下标 = 字段个数）。
 *
 * ## 放不下就滚动
 *
 * 编辑一个候选很多的枚举时整块会顶穿屏幕，所以给 `maxRows` 就只画窗口里那一段：窗口跟着焦点
 * 走，被截掉的头部与尾部各用一句 `…` 说明还有东西 —— 不静默丢行。
 */
export function formLines(
  schema: FormSchemaView,
  editing: FormEditing,
  texts: FormTexts,
  maxRows?: number,
): FormLine[] {
  const names = fieldNames(schema);
  const submitAt = names.length;
  const lines: FormLine[] = [];
  /** 焦点那一块的第一行在 `lines` 里的下标（滚动要对准它） */
  let focusAt = 0;

  for (const [index, name] of names.entries()) {
    const field = schema.properties[name]!;
    const isFocus = index === editing.focus;
    const inEditing = isFocus && editing.mode === "editing";
    if (isFocus) focusAt = lines.length;
    // 编辑层用 `▸`：与浏览层的 `❯` 分开，一眼看得出「按了回车之后我在哪一层」
    const marker = isFocus ? (inEditing ? "▸" : "❯") : " ";
    const label = labelOf(name, field);
    const options = enumValues(field);

    // 只有必填才带这一格（`undefined` 而不是 `false`：渲染那边只判有没有）
    const star = (schema.required ?? []).includes(name) || undefined;

    if (options === undefined || !inEditing) {
      // 编辑中的文本/数字**不写「（空）」**：那儿只有一个光标，写「空」是把「没有值」当成值
      const shown =
        inEditing && isTextual(field)
          ? String(editing.values[name] ?? "")
          : browsingValue(field, editing.values[name], texts.empty);
      const caret = inEditing && isTextual(field) ? "▏" : "";
      lines.push({
        text: `${marker} ${label}`,
        star,
        rest: `：${shown}${caret}`,
        focused: isFocus,
      });
      continue;
    }

    // 编辑中的枚举：标签一行，候选各一行（缩进两个空格，对齐在标记后面）
    lines.push({ text: `${marker} ${label}`, star, focused: true });
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
      const pointer = field.type === "array" && at === cursor ? "❯" : " ";
      lines.push({ text: `   ${pointer} ${mark} ${labels[at] ?? option}`, focused: true });
    }
  }

  // 单项表不画动作：回车就是交卷、Esc 就是关掉，画两个按不到的按钮只是噪声
  if (names.length === 1) {
    if (editing.error !== undefined) lines.push({ text: editing.error, tone: "error" });
    return clip(lines, focusAt, maxRows);
  }

  // 动作之前空一行：它们是「对整张表做的事」，与上面那几格不是同一类
  lines.push({ text: "" });

  const actions = [texts.submit, texts.cancel] as const;
  for (const [offset, label] of actions.entries()) {
    const index = submitAt + offset;
    const isFocus = editing.mode === "browsing" && editing.focus === index;
    if (isFocus) focusAt = lines.length;
    lines.push({
      text: `${isFocus ? "❯" : " "} [${label}]`,
      focused: isFocus,
      tone: offset === 0 ? "submit" : "cancel",
    });
  }

  if (editing.error !== undefined) lines.push({ text: editing.error, tone: "error" });
  return clip(lines, focusAt, maxRows);
}

/** 文本/数字那种「正在输入」的游标只画在编辑中的那一格上 */
function isTextual(field: FormFieldView): boolean {
  return field.type === "string" || field.type === "number" || field.type === "integer";
}

/** 浏览层里一格的值怎么写：枚举写显示名，其余按原样 */
function browsingValue(field: FormFieldView, value: unknown, emptyLabel: string): string {
  if (field.type === "boolean") return value === true ? "[x]" : "[ ]";

  const options = enumValues(field);
  if (options !== undefined) {
    const labels = labelsOf(field);
    if (field.type === "array") {
      const picked = (value as readonly string[] | undefined) ?? [];
      if (picked.length === 0) return emptyLabel;
      return picked.map((item) => labels[options.indexOf(item)] ?? item).join("、");
    }
    const at = options.indexOf(String(value ?? ""));
    return at < 0 ? emptyLabel : (labels[at] ?? options[at]!);
  }

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
