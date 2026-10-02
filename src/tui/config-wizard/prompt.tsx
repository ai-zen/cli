// 由 src/tui/config-wizard.tsx 拆分而来 —— 单行输入屏 PromptScreen + promptLayout
import { useState } from "react";
import { Box, Text, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { KeyHints } from "../components.js";
import { INPUT_PREFIX_WIDTH, bottomPadding, displayWidth, layoutInput, isTerminalReply } from "../text.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";

// ==================== 输入屏布局（纯函数，便于单测）====================

export interface PromptLayoutInput {
  /** 终端行数 */
  terminalRows: number;
  /** 标题 + 说明已占行数 */
  headerLines: number;
  /** 输入区折行后的行数 */
  inputLines: number;
  /** 输入区之后额外占用的行数（空值提示 / 错误行 / 明文提示） */
  extraLines: number;
  /** 底部键位提示行数（通常 1） */
  hintLines: number;
  /** 光标在输入区内的行 / 列（列以 code point 计） */
  cursorRow: number;
  cursorCol: number;
  /** 光标所在行的文本（不含提示符） */
  lineText: string;
}

export interface PromptLayout {
  /** 内容总行数 */
  contentLines: number;
  /** 顶部留白行数 */
  topPadding: number;
  /** 终端硬件光标坐标（相对整帧原点，供 IME 候选框定位） */
  cursor: { x: number; y: number };
}

/** 计算输入屏的顶部留白与硬件光标坐标（吸底布局 + IME 跟随） */
export function promptLayout(input: PromptLayoutInput): PromptLayout {
  const contentLines = input.headerLines + input.inputLines + input.extraLines + input.hintLines;
  const topPadding = bottomPadding(input.terminalRows, contentLines);
  const before = Array.from(input.lineText).slice(0, input.cursorCol).join("");
  return {
    contentLines,
    topPadding,
    cursor: {
      x: INPUT_PREFIX_WIDTH + displayWidth(before),
      y: topPadding + input.headerLines + input.cursorRow,
    },
  };
}

// ==================== 文本输入屏 ====================

export interface PromptScreenProps {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  title: string;
  /** 标题下的说明行（自动折行） */
  details?: string[];
  /** 输入框初始值 */
  initialValue?: string;
  /** 掩码输入（API Key），Tab 可临时切明文核对 */
  mask?: boolean;
  /** 上级校验错误 */
  error?: string | null;
  hints: [string, string][];
  /** 光标位置变化时回调（用于宿主实时预览，可省略） */
  onChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * 全屏单行输入：标题 + 输入行 + 键位提示（吸底布局）。
 *
 * 硬件光标 y 由 `promptLayout()` 按「顶部留白 + 标题行数 + 输入行内偏移」算出，
 * 而整帧高度恒小于终端行数（不命中 Ink 全屏分支），因此 IME 候选框与自绘光标精确对齐。
 */
export function PromptScreen(props: PromptScreenProps) {
  const { setCursorPosition } = useCursor();
  const [value, setValue] = useState(props.initialValue ?? "");
  const [cursor, setCursor] = useState(Array.from(props.initialValue ?? "").length);
  const [revealed, setRevealed] = useState(!props.mask);

  const chars = Array.from(value);
  const caret = Math.max(0, Math.min(cursor, chars.length));
  const display = revealed ? value : "•".repeat(chars.length);
  const layout = layoutInput(display, caret, Math.max(4, props.columns - 4));

  const header: Row[] = [
    ...textRows(`? ${props.title}`, props.columns, theme.warn, true),
    ...(props.details ?? []).flatMap((detail) => textRows(detail, props.columns, theme.dim)),
  ];
  // 输入区之后的附加行：空值提示 / 校验错误 / 明文提示
  const extraLines = (chars.length === 0 ? 1 : 0) + (props.error ? 1 : 0) + (props.mask && revealed ? 1 : 0);
  const position = promptLayout({
    terminalRows: props.rows,
    headerLines: header.length,
    inputLines: layout.lines.length,
    extraLines,
    hintLines: 1,
    cursorRow: layout.cursorRow,
    cursorCol: layout.cursorCol,
    lineText: layout.lines[layout.cursorRow] ?? "",
  });
  setCursorPosition(position.cursor);

  const update = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(nextCursor);
    props.onChange?.(next);
  };
  const insert = (text: string) => {
    update(chars.slice(0, caret).join("") + text + chars.slice(caret).join(""), caret + Array.from(text).length);
  };
  const deleteBefore = () => {
    if (caret === 0) return;
    update(chars.slice(0, caret - 1).join("") + chars.slice(caret).join(""), caret - 1);
  };
  const deleteAfter = () => {
    if (caret >= chars.length) return;
    update(chars.slice(0, caret).join("") + chars.slice(caret + 1).join(""), caret);
  };

  useInput((char, key) => {
    // 终端应答序列（如 Kitty 查询应答 `[?0u`）不是用户输入，丢弃
    if (isTerminalReply(char)) return;
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      props.onSubmit(value);
      return;
    }
    if (key.tab && props.mask) {
      setRevealed((v) => !v);
      return;
    }
    if (char === "u" && key.ctrl) {
      update("", 0);
      return;
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, caret - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(chars.length, caret + 1));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(chars.length);
      return;
    }
    if (key.backspace) {
      deleteBefore();
      return;
    }
    if (key.delete) {
      deleteAfter();
      return;
    }
    if (char && !key.ctrl && !key.meta) insert(char);
  });

  return (
    <WizardFrame columns={props.columns} rows={props.rows} contentLines={position.contentLines}>
      <Header rows={header} />

      <Box flexDirection="column" paddingX={1}>
        {layout.lines.map((line, index) => {
          const prompt =
            index === 0 ? (
              <Text color={theme.brand[0]} bold>
                {"❯ "}
              </Text>
            ) : (
              <Text>{"  "}</Text>
            );
          if (index !== layout.cursorRow) {
            return (
              <Text key={index} wrap="truncate">
                {prompt}
                <Text>{line}</Text>
              </Text>
            );
          }
          const rowChars = Array.from(line);
          const at = rowChars[layout.cursorCol];
          return (
            <Text key={index} wrap="truncate">
              {prompt}
              <Text>{rowChars.slice(0, layout.cursorCol).join("")}</Text>
              <Text inverse color={theme.brand[0]}>
                {at ?? " "}
              </Text>
              <Text>{rowChars.slice(layout.cursorCol + 1).join("")}</Text>
            </Text>
          );
        })}
      </Box>

      {chars.length === 0 ? (
        <Box paddingX={1}>
          <Text color={theme.faint} wrap="truncate">
            {props.mask ? "（粘贴或输入后按 Enter 保存，Tab 可切明文核对）" : "（输入后按 Enter 确认）"}
          </Text>
        </Box>
      ) : null}

      {props.error ? (
        <Box paddingX={1}>
          <Text color={theme.error} wrap="truncate">
            ✖ {props.error}
          </Text>
        </Box>
      ) : null}

      {props.mask && revealed ? (
        <Box paddingX={1}>
          <Text color={theme.warn} wrap="truncate">
            ⚠ 当前为明文显示（Tab 切回掩码）
          </Text>
        </Box>
      ) : null}

      <KeyHints hints={props.hints} />
    </WizardFrame>
  );
}

