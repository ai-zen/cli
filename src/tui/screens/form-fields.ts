/**
 * 表单的编辑状态机 —— 纯函数，不碰 ink。
 *
 * 面板（`overlays.tsx` 的 `FormOverlay`）只做三件事：把按键翻译成 {@link FormKey}、把状态画出来、
 * 把 {@link answerOf} 的结果交回去。所有「按一下该变成什么」的规矩都在这里，于是它们可以单测，
 * 而不用从键盘打到屏幕上去验。
 *
 * ## 值先按草稿存
 *
 * 文本与数字都按**字符串**存：用户敲到一半的 `3.` 不是一个合法数字，但它要能显示出来。真的转
 * 成数字只在提交那一刻（{@link answerOf}）。
 *
 * ## 焦点在哪一格，那一格就是「活的」
 *
 * 不再让用户为「文本」多按一次回车 —— 一个只能打字的格子，先按回车才肯收字是纯多余的一步：
 *
 * | 焦点 | 直接能做 | 回车 | 空格 |
 * |---|---|---|---|
 * | 文本 / 数字 | 敲字、退格（光标就在那儿） | 下一格 | — |
 * | 布尔 | — | 切换 | 切换 |
 * | 单选 / 多选（收起） | — | **展开**候选 | — |
 * | 单选 / 多选（展开后） | ↑↓（←→）换候选，多选空格勾 | 收起 | 勾（仅多选） |
 * | `[同意]` / `[拒绝]` / `[取消]` | — | 执行 | — |
 *
 * 于是 `mode: "editing"` 只剩一个含义：**这一格的候选展开了**。文本与布尔永远不进去。
 *
 * 动作那三个按钮指的是**谁做的决定**（MCP elicitation 的三态）：`[同意]` 是带内容交卷、
 * `[拒绝]` 是明确说不、`[取消]` 是没做决定（Esc 同义）。一条表一种形状 —— 没有「只有一个
 * 字段时另走一条路」那种特例：整张表就一格也一样要走到按钮上才交卷。
 *
 * 回车永远安全：在文本上是「下一格」、在枚举上是「展开」、在布尔上是切换 —— 只有落在动作按钮
 * 上才交卷。提交是一件要说清的事，误按回车把半成品交出去比多按一下坏得多。
 */

import type { FormFieldView, FormSchemaView } from "../../session/types.js";

/** 编辑期间的草稿：文本/数字是字符串，布尔是布尔，多选是一组值 */
export type FormValues = Record<string, string | boolean | readonly string[]>;

/** 面板现在在哪一层 */
export type FormMode = "browsing" | "editing";

