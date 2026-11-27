// 多行文本编辑屏 PromptEditorScreen（AgentDefinition 的提示词 / 函数说明 / 参数 schema）
//
// ## 为什么内容不在这屏里敲
//
// 这三处都是整段文本（提示词上千行不稀奇，参数 schema 是 JSON）。TUI 里逐字敲既没有语法
// 高亮也没有撤销，重造一个编辑器是赔本买卖：内容交给用户的 `$EDITOR`，与 `/editor`
// （`commands/handlers.ts` 的 `cmdEditor`）走同一条路 —— 那条路已经证明在真终端里好用。
// 本屏只做三件事：摆出当前内容、挂起 Ink 把终端交给编辑器、把改完的文本交给调用方去写盘。
//
// ## 写盘是调用方的事
//
// 本屏不认识宿主、也不认识 `agent.update`：`onSave` 返回 `null` 就是写成了，返回字符串就是
// 一句要上屏的失败原因。参数 schema 的 JSON 校验因此落在调用方（`step-agents.tsx`），
// 由它把「非法 JSON」变成一个字符串返回 —— 本屏只负责把错误摆在上面、把用户改过的内容留住。
import { useState } from "react";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Text, useApp, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { KeyHints } from "../components.js";
import { usableFrameRows, wrapText } from "../text.js";
import { openInSystemEditor, systemEditorCommand } from "../../system-editor.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";
import { ListStep } from "./list.js";
import { t } from "../../i18n/index.js";

/**
 * 打开系统编辑器的实现（默认 `openInSystemEditor`）。
 *
 * 用例注入假实现：真起一个 `vi` 会把用例挂住，而本仓不用 `vi.mock`（`vitest.config.ts` 的
 * `isolate: false`：按模块说明符注册的 mock 会串到别的文件）。
 */
export type OpenEditor = (editor: string, file: string) => void | Promise<void>;

export interface PromptEditorScreenProps {
  columns: number;
  rows: number;
  title: string;
  subtitle?: string;
  /** 待编辑的多行文本（当前内容） */
  text: string;
  /**
   * 临时文件后缀（默认 md）。
   *
   * 参数 schema 传 `json`：编辑器那边才有语法高亮与格式化，用户手改一份 schema 不必对着
   * 一片纯文本数括号。
   */
  ext?: string;
  notice?: string | null;
  /** 打开编辑器的实现（缺省 `openInSystemEditor`）；见 `OpenEditor` */
  openEditor?: OpenEditor;
  /**
   * 写盘之前先出一次确认，即「二次确认要能先给代价、再真做」。
   *
   * AgentDefinition 的提示词 / 函数说明 / 参数 schema 是定义的一部分：改一次，所有用这个 AgentDefinition 的会话都跟
   * 着变，所以保存之前先把代价摆出来（措辞是「正在看的那段回答会断」）。
   */
  confirm?: { title: string; cost: readonly string[] };
  /** 保存：`null` = 写成，字符串 = 要上屏的失败原因 */
  onSave: (text: string) => Promise<string | null>;
  onBack: () => void;
}

/**
 * 多行文本编辑屏。
 *
 * 屏内只预览当前内容；`Enter` 挂起 Ink、用 `$EDITOR`（Windows 默认 notepad）打开临时
 * 文件，改完保存后回读、比对、交给 `onSave`；`Esc` 直接返回，一个字段都不改。
 *
 * 两处务实的选择：
 *   - 没改动就不写盘：编辑器原样退出（`:q`）不该换来一次 `agent.update` ——
 *     那会把出厂 AgentDefinition 静默标成自定义，并多出一条通知；
 *   - 校验失败保留草稿（`draft`）：参数 schema 不是合法 JSON 时，用户刚打的那几十行还在
 *     屏上，再按 `Enter` 是在它上面接着改，而不是退回原值重敲。
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
  confirm,
  onSave,
  onBack,
}: PromptEditorScreenProps) {
  const { setCursorPosition } = useCursor();
  const { suspendTerminal } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  /** 待确认写入的那份文本（带 `confirm` 时先停在这里，确认之前一个写请求都不发） */
  const [pending, setPending] = useState<string | null>(null);
  // 草稿优先：失败过一次之后屏上/编辑器里都该是「用户改过的那份」
  const current = draft ?? text;

  /** 真的把那一次写发出去（确认之后的写进 messages） */
  const commit = async (edited: string) => {
    try {
      const failure = await onSave(edited);
      if (failure) {
        // 写没成：退回编辑屏把原因摆出来（草稿留着，再按 Enter 是在它上面接着改）
        setPending(null);
        setError(failure);
        return;
      }
      // 成功：交回父级给的最新内容（`agent.update` 的返回值已经换进了快照）
      setDraft(null);
      setPending(null);
    } catch (cause: unknown) {
      setPending(null);
      setError(
        t("wiz.openEditorFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  };

  const launch = async () => {
    setError(null);
    setHint(null);
    const before = current;
    const file = join(tmpdir(), `aizen-edit-${Date.now()}.${ext}`);
    try {
      writeFileSync(file, before, "utf-8");
      // 挂起 Ink 再起编辑器：用户敲字的那几分钟里帧不能继续重绘（与 `/editor` 同一条路）
      await suspendTerminal(() => (openEditor ?? openInSystemEditor)(systemEditorCommand(), file));
      // 编辑器普遍会在末尾补换行：这一行差异不是用户改的内容
      const edited = readFileSync(file, "utf-8").replace(/\r\n/g, "\n").trimEnd();
      if (edited === before) {
        setHint(t("wiz.editorUnchanged"));
        return;
      }
      setDraft(edited);
      // 带 `confirm` 的地方：先把代价摆出来，人点头了才写
      if (confirm) {
        setPending(edited);
        return;
      }
      await commit(edited);
    } catch (cause: unknown) {
      setError(
        t("wiz.openEditorFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } finally {
      try {
        unlinkSync(file);
      } catch {
        /* 临时文件删不掉不影响这次编辑：失败原因已经上屏或已经写成 */
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
    // 确认子屏自己收键：同一屏两层 `useInput` 会让回车既确认又重开编辑器
    { isActive: !busy && pending === null },
  );

  if (pending !== null && confirm) {
    const waiting = pending;
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={confirm.title}
        subtitle={confirm.cost.join("\n")}
        items={[
          { label: t("common.yes"), value: "yes" },
          { label: t("common.no"), value: "no" },
        ]}
        onPick={(picked) => {
          if (picked === "yes") void commit(waiting);
          else setPending(null);
        }}
        onCancel={() => setPending(null)}
      />
    );
  }

  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(subtitle ? textRows(subtitle, columns, theme.dim) : []),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
    ...(hint ? textRows(`· ${hint}`, columns, theme.dim) : []),
    ...(error ? textRows(`✖ ${error}`, columns, theme.error) : []),
  ];
  // 预览按剩余行数截断：正文再长也不能把吸底布局顶出可视区（与各详情屏同一处约束）
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
