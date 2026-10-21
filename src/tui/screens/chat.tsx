// 对话屏幕 —— 以 SDK 的 `agent.messages` 为唯一数据源渲染（无自定义中间模型）
import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useCursor, useInput, useWindowSize } from "ink";
import { AgentNS } from "@ai-zen/agents-core";
import { AppConfig } from "@ai-zen/agents-sdk";
import { theme } from "../theme.js";
import { Spinner, StatusBar, SlashMenu, SelectItem } from "../components.js";
import { layoutInput, usableFrameRows, isTerminalReply } from "../text.js";
import { ChatSession, type ChatSessionNotifier } from "../chat-session.js";
import { CommandHint, matchCommandHints } from "../../conversation-commands/registry.js";
import { readConfig, readMcpConfig, saveConfig, writeMcpConfig } from "../../config.js";
import { readAgentStore, AgentStore } from "../../agents-store.js";
import { resolveCredential } from "../../config-editor.js";
import { ConfigWizard, McpSnapshot, WizardCloseResult, WizardStep } from "../config-wizard/index.js";
import { computeInputCursorPosition, wordLeft, wordRight } from "./input.js";
import { ChatLayout, computeChatLayout } from "./layout.js";
import { FrameBuffer } from "./frame-buffer.js";
import { LineView } from "./render.js";
import { messageToLines, transcriptLines } from "./messages-view.js";
import { PickerOverlay, Confirm } from "./overlays.js";
import { chooseHandoffMode } from "./handoff-choice.js";
import { runCommand } from "./chat-commands.js";
import { NoticeChannel, noticeLines, type Notice } from "./notice.js";

// ==================== 对话屏幕 ====================

export interface ChatScreenProps {
  modelId: string;
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
  /** 重挂载时的初始输入（/back 撤回后用于预填） */
  initialInput?: string;
}

