/**
 * TUI 屏幕 —— 启动界面（Splash）/ 对话（Chat）
 *
 * 交互模型（1.0.0-alpha.1 调整）：
 *   - 启动界面结束后**直接进入对话**；
 *   - 对话屏采用「底部固定」布局：输入框 / 状态栏永远贴底，对话历史在上方滚动。
 *
 * 「底部固定」的实现要点（`computeChatLayout`）：
 *   对话内容先被**按显示宽度预折行**成若干「行」，再自底部向上截取可容纳的行数，
 *   顶部用空白行补齐 —— 使整帧高度恒小于终端行数（预留末行，见 `usableFrameRows`，避免
 *   命中 Ink 全屏分支导致硬件光标上移一行）。每行以 `wrap="truncate"` 渲染，
 *   确保 Ink 不会二次折行。这样即使单条回复远超一屏，也不会撑破帧高（Ink 无法处理
 *   高于终端的帧，会打乱光标重绘）。
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useCursor, useInput, useWindowSize } from "ink";
import { theme, pickLogo, logoGradientColors } from "./theme.js";
import { Spinner, SelectList, StatusBar, SlashMenu, KeyHints, type SelectItem } from "./components.js";
import { displayWidth, wrapText, layoutInput, INPUT_PREFIX_WIDTH, usableFrameRows, isTerminalReply } from "./text.js";
import { ChatSession, stripCwdNote, type ChatEvent } from "./chat-session.js";
import type { CommandHint } from "../conversation-commands/registry.js";
import { matchCommandHints } from "../conversation-commands/registry.js";
import { conversationRepository, listConversations } from "../conversation-repository.js";
import { readConfig, readMcpConfig, saveConfig, writeMcpConfig } from "../config.js";
import { readAgentStore, type AgentStore } from "../agents-store.js";
import { resolveCredential } from "../config-editor.js";
import { ConfigWizard, type McpSnapshot, type WizardCloseResult, type WizardStep } from "./config-wizard.js";
import { formatShortTime } from "../format-time.js";
import { CLI_VERSION, SDK_VERSION, CORE_VERSION } from "../version.js";
import { AgentNS } from "@ai-zen/agents-core";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 文本度量 / 折行 / 整帧高度已抽出到 ./text.js；此处 re-export，保持既有引用与测试不变。
export { displayWidth, wrapText, layoutInput, INPUT_PREFIX_WIDTH, usableFrameRows } from "./text.js";

// ==================== 行模型（对话区按行渲染，精确控高）====================

export type LineKind =
  | "gap"
  | "user-header"
  | "user-text"
  | "ai-header"
  | "reasoning"
  | "tool"
  | "content"
  | "notice"
  | "error";

export interface RLine {
  key: string;
  kind: LineKind;
  text: string;
}

export interface ToolLine {
  name: string;
  args: string;
}

export type Block =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; reasoning: string; content: string; tools: ToolLine[] }
  | { id: number; kind: "notice"; tone: "info" | "error"; text: string };

export interface LiveAssistant {
  reasoning: string;
  content: string;
  tools: ToolLine[];
  sub: string | null;
}

/** 缩进 2 列后的可用文本宽度 */
function innerWidth(columns: number): number {
  return Math.max(4, columns - 4);
}

function indentLines(kind: LineKind, key: string, text: string, width: number): RLine[] {
  return wrapText(text, width).map((line, i) => ({ key: `${key}-${i}`, kind, text: `  ${line}` }));
}

/** 单个对话块 → 若干预折行 */
export function blockToLines(block: Block, columns: number): RLine[] {
  const width = innerWidth(columns);
  const id = `b${block.id}`;
  if (block.kind === "user") {
    return [
      { key: `${id}-gap`, kind: "gap", text: " " },
      { key: `${id}-h`, kind: "user-header", text: "❯ 你" },
      ...indentLines("user-text", id, block.text, width),
    ];
  }
  if (block.kind === "notice") {
    const prefix = block.tone === "error" ? "✖ " : "· ";
    return wrapText(block.text, width).map((line, i) => ({
      key: `${id}-${i}`,
      kind: block.tone === "error" ? ("error" as const) : ("notice" as const),
      text: `  ${i === 0 ? prefix : "  "}${line}`,
    }));
  }
  const lines: RLine[] = [
    { key: `${id}-gap`, kind: "gap", text: " " },
    { key: `${id}-h`, kind: "ai-header", text: "✦ AI" },
  ];
  if (block.reasoning.trim()) {
    lines.push(...indentLines("reasoning", `${id}-r`, block.reasoning.trim(), width));
  }
  for (const tool of block.tools) {
    if (tool.name) lines.push({ key: `${id}-t${lines.length}`, kind: "tool", text: `  ⚙ ${tool.name}` });
  }
  if (block.content.trim()) {
    // 思考 / 工具与正文之间留一个空行，便于区分「过程」与「结论」
    if (lines.length > 2) lines.push({ key: `${id}-cgap`, kind: "gap", text: " " });
    lines.push(...indentLines("content", `${id}-c`, block.content.trim(), width));
  }
  return lines;
}

