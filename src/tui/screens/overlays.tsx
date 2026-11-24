// 选择覆盖层（选择器：/load、/back、/model、/agent、交接方式、问题对象…）
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { SelectList, KeyHints, SelectItem } from "../components.js";
import { t } from "../../i18n/index.js";

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
