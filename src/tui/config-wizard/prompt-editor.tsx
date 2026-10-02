// 由 src/tui/config-wizard.tsx 拆分而来 —— 多行文本编辑屏 PromptEditorScreen（系统编辑器）
import { useState } from "react";
import { Box, Text, useApp, useCursor, useInput } from "ink";
import { spawnSync } from "child_process";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { theme } from "../theme.js";
import { KeyHints } from "../components.js";
import { usableFrameRows, wrapText } from "../text.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";

// ==================== 多行文本编辑屏（系统编辑器）====================

export interface PromptEditorScreenProps {
  columns: number;
  rows: number;
  title: string;
  subtitle?: string;
  /** 待编辑的多行文本（当前内容） */
  text: string;
  /** 临时文件扩展名（默认 md；参数 schema 等 JSON 用 json，便于编辑器语法高亮 / 格式化） */
  ext?: string;
  notice?: string | null;
  onSave: (text: string) => Promise<string | null>;
  onBack: () => void;
}

/**
 * 多行文本编辑屏 —— 内容交给**系统编辑器**（复用 `/editor` 的 `suspendTerminal` 模式）。
 *
 * 屏内只预览当前内容；`Enter` 挂起 Ink、用 `$EDITOR`（Windows 默认 notepad）打开临时
 * 文件，保存回读后写盘；`Esc` 返回。
 *
 * 校验失败时**保留用户改后的内容**（`draft`），再次 `Enter` 可在其基础上继续修改 —— 避免
 * JSON 校验失败后改动丢失；内容未改动时直接返回、不写盘。
 */
export function PromptEditorScreen({
  columns,
  rows,
  title,
  subtitle,
  text,
  ext = "md",
  notice,
  onSave,
  onBack,
}: PromptEditorScreenProps) {
  const { setCursorPosition } = useCursor();
  const { suspendTerminal } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? text;

  const launch = async () => {
    setError(null);
    const before = current;
    const file = join(tmpdir(), `aizen-edit-${Date.now()}.${ext}`);
    try {
      writeFileSync(file, before, "utf-8");
      await suspendTerminal(() => {
        const editor =
          process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi");
        const result = spawnSync(editor, [file], { stdio: "inherit" });
        if (result.error) throw result.error;
      });
      const edited = readFileSync(file, "utf-8").replace(/\r\n/g, "\n").trimEnd();
      if (edited === before) return; // 未改动：不写盘
      setDraft(edited);
      const failure = await onSave(edited);
      if (failure) setError(failure);
      else setDraft(null); // 成功：交回父级最新值
    } catch (cause: any) {
      setError(`打开编辑器失败：${cause?.message ?? cause}`);
    } finally {
      try {
        unlinkSync(file);
      } catch {
        /* 忽略 */
      }
    }
  };

  setCursorPosition(undefined);
  useInput(
    (_char, key) => {
      if (key.escape) onBack();
      else if (key.return && !busy) {
        setBusy(true);
        void launch().finally(() => setBusy(false));
      }
    },
    { isActive: !busy },
  );

  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(subtitle ? textRows(subtitle, columns, theme.dim) : []),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
    ...(error ? textRows(`✖ ${error}`, columns, theme.error) : []),
  ];
  const previewBudget = Math.max(3, usableFrameRows(rows) - headerRows.length - 3);
  const preview = current ? wrapText(current, Math.max(8, columns - 4)).slice(0, previewBudget) : ["（空）"];
  const contentLines = headerRows.length + 1 + preview.length + 1;

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1} flexDirection="column" paddingX={1}>
        {preview.map((line, index) => (
          <Text key={index} color={theme.assistant} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      <KeyHints hints={[["Enter", busy ? "编辑中…" : "打开系统编辑器"], ["Esc", "返回"]]} />
    </WizardFrame>
  );
}
