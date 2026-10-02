// 由 src/tui/screens.tsx 拆分而来 —— 对话屏幕 Chat
import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useCursor, useInput, useWindowSize } from "ink";
import { AgentNS } from "@ai-zen/agents-core";
import { AppConfig } from "@ai-zen/agents-sdk";
import { theme } from "../theme.js";
import { Spinner, StatusBar, SlashMenu, SelectItem } from "../components.js";
import { layoutInput, usableFrameRows, isTerminalReply } from "../text.js";
import { ChatSession } from "../chat-session.js";
import { CommandHint, matchCommandHints } from "../../conversation-commands/registry.js";
import { readConfig, readMcpConfig, saveConfig, writeMcpConfig } from "../../config.js";
import { readAgentStore, AgentStore } from "../../agents-store.js";
import { resolveCredential } from "../../config-editor.js";
import { ConfigWizard, McpSnapshot, WizardCloseResult, WizardStep } from "../config-wizard/index.js";
import { computeInputCursorPosition, wordLeft, wordRight } from "./input.js";
import { ChatLayout, computeChatLayout } from "./layout.js";
import { chatReducer } from "./state.js";
import { LineView, messagesToBlocks } from "./render.js";
import { PickerOverlay, Confirm } from "./overlays.js";
import { runCommand } from "./chat-commands.js";

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
      await runCommand(name, trimmed, {
        session: sessionRef.current!,
        dispatch,
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
      return;
    }
    setHistory((h) => [...h, trimmed]);
    await sessionRef.current.send(trimmed);
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

