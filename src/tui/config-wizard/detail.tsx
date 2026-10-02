// 由 src/tui/config-wizard.tsx 拆分而来 —— 通用详情屏 DetailStep（就地编辑）
import { useEffect, useState } from "react";
import { Box, Text, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { KeyHints } from "../components.js";
import { bottomPadding, displayWidth, isTerminalReply } from "../text.js";
import { Header, WizardFrame, Row, textRows, padDisplay } from "./frame.js";
import { ListStep } from "./list.js";

// ==================== 通用详情屏（就地编辑）====================

export type DetailFieldKind = "text" | "secret" | "number" | "enum" | "bool" | "map";

/** 详情屏的一个可编辑字段 */
export interface DetailField {
  key: string;
  label: string;
  kind: DetailFieldKind;
  /** 展示值（bool → "是"/"否"；enum → 当前选项 label；secret → 已掩码的串） */
  value: string;
  /** 进入编辑（text/secret/number）时的初值；缺省用 `value` */
  initial?: string;
  /** enum 选项 */
  options?: { label: string; value: string }[];
  /** 提交文本 / 枚举值：返回错误信息或 `null`（成功） */
  commit?: (raw: string) => Promise<string | null>;
  /** bool 切换 */
  toggle?: () => Promise<string | null>;
  /** map 类型：按 Enter 进入子屏（键值编辑） */
  open?: () => void;
}

/** 详情屏底部的整体动作（如「删除」），危险动作以红色呈现并可二次确认 */
export interface DetailAction {
  label: string;
  run: () => Promise<string | null>;
}

export interface DetailStepProps {
  columns: number;
  rows: number;
  title: string;
  /** 标题下的说明行 */
  details?: string[];
  fields: DetailField[];
  notice?: string | null;
  /** 底部危险动作（如删除） */
  action?: DetailAction;
  onBack: () => void;
}

/**
 * 通用详情屏 —— 一屏列出某实体的全部字段，就地编辑：
 *   - 导航态：`↑ ↓` 在字段（含底部动作）间移动，`Esc` 返回列表；
 *   - 文本类（text/secret/number）：`Enter` 进入编辑，`Enter` 保存、`Esc` 取消，secret 支持 `Tab` 切明文；
 *   - bool：`Enter` 直接切换；enum：`Enter` 弹出选项列表；
 *   - 动作行：`Enter` 弹二次确认，确认后执行（通常用于删除）。
 *
 * 文本编辑时光标「就地」落在所选字段的值上（硬件光标同步，IME 候选框跟随）；
 * 帧高恒为「终端行数 − 1」，与其它屏一致。
 */
export function DetailStep({ columns, rows, title, details, fields, notice, action, onBack }: DetailStepProps) {
  const { setCursorPosition } = useCursor();
  const rowCount = Math.max(1, fields.length + (action ? 1 : 0));
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // 行数变化（如 Agent 详情 ↔ 权限子屏共用本组件）时收敛高亮索引，避免越界导致无高亮
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, rowCount - 1)));
  }, [rowCount]);

  const labelWidth = Math.max(6, ...fields.map((f) => displayWidth(f.label)));
  const valueX = 2 + labelWidth + 2;
  const field = index < fields.length ? fields[index] : undefined;
  const onActionRow = Boolean(action) && index === fields.length;

  const chars = Array.from(value);
  const caret = Math.max(0, Math.min(cursor, chars.length));
  const masked = field?.kind === "secret" && !revealed;

  const beginEdit = () => {
    if (!field) return;
    const current = field.initial ?? field.value;
    setValue(current);
    setCursor(Array.from(current).length);
    setRevealed(false);
    setError(null);
    setEditing(true);
  };
  const update = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(nextCursor);
  };
  const insert = (text: string) =>
    update(chars.slice(0, caret).join("") + text + chars.slice(caret).join(""), caret + Array.from(text).length);
  const deleteBefore = () => {
    if (caret === 0) return;
    update(chars.slice(0, caret - 1).join("") + chars.slice(caret).join(""), caret - 1);
  };
  const deleteAfter = () => {
    if (caret >= chars.length) return;
    update(chars.slice(0, caret).join("") + chars.slice(caret + 1).join(""), caret);
  };

  const apply = async (run: () => Promise<string | null>) => {
    setError(null);
    const failure = await run();
    if (failure) setError(failure);
  };

  const submit = async () => {
    if (!field?.commit) return;
    const raw = value.trim();
    const current = (field.initial ?? field.value).trim();
    if (raw === current) {
      setEditing(false);
      setError(null);
      return;
    }
    const failure = await field.commit(raw);
    if (failure) {
      setError(failure);
      return;
    }
    setEditing(false);
    setError(null);
  };

  useInput(
    (char, key) => {
      if (isTerminalReply(char)) return;
      if (editing) {
        if (key.escape) {
          setEditing(false);
          setError(null);
          return;
        }
        if (key.return) {
          void submit();
          return;
        }
        if (key.tab && field?.kind === "secret") {
          setRevealed((r) => !r);
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
        return;
      }
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        setIndex((i) => (i - 1 + rowCount) % rowCount);
        return;
      }
      if (key.downArrow) {
        setIndex((i) => (i + 1) % rowCount);
        return;
      }
      if (key.return) {
        if (onActionRow && action) {
          setConfirming(true);
          return;
        }
        if (!field) return;
        if (field.kind === "bool") {
          if (field.toggle) void apply(field.toggle);
          return;
        }
        if (field.kind === "enum") {
          setChoosing(true);
          return;
        }
        if (field.kind === "map") {
          field.open?.();
          return;
        }
        beginEdit();
      }
    },
    { isActive: !choosing && !confirming },
  );

  // ---- 子屏：枚举选择 ----
  const enumOptions = field?.options;
  if (choosing && field && enumOptions) {
    const target = field;
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={`${target.label} · 选择`}
        items={enumOptions.map((option) => ({ label: option.label || "（空）", value: option.value }))}
        onPick={(picked) => {
          setChoosing(false);
          if (target.commit) void apply(() => target.commit!(picked));
        }}
        onCancel={() => setChoosing(false)}
      />
    );
  }

  // ---- 子屏：动作二次确认 ----
  if (confirming && action) {
    const target = action;
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={`${target.label}？`}
        subtitle={`${title} —— 此操作不可撤销`}
        items={[
          { label: `确认${target.label}`, value: "yes" },
          { label: "取消", value: "no" },
        ]}
        onPick={(picked) => {
          setConfirming(false);
          if (picked === "yes") void apply(target.run);
        }}
        onCancel={() => setConfirming(false)}
      />
    );
  }

  // ---- 主屏 ----
  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(details ?? []).flatMap((detail) => textRows(detail, columns, theme.dim)),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
    ...(error ? textRows(`✖ ${error}`, columns, theme.error) : []),
  ];
  const contentLines = headerRows.length + 1 + fields.length + (action ? 1 : 0) + 1;

  if (editing && field) {
    const shown = masked ? "•".repeat(chars.length) : value;
    const shownChars = Array.from(shown);
    setCursorPosition({
      x: valueX + displayWidth(shownChars.slice(0, caret).join("")),
      y: bottomPadding(rows, contentLines) + headerRows.length + 1 + index,
    });
  } else {
    setCursorPosition(undefined);
  }

  const hints: [string, string][] = editing
    ? masked
      ? [
          ["Enter", "保存"],
          ["Tab", "明文/掩码"],
          ["Esc", "取消"],
        ]
      : [
          ["Enter", "保存"],
          ["Esc", "取消"],
        ]
    : onActionRow
      ? [
          ["Enter", "执行"],
          ["↑ ↓", "移动"],
          ["Esc", "返回"],
        ]
      : field?.kind === "bool"
        ? [
            ["Enter", "切换"],
            ["↑ ↓", "移动"],
            ["Esc", "返回"],
          ]
        : field?.kind === "enum"
          ? [
              ["Enter", "选择"],
              ["↑ ↓", "移动"],
              ["Esc", "返回"],
            ]
          : field?.kind === "map"
            ? [
                ["Enter", "打开"],
                ["↑ ↓", "移动"],
                ["Esc", "返回"],
              ]
            : [
              ["Enter", "编辑"],
              ["↑ ↓", "移动"],
              ["Esc", "返回"],
            ];

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1} flexDirection="column">
        {fields.map((f, i) => {
          const selected = i === index;
          const active = editing && selected;
          const rowMasked = f.kind === "secret" && !revealed;
          let before = f.value;
          let at = "";
          let after = "";
          if (active) {
            const shown = rowMasked ? "•".repeat(chars.length) : value;
            const shownChars = Array.from(shown);
            before = shownChars.slice(0, caret).join("");
            at = shownChars[caret] ?? " ";
            after = shownChars.slice(caret + 1).join("");
          }
          return (
            <Text key={f.key} wrap="truncate">
              <Text color={selected ? theme.brand[0] : theme.faint}>{selected ? "❯ " : "  "}</Text>
              <Text bold={selected} color={selected ? theme.highlight : theme.assistant}>
                {padDisplay(f.label, labelWidth)}
              </Text>
              <Text>{"  "}</Text>
              {active ? (
                <>
                  <Text>{before}</Text>
                  <Text inverse color={theme.brand[0]}>
                    {at}
                  </Text>
                  <Text>{after}</Text>
                </>
              ) : (
                <Text color={f.kind === "text" ? theme.assistant : theme.dim}>{before}</Text>
              )}
            </Text>
          );
        })}
        {action ? (
          <Text wrap="truncate">
            <Text color={index === fields.length ? theme.brand[0] : theme.faint}>
              {index === fields.length ? "❯ " : "  "}
            </Text>
            <Text bold={index === fields.length} color={theme.error}>
              {padDisplay(action.label, labelWidth)}
            </Text>
          </Text>
        ) : null}
      </Box>
      <KeyHints hints={hints} />
    </WizardFrame>
  );
}