/** 流式中的 AI 块 → 若干预折行（与完成态一致：前置一个空行隔开上文） */
export function liveToLines(live: LiveAssistant, columns: number): RLine[] {
  const width = innerWidth(columns);
  const id = "live";
  const lines: RLine[] = [
    { key: `${id}-gap`, kind: "gap", text: " " },
    { key: `${id}-h`, kind: "ai-header", text: "✦ AI" },
  ];
  if (live.reasoning.trim()) {
    lines.push(...indentLines("reasoning", `${id}-r`, live.reasoning.trim(), width));
  }
  for (const tool of live.tools) {
    if (tool.name) lines.push({ key: `${id}-t${lines.length}`, kind: "tool", text: `  ⚙ ${tool.name}` });
  }
  if (live.content.trim()) {
    // 思考 / 工具与正文之间留一个空行，便于区分「过程」与「结论」
    if (lines.length > 2) lines.push({ key: `${id}-cgap`, kind: "gap", text: " " });
    lines.push(...indentLines("content", `${id}-c`, live.content.trim(), width));
  }
  return lines;
}

// ==================== 对话屏布局（吸底）====================

/** 输入区文本折行（不含提示符 `❯ `，交由渲染层补齐）；空输入用占位提示 */
export function inputLines(text: string, columns: number): string[] {
  const width = Math.max(4, columns - 4);
  const body = text.length > 0 ? text : "输入消息，/ 查看命令…";
  return layoutInput(body, 0, width).lines;
}

/**
 * 计算终端硬件光标坐标（相对 Ink 输出原点），用于让 IME（输入法）候选框
 * 跟随编辑光标。x 为列、y 为行。
 */
export function computeInputCursorPosition(input: {
  /** 对话区行数（输入区之前的行偏移基数） */
  transcriptLines: number;
  /** 斜杠命令菜单行数 */
  hintCount: number;
  /** 光标在输入框内的行 / 列（列以 code point 计） */
  cursorRow: number;
  cursorCol: number;
  /** 光标所在行的文本（不含提示符） */
  lineText: string;
  /** 是否为空输入占位状态 */
  placeholder: boolean;
}): { x: number; y: number } {
  const before = input.placeholder
    ? ""
    : Array.from(input.lineText).slice(0, input.cursorCol).join("");
  return {
    x: INPUT_PREFIX_WIDTH + displayWidth(before),
    // 对话区 + 斜杠菜单 + 分隔线 + 输入行内偏移
    y: input.transcriptLines + input.hintCount + 1 + input.cursorRow,
  };
}

// ==================== 跨词移动（Ctrl/Alt + ← →）====================

/** 是否为「单词字符」：ASCII 下为字母/数字/下划线，非 ASCII（CJK 等）一律算单词字符 */
export function isWordChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0)!;
  if (code < 128) return /[A-Za-z0-9_]/.test(ch);
  return !/\s/.test(ch);
}

/** 向左跨词后的光标位置（跳过分隔符与单词，停在词首） */
export function wordLeft(text: string, cursor: number): number {
  const chars = Array.from(text);
  let i = Math.max(0, Math.min(cursor, chars.length));
  while (i > 0 && !isWordChar(chars[i - 1])) i -= 1;
  while (i > 0 && isWordChar(chars[i - 1])) i -= 1;
  return i;
}

/** 向右跨词后的光标位置（跳过单词与分隔符，停在词尾） */
export function wordRight(text: string, cursor: number): number {
  const chars = Array.from(text);
  let i = Math.max(0, Math.min(cursor, chars.length));
  while (i < chars.length && !isWordChar(chars[i])) i += 1;
  while (i < chars.length && isWordChar(chars[i])) i += 1;
  return i;
}

/** 确认框固定高度（外 marginTop 1 + 上下边框 2 + 问题 1 + marginTop 1 + 选项 1） */
export const CONFIRM_LINES = 6;
/** 选择覆盖层高度（相对条目数） */
export function pickerLines(itemCount: number): number {
  return 7 + itemCount;
}

export interface ChatLayoutInput {
  columns: number;
  rows: number;
  blocks: Block[];
  live: LiveAssistant | null;
  input: string;
  busy: boolean;
  hintCount: number;
  overlay: "none" | "confirm" | "picker";
  pickerItems: number;
  /** 视口顶部行索引（相对整个对话行）；null / undefined = 贴底（自动跟随最新） */
  viewTop?: number | null;
}

export interface ChatLayout {
  /** 对话区（含顶部补齐空行），行数恒为 `rows - bottomLines` */
  lines: RLine[];
  /** 底部区域（输入 / 覆盖层 + 状态栏）占用行数 */
  bottomLines: number;
  /** 对话框总行数（未截取前） */
  totalLines: number;
  /** 对话区可用高度（已扣除底部区域） */
  budget: number;
  /** 本次实际生效的视口顶部索引 */
  viewTop: number;
  /** 是否处于滚动状态（视口未贴底，下方仍有更新的内容） */
  scrolled: boolean;
}

/**
 * 计算对话屏布局：底部区域高度固定后，把「对话行」按视口截取到可用高度，顶部用空行
 * 补齐 —— 使整帧高度恒等于传入的 `rows`（调用方以 `usableFrameRows()` 预留末行），
 * 输入框稳定吸附底部。
 *
 * `viewTop` 指定视口顶部对应的对话行索引：省略 / `null` 表示贴底（自动跟随最新内容）；
 * 传入具体值时按 [0, totalLines - budget] 钳制，用于「应用内翻页」回看更早的历史。
 */
