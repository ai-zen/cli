// 由 src/tui/config-wizard.tsx 拆分而来 —— 向导外壳：头部行 + 吸底布局
import { ReactNode } from "react";
import { Box, Text } from "ink";
import { bottomPadding, displayWidth, wrapText } from "../text.js";

// ==================== 头部行 ====================

export interface Row {
  text: string;
  color: string;
  bold: boolean;
}

/** 把一段文本按终端宽度折行成「每行一条 row」（渲染时以 truncate 保证 1 行 = 1 终端行） */
export function textRows(text: string, columns: number, color: string, bold = false): Row[] {
  return wrapText(text, Math.max(8, columns - 2)).map((line) => ({ text: line, color, bold }));
}

/** 按显示宽度右侧补空格（用于把字段值对齐到同一列） */
export function padDisplay(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

export function Header({ rows: headerRows }: { rows: Row[] }) {
  return (
    <>
      {headerRows.map((row, index) => (
        <Box key={index} paddingX={1}>
          <Text color={row.color} bold={row.bold} wrap="truncate">
            {row.text}
          </Text>
        </Box>
      ))}
    </>
  );
}

// ==================== 向导外壳（自底部向上布局）====================

/**
 * 向导外壳 —— 与对话屏一致：内容用顶部空白行顶到底部。
 *
 * 帧高 = 内容行数 + 顶部留白，其中留白 = 「终端行数 − 1 − 内容行数」。
 * 这样内容永不飘到视口外（之前短帧顶对齐时，从对话屏切过来会被擦除/滚动错位顶出可视区，
 * 在 VS Code 终端里表现为「渲染不全」），且与对话屏帧高一致、切换时不抖动。
 */
export function WizardFrame({
  columns,
  rows,
  contentLines,
  children,
}: {
  columns: number;
  rows: number;
  contentLines: number;
  children: ReactNode;
}) {
  const pad = bottomPadding(rows, contentLines);
  return (
    <Box flexDirection="column" width={columns}>
      {Array.from({ length: pad }, (_, index) => (
        <Text key={`pad-${index}`}> </Text>
      ))}
      {children}
    </Box>
  );
}

