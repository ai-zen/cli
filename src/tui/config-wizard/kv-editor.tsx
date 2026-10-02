// 由 src/tui/config-wizard.tsx 拆分而来 —— 键值编辑屏 KvEditorScreen（MCP env / headers）
import { useState } from "react";
import { Box, Text, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { KeyHints } from "../components.js";
import { usableFrameRows } from "../text.js";
import { kvEntries, parseKvInput } from "../../config-editor.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";
import { PromptScreen } from "./prompt.js";

// ==================== 键值编辑屏（MCP env / headers）====================

export interface KvEditorScreenProps {
  columns: number;
  rows: number;
  title: string;
  subtitle?: string;
  map: Record<string, string>;
  notice?: string | null;
  onCommit: (next: Record<string, string>) => Promise<string | null>;
  onBack: () => void;
}

/**
 * 键值映射编辑屏（MCP 的环境变量 / 请求头）：
 *   - 首行为「＋ 新增」，其后为各 `KEY = VALUE`；
 *   - `Enter` 新增 / 编辑（弹出 KEY=VALUE 输入屏，首个 = 分割）；
 *   - `Ctrl+D` 或 `Delete` 删除高亮项；`↑ ↓` 移动；`Esc` 返回。
 */
export function KvEditorScreen({ columns, rows, title, subtitle, map, notice, onCommit, onBack }: KvEditorScreenProps) {
  const { setCursorPosition } = useCursor();
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<{ mode: "add" | "edit"; initial: string; key?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entries = kvEntries(map);
  const rowCount = entries.length + 1;

  const commit = async (next: Record<string, string>) => {
    const failure = await onCommit(next);
    if (failure) setError(failure);
    return failure;
  };

  const remove = async (key: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) if (k !== key) next[k] = v;
    await commit(next);
  };

  const submit = async (raw: string) => {
    const parsed = parseKvInput(raw);
    if (!parsed) {
      setError("格式应为 KEY=VALUE");
      return;
    }
    const target = editing!;
    if (target.mode === "add" && Object.prototype.hasOwnProperty.call(map, parsed.key)) {
      setError(`已存在 ${parsed.key}`);
      return;
    }
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (target.mode === "edit" && target.key === k) next[parsed.key] = parsed.value;
      else next[k] = v;
    }
    if (target.mode === "add") next[parsed.key] = parsed.value;
    const failure = await commit(next);
    if (failure) return;
    setEditing(null);
    setError(null);
  };

  useInput(
    (char, key) => {
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
      if (key.delete || (char === "d" && key.ctrl)) {
        if (index >= 1 && entries[index - 1]) void remove(entries[index - 1]!.key);
        return;
      }
      if (key.return) {
        setError(null);
        if (index === 0) {
          setEditing({ mode: "add", initial: "" });
        } else {
          const entry = entries[index - 1]!;
          setEditing({ mode: "edit", initial: `${entry.key}=${entry.value}`, key: entry.key });
        }
      }
    },
    { isActive: !editing },
  );

  if (editing) {
    return (
      <PromptScreen
        key={`kv:${editing.mode}:${editing.key ?? "new"}`}
        columns={columns}
        rows={rows}
        title={`${title} · ${editing.mode === "add" ? "新增" : "编辑"}`}
        details={["格式：KEY=VALUE（键与值以首个 = 分隔）", "例如 PATH=/usr/bin 或 Authorization=Bearer xxx"]}
        initialValue={editing.initial}
        error={error}
        hints={[["Enter", "保存"], ["Esc", "取消"]]}
        onSubmit={(value) => void submit(value)}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
      />
    );
  }

  setCursorPosition(undefined);

  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(subtitle ? textRows(subtitle, columns, theme.dim) : []),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
    ...(error ? textRows(`✖ ${error}`, columns, theme.error) : []),
  ];
  const maxEntries = Math.max(1, usableFrameRows(rows) - (headerRows.length + 4));
  const shown = entries.slice(0, maxEntries);
  const truncated = entries.length > shown.length;
  const listLines = 1 + Math.max(shown.length, 1) + (truncated ? 1 : 0);
  const contentLines = headerRows.length + 1 + listLines + 1;
  const safeIndex = Math.min(index, rowCount - 1);

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1} flexDirection="column">
        <Text wrap="truncate">
          <Text color={safeIndex === 0 ? theme.brand[0] : theme.faint}>{safeIndex === 0 ? "❯ " : "  "}</Text>
          <Text bold={safeIndex === 0} color={safeIndex === 0 ? theme.highlight : theme.assistant}>
            ＋ 新增
          </Text>
        </Text>
        {shown.length === 0 ? (
          <Text color={theme.faint} wrap="truncate">
            {"  （暂无，按 Enter 新增）"}
          </Text>
        ) : (
          shown.map((entry, i) => {
            const selected = safeIndex === i + 1;
            return (
              <Text key={entry.key} wrap="truncate">
                <Text color={selected ? theme.brand[0] : theme.faint}>{selected ? "❯ " : "  "}</Text>
                <Text bold={selected} color={selected ? theme.highlight : theme.assistant}>
                  {entry.key}
                </Text>
                <Text color={theme.dim}> = {entry.value}</Text>
              </Text>
            );
          })
        )}
        {truncated ? (
          <Text color={theme.faint} wrap="truncate">
            {`  （共 ${entries.length} 项，仅显示前 ${shown.length} 项）`}
          </Text>
        ) : null}
      </Box>
      <KeyHints hints={[["Enter", "编辑/新增"], ["Ctrl+D", "删除"], ["↑ ↓", "移动"], ["Esc", "返回"]]} />
    </WizardFrame>
  );
}