export function computeChatLayout(input: ChatLayoutInput): ChatLayout {
  const transcript: RLine[] = [];
  for (const block of input.blocks) transcript.push(...blockToLines(block, input.columns));
  if (input.live) transcript.push(...liveToLines(input.live, input.columns));

  const inputHeight = input.busy ? 1 : inputLines(input.input, input.columns).length;
  const overlayHeight =
    input.overlay === "confirm"
      ? CONFIRM_LINES
      : input.overlay === "picker"
        ? pickerLines(input.pickerItems)
        : 0;
  const bottomLines =
    input.overlay === "none"
      ? 1 /* 分隔线 */ + input.hintCount + inputHeight + 1 /* 状态栏 */
      : overlayHeight + 1 /* 状态栏 */;

  const budget = Math.max(0, input.rows - bottomLines);
  const totalLines = transcript.length;
  const maxTop = Math.max(0, totalLines - budget);
  const top = input.viewTop == null ? maxTop : Math.min(Math.max(0, input.viewTop), maxTop);
  const viewLines = transcript.slice(top, top + budget);
  const padTop = Math.max(0, budget - viewLines.length);
  const lines: RLine[] = [
    ...Array.from({ length: padTop }, (_, i) => ({ key: `pad-${i}`, kind: "gap" as const, text: " " })),
    ...viewLines,
  ];
  return { lines, bottomLines, totalLines, budget, viewTop: top, scrolled: top < maxTop };
}

// ==================== Splash（启动界面）====================

const TAGLINE = "终端里的 AI 协作台";

