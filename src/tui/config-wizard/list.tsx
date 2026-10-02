// 由 src/tui/config-wizard.tsx 拆分而来 —— 通用列表选择屏 ListStep
import { Box, Text, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { SelectList, KeyHints, SelectItem } from "../components.js";
import { usableFrameRows } from "../text.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";

// ==================== 列表选择屏 ====================

export interface ListStepProps<T> {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  title: string;
  subtitle?: string;
  items: SelectItem<T>[];
  onPick: (value: T) => void;
  onCancel: () => void;
}

export function ListStep<T>({ columns, rows, title, subtitle, items, onPick, onCancel }: ListStepProps<T>) {
  const { setCursorPosition } = useCursor();
  // 列表屏无文本编辑：显式隐藏硬件光标，避免沿用上一屏（对话屏）的位置
  setCursorPosition(undefined);
  useInput((_char, key) => {
    if (key.escape) onCancel();
  });

  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(subtitle ? textRows(subtitle, columns, theme.dim) : []),
  ];
  // 列表项多到装不下时就截断（每项严格占一行，吸底布局才能精确留白）
  const maxItems = Math.max(1, usableFrameRows(rows) - (headerRows.length + 3));
  const visible = items.slice(0, maxItems);
  const truncated = items.length > visible.length;
  const contentLines = headerRows.length + 1 + Math.max(visible.length, 1) + (truncated ? 1 : 0) + 1;

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1} flexDirection="column">
        {visible.length > 0 ? (
          // key 绑定标题：切换步骤时强制重建，避免复用上一个列表的高亮索引
          <SelectList key={title} items={visible} onSelect={onPick} columns={columns} />
        ) : (
          <Text color={theme.faint} wrap="truncate">
            {"  （无可选项）"}
          </Text>
        )}
        {truncated ? (
          <Text color={theme.faint} wrap="truncate">
            {`  （共 ${items.length} 项，仅显示前 ${visible.length} 项）`}
          </Text>
        ) : null}
      </Box>
      <KeyHints hints={[["↑ ↓", "选择"], ["Enter", "确认"], ["Esc", "返回"]]} />
    </WizardFrame>
  );
}

