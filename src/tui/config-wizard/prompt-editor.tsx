// 由 src/tui/config-wizard.tsx 拆分而来 —— 提示词编辑屏 PromptEditorScreen（系统编辑器）
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

// ==================== 提示词编辑屏（系统编辑器）====================

export interface PromptEditorScreenProps {
  columns: number;
  rows: number;
  title: string;
  subtitle?: string;
  prompt: string;
  notice?: string | null;
  onSave: (text: string) => Promise<string | null>;
  onBack: () => void;
}

/**
 * 提示词编辑屏 —— 多行文本交给**系统编辑器**（复用 `/editor` 的 `suspendTerminal` 模式）。
 *
 * 屏内只预览当前提示词；`Enter` 挂起 Ink、用 `$EDITOR`（Windows 默认 notepad）打开临时
 * `.md` 文件，保存回读后写盘；`Esc` 返回。
 */
export function PromptEditorScreen({ columns, rows, title, subtitle, prompt, notice, onSave, onBack }: PromptEditorScreenProps) {
  const { setCursorPosition } = useCursor();
  const { suspendTerminal } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const launch = async () => {
    setError(null);
    const file = join(tmpdir(), `aizen-agent-prompt-${Date.now()}.md`);
    try {
      writeFileSync(file, prompt, "utf-8");
      await suspendTerminal(() => {
        const editor =
          process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi");
        const result = spawnSync(editor, [file], { stdio: "inherit" });
        if (result.error) throw result.error;
      });
      const text = readFileSync(file, "utf-8").replace(/\r\n/g, "\n").trimEnd();
      const failure = await onSave(text);
      if (failure) setError(failure);
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
  const preview = prompt ? wrapText(prompt, Math.max(8, columns - 4)).slice(0, previewBudget) : ["（空）"];
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

