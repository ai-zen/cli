// 通用列表选择屏 ListStep
import { Box, Text, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { SelectList, KeyHints, SelectItem } from "../components.js";
import { usableFrameRows } from "../text.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";
import { t } from "../../i18n/index.js";

// ==================== 列表选择屏 ====================

export interface ListStepProps<T> {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  title: string;
  subtitle?: string;
  /** 警示行（如「该文件已损坏」）：以错误色印在副标题之下，不影响列表与按键 */
  warning?: string;
  items: SelectItem<T>[];
  onPick: (value: T) => void;
  onCancel: () => void;
}

export function ListStep<T>({
  columns,
  rows,
  title,
  subtitle,
  warning,
  items,
  onPick,
  onCancel,
}: ListStepProps<T>) {
  const { setCursorPosition } = useCursor();
  // 列表屏无文本编辑：显式隐藏硬件光标，避免沿用上一屏（会话屏）的位置
  setCursorPosition(undefined);
  useInput((_char, key) => {
    if (key.escape) onCancel();
  });

  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(subtitle ? textRows(subtitle, columns, theme.dim) : []),
    ...(warning ? textRows(`✖ ${warning}`, columns, theme.error) : []),
  ];
  // 每项严格占一行（吸底布局才能精确留白）；装不下时列表内部滚动，不截断候选
  const maxItems = Math.max(1, usableFrameRows(rows) - (headerRows.length + 3));
  const visibleCount = Math.min(items.length, maxItems);
  const contentLines = headerRows.length + 1 + Math.max(visibleCount, 1) + 1;

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1} flexDirection="column">
        {items.length > 0 ? (
          // key 绑定标题：切换步骤时强制重建，避免复用上一个列表的高亮索引
          <SelectList
            key={title}
            items={items}
            onSelect={onPick}
            columns={columns}
            maxRows={maxItems}
          />
        ) : (
          <Text color={theme.faint} wrap="truncate">
            {t("wiz.listEmpty")}
          </Text>
        )}
      </Box>
      <KeyHints
        hints={[
          ["↑ ↓", t("ui.select")],
          ["Enter", t("ui.confirm")],
          ["Esc", t("ui.back")],
        ]}
      />
    </WizardFrame>
  );
}