export function Splash({ onDone }: { onDone?: () => void }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const logo = pickLogo(columns ?? 80);
  const [revealed, setRevealed] = useState(0);
  const [phase, setPhase] = useState(0);
  const [ready, setReady] = useState(false);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone?.();
    exit("done");
  };

  useEffect(() => {
    const revealTimer = setInterval(
      () => setRevealed((r) => Math.min(r + 1, logo.length)),
      55,
    );
    const sweepTimer = setInterval(() => setPhase((p) => Math.min(p + 0.05, 1)), 35);
    return () => {
      clearInterval(revealTimer);
      clearInterval(sweepTimer);
    };
  }, [logo.length]);

  useEffect(() => {
    if (revealed >= logo.length && phase >= 1) setReady(true);
  }, [revealed, phase, logo.length]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(finish, 1100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useInput(() => finish());

  const totalRows = rows ?? 24;
  const padTop = Math.max(0, Math.floor((totalRows - (logo.length + 9)) / 2));
  const visibleLogo = logo.slice(0, revealed);
  const logoColors = logoGradientColors(visibleLogo, phase);

  return (
    <Box flexDirection="column" alignItems="center" paddingTop={padTop} width={columns}>
      <Box flexDirection="column" alignItems="center">
        {visibleLogo.map((line, i) => (
          <Text key={i}>
            {[...line].map((ch, x) => (
              <Text key={x} color={logoColors[i]?.[x]}>
                {ch}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.accent}>{TAGLINE}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          v{CLI_VERSION} · sdk {SDK_VERSION} · core {CORE_VERSION}
        </Text>
      </Box>
      <Box marginTop={2} flexDirection="column" alignItems="center">
        {ready ? (
          <Text color={theme.faint}>按任意键开始…</Text>
        ) : (
          <Spinner label="正在准备" />
        )}
      </Box>
    </Box>
  );
}

// ==================== 对话状态与归约器 ====================

export interface ChatState {
  blocks: Block[];
  live: LiveAssistant | null;
}

export type ChatAction = ChatEvent | { type: "clear" };

let blockSeq = 0;
const nextId = () => ++blockSeq;

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "clear":
      return { blocks: [], live: null };
    case "user":
      return {
        blocks: [...state.blocks, { id: nextId(), kind: "user", text: action.text }],
        live: { reasoning: "", content: "", tools: [], sub: null },
      };
    case "assistant-start":
      return {
        ...state,
        live: state.live ?? { reasoning: "", content: "", tools: [], sub: null },
      };
    case "reasoning":
      return state.live
        ? { ...state, live: { ...state.live, reasoning: state.live.reasoning + action.text } }
        : state;
    case "content":
      return state.live
        ? { ...state, live: { ...state.live, content: state.live.content + action.text } }
        : state;
    case "tool": {
      if (!state.live) return state;
      const tools = [...state.live.tools];
      const prev = tools[action.index] ?? { name: "", args: "" };
      tools[action.index] = {
        name: prev.name + (action.name ?? ""),
        args: prev.args + (action.args ?? ""),
      };
      return { ...state, live: { ...state.live, tools } };
    }
    case "subagent-start":
      return state.live ? { ...state, live: { ...state.live, sub: action.name } } : state;
    case "subagent-end":
      return state.live ? { ...state, live: { ...state.live, sub: null } } : state;
    case "notice":
      return {
        ...state,
        blocks: [...state.blocks, { id: nextId(), kind: "notice", tone: "info", text: action.text }],
      };
    case "error":
      return {
        ...state,
        blocks: [...state.blocks, { id: nextId(), kind: "notice", tone: "error", text: action.text }],
      };
    case "done": {
      if (!state.live) return state;
      const { reasoning, content, tools } = state.live;
      // 请求失败时 live 可能为空壳（无思考/内容/工具）——不产生空白的 AI 块
      const isEmpty = !reasoning.trim() && !content.trim() && !tools.some((t) => t.name);
      if (isEmpty) return { ...state, live: null };
      const finished: Block = { id: nextId(), kind: "assistant", reasoning, content, tools };
      return { blocks: [...state.blocks, finished], live: null };
    }
    default:
      return state;
  }
}

// ==================== 行渲染 ====================

function LineView({ line }: { line: RLine }) {
  switch (line.kind) {
    case "gap":
      return <Text>{line.text}</Text>;
    case "user-header":
      return <Text color={theme.user} bold>{line.text}</Text>;
    case "user-text":
      return <Text wrap="truncate">{line.text}</Text>;
    case "ai-header":
      return <Text color={theme.brand[2]} bold>{line.text}</Text>;
    case "reasoning":
      return <Text color={theme.reasoning} italic wrap="truncate">{line.text}</Text>;
    case "tool":
      return <Text color={theme.tool} wrap="truncate">{line.text}</Text>;
    case "content":
      return <Text color={theme.assistant} wrap="truncate">{line.text}</Text>;
    case "notice":
      return <Text color={theme.dim} wrap="truncate">{line.text}</Text>;
    case "error":
      return <Text color={theme.error} wrap="truncate">{line.text}</Text>;
    default:
      return <Text>{line.text}</Text>;
  }
}

// ==================== 消息 → 块（撤回后重建视图）====================

function contentToText(content: AgentNS.MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "image_url"
          ? `[图片: ${part.image_url.url}]`
          : "",
    )
    .join("");
}

export function messagesToBlocks(messages: AgentNS.Message[]): Block[] {
  const blocks: Block[] = [];
  for (const message of messages) {
    if (message.role === AgentNS.Role.User) {
      const text = contentToText(message.content);
      if (text.trim()) blocks.push({ id: nextId(), kind: "user", text });
    } else if (message.role === AgentNS.Role.Assistant) {
      const content = contentToText(message.content);
      const reasoning = message.reasoning_content ?? "";
      const tools: ToolLine[] = (message.tool_calls ?? []).map((tc) => ({
        name: tc.function?.name ?? "",
        args: tc.function?.arguments ?? "",
      }));
      if (content.trim() || reasoning.trim() || tools.some((t) => t.name)) {
        blocks.push({ id: nextId(), kind: "assistant", reasoning, content, tools });
      }
    }
  }
  return blocks;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

// ==================== 选择覆盖层（/back）====================

function PickerOverlay({
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

function Confirm({
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

// ==================== 对话屏幕 ====================

export interface ChatScreenProps {
  modelId: string;
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
  /** 重挂载时的初始输入（/back 撤回后用于预填） */
  initialInput?: string;
  /** 重挂载时是否清空记录显示（/clear：清屏但保留上下文） */
  clearTranscript?: boolean;
}

/**
 * 计算回车时应提交的文本。
 *
 * 斜杠候选菜单可见时（输入以 `/` 开头且尚未输入参数），回车应**直接执行高亮命令**，
 * 而不是提交半截输入 —— 否则用户只输入 `/` 或未补全的命令名时，回车会落到
 * 「未知命令」报错（体验很差）。非命令输入原样返回。
 *
 * `menuIndex` 越界时回落到最后一项，避免菜单看似有选中却回车落空。
 */
export function resolveSubmitText(input: string, hints: CommandHint[], menuIndex: number): string {
  const slash = input.startsWith("/") && !input.includes("\n") && !input.includes(" ");
  if (!slash || hints.length === 0) return input;
  const index = Math.max(0, Math.min(menuIndex, hints.length - 1));
  const picked = hints[index]?.names[0];
  return picked ? `/${picked}` : input;
}

export function Chat(props: ChatScreenProps) {
  const { exit, suspendTerminal } = useApp();
  const { setCursorPosition } = useCursor();
  const { columns, rows } = useWindowSize();
  const [state, dispatch] = useReducer(chatReducer, {
    blocks: props.clearTranscript ? [] : messagesToBlocks(props.messages ?? []),
    live: null,
  });
  const [input, setInput] = useState(props.initialInput ?? "");
  /** 光标位置：以 code point 计的字符索引（0..len） */
  const [cursor, setCursor] = useState(Array.from(props.initialInput ?? "").length);
  const [menuIndex, setMenuIndex] = useState(0);
  // 输入变化后候选集随之改变：高亮重置回首项，避免索引越界（看似选中实为无高亮 / 回车落空）
  useEffect(() => {
    setMenuIndex(0);
  }, [input]);
  const [confirmState, setConfirmState] = useState<{ question: string; resolve: (v: boolean) => void } | null>(null);
  const [pickerState, setPickerState] = useState<{
    title: string;
    items: SelectItem<string>[];
    resolve: (value: string | null) => void;
  } | null>(null);
  /** 配置向导：非 null 时整屏接管（凭据设置 / 配置中心） */
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  const [wizardConfig, setWizardConfig] = useState<AppConfig | null>(null);
  /** 可用 Agent 列表（供配置中心「默认 Agent」选择） */
  const [wizardAgents, setWizardAgents] = useState<{ id: string; name: string }[]>([]);
  /** MCP 配置快照（全局 + 项目），打开向导时刷新 */
  const [wizardMcp, setWizardMcp] = useState<McpSnapshot | null>(null);
  /** Agent / Sub-agent 定义仓储（快照 + 读写），打开向导时刷新 */
  const [wizardAgentStore, setWizardAgentStore] = useState<AgentStore | null>(null);
  /** 当前会话所用端点 id（打开向导时刷新，用于判断改动是否影响本会话） */
  const currentEndpointRef = useRef<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef<number>(-1);
  const sessionRef = useRef<ChatSession | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** 视口顶部行索引；null = 贴底（自动跟随最新内容） */
  const [viewTop, setViewTop] = useState<number | null>(null);
  /** 最近一次布局，供键盘回调读取总行数 / 视口高度（应用内翻页） */
  const layoutRef = useRef<ChatLayout | null>(null);

  const busy = state.live != null;

  // 创建会话
  useEffect(() => {
    let disposed = false;
    ChatSession.create(
      {
        modelId: props.modelId,
        agentId: props.agentId,
        messages: props.messages,
        conversationId: props.conversationId,
        conversationName: props.conversationName,
        requestConfirm: (question) =>
          new Promise<boolean>((resolve) => setConfirmState({ question, resolve })),
      },
      (event) => {
        if (!disposed) dispatch(event);
      },
    )
      .then((session) => {
        if (disposed) {
          session.dispose();
          return;
        }
        sessionRef.current = session;
        setReady(true);
      })
      .catch((error: any) => setBootError(error?.message ?? String(error)));
    return () => {
      disposed = true;
      sessionRef.current?.dispose();
    };
  }, [
    props.modelId,
    props.agentId,
    props.messages,
    props.conversationId,
    props.conversationName,
  ]);

  const resolveConfirm = (value: boolean) => {
    setConfirmState((cs) => {
      cs?.resolve(value);
      return null;
    });
  };

  const resolvePicker = (value: string | null) => {
    setPickerState((ps) => {
      ps?.resolve(value);
      return null;
    });
  };

  // ---- 配置向导（凭据 / 配置中心）----

  /** 打开配置向导：先取配置 / MCP / Agent 快照，再切入指定步骤 */
  const openWizard = async (step: WizardStep) => {
    try {
      const config = await readConfig();
      currentEndpointRef.current = resolveCredential(config, props.modelId)?.endpointId ?? null;
      const agentStore = await readAgentStore();
      setWizardConfig(config);
      setWizardAgents(agentStore.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id })));
      setWizardAgentStore(agentStore);
      setWizardMcp({ global: await readMcpConfig("global"), project: await readMcpConfig("project") });
      setWizardStep(step);
    } catch (error: any) {
      dispatch({ type: "error", text: `读取配置失败：${error?.message ?? error}` });
    }
  };

  /** `/key`：直达「当前模型所用端点」的 API Key 编辑步骤 */
  const openKeyEditor = async () => {
    try {
      const config = await readConfig();
      const credential = resolveCredential(config, props.modelId);
      if (!credential) {
        dispatch({
          type: "error",
          text: `模型 ${props.modelId} 未绑定可用端点，请用 /config 检查配置`,
        });
        return;
      }
      currentEndpointRef.current = credential.endpointId;
      setWizardConfig(config);
      setWizardStep({ kind: "edit", field: "apiKey", endpointId: credential.endpointId });
    } catch (error: any) {
      dispatch({ type: "error", text: `读取配置失败：${error?.message ?? error}` });
    }
  };

  /** 向导关闭：渲染变更摘要；若改到当前端点则重建会话（消息保留） */
  const closeWizard = (result: WizardCloseResult) => {
    setWizardStep(null);
    setWizardConfig(null);
    setWizardMcp(null);
    setWizardAgentStore(null);
    for (const line of result.summary) dispatch({ type: "notice", text: `配置已更新：${line}` });
    if (!result.dirty) return;

    // 会话尚未建立（启动失败进入向导）：重挂载对话屏重试
    if (!sessionRef.current) {
      exit({ restart: true, messages: props.messages });
      return;
    }
    const endpointChanged =
      !!currentEndpointRef.current && result.changedEndpointIds.includes(currentEndpointRef.current);
    if (endpointChanged || result.mcpChanged || result.agentsChanged) {
      sessionRef.current
        .reload()
        .then(() => dispatch({ type: "notice", text: "已按新配置重建会话（消息与上下文保留）" }))
        .catch((error: any) => dispatch({ type: "error", text: `重建会话失败：${error?.message ?? error}` }));
    }
  };

  // ---- 滚动视口控制（应用内翻页，回看历史）----
  /** 跳到指定顶部行；越界钳制；一旦贴到底部则恢复「自动跟随」 */
  const scrollTo = (nextTop: number) => {
    const L = layoutRef.current;
    if (!L) return;
    const maxTop = Math.max(0, L.totalLines - L.budget);
    const clamped = Math.max(0, Math.min(maxTop, nextTop));
    setViewTop(clamped >= maxTop ? null : clamped);
  };
  /** 翻页滚动（dir：-1 上翻 / +1 下翻） */
  const scrollByPage = (dir: -1 | 1) => {
    const L = layoutRef.current;
    if (!L) return;
    scrollTo(L.viewTop + dir * Math.max(1, L.budget - 1));
  };
  /** 单行滚动（dir：-1 上 / +1 下） */
  const scrollByLine = (dir: -1 | 1) => {
    const L = layoutRef.current;
    if (!L) return;
    scrollTo(L.viewTop + dir);
  };
  /** 回到最新（贴底，恢复自动跟随） */
  const scrollToBottom = () => setViewTop(null);

  // ---- 输入编辑（光标感知）----
  /** 替换整个输入并把光标移到末尾 */
  const setInputText = (text: string) => {
    setInput(text);
    setCursor(Array.from(text).length);
  };
  /** 在光标处插入文本 */
  const insertAtCursor = (text: string) => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    setInput(chars.slice(0, cp).join("") + text + chars.slice(cp).join(""));
    setCursor(cp + Array.from(text).length);
  };
  /** 删除光标前一个字符（Backspace） */
  const deleteBeforeCursor = () => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    if (cp === 0) return;
    setInput(chars.slice(0, cp - 1).join("") + chars.slice(cp).join(""));
    setCursor(cp - 1);
  };
  /** 删除光标后一个字符（Delete） */
  const deleteAfterCursor = () => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    if (cp >= chars.length) return;
    setInput(chars.slice(0, cp).join("") + chars.slice(cp + 1).join(""));
  };
  /** 以字符为单位移动光标 */
  const moveCursor = (delta: number) => {
    const len = Array.from(input).length;
    setCursor((c) => Math.max(0, Math.min(len, c + delta)));
  };
  /** 光标移到当前逻辑行行首（Home） */
  const moveCursorToLineStart = () => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    let i = cp;
    while (i > 0 && chars[i - 1] !== "\n") i -= 1;
    setCursor(i);
  };
  /** 光标移到当前逻辑行行尾（End） */
  const moveCursorToLineEnd = () => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    let i = cp;
    while (i < chars.length && chars[i] !== "\n") i += 1;
    setCursor(i);
  };

  // 命令候选人
  const slash = input.startsWith("/") && !input.includes("\n") && !input.includes(" ");
  const hints: CommandHint[] = slash ? matchCommandHints(input.slice(1)) : [];

  const runSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !sessionRef.current || busy) return;
    setInputText("");
    historyIndex.current = -1;
    scrollToBottom();

    if (trimmed.startsWith("/")) {
      const name = trimmed.slice(1).toLowerCase();
      await runCommand(name, trimmed);
      return;
    }
    setHistory((h) => [...h, trimmed]);
    await sessionRef.current.send(trimmed);
  };

  const runCommand = async (name: string, raw: string) => {
    const session = sessionRef.current!;
    const push = (text: string, tone: "info" | "error" = "info") => {
      if (tone === "error") dispatch({ type: "error", text });
      else dispatch({ type: "notice", text });
    };

    switch (name) {
      case "config":
        await openWizard({ kind: "menu" });
        break;
      case "key":
        await openKeyEditor();
        break;
      case "help": {
        const lines = ["可用命令："];
        for (const hint of matchCommandHints("")) {
          lines.push(`  ${hint.label}  ${hint.description}`);
        }
        push(lines.join("\n"));
        break;
      }
      case "clear":
        // 清屏但保留上下文：重挂载对话屏且不重建历史
        exit({ restart: true, messages: session.messages, clearTranscript: true });
        break;
      case "new":
        await session.reset();
        dispatch({ type: "clear" });
        push("已开始新对话");
        break;
      case "save": {
        try {
          const id = await session.save();
          push(`对话已保存：${id}`);
        } catch (error: any) {
          push(`保存失败：${error?.message ?? error}`, "error");
        }
        break;
      }
      case "load": {
        const list = await listConversations();
        if (list.length === 0) {
          push("还没有已保存的对话", "error");
          break;
        }
        const allItems: SelectItem<string>[] = list.map((c) => ({
          label: c.name,
          value: c.id,
          hint: formatShortTime(c.updatedAt),
        }));
        // 覆盖层不能高于终端：仅展示最近的有限条
        const maxItems = Math.max(1, (rows ?? 24) - 8);
        const items = allItems.slice(0, maxItems);
        const title =
          allItems.length > maxItems
            ? `选择要加载的对话（仅显示最近 ${maxItems} 条）`
            : "选择要加载的对话（当前会话将被替换）";
        const choice = await new Promise<string | null>((resolve) =>
          setPickerState({ title, items, resolve }),
        );
        if (choice == null) {
          push("已取消加载");
          break;
        }
        const conversation = await conversationRepository.read(choice);
        if (!conversation) {
          push(`对话不存在或读取失败：${choice}`, "error");
          break;
        }
        // 整体切换会话（含模型 / Agent）——交由上层重挂载对话屏
        exit({
          load: {
            modelId: conversation.modelId,
            agentId: conversation.agentId,
            messages: conversation.messages,
            conversationId: conversation.id,
            conversationName: conversation.id,
          },
        });
        break;
      }
      case "migrate": {
        if (!session.messages.some((m) => m.role === AgentNS.Role.User)) {
          push("当前对话还没有可迁移的内容", "error");
          break;
        }
        const ok = await new Promise<boolean>((resolve) => setConfirmState({ question: "确定对当前对话进行任务迁移吗？", resolve }));
        if (!ok) {
          push("已取消迁移");
          break;
        }
        try {
          await session.migrate();
          push("任务迁移完成，已开启新会话");
        } catch (error: any) {
          push(`任务迁移失败：${error?.message ?? error}`, "error");
        }
        break;
      }
      case "back": {
        const allItems: SelectItem<string>[] = [];
        session.messages.forEach((message, index) => {
          if (message.role !== AgentNS.Role.User) return;
          const content = typeof message.content === "string" ? message.content : "";
          allItems.push({ label: truncate(stripCwdNote(content), 60), value: String(index) });
        });
        if (allItems.length === 0) {
          push("还没有可撤回的消息", "error");
          break;
        }
        // 最近的在最前；仅展示最近的有限条，避免覆盖层高于终端
        const maxItems = Math.max(1, (rows ?? 24) - 8);
        const items = allItems.reverse().slice(0, maxItems);
        const title =
          allItems.length > maxItems
            ? `选择要撤回到的消息（仅显示最近 ${maxItems} 条）`
            : "选择要撤回到的消息（其后内容将被移除）";
        const choice = await new Promise<string | null>((resolve) =>
          setPickerState({ title, items, resolve }),
        );
        if (choice == null) {
          push("已取消撤回");
          break;
        }
        const text = session.rollbackTo(Number(choice));
        exit({ restart: true, messages: session.messages, initialInput: text });
        break;
      }
      case "editor": {
        const file = join(tmpdir(), `aizen-input-${Date.now()}.md`);
        try {
          writeFileSync(file, "", "utf-8");
          await suspendTerminal(() => {
            const editor =
              process.env.EDITOR ||
              process.env.VISUAL ||
              (process.platform === "win32" ? "notepad" : "vi");
            const result = spawnSync(editor, [file], { stdio: "inherit" });
            if (result.error) throw result.error;
          });
          const text = readFileSync(file, "utf-8").trim();
          if (text) setInputText(text);
        } catch (error: any) {
          push(`编辑器打开失败：${error?.message ?? error}`, "error");
        } finally {
          try {
            unlinkSync(file);
          } catch {
            /* 忽略 */
          }
        }
        break;
      }
      case "exit":
      case "quit": {
        await doExit();
        break;
      }
      default:
        push(`未知命令：${raw}（输入 /help 查看可用命令）`, "error");
    }
  };

  const doExit = () => {
    // 会话已由 ConversationPersistPlugin 实时落盘，退出无需再询问是否保存
    exit("done");
  };

  // 输入处理
  useInput(
    (char, key) => {
      // 启动失败：给出「按 k 打开配置中心」的出路，而不是只能退出
      if (bootError) {
        if (char === "k" || char === "K") {
          void openWizard({ kind: "menu" });
          return;
        }
        if (key.return || key.escape) exit("done");
        return;
      }
      // 终端应答序列（如 Kitty 查询应答 `[?0u`）不是用户输入，丢弃
      if (isTerminalReply(char)) return;
      // 翻页滚动（回看历史）
      if (key.pageUp) {
        scrollByPage(-1);
        return;
      }
      if (key.pageDown) {
        scrollByPage(1);
        return;
      }
      // 换行：Ctrl+Enter / Alt+Enter / Shift+Enter
      // （仅当终端**原生**以 Kitty CSI-u 序列上报这些组合键时才生效 —— 本 CLI 不再
      //   主动查询/开启该协议，见 tui/index.tsx 的 RENDER_OPTIONS；换行主推 Ctrl+N）
      if (key.return && (key.ctrl || key.meta || key.shift)) {
        insertAtCursor("\n");
        return;
      }
      if (char === "c" && key.ctrl) {
        if (busy) sessionRef.current?.abort();
        else void doExit();
        return;
      }
      if (char === "d" && key.ctrl) {
        void doExit();
        return;
      }
      if (char === "l" && key.ctrl) {
        exit({ restart: true, messages: sessionRef.current?.messages, clearTranscript: true });
        return;
      }
      if (char === "u" && key.ctrl) {
        setInputText("");
        return;
      }
      if (char === "j" && key.ctrl) {
        insertAtCursor("\n");
        return;
      }
      // 换行：Ctrl+N（不依赖终端协议，兼容性最好）
      if (char === "n" && key.ctrl) {
        insertAtCursor("\n");
        return;
      }
      if (key.return) {
        // 斜杠候选菜单可见时回车直接执行高亮命令，避免把半截输入（如仅 `/`）当命令提交
        void runSubmit(resolveSubmitText(input, hints, menuIndex));
        return;
      }
      if (key.tab && hints.length > 0) {
        setInputText(`/${hints[menuIndex]?.names[0] ?? ""} `);
        return;
      }
      if (key.upArrow || key.downArrow) {
        // Shift / Alt + ↑↓：单行滚动（优先于历史召回）
        if (key.shift || key.meta) {
          scrollByLine(key.upArrow ? -1 : 1);
          return;
        }
        if (hints.length > 0) {
          setMenuIndex((i) =>
            key.upArrow ? (i - 1 + hints.length) % hints.length : (i + 1) % hints.length,
          );
          return;
        }
        // 历史召回
        if (key.upArrow && history.length > 0) {
          const idx = historyIndex.current < 0 ? history.length - 1 : Math.max(0, historyIndex.current - 1);
          historyIndex.current = idx;
          setInputText(history[idx]);
        } else if (key.downArrow && historyIndex.current >= 0) {
          const idx = historyIndex.current + 1;
          if (idx >= history.length) {
            historyIndex.current = -1;
            setInputText("");
          } else {
            historyIndex.current = idx;
            setInputText(history[idx]);
          }
        }
        return;
      }
      // 光标移动：← → 单字符，Ctrl/Alt+← → 跨词，Home / End 到行首 / 行尾
      if (key.leftArrow) {
        if (key.ctrl || key.meta) setCursor(wordLeft(input, cursor));
        else moveCursor(-1);
        return;
      }
      if (key.rightArrow) {
        if (key.ctrl || key.meta) setCursor(wordRight(input, cursor));
        else moveCursor(1);
        return;
      }
      if (key.home) {
        moveCursorToLineStart();
        return;
      }
      if (key.end) {
        moveCursorToLineEnd();
        return;
      }
      if (key.escape) {
        setInputText("");
        scrollToBottom();
        return;
      }
      if (key.backspace) {
        deleteBeforeCursor();
        return;
      }
      if (key.delete) {
        deleteAfterCursor();
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        insertAtCursor(char);
      }
    },
    { isActive: !confirmState && !pickerState && !wizardStep },
  );

  // 配置向导：整屏接管（凭据设置 / 配置中心），关闭后回到对话屏
  if (wizardStep && wizardConfig) {
    return (
      <ConfigWizard
        config={wizardConfig}
        initialStep={wizardStep}
        closeOnSave={wizardStep.kind !== "menu"}
        agents={wizardAgents}
        mcp={wizardMcp ?? undefined}
        agentStore={wizardAgentStore ?? undefined}
        onSave={saveConfig}
        onSaveMcp={async (scope, cfg) => {
          await writeMcpConfig(cfg, scope);
        }}
        onClose={closeWizard}
      />
    );
  }

  if (bootError) {
    setCursorPosition(undefined);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error} wrap="truncate">
          ✖ 无法启动对话：{bootError}
        </Text>
        <Text color={theme.dim} wrap="truncate">
          按 k 打开配置中心（可设置 API Key / 端点地址）· Enter 返回
        </Text>
      </Box>
    );
  }

  const session = sessionRef.current;
  const tokens = session?.lastUsage?.total_tokens;
  const cols = columns ?? 80;

  const layout = computeChatLayout({
    columns: cols,
    rows: usableFrameRows(rows ?? 24),
    blocks: state.blocks,
    live: state.live,
    input,
    busy,
    hintCount: hints.length,
    overlay: confirmState ? "confirm" : pickerState ? "picker" : "none",
    pickerItems: pickerState?.items.length ?? 0,
    viewTop,
  });
  layoutRef.current = layout;
  const isPlaceholder = input.length === 0;
  const inputLayout = layoutInput(
    isPlaceholder ? "输入消息，/ 查看命令…" : input,
    isPlaceholder ? 0 : cursor,
    Math.max(4, cols - 4),
  );
  const bodyLines = inputLayout.lines;

  // 把终端硬件光标移到编辑光标处，让 IME（输入法）候选框正确定位
  if (!busy && !confirmState && !pickerState) {
    setCursorPosition(
      computeInputCursorPosition({
        transcriptLines: layout.lines.length,
        hintCount: hints.length,
        cursorRow: inputLayout.cursorRow,
        cursorCol: inputLayout.cursorCol,
        lineText: bodyLines[inputLayout.cursorRow] ?? "",
        placeholder: isPlaceholder,
      }),
    );
  } else {
    setCursorPosition(undefined);
  }

  return (
    <Box flexDirection="column" width={cols}>
      {layout.lines.map((line) => (
        <LineView key={line.key} line={line} />
      ))}

      {confirmState ? (
        <Confirm question={confirmState.question} onAnswer={resolveConfirm} />
      ) : pickerState ? (
        <PickerOverlay title={pickerState.title} items={pickerState.items} columns={cols} onPick={resolvePicker} />
      ) : (
        <Box flexDirection="column">
          {hints.length > 0 ? <SlashMenu hints={hints} selected={menuIndex} /> : null}
          <Box paddingX={1}>
            <Text color={theme.border} wrap="truncate">
              {"─".repeat(Math.max(1, cols - 2))}
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={1}>
            {busy ? (
              <Spinner label="思考中…" />
            ) : (
              bodyLines.map((line, i) => {
                const prompt =
                  i === 0 ? (
                    <Text color={theme.brand[0]} bold>
                      {"❯ "}
                    </Text>
                  ) : (
                    <Text>{"  "}</Text>
                  );
                if (isPlaceholder) {
                  return (
                    <Text key={i} wrap="truncate">
                      {prompt}
                      <Text color={theme.faint}>{line}</Text>
                      {i === bodyLines.length - 1 ? (
                        <Text color={theme.brand[1]}>▏</Text>
                      ) : null}
                    </Text>
                  );
                }
                if (i === inputLayout.cursorRow) {
                  const rowChars = Array.from(line);
                  const before = rowChars.slice(0, inputLayout.cursorCol).join("");
                  const at = rowChars[inputLayout.cursorCol];
                  const after = rowChars.slice(inputLayout.cursorCol + 1).join("");
                  return (
                    <Text key={i} wrap="truncate">
                      {prompt}
                      <Text>{before}</Text>
                      <Text inverse color={theme.brand[0]}>
                        {at ?? " "}
                      </Text>
                      <Text>{after}</Text>
                    </Text>
                  );
                }
                return (
                  <Text key={i} wrap="truncate">
                    {prompt}
                    <Text>{line}</Text>
                  </Text>
                );
              })
            )}
          </Box>
        </Box>
      )}

      <StatusBar
        model={props.modelId}
        agent={props.agentId ?? "default"}
        tokens={tokens}
        busy={busy}
        hint={
          !ready
            ? "初始化中…"
            : layout.scrolled
              ? "↕ 滚动中 · PgUp/PgDn 翻页 · 发送回到底部"
              : "Enter 发送 · Ctrl+N 换行 · / 命令 · PgUp 看历史"
        }
      />
    </Box>
  );
}
