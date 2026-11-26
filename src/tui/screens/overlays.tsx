// 覆盖层：选择器（/load、/back、/model、/agent…）与表单（宿主问过来的那张表）
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { SelectList, KeyHints, SelectItem } from "../components.js";
import { t } from "../../i18n/index.js";
import type { FormAnswerView, FormSchemaView } from "../../session/types.js";
import {
  answerOf,
  applyFormKey,
  formLines,
  initialEditing,
  type FormEditing,
  type FormKey,
} from "./form-fields.js";

// ==================== 选择覆盖层 ====================

export function PickerOverlay({
  title,
  items,
  columns,
  maxRows,
  onPick,
}: {
  title: string;
  items: SelectItem<string>[];
  columns: number;
  /**
   * 一次最多画几条候选（窗高）。由屏幕按 `pickerCapacity` 算好递进来 —— 覆盖层不知道终端
   * 行数、也不该去算（那份算式在 `layout.ts`，与「覆盖层占几行」同源）。
   *
   * 候选比窗高时列表**滚动**（`SelectList` 的视窗），而不是被截断或把整帧顶高。
   */
  maxRows: number;
  onPick: (value: string | null) => void;
}) {
  useInput((input, key) => {
    // Ctrl+C 与 Esc 同义：选择器阶段也属于「命令执行中」（交接 / 迁移要在这里先选执行者），
    // 只认 Esc 会让习惯 Ctrl+C 的人在这段等待里按不动、以为卡死了。
    // 注：两个主输入处理器的 `isActive` 都带 `!pickerState`，此刻它们都失活，没人兼管。
    if (key.escape || (key.ctrl && input === "c")) onPick(null);
  });
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={theme.border}
      paddingX={2}
    >
      {/*
        标题**折行**而不裁切：有一类选择器是「破坏性动作之前的那一问」（`/shutdown`、`/upgrade`、
        `/delete`），它要说的是代价 —— 裁掉后半截等于少说一个事实，用户在 80 列的终端上会把
        「其他客户端也会断开」这种话正好切掉。条目仍然单行（`fitItem` 那条规矩不变：列表高度
        是按行数算的），折行的只有这一句问题本身。
      */}
      <Text color={theme.warn} wrap="wrap">
        ? {title}
      </Text>
      <Box marginTop={1}>
        <SelectList items={items} columns={columns} maxRows={maxRows} onSelect={(v) => onPick(v)} />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            ["↑ ↓", t("ui.select")],
            ["Enter", t("ui.confirm")],
            ["Esc", t("ui.cancel")],
          ]}
        />
      </Box>
    </Box>
  );
}

// ==================== 表单覆盖层 ====================

/**
 * 表单覆盖层 —— 宿主问过来一张表（交接三选一、破坏性动作前确认，将来还有外部服务器发来的
 * MCP elicitation），用户在面板上逐格填。
 *
 * ## 面板不认识「题」，只认识表
 *
 * 画什么全由 `requestedSchema` 决定：字符串/数字是一格草稿，布尔是一个勾，单选枚举是一行可左右
 * 切换的候选，多选枚举是一行可空格勾选的候选。交接那道三选题不过是「一个单选枚举字段」。
 *
 * ## 按键的两种事
 *
 * ↑ ↓ / Tab 换字段，← → 换选项（多选是移动项光标），空格切布尔与多选，回车提交，Esc 取消。
 * 编辑的规矩全在 `form-fields.ts` 里（纯函数，单测在那边），这一层只管把 ink 的按键翻译过去、
 * 把状态画出来。
 *
 * 校验不过**不关面板**：焦点跳到那一格、下面多一行说清为什么 —— 用户正在填的东西不该被丢掉。
 */
export function FormOverlay({
  title,
  schema,
  maxRows,
  onAnswer,
  onCancel,
}: {
  title: string;
  schema: FormSchemaView;
  /**
   * 一次最多画几行内容（窗高）。由屏幕按布局算好递进来 —— 覆盖层不知道终端行数，也不该去算。
   *
   * 候选多的那几种字段会顶穿屏幕，所以给窗就只画窗口里那一段，窗口跟着焦点走。
   */
  maxRows?: number;
  /** 用户提交或取消：`accept` 带内容，`cancel` 是关掉没作答 */
  onAnswer: (answer: FormAnswerView) => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState<FormEditing>(() => initialEditing(schema));

  useInput((input, key) => {
    // Ctrl+C 与 Esc 同义（与选择器那一条同源：这段时间两个主输入处理器都失活）
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }
    if (key.return) {
      const result = answerOf(schema, editing.values);
      if (result.ok) onAnswer({ action: "accept", content: result.content });
      else setEditing({ ...editing, focus: result.focus, error: result.reason });
      return;
    }

    const translated = translateKey(input, key);
    if (translated === undefined) return;
    setEditing((current) => applyFormKey(current, schema, translated));
  });

  const lines = formLines(schema, editing, t("ui.form.empty"), maxRows);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={theme.border}
      paddingX={2}
    >
      <Text color={theme.warn} wrap="wrap">
        ? {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, index) => (
          <Text
            // 行是摊平算出来的，没有稳定 id：位置就是它的身份（内容一变整块重算）
            key={index}
            color={line.error ? theme.error : line.focused ? theme.accent : undefined}
            wrap="wrap"
          >
            {line.text}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            ["↑ ↓ / Tab", t("ui.form.switch")],
            ["← → / Space", t("ui.form.choose")],
            ["Enter", t("ui.form.submit")],
            ["Esc", t("ui.cancel")],
          ]}
        />
      </Box>
    </Box>
  );
}

/**
 * ink 的按键 → 面板认得的那几种。
 *
 * 只有一件事不在这里：回车与 Esc（它们不是「编辑」，是提交与取消，由组件自己接）。
 */
function translateKey(
  input: string,
  key: {
    tab?: boolean;
    shift?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  },
): FormKey | undefined {
  if (key.tab) return key.shift ? { kind: "prev" } : { kind: "next" };
  if (key.downArrow) return { kind: "next" };
  if (key.upArrow) return { kind: "prev" };
  if (key.leftArrow) return { kind: "step", delta: -1 };
  if (key.rightArrow) return { kind: "step", delta: 1 };
  if (key.backspace || key.delete) return { kind: "backspace" };
  if (input === " ") return { kind: "space" };
  if (input.length > 0 && !key.ctrl && !key.meta) return { kind: "text", input };
  return undefined;
}