/**
 * 计算回车时应提交的文本。
 *
 * 斜杠候选菜单可见时（输入以 `/` 开头且尚未输入参数），回车应**直接执行高亮命令**，
 * 而不是提交半截输入 —— 否则用户只输入 `/` 或未补全的命令名时，回车会落到
 * 「未知命令」报错（体验很差）。非命令输入原样返回。
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

  const [input, setInput] = useState(props.initialInput ?? "");
  /** 光标位置：以 code point 计的字符索引（0..len） */
  const [cursor, setCursor] = useState(Array.from(props.initialInput ?? "").length);
  const [menuIndex, setMenuIndex] = useState(0);
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
  const [wizardAgents, setWizardAgents] = useState<{ id: string; name: string }[]>([]);
  const [wizardMcp, setWizardMcp] = useState<McpSnapshot | null>(null);
  const [wizardAgentStore, setWizardAgentStore] = useState<AgentStore | null>(null);
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

  /** 本轮是否在生成中（spinner / 输入禁用） */
  const [busy, setBusy] = useState(false);
  /** 乐观回显：提交后、真实 user 消息落进 messages 之前，先显示用户提问 */
  const [pendingUser, setPendingUser] = useState<{ text: string; base: number } | null>(null);
  /** 转录显示起点（/clear 清屏用：隐藏此索引之前的消息，但不改上下文） */
  const [transcriptFrom, setTranscriptFrom] = useState(0);

  /**
   * 通知通道：notice / error 走独立栏位，绝不进对话转录（messages）。
   */
  const noticeChannelRef = useRef<NoticeChannel | null>(null);
  if (noticeChannelRef.current == null) noticeChannelRef.current = new NoticeChannel();
  const noticeChannel = noticeChannelRef.current;
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => noticeChannel.subscribe(setNotice), [noticeChannel]);

  /**
   * 渲染信号 + 合帧：SDK 内容变更 → FrameBuffer 合帧 → setTick 触发重渲染。
   * 转录内容始终从 `agent.messages` 现取，tick 只负责「告诉 React 该重画了」。
   */
  const [, setTick] = useState(0);
  const frameBufferRef = useRef<FrameBuffer<null> | null>(null);
  if (frameBufferRef.current == null) {
    frameBufferRef.current = new FrameBuffer<null>(() => setTick((t) => t + 1));
  }

  // 创建会话
  useEffect(() => {
    let disposed = false;
    const notifier: ChatSessionNotifier = {
      onChange: (immediate) => {
        if (disposed) return;
        frameBufferRef.current?.push(null, immediate);
      },
      onNotice: (text, tone) => {
        if (!disposed) noticeChannel.push(text, tone);
      },
    };
    ChatSession.create(
      {
        modelId: props.modelId,
        agentId: props.agentId,
        messages: props.messages,
        conversationId: props.conversationId,
        conversationName: props.conversationName,
        // 自动迁移：与手动 /migrate、/handoff 共用同一套「交接方式三选一」选择器
        requestMode: (info) =>
          chooseHandoffMode(
            setPickerState,
            `上下文即将超限（${info.promptTokens}/${info.maxTokens} tokens）· 选择交接方式`,
          ),
      },
      notifier,
    )
      .then((session) => {
        if (disposed) {
          session.dispose();
          return;
        }
        sessionRef.current = session;
        setReady(true);
        setTick((t) => t + 1);
      })
      .catch((error: any) => setBootError(error?.message ?? String(error)));
    return () => {
      disposed = true;
      frameBufferRef.current?.dispose();
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
      noticeChannel.push(`读取配置失败：${error?.message ?? error}`, "error");
    }
  };

  /** `/key`：直达「当前模型所用端点」的 API Key 编辑步骤 */
  const openKeyEditor = async () => {
    try {
      const config = await readConfig();
      const credential = resolveCredential(config, props.modelId);
      if (!credential) {
        noticeChannel.push(`模型 ${props.modelId} 未绑定可用端点，请用 /config 检查配置`, "error");
        return;
      }
      currentEndpointRef.current = credential.endpointId;
      setWizardConfig(config);
      setWizardStep({ kind: "edit", field: "apiKey", endpointId: credential.endpointId });
    } catch (error: any) {
      noticeChannel.push(`读取配置失败：${error?.message ?? error}`, "error");
    }
  };

  /** 向导关闭：渲染变更摘要；若改到当前端点则重建会话（消息保留） */
  const closeWizard = (result: WizardCloseResult) => {
    setWizardStep(null);
    setWizardConfig(null);
    setWizardMcp(null);
    setWizardAgentStore(null);
    for (const line of result.summary) noticeChannel.push(`配置已更新：${line}`);
    if (!result.dirty) return;

    if (!sessionRef.current) {
      exit({ restart: true, messages: props.messages });
      return;
    }
    const endpointChanged =
      !!currentEndpointRef.current && result.changedEndpointIds.includes(currentEndpointRef.current);
    if (endpointChanged || result.mcpChanged || result.agentsChanged) {
      sessionRef.current
        .reload()
        .then(() => noticeChannel.push("已按新配置重建会话（消息与上下文保留）"))
        .catch((error: any) => noticeChannel.push(`重建会话失败：${error?.message ?? error}`, "error"));
    }
  };

  // ---- 滚动视口控制（应用内翻页，回看历史）----
  const scrollTo = (nextTop: number) => {
    const L = layoutRef.current;
    if (!L) return;
    const maxTop = Math.max(0, L.totalLines - L.budget);
    const clamped = Math.max(0, Math.min(maxTop, nextTop));
    setViewTop(clamped >= maxTop ? null : clamped);
  };
  const scrollByPage = (dir: -1 | 1) => {
    const L = layoutRef.current;
    if (!L) return;
    scrollTo(L.viewTop + dir * Math.max(1, L.budget - 1));
  };
  const scrollByLine = (dir: -1 | 1) => {
    const L = layoutRef.current;
    if (!L) return;
    scrollTo(L.viewTop + dir);
  };
  const scrollToBottom = () => setViewTop(null);

  /** 清屏但保留上下文：把显示起点推到当前消息末尾 */
  const clearTranscript = () => {
    setTranscriptFrom(sessionRef.current?.messages.length ?? 0);
    setNotice(null);
  };

  // ---- 输入编辑（光标感知）----
  const setInputText = (text: string) => {
    setInput(text);
    setCursor(Array.from(text).length);
  };
  const insertAtCursor = (text: string) => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    setInput(chars.slice(0, cp).join("") + text + chars.slice(cp).join(""));
    setCursor(cp + Array.from(text).length);
  };
  const deleteBeforeCursor = () => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    if (cp === 0) return;
    setInput(chars.slice(0, cp - 1).join("") + chars.slice(cp).join(""));
    setCursor(cp - 1);
  };
  const deleteAfterCursor = () => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    if (cp >= chars.length) return;
    setInput(chars.slice(0, cp).join("") + chars.slice(cp + 1).join(""));
  };
  const moveCursor = (delta: number) => {
    const len = Array.from(input).length;
    setCursor((c) => Math.max(0, Math.min(len, c + delta)));
  };
  const moveCursorToLineStart = () => {
    const chars = Array.from(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    let i = cp;
    while (i > 0 && chars[i - 1] !== "\n") i -= 1;
    setCursor(i);
  };
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
    setNotice(null);

    if (trimmed.startsWith("/")) {
      // 命令名取首个 token：支持 `/migrate summary`、`/handoff self` 这类带参数的写法
      const name = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
      // 交接/迁移会调用模型写文档（较慢）：期间应像自动迁移一样拦住输入框。
      const blocksInput = name === "migrate" || name === "migration" || name === "handoff";
      if (blocksInput) setBusy(true);
      try {
        await runCommand(name, trimmed, {
          session: sessionRef.current!,
          notice: (text, tone) => noticeChannel.push(text, tone),
          clearTranscript,
          rows: rows ?? 24,
          exit,
          suspendTerminal,
          openWizard,
          openKeyEditor,
          doExit,
          setPickerState,
          setConfirmState,
          setInputText,
        });
      } finally {
        if (blocksInput) setBusy(false);
      }
      return;
    }

    setHistory((h) => [...h, trimmed]);
    const base = sessionRef.current!.messages.filter((m) => m.role === AgentNS.Role.User).length;
    setPendingUser({ text: trimmed, base });
    setBusy(true);
    try {
      await sessionRef.current!.send(trimmed);
    } finally {
      setBusy(false);
      setPendingUser(null);
    }
  };
  const doExit = () => {
    exit("done");
  };

  // 输入处理
  useInput(
    (char, key) => {
      if (bootError) {
        if (char === "k" || char === "K") {
          void openWizard({ kind: "menu" });
          return;
        }
        if (key.return || key.escape) exit("done");
        return;
      }
      if (isTerminalReply(char)) return;
      if (key.pageUp) {
        scrollByPage(-1);
        return;
      }
      if (key.pageDown) {
        scrollByPage(1);
        return;
      }
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
        clearTranscript();
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
      if (char === "n" && key.ctrl) {
        insertAtCursor("\n");
        return;
      }
      if (key.return) {
        void runSubmit(resolveSubmitText(input, hints, menuIndex));
        return;
      }
      if (key.tab && hints.length > 0) {
        setInputText(`/${hints[menuIndex]?.names[0] ?? ""} `);
        return;
      }
      if (key.upArrow || key.downArrow) {
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
    // 生成 / 自动迁移期间主输入框整体失活：此时输入框已被 Spinner 顶替，若仍激活，
    // 按键会被静默吞进隐藏的输入缓冲、待本轮结束后才冒出来（即「迁移过程中输入框
    // 没被拦住」）。失活后改由下方「忙碌期」处理器只放行中止 / 退出 / 回看滚动。
    { isActive: !busy && !confirmState && !pickerState && !wizardStep },
  );

  // 忙碌期（生成 / 迁移中）专用：输入框不可编辑，仅保留「中止(Ctrl+C) / 退出(Ctrl+D) / 回看滚动」。
  useInput(
    (char, key) => {
      if (isTerminalReply(char)) return;
      if (char === "c" && key.ctrl) {
        sessionRef.current?.abort();
        return;
      }
      if (char === "d" && key.ctrl) {
        void doExit();
        return;
      }
      if (key.pageUp) {
        scrollByPage(-1);
        return;
      }
      if (key.pageDown) {
        scrollByPage(1);
        return;
      }
      if ((key.upArrow || key.downArrow) && (key.shift || key.meta)) {
        scrollByLine(key.upArrow ? -1 : 1);
        return;
      }
    },
    { isActive: busy && !confirmState && !pickerState && !wizardStep },
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
  const lastTokens = session?.lastUsage?.total_tokens;
  const totalTokens = session?.totalUsage.total_tokens;
  const cols = columns ?? 80;

  const messages = session?.messages ?? [];
  const userCount = messages.filter((m) => m.role === AgentNS.Role.User).length;
  const showPending = pendingUser != null && userCount <= pendingUser.base;

  const transcript = transcriptLines(messages.slice(transcriptFrom), cols);
  if (showPending) {
    transcript.push(
      ...messageToLines(
        { id: "__pending_user", role: AgentNS.Role.User, content: pendingUser!.text },
        cols,
      ),
    );
  }

  const noticeTextLines = notice ? noticeLines(notice, cols) : [];
  const layout = computeChatLayout({
    columns: cols,
    rows: usableFrameRows(rows ?? 24),
    transcript,
    input,
    busy,
    hintCount: hints.length,
    noticeCount: noticeTextLines.length,
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
          {noticeTextLines.length > 0 ? (
            <Box flexDirection="column" paddingX={1}>
              {noticeTextLines.map((line, i) => (
                <Text key={i} color={notice?.tone === "error" ? theme.error : theme.dim} wrap="truncate">
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
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
        lastTokens={lastTokens}
        totalTokens={totalTokens}
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
