// 对话屏幕 —— 以 SDK 的 `agent.messages` 为唯一数据源渲染（无自定义中间模型）
import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useCursor, useInput, useWindowSize } from "ink";
import { keyDebug } from "../key-debug.js";
import { parseWheel, WHEEL_STEP } from "../mouse.js";
import type { RateSample } from "../token-rate.js";
import { AgentNS } from "@ai-zen/agents-core";
import { AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { theme } from "../theme.js";
import { Spinner, StatusBar, statusBarRows, SlashMenu, SelectItem, type StatusBarProps } from "../components.js";
import { graphemes, layoutInput, usableFrameRows, isTerminalReply } from "../text.js";
import { ChatSession, type ChatSessionNotifier } from "../chat-session.js";
import { CommandHint, matchCommandHints } from "../../conversation-commands/registry.js";
import { readConfig, readMcpConfig, readReasoningPresets, saveConfig, writeMcpConfig } from "../../config.js";
import { readAgentStore, AgentStore } from "../../agents-store.js";
import { resolveCredential } from "../../config-editor.js";
import { ConfigWizard, McpSnapshot, WizardCloseResult, WizardStep } from "../config-wizard/index.js";
import { computeInputCursorPosition, deleteToLineEnd, deleteToLineStart, deleteWordLeft, deleteWordRight, wordLeft, wordRight } from "./input.js";
import {
  deleteToPrevWhitespace,
  killedText,
  killAt,
  popUndo,
  pushKill,
  pushUndo,
  type EditState,
} from "../input-editing.js";
import { ChatLayout, clampViewTop, computeChatLayout } from "./layout.js";
import { FrameBuffer } from "./frame-buffer.js";
import { LineView } from "./render.js";
import { messageToLines, transcriptLines } from "./messages-view.js";
import { PickerOverlay, Confirm } from "./overlays.js";
import { CursorInputRow, type CursorPosition } from "./input-row.js";
import { chooseHandoffMode } from "./handoff-choice.js";
import { runCommand } from "./chat-commands.js";
import { describeEffortView } from "../../reasoning-effort.js";
import { t } from "../../i18n/index.js";
import { NoticeChannel, noticeLines, type Notice } from "./notice.js";

// ==================== 对话屏幕 ====================

export interface ChatScreenProps {
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
  /** 重挂载时的初始输入（/back 撤回后用于预填） */
  initialInput?: string;
  /** 重挂载后展示一次的系统提示（如 /model 的写入结果，旧实例已卸载） */
  initialNotice?: string;
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
  const [cursor, setCursor] = useState(graphemes(props.initialInput ?? "").length);
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
  const [wizardPresets, setWizardPresets] = useState<ReasoningPresets>({});
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
  /** 生成速率快照（token/s）：生成中为实时值，结束后保留本轮平均 */
  const [rate, setRate] = useState<RateSample | null>(null);
  /**
   * 当前模型 id —— **从会话（即 Agent 定义）读**，不作为 prop 传入。
   *
   * 模型的唯一真相源是 `AgentDefinition.modelId`：所以状态栏、凭据检查、思考状态
   * 与 SDK 实发请求用的永远是同一个值，不会出现「显示 A、实发 B」。
   */
  const [modelId, setModelId] = useState<string>("");

  /**
   * 思考强度展示文案（关 / 低 / 中 / 高 / 最高 / 开 / —）。
   *
   * 真相在配置里（模型的 `defaultParams`），这里只镜像一份供状态栏用：
   * `/think` 写入后由命令层回调刷新，切模型（会话重建）时靠 `modelId` 变化重读。
   */
  const [effortView, setEffortView] = useState<{ text: string; dimmed: boolean } | null>(null);
  /**
   * 语言切换计数（`/lang`）：`t()` 是模块级函数，语言变了已渲染的文案不会自更新，
   * 递增这个计数只为逼 React 重跑一遍渲染函数。
   */
  const [localeTick, bumpLocale] = useState(0);
  /**
   * IME 光标位置：由光标所在行**渲染后实测**而来（渲染器给的帧内坐标）。
   * 带上 key —— 只有「产生它的那个输入状态」与当前一致时才能用，否则就是上一帧的陈旧值。
   */
  const [imePosition, setImePosition] = useState<{
    key: string;
    position: CursorPosition;
  } | null>(null);
  /** 乐观回显：提交后、真实 user 消息落进 messages 之前，先显示用户提问 */
  const [pendingUser, setPendingUser] = useState<{ text: string; base: number } | null>(null);
  /** 转录显示起点（/clear 清屏用：隐藏此索引之前的消息，但不改上下文） */
  const [transcriptFrom, setTranscriptFrom] = useState(0);

  // ---- Claude Code 同款编辑状态 ----
  /** kill ring：Ctrl+W/U/K 删掉的文本，Ctrl+Y 取回、Alt+Y 循环 */
  const killRingRef = useRef<string[]>([]);
  const yankIndexRef = useRef(-1);
  /** 编辑撤销栈（Ctrl+_） */
  const undoStackRef = useRef<EditState[]>([]);
  /** 暂存区（Ctrl+S） */
  const stashRef = useRef<EditState | null>(null);
  /** Ctrl+D 双击退出计时 */
  const ctrlDAtRef = useRef(0);

  /**
   * 通知通道：notice / error 走独立栏位，绝不进对话转录（messages）。
   */
  const noticeChannelRef = useRef<NoticeChannel | null>(null);
  if (noticeChannelRef.current == null) noticeChannelRef.current = new NoticeChannel();
  const noticeChannel = noticeChannelRef.current;
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => noticeChannel.subscribe(setNotice), [noticeChannel]);

  /**
   * 重挂载附带的系统提示（如 `/model` 的切换结果）。
   *
   * 用 ref 而非 props 直读：本值只在首次挂载消费一次，若写进 create 的依赖数组，
   * 会把「展示一条提示」误变成「重建会话」。
   */
  const initialNoticeRef = useRef(props.initialNotice);

  /**
   * 渲染信号 + 合帧：SDK 内容变更 → FrameBuffer 合帧 → setTick 触发重渲染。
   * 转录内容始终从 `agent.messages` 现取，tick 只负责「告诉 React 该重画了」。
   */
  const [, setTick] = useState(0);
  const frameBufferRef = useRef<FrameBuffer<null> | null>(null);
  if (frameBufferRef.current == null) {
    frameBufferRef.current = new FrameBuffer<null>(() => setTick((t) => t + 1));
  }

  // 思考强度展示：从当前模型的 defaultParams 派生；`/think` 写入后由命令层回调刷新，
  // 切模型（会话重建）时靠 modelId 变化重读。
  useEffect(() => {
    if (!modelId) return;
    let alive = true;
    // 档位存在 Agent 定义上（`modelParams`），可选档位在策略表里（`reasoningPreset` 指向），两者都要读
    Promise.all([readConfig(), readAgentStore(), readReasoningPresets()])
      .then(([config, store, presets]) => {
        const model = config.models?.find((item) => item.id === modelId);
        const agentId = props.agentId ?? "default";
        const definition = store.agents.find((item) => item.id === agentId) ?? null;
        if (alive) setEffortView(describeEffortView(model, presets, definition));
      })
      .catch(() => {
        if (alive) setEffortView(null);
      });
    return () => {
      alive = false;
    };
    // localeTick：切语言后档位文案要重算（它缓存的是已本地化的字符串，不是档位名）
  }, [modelId, props.agentId, localeTick]);

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
        agentId: props.agentId,
        messages: props.messages,
        conversationId: props.conversationId,
        conversationName: props.conversationName,
        // 自动迁移：与手动 /migrate、/handoff 共用同一套「交接方式三选一」选择器
        requestMode: (info) =>
          chooseHandoffMode(
            setPickerState,
            t("handoff.pickTitle", { used: info.promptTokens, limit: info.handoffTokens }),
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
        setModelId(session.modelId);
        setReady(true);
        // 重挂载附带的提示只需展示一次（消费后置空，避免再次触发）
        if (initialNoticeRef.current) {
          noticeChannel.push(initialNoticeRef.current);
          initialNoticeRef.current = undefined;
        }
        setTick((t) => t + 1);
      })
      .catch((error: any) => setBootError(error?.message ?? String(error)));
    return () => {
      disposed = true;
      frameBufferRef.current?.dispose();
      sessionRef.current?.dispose();
    };
  }, [
    props.agentId,
    props.messages,
    props.conversationId,
    props.conversationName,
  ]);

  // 速率采样：Spinner 的重渲染只影响它自己，不会带着状态栏一起刷，所以生成中要自己定时读快照。
  // 生成结束（busy → false）时再读一次，拿本轮平均速率并留在状态栏上。
  useEffect(() => {
    const read = () => setRate(sessionRef.current?.rateSample ?? null);
    read();
    if (!busy) return;
    const timer = setInterval(read, 250);
    return () => clearInterval(timer);
  }, [busy]);

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
      currentEndpointRef.current = resolveCredential(config, modelId)?.endpointId ?? null;
      const agentStore = await readAgentStore();
      setWizardConfig(config);
      setWizardPresets(await readReasoningPresets());
      setWizardAgents(agentStore.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id })));
      setWizardAgentStore(agentStore);
      setWizardMcp({ global: await readMcpConfig("global"), project: await readMcpConfig("project") });
      setWizardStep(step);
    } catch (error: any) {
      noticeChannel.push(t("chat.configReadFailed", { error: error?.message ?? error }), "error");
    }
  };

  /** `/key`：直达「当前模型所用端点」的 API Key 编辑步骤 */
  const openKeyEditor = async () => {
    try {
      const config = await readConfig();
      const credential = resolveCredential(config, modelId);
      if (!credential) {
        noticeChannel.push(t("chat.modelNoEndpoint", { id: modelId }), "error");
        return;
      }
      currentEndpointRef.current = credential.endpointId;
      setWizardConfig(config);
      setWizardStep({ kind: "edit", field: "apiKey", endpointId: credential.endpointId });
    } catch (error: any) {
      noticeChannel.push(t("chat.configReadFailed", { error: error?.message ?? error }), "error");
    }
  };

  /** 向导关闭：渲染变更摘要；若改到当前端点则重建会话（消息保留） */
  const closeWizard = (result: WizardCloseResult) => {
    setWizardStep(null);
    setWizardConfig(null);
    setWizardMcp(null);
    setWizardAgentStore(null);
    for (const line of result.summary) noticeChannel.push(t("chat.configUpdated", { line }));
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
        .then(() => noticeChannel.push(t("notice.reloaded")))
        .catch((error: any) => noticeChannel.push(t("chat.sessionReloadFailed", { error: error?.message ?? error }), "error"));
    }
  };

  // ---- 滚动视口控制（应用内翻页，回看历史）----
  const scrollTo = (nextTop: number) => {
    const L = layoutRef.current;
    if (!L) return;
    setViewTop(clampViewTop(L.totalLines, L.budget, nextTop));
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
  /** 鼠标滚轮：一格滚 `WHEEL_STEP` 行（与按行滚动共用一个钳制入口） */
  const scrollByWheel = (dir: -1 | 1) => {
    const L = layoutRef.current;
    if (!L) return;
    scrollTo(L.viewTop + dir * WHEEL_STEP);
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
    setCursor(graphemes(text).length);
  };
  const insertAtCursor = (text: string) => {
    const chars = graphemes(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    setInput(chars.slice(0, cp).join("") + text + chars.slice(cp).join(""));
    setCursor(cp + graphemes(text).length);
  };
  const deleteBeforeCursor = () => {
    const chars = graphemes(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    if (cp === 0) return;
    setInput(chars.slice(0, cp - 1).join("") + chars.slice(cp).join(""));
    setCursor(cp - 1);
  };
  const deleteAfterCursor = () => {
    const chars = graphemes(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    if (cp >= chars.length) return;
    setInput(chars.slice(0, cp).join("") + chars.slice(cp + 1).join(""));
  };
  /** 套用纯函数算好的「文本 + 光标」结果（无变化则不触发重渲染） */
  const applyEdit = (r: { text: string; cursor: number }) => {
    if (r.text === input && r.cursor === cursor) return;
    undoStackRef.current = pushUndo(undoStackRef.current, { text: input, cursor });
    setInput(r.text);
    setCursor(r.cursor);
  };
  /** 删除类编辑：额外把删掉的文本放进 kill ring（Ctrl+Y 可取回） */
  const applyKill = (r: { text: string; cursor: number }) => {
    if (r.text === input && r.cursor === cursor) return;
    killRingRef.current = pushKill(killRingRef.current, killedText(input, r.text));
    yankIndexRef.current = -1;
    applyEdit(r);
  };
  const deleteWordBeforeCursor = () => applyKill(deleteWordLeft(input, cursor));
  const deleteWordAfterCursor = () => applyKill(deleteWordRight(input, cursor));
  const deleteToEndOfLine = () => applyKill(deleteToLineEnd(input, cursor));
  const deleteToStartOfLine = () => applyKill(deleteToLineStart(input, cursor));
  /** Ctrl+W：删到前一空白（标点不切分，整条路径一次删掉） */
  const deletePrevWhitespace = () => applyKill(deleteToPrevWhitespace(input, cursor));
  /** Ctrl+Y / Alt+Y：插入 kill ring 中的一段（index 循环） */
  const yank = (advance: boolean) => {
    const ring = killRingRef.current;
    if (ring.length === 0) return;
    const next = advance ? yankIndexRef.current + 1 : 0;
    if (next >= ring.length) return;
    yankIndexRef.current = next;
    const text = killAt(ring, next) ?? "";
    insertAtCursor(text);
  };
  /** Ctrl+_：撤销上一次编辑 */
  const undoEdit = () => {
    const popped = popUndo(undoStackRef.current);
    if (!popped) return;
    undoStackRef.current = popped.rest;
    setInput(popped.state.text);
    setCursor(popped.state.cursor);
  };
  /** Ctrl+S：暂存 / 恢复输入 */
  const toggleStash = () => {
    if (input.length > 0) {
      stashRef.current = { text: input, cursor };
      setInputText("");
      noticeChannel.push(t("notice.draftSaved"));
      return;
    }
    const stashed = stashRef.current;
    if (!stashed) return;
    stashRef.current = null;
    setInput(stashed.text);
    setCursor(stashed.cursor);
    noticeChannel.push(t("notice.draftRestored"));
  };
  /** Ctrl+V：粘粘图片 —— 暂未支持（需先做「文件 → 内容块」能力探测，见 SKILL/后续迭代） */
  const pasteImageUnsupported = () => {
    noticeChannel.push(t("notice.pasteImageUnsupported"), "error");
  };
  const moveCursor = (delta: number) => {
    const len = graphemes(input).length;
    setCursor((c) => Math.max(0, Math.min(len, c + delta)));
  };
  const moveCursorToLineStart = () => {
    const chars = graphemes(input);
    const cp = Math.max(0, Math.min(cursor, chars.length));
    let i = cp;
    while (i > 0 && chars[i - 1] !== "\n") i -= 1;
    setCursor(i);
  };
  const moveCursorToLineEnd = () => {
    const chars = graphemes(input);
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
      const blocksInput = name === "migrate" || name === "handoff";
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
          setEffortView,
          refreshLocale: () => bumpLocale((n) => n + 1),
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
      // 按键诊断（AIZ_DEBUG_KEYS=1）：必须在任何 return 之前记录，否则被吞掉的键不会留痕
      keyDebug(char, key);
      if (bootError) {
        if (char === "k" || char === "K") {
          void openWizard({ kind: "menu" });
          return;
        }
        if (key.return || key.escape) exit("done");
        return;
      }
      // 鼠标滚轮：滚视口。**必须**排在下面 `isTerminalReply` 之前——那里会把整条鼠标序列
      // 当「终端上报」吃掉，放后面就永远收不到滚轮。其余鼠标事件（点击 / 拖拽 / 横向滚轮）
      // 交给 `isTerminalReply` 丢弃，绝不落下到输入框。
      const wheel = parseWheel(char);
      if (wheel) {
        scrollByWheel(wheel.direction);
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
      // 翻页的「兜底键」：部分终端把 PgUp/PgDn 留给自己滚 scrollback（应用收不到）。
      // 注意 `Ctrl+V` 预留给图片粘贴（当前未实现），不再兼任 page-down。
      if (char === "v" && key.meta) {
        scrollByPage(-1);
        return;
      }
      // macOS 习惯键：⌘[ / ⌘] 翻页、⌘; / ⌘' 按行滚动。
      // Cmd 只在 kitty 键盘协议下才会带 super 位（或终端把 ⌘ 组合映射成带 8 号
      // 修饰位的转义序列，那种会落到上面的 meta 分支里，同样生效）。
      if (key.super && (char === "[" || char === "]")) {
        scrollByPage(char === "[" ? -1 : 1);
        return;
      }
      if (key.super && (char === ";" || char === "'")) {
        scrollByLine(char === ";" ? -1 : 1);
        return;
      }
      if (key.return && (key.ctrl || key.meta || key.shift)) {
        insertAtCursor("\n");
        return;
      }
      if (char === "c" && key.ctrl) {
        // Claude Code：生成中中断；空闲时有草稿就先清空，已空则退出
        if (busy) sessionRef.current?.abort();
        else if (input.length > 0) {
          setInputText("");
          noticeChannel.push(t("notice.inputCleared"));
        } else void doExit();
        return;
      }
      if (char === "d" && key.ctrl) {
        // Claude Code：有草稿时删光标后一个字符；空输入需双击确认退出
        if (input.length > 0) {
          deleteAfterCursor();
          return;
        }
        const now = Date.now();
        if (now - ctrlDAtRef.current < 800) {
          void doExit();
          return;
        }
        ctrlDAtRef.current = now;
        noticeChannel.push(t("notice.pressCtrlDAgain"));
        return;
      }
      if (char === "l" && key.ctrl) {
        clearTranscript();
        return;
      }
      // ---- kill / yank / undo / stash（照抄 Claude Code / readline）----
      if (char === "u" && key.ctrl) {
        // 删到行首。macOS 上 ⌘⌫ 会被终端映射成 Ctrl+U，故不能做成「清空全部」
        deleteToStartOfLine();
        return;
      }
      if (char === "k" && key.ctrl) {
        deleteToEndOfLine();
        return;
      }
      if (char === "w" && key.ctrl) {
        // 删到前一空白（标点不切分：`src/utils/foo.ts` 一次删完）
        deletePrevWhitespace();
        return;
      }
      if (char === "y" && key.ctrl) {
        yank(false);
        return;
      }
      if (char === "y" && key.meta) {
        yank(true);
        return;
      }
      // Ctrl+_ / Ctrl+Shift+-：撤销上一次输入编辑
      if ((char === "_" && key.ctrl) || (char === "-" && key.ctrl && key.shift)) {
        undoEdit();
        return;
      }
      if (char === "s" && key.ctrl) {
        toggleStash();
        return;
      }
      if ((char === "v" && key.ctrl) || (key.super && (char === "v" || char === "V"))) {
        pasteImageUnsupported();
        return;
      }
      // readline 的行首 / 行尾（macOS 上部分终端把 ⌘← / ⌘→ 发成 ^A / ^E）
      if (char === "a" && key.ctrl) {
        moveCursorToLineStart();
        return;
      }
      if (char === "e" && key.ctrl) {
        moveCursorToLineEnd();
        return;
      }
      if (char === "j" && key.ctrl) {
        insertAtCursor("\n");
        return;
      }
      // Ctrl+P / Ctrl+N：历史上下（Claude Code 语义；换行改用 Ctrl+J / Alt+Enter）
      if ((char === "p" && key.ctrl) || (char === "n" && key.ctrl)) {
        const up = char === "p";
        if (hints.length > 0) {
          setMenuIndex((i) => (up ? (i - 1 + hints.length) % hints.length : (i + 1) % hints.length));
          return;
        }
        if (up && history.length > 0) {
          const idx = historyIndex.current < 0 ? history.length - 1 : Math.max(0, historyIndex.current - 1);
          historyIndex.current = idx;
          setInputText(history[idx]);
        } else if (!up && historyIndex.current >= 0) {
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
      // 按词删除：Alt+Backspace / Ctrl+Backspace 删前一个词；Alt+D / Ctrl+Delete 删后一个词。
      // 必须在下面「单字符 Backspace/Delete」之前判定，否则带修饰键的删除只掉一个字符。
      if (key.backspace && (key.ctrl || key.meta || key.super)) {
        deleteWordBeforeCursor();
        return;
      }
      if (key.delete && (key.ctrl || key.meta || key.super)) {
        deleteWordAfterCursor();
        return;
      }
      if (char === "d" && key.meta) {
        deleteWordAfterCursor();
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
        if (key.ctrl || key.meta || key.super) setCursor(wordLeft(input, cursor));
        else moveCursor(-1);
        return;
      }
      if (key.rightArrow) {
        if (key.ctrl || key.meta || key.super) setCursor(wordRight(input, cursor));
        else moveCursor(1);
        return;
      }
      // 跨词移动的「兜底键」：macOS 上 Option+←/→ 往往发的是 ESC b / ESC f
      // （readline 的 backward-word / forward-word），并不带 leftArrow 标记；
      // 而 Ctrl+←/→ 常被系统「Mission Control → 左右切换空间」截走，应用根本收不到。
      if (char === "b" && key.meta) {
        setCursor(wordLeft(input, cursor));
        return;
      }
      if (char === "f" && key.meta) {
        setCursor(wordRight(input, cursor));
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
        // Claude Code：生成中 Esc = 中断本轮；否则清空草稿并回到底部
        if (busy) sessionRef.current?.abort();
        else {
          setInputText("");
          scrollToBottom();
        }
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
      if (char && !key.ctrl && !key.meta && !key.super) {
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
      keyDebug(char, key);
      // 忙碌期只剩「中止 / 退出 / 回看」，滚轮同样生效（生成时正是最想往回看的时机）
      const wheel = parseWheel(char);
      if (wheel) {
        scrollByWheel(wheel.direction);
        return;
      }
      if (isTerminalReply(char)) return;
      if (char === "c" && key.ctrl) {
        sessionRef.current?.abort();
        return;
      }
      if (key.escape) {
        // 忙碌期 Esc 也充当「中断」（与 Claude Code 一致）
        sessionRef.current?.abort();
        return;
      }
      if (char === "d" && key.ctrl) {
        const now = Date.now();
        if (now - ctrlDAtRef.current < 800) {
          void doExit();
          return;
        }
        ctrlDAtRef.current = now;
        noticeChannel.push(t("notice.pressCtrlDAgain"));
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
      if ((key.upArrow || key.downArrow) && (key.shift || key.meta || key.super)) {
        scrollByLine(key.upArrow ? -1 : 1);
        return;
      }
      if (char === "v" && (key.meta || key.super)) {
        scrollByPage(-1);
        return;
      }
      if (key.super && (char === "[" || char === "]")) {
        scrollByPage(char === "[" ? -1 : 1);
        return;
      }
      if (key.super && (char === ";" || char === "'")) {
        scrollByLine(char === ";" ? -1 : 1);
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
        reasoningPresets={wizardPresets}
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
          {t("chat.bootFailed", { error: bootError })}
        </Text>
        <Text color={theme.dim} wrap="truncate">
          {t("chat.bootHint")}
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

  // 状态栏：先按当前状态算出「折行后实际几行」，交给布局预留高度（否则窄屏下一旦提示折行，
  // 整帧就会高出一行，把输入框顶出屏幕）。这里用 `viewTop` 状态判断滚动，而不是
  // `layout.scrolled` —— 后者要等布局算完才有，会与行数测量形成循环。
  const statusProps: StatusBarProps = {
    model: modelId,
    agent: props.agentId ?? "default",
    effort: effortView?.text ?? null,
    effortDimmed: effortView?.dimmed ?? false,
    lastTokens,
    totalTokens,
    busy,
    hint: !ready
      ? t("input.hint.initializing")
      : viewTop != null
        ? t("input.hint.scrolling")
        : t("input.hint.ready"),
    rate,
    columns: cols,
  };
  const statusRows = statusBarRows(statusProps, cols);

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
    statusBarLines: statusRows.length,
  });
  layoutRef.current = layout;
  const isPlaceholder = input.length === 0;
  const inputLayout = layoutInput(
    isPlaceholder ? t("input.placeholder") : input,
    isPlaceholder ? 0 : cursor,
    Math.max(4, cols - 4),
  );
  const bodyLines = inputLayout.lines;

  // 光标所在行的三段拆分（与 `CursorInputRow` 的渲染一一对应）
  const cursorRowIndex = inputLayout.cursorRow;
  const cursorRowChars = graphemes(bodyLines[cursorRowIndex] ?? "");
  const cursorColInRow = Math.min(inputLayout.cursorCol, cursorRowChars.length);
  const cursorBefore = cursorRowChars.slice(0, cursorColInRow).join("");
  const cursorAt = cursorRowChars[cursorColInRow] ?? " ";
  const cursorAfter = cursorRowChars.slice(cursorColInRow + 1).join("");
  /** 实测结果的身份标记：输入段落一改，上一帧的实测值就作废 */
  const cursorKey = `${cursorRowIndex}\u0000${cursorBefore}\u0000${cursorAt}\u0000${cursorAfter}`;
  /** 渲染后实测（值不变则不会重渲染）；闭包捕获当帧的 key，保证标的是「这一帧」的结果 */
  const onCursorMeasure = (position: CursorPosition) => {
    setImePosition((prev) =>
      prev && prev.position.x === position.x && prev.position.y === position.y
        ? prev
        : { key: cursorKey, position },
    );
  };

  // 把终端硬件光标移到编辑光标处，让 IME（输入法）候选框正确定位：
  // 首选「渲染器实测」（宽字符 / emoji 的宽度由 Ink 自己算，不会偏）；
  // 首次渲染还没量到时，退回手算值顶一帧（下一帧即被实测值纠正）。
  if (!busy && !confirmState && !pickerState) {
    const measured = imePosition && imePosition.key === cursorKey ? imePosition.position : null;
    setCursorPosition(
      measured ??
        computeInputCursorPosition({
          transcriptLines: layout.lines.length,
          // 通知栏夹在对话区与斜杠菜单之间：漏算会让硬件光标整体偏上（多行通知如 /help 最明显）
          noticeCount: noticeTextLines.length,
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
              <Spinner label={t("spinner.thinking")} />
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
                  // 占位态不画「假光标」（那个行尾的 ▏）：硬件光标这时就停在提示语开头
                  // （x = 前缀宽），终端自己会把它显示出来；再画一个方块等于屏幕上两个光标，
                  // 而且位置还在提示语末尾，反而误导。
                  return (
                    <Text key={i} wrap="truncate">
                      {prompt}
                      <Text color={theme.faint}>{line}</Text>
                    </Text>
                  );
                }
                // 光标行：把光标字符包成独立节点，渲染后由渲染器给出真实坐标（IME 定位）
                if (i === cursorRowIndex) {
                  return (
                    <CursorInputRow
                      key={i}
                      firstLine={i === 0}
                      before={cursorBefore}
                      at={cursorAt}
                      after={cursorAfter}
                      onMeasure={onCursorMeasure}
                    />
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

      <StatusBar {...statusProps} />
    </Box>
  );
}
