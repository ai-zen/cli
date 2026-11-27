import { ReactNode } from "react";
import { Box, Text } from "ink";
import { bottomPadding, displayWidth, wrapText } from "../text.js";

export interface Row {
  text: string;
  color: string;
  bold: boolean;
}

/** 把一段文本按终端宽度折行成每行一条 row；渲染时用 truncate 保证一行只占一个终端行 */
export function textRows(text: string, columns: number, color: string, bold = false): Row[] {
  return wrapText(text, Math.max(8, columns - 2)).map((line) => ({ text: line, color, bold }));
}

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

/**
 * 向导外壳：顶部补空白行，内容贴着帧底，与会话屏一致。
 *
 * 短帧顶对齐时，从会话屏切过来会被擦除、或因滚动错位顶出可视区，在 VS Code 终端里表现为
 * 渲染不全；帧高与会话屏一致之后，切换时也不再有位置跳变。
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