export interface FormEditing {
  readonly values: FormValues;
  /** 浏览层在「各个字段 + 三个动作」之间走，编辑层停留在某一个字段上 */
  readonly mode: FormMode;
  /**
   * 当前焦点落在第几个**项**上（`properties` 的键顺序，最后一项是提交）。
   *
   * 动作项的下标从 `fieldNames(schema).length` 起（同意、拒绝、取消各占一格）—— 它们与字段
   * 共用这一个下标，于是上下箭头只需要管一条线。
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
  | { kind: "state"; editing: FormEditing }
  | { kind: "accept" }
  | { kind: "decline" }
  | { kind: "cancel" };

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
  // 初始状态落在浏览层、第一格 —— 一张表只有一种形状，字段几个都一样
  return { values, mode: "browsing", focus: 0, cursors: {} };
}

/** 按一下键，得到新的编辑状态 */
export function applyFormKey(editing: FormEditing, schema: FormSchemaView, key: FormKey): FormStep {
  const names = fieldNames(schema);
  // 三个动作与字段共用那条焦点线：accept 的下标是字段个数，拒绝、取消紧随其后
  const acceptAt = names.length;
  const declineAt = acceptAt + 1;
  const cancelAt = declineAt + 1;
  // 改任何一种输入都清掉上一次的错误：那句是「上一版草稿」的结论
  const cleared: FormEditing =
    editing.error === undefined ? editing : { ...editing, error: undefined };

  const slots = cancelAt + 1;
  const move = (delta: 1 | -1): FormStep => ({
    kind: "state",
    editing: { ...cleared, focus: (cleared.focus + delta + slots) % slots },
  });

  if (key.kind === "escape") {
    // 编辑里退一层（值留着）；浏览里就是关掉整张表
    return cleared.mode === "editing"
      ? { kind: "state", editing: { ...cleared, mode: "browsing" } }
      : { kind: "cancel" };
  }

  if (cleared.mode === "browsing") {
    const focusedField =
      cleared.focus < names.length ? schema.properties[names[cleared.focus]!] : undefined;
    const focusedName = cleared.focus < names.length ? names[cleared.focus]! : undefined;

    switch (key.kind) {
      case "next":
        return move(1);
      case "prev":
        return move(-1);
      // 文本/数字在浏览层就能直接改：光标就在那一格上，没有「先进编辑」这一步。
      // 枚举是字符串但**不收字** —— 它的值只能从候选里选（`enumValues` 有值就不算能打字）
      case "text":
        if (!typing(focusedField)) return { kind: "state", editing: cleared };
        return { kind: "state", editing: type(cleared, focusedName!, focusedField!, key.input) };
      case "backspace":
        if (!typing(focusedField)) return { kind: "state", editing: cleared };
        return {
          kind: "state",
          editing: backspace(cleared, focusedName!, focusedField!),
        };
      case "enter": {
        // 三个动作各有去处
        if (cleared.focus === acceptAt) return { kind: "accept" };
        if (cleared.focus === declineAt) return { kind: "decline" };
        if (cleared.focus === cancelAt) return { kind: "cancel" };

        if (focusedField === undefined || focusedName === undefined) {
          return { kind: "state", editing: cleared };
        }
        // 布尔没有第二层：回车就是切过去
        if (focusedField.type === "boolean") {
          return { kind: "state", editing: toggle(cleared, focusedName, focusedField) };
        }
        // 文本/数字没有候选可展开：回车当「下一格」（Tab / ↓ 同义）
        if (enumValues(focusedField) === undefined) return move(1);
        // 枚举：这才是「进编辑」—— 候选展开
        return { kind: "state", editing: { ...cleared, mode: "editing" } };
      }
      case "space": {
        // 布尔在浏览层也能直接切（空格与回车同义）：一个开关要「先进去再按空格」是没道理的。
        // 其余类型空格什么都不做 —— 文本里打空格是编辑层里的事
        const field = schema.properties[names[cleared.focus]!];
        if (field === undefined || field.type !== "boolean") {
          return { kind: "state", editing: cleared };
        }
        return { kind: "state", editing: toggle(cleared, names[cleared.focus]!, field) };
      }
      default:
        // 浏览层不处理字符输入：字符只在编辑层里敲（否则浏览时敲的字会写进某一格）
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
  /** 星号之前那一段（通常是 `标记 + 标签`）；动作行是整块（选中的带方括号，其余用空格占位） */
  readonly text: string;
  /** 必填标记：这一行在 `text` 后面跟一个红色的 `*` */
  readonly star?: boolean;
  /** 星号之后那一段（`：值`）；必填与非必填都要拼上它 */
  readonly rest?: string;
  readonly focused?: boolean;
  /** 动作行与错误行的固定颜色（焦点只改标记，不改颜色） */
  readonly tone?: "accept" | "decline" | "cancel" | "error";
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
 * 每个字段一行 + 空行 + 三个动作（同意/拒绝/取消）。只有枚举展开时会多出候选，那部分由覆盖层
 * 自己滚动（见 {@link formLines} 的 `maxRows`）。
 */
export function schemaRows(schema: FormSchemaView): number {
  return fieldNames(schema).length + ACTION_ROWS + 1;
}

/** 动作行的个数（同意、拒绝、取消），以及它们前面的那一空行 */
const ACTION_ROWS = 3;

/** 面板上要印的那几句话（文案由调用方给：`formLines` 是纯函数，不碰 i18n） */
export interface FormTexts {
  /** 空值的写法，例如「（空）」 */
  readonly empty: string;
  /** 带内容交卷那个动作（渲染成 `[同意]`） */
  readonly accept: string;
  /** 明确拒绝那个动作（渲染成 `[拒绝]`） */
  readonly decline: string;
  /** 没做决定、关掉那个动作（渲染成 `[取消]`） */
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
 * 最后是三个动作：**同意**、**拒绝**、**取消**。它们和字段共用同一条焦点线（下标从字段个数起）；
 * 方括号只画在焦点那一格上，其余用空格占同样的位 —— 选中与没选中占一样宽，换焦点时整行不跳。
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
  const acceptAt = names.length;
  const lines: FormLine[] = [];
  /** 焦点那一块的第一行在 `lines` 里的下标（滚动要对准它） */
  let focusAt = 0;

  for (const [index, name] of names.entries()) {
    const field = schema.properties[name]!;
    const isFocus = index === editing.focus;
    const inEditing = isFocus && editing.mode === "editing";
    if (isFocus) focusAt = lines.length;
    // 行首只有一格：**这一格能不能展开**（`+` 能、`-` 不能）。
    //
    // 焦点不再占一个字符（原来那个右尖括号去掉了）：焦点靠颜色与加粗说，位置靠这一格的标记说。
    // 用户看到 `- 文本` 就知道那一格没有第二层可进，看到 `+ 单选` 就知道可以按回车展开。
    const marker = enumValues(field) === undefined ? "-" : "+";
    const label = labelOf(name, field);
    const options = enumValues(field);

    // 只有必填才带这一格（`undefined` 而不是 `false`：渲染那边只判有没有）
    const star = (schema.required ?? []).includes(name) || undefined;

    if (options === undefined || !inEditing) {
      // 活着的文本格（在焦点上、而且能打字）不写「（空）」：那儿只有一个光标，
      // 把「没有值」写成空是把「空」当成一个值
      const live = isFocus && isTextual(field);
      const shown = live
        ? String(editing.values[name] ?? "")
        : browsingValue(field, editing.values[name], texts.empty);
      const caret = live ? "▏" : "";
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
      // 多选要一个项光标（空格切哪一项）；单选不需要，`(o)` 就是它
      const pointer = field.type === "array" && at === cursor ? ">" : " ";
      lines.push({ text: `   ${pointer} ${mark} ${labels[at] ?? option}`, focused: true });
    }
  }

  // 动作之前空一行：它们是「对整张表做的事」，与上面那几格不是同一类
  lines.push({ text: "" });

  const actions = [texts.accept, texts.decline, texts.cancel] as const;
  for (const [offset, label] of actions.entries()) {
    const index = acceptAt + offset;
    const isFocus = editing.mode === "browsing" && editing.focus === index;
    if (isFocus) focusAt = lines.length;
    // 方括号只说「现在是这一格」：没选中的用空格占同样的位，换焦点时整行不跳
    lines.push({
      text: isFocus ? `[${label}]` : ` ${label} `,
      focused: isFocus,
      tone: offset === 0 ? "accept" : offset === 1 ? "decline" : "cancel",
    });
  }

  if (editing.error !== undefined) lines.push({ text: editing.error, tone: "error" });
  return clip(lines, focusAt, maxRows);
}

/** 能打字的那几种（枚举也是字符串，但它的值只能从候选里选） */
function typing(field: FormFieldView | undefined): boolean {
  if (field === undefined) return false;
  if (field.type === "number" || field.type === "integer") return true;
  return field.type === "string" && field.enum === undefined;
}

/** 文本/数字那种「正在输入」的游标只画在活着的那一格上 */
function isTextual(field: FormFieldView): boolean {
  return typing(field);
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
