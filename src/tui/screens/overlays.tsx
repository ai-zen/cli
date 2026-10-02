// 由 src/tui/screens.tsx 拆分而来 —— 选择覆盖层 / 确认框
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { SelectList, KeyHints, SelectItem } from "../components.js";

// ==================== 选择覆盖层（/back）====================

export function PickerOverlay({
  title,
  items,
  columns,
  onPick,
}: {
  title: string;
  items: SelectItem<string>[];
  columns: number;
  onPick: (value: string | null) => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onPick(null);
  });
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={2}>
      <Text color={theme.warn} wrap="truncate">? {title}</Text>
      <Box marginTop={1}>
        <SelectList items={items} columns={columns} onSelect={(v) => onPick(v)} />
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={[["↑ ↓", "选择"], ["Enter", "确认"], ["Esc", "取消"]]} />
      </Box>
    </Box>
  );
}

// ==================== 确认框 ====================

export function Confirm({
  question,
  onAnswer,
}: {
  question: string;
  onAnswer: (value: boolean) => void;
}) {
  const [yes, setYes] = useState(true);
  useInput((input, key) => {
    if (key.ctrl && input === "c") onAnswer(false);
    else if (key.leftArrow || key.rightArrow) setYes((v) => !v);
    else if (input === "y" || input === "Y") onAnswer(true);
    else if (input === "n" || input === "N") onAnswer(false);
    else if (key.return) onAnswer(yes);
    else if (key.escape) onAnswer(false);
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={2}>
      <Text color={theme.warn} wrap="truncate">? {question}</Text>
      <Box marginTop={1} gap={2}>
        <Text inverse={yes} color={yes ? theme.ok : theme.dim}>
          {" 是 "}
        </Text>
        <Text inverse={!yes} color={!yes ? theme.error : theme.dim}>
          {" 否 "}
        </Text>
        <Text color={theme.faint} wrap="truncate">← → 选择 · y/n · Enter 确认</Text>
      </Box>
    </Box>
  );
}

