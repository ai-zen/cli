// 多行文本编辑屏 PromptEditorScreen（调系统编辑器）
import { useState } from "react";
import { Box, Text, useApp, useCursor, useInput } from "ink";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { theme } from "../theme.js";
import { KeyHints } from "../components.js";
import { usableFrameRows, wrapText } from "../text.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";
import { t } from "../../i18n/index.js";
import { openInSystemEditor, systemEditorCommand, type OpenEditor } from "../../system-editor.js";

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
  /**
   * 打开编辑器的实现。缺省用 {@link openInSystemEditor}；测试注入假实现，**不必**
   * `vi.mock("child_process")` ——模块级 mock 是全局注册的，多个测试文件各自 mock 同一
   * 说明符会互相覆盖。
   */
  openEditor?: OpenEditor;
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
  openEditor,
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
      await writeFile(file, before, "utf-8");
      await suspendTerminal(() => (openEditor ?? openInSystemEditor)(systemEditorCommand(), file));
      const edited = (await readFile(file, "utf-8")).replace(/\r\n/g, "\n").trimEnd();
      if (edited === before) return; // 未改动：不写盘
      setDraft(edited);
      const failure = await onSave(edited);
      if (failure) setError(failure);
      else setDraft(null); // 成功：交回父级最新值
    } catch (cause: any) {
      setError(t("wiz.openEditorFailed", { error: cause?.message ?? cause }));
    } finally {
      try {
        await unlink(file);
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
  const preview = current
    ? wrapText(current, Math.max(8, columns - 4)).slice(0, previewBudget)
    : [t("common.empty")];
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
      <KeyHints
        hints={[
          ["Enter", busy ? t("wiz.editorBusy") : t("wiz.openSystemEditor")],
          ["Esc", t("ui.back")],
        ]}
      />
    </WizardFrame>
  );
}
