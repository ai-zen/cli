// 对话屏幕 —— 以 SDK 的 `agent.messages` 为唯一数据源渲染（无自定义中间模型）
import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useCursor, useInput, useWindowSize } from "ink";
import { spawn } from "node:child_process";
import { disableMouseTracking } from "../mouse.js";
import { setSdkNoticeSink } from "../../sdk-log.js";
import { keyDebug } from "../key-debug.js";
import type { RateSample } from "../../session-rate.js";
import { phaseLabel } from "../../session-phase.js";
import type { PhaseInfo } from "@ai-zen/agents-server";
import { AgentNS } from "@ai-zen/agents-core";
import { theme } from "../theme.js";
import {
  Spinner,
  StatusBar,
  statusBarRows,
  BottomMenu,
  PastedImagesBar,
  type MenuItem,
  type StatusBarProps,
} from "../components.js";
import { graphemes, layoutInput, usableFrameRows } from "../text.js";
import {
  type ChatSessionLike,
  type ChatSessionNotifier,
  type ChatSessionOptions,
} from "../../session/types.js";
import { createRemoteChatSession } from "../../session.js";
import {
  CommandHint,
  commandBlocksInput,
  matchCommandHints,
  parseCommandInput,
} from "../../commands/registry.js";
import { createConfigPort, type ConfigPort } from "../../server-client/index.js";
import { ConfigWizard } from "../config-wizard/index.js";
import { computeInputCursorPosition, inputWindow } from "./input.js";
import { AGENT_TABS_LINES, computeChatLayout } from "./layout.js";
import { FrameBuffer } from "./frame-buffer.js";
import { LineView } from "./render.js";
import { messageToLines, transcriptLines } from "./messages-view.js";
import { welcomeLines } from "./welcome.js";
import { PickerOverlay, Confirm } from "./overlays.js";
import { CursorInputRow, type CursorPosition } from "./input-row.js";
import { chooseHandoffMode } from "./handoff-choice.js";
import { runCommand } from "./chat-commands.js";
import { describeEffortView } from "../../reasoning-effort.js";
import { t } from "../../i18n/index.js";
import { NoticeChannel, noticeLines, type Notice } from "./notice.js";
import { NoticeBar } from "./notice-bar.js";
import { AgentTabs, type AgentTab } from "./agent-tabs.js";
import { useChatViewport } from "./use-chat-viewport.js";
import { useChatOverlays } from "./use-overlays.js";
import { useWizardHost } from "./use-wizard-host.js";
import { useInputEditing } from "./use-input-editing.js";
import { extractMention, mentionInsertText, rankPaths, type PathEntry } from "../mention.js";
import { userDrafts } from "../chat-history.js";
import {
  MAX_CLIPBOARD_TEXT_BYTES,
  readClipboardImage,
  readClipboardText,
  type ClipboardImage,
} from "../../clipboard.js";
import { handleCtrlDExit, handleScrollKey } from "./common-keys.js";

// ==================== 对话屏幕 ====================

/**
 * 造会话的入口：换到服务端之后，屏幕只认它的**返回值**（{@link ChatSessionLike}）。
 *
 * 之所以注入成函数而不是在组件里直接调：测试要能塞一个假会话，而 `vi.mock` 在
 * 进程内共享模块时会波及别的测试文件。
 */
export type CreateChatSession = (
  options: ChatSessionOptions,
  notifier: ChatSessionNotifier,
) => Promise<ChatSessionLike>;

/**
 * `Chat` 的外部依赖。
 *
 * 全部可注入是为了让集成测试**不必** `vi.mock` 整模块 —— 模块级 mock 在
 * 进程内共享模块（`isolate: false`）时是全局生效的，会把别的测试文件也带偏。
 */
export interface ChatDeps {
  /** 配置面的唯一入口：真相在服务端，客户端只是问它 */
  config: ConfigPort;
  createSession: CreateChatSession;
  readClipboardImage: typeof readClipboardImage;
  readClipboardText: typeof readClipboardText;
}

/**
 * 默认配置面：**远程**实现。
 *
 * 为什么默认不是本地：TUI 已经是纯客户端，配置与 Agent 定义的真相在服务端。
 * 默认本地会让「界面上改的」和「Agent 实际跑的」变成两份互不相干的真相 ——
 * 界面显示成功、跑起来还是旧模型，错得很安静。
 * 测试或特殊场景由调用方经 `deps.config` 注入自己的实现。
 *
 * 为什么做成模块级单例而不是每次渲染新建：远程端口是懒连接的，每个组件实例各建一个
 * 就等于各连一条；而它一旦连上就是进程级共享的资源，本来也没有「每个屏幕一份」的理由。
 */
let defaultConfigPort: ConfigPort | undefined;

function remoteConfigPort(): ConfigPort {
  defaultConfigPort ??= createConfigPort();
  return defaultConfigPort;
}

export interface ChatScreenProps {
  agentId?: string;
  /** 依赖注入（测试用；缺省全部走真实实现） */
  deps?: Partial<ChatDeps>;
  messages?: AgentNS.Message[];
  sessionId?: string;
  /**
   * 「接着该工作区的上一轮会话」—— 只表达**意图**，不带数据。
   *
   * 为什么屏幕层不自己判断「有没有上一轮」：哪一段算上一轮，真相在服务端（指针 + 存档）。
   * 屏幕去读一遍就是第二份会漂的真相，而且永远得出「没有上次」——所以这里只把意图
   * 透传给会话层。
   */
  resume?: boolean;
  /** 重挂载时的初始输入（/back 撤回后用于预填） */
  initialInput?: string;
  /**
   * 启动后**自动作为首条消息发送**的内容（shell 钩子 `ai --tui --new "$@"`）。
   *
   * 与 `initialInput` 的区别：那个是**预填到输入框**、等用户确认；这个是直接发出去。
   * 它一律当**普通消息**发送，不经过斜杠命令解析——钩子带来的可能是 `/opt/bin/foo`
   * 这种以 `/` 开头的命令，否则会被当成 CLI 命令而报「未知命令」。
   */
  initialPrompt?: string;
  /** 重挂载后展示一次的系统提示（如 /model 的写入结果，旧实例已卸载） */
  initialNotice?: string;
}

/**
 * 单条消息最多附几张粘贴图片。
 *
 * 顶在 4 张：一张手机截图内联后 base64 常在 1~3MB，再多一次请求就是几十 MB，
 * 既扫 token 也容易撞端点的请求体上限。
 */
export const MAX_PASTED_IMAGES = 4;

/** 字节数 → 一位小数的 MB（提示文案用） */
export function formatMegabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
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

/**
 * 忙碌期那一行 spinner 的文案。
 *
 * 生成中由 SDK 的阶段驱动（`phaseLabel`）；但 `/update`、`/migrate` 这类
 * **阻塞输入的命令**执行时根本没有生成轮次，`phase` 是 `null`，`phaseLabel(null)`
 * 会兜底成「处理中…」——与实际动作毫无关系。命令期间改显命令名，
 * 至少能看出「在跑哪条命令」，具体进度由命令自己 push 通知（查版本 / 开始安装 …）。
 */
export function busySpinnerLabel(phase: PhaseInfo | null, command: string | null): string {
  if (phase) return phaseLabel(phase);
  return command ? t("cmd.running", { name: command }) : phaseLabel(null);
}

export function Chat(props: ChatScreenProps) {
  // 调用方注入了配置面就不去建远程端口：测试塞的是假端口，不该顺手连一次真服务端。
  // `??` 的短路是有意为之，不是省事。
  const configPort = props.deps?.config ?? remoteConfigPort();
  const deps: ChatDeps = {
    config: configPort,
    createSession: createRemoteChatSession,
    readClipboardImage,
    readClipboardText,
    ...props.deps,
  };
  const { exit, suspendTerminal } = useApp();
  const { setCursorPosition } = useCursor();
  const { columns, rows } = useWindowSize();

  /** 覆盖层（确认框 / 选择器）：弹窗与 resolve 生命周期见 use-overlays.ts */
  const {
    confirmState,
    pickerState,
    setConfirmState,
    setPickerState,
    resolveConfirm,
    resolvePicker,
  } = useChatOverlays();
  const sessionRef = useRef<ChatSessionLike | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** 视口：滚动状态与翻页 / 按行 / 滚轮换算（唯一入口见 use-chat-viewport.ts） */
  const { viewTop, layoutRef, scrollByPage, scrollByLine, scrollByWheel, scrollToBottom } =
    useChatViewport();

  /** 本轮是否在生成中（spinner / 输入禁用） */
  const [busy, setBusy] = useState(false);
  /** 正在执行的**阻塞型命令**名（`blocksInput: true` 的 `/update` / `/migrate` …），见 `busySpinnerLabel` */
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
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
  const [pendingUser, setPendingUser] = useState<{
    text: string;
    base: number;
    /** 本条附带的粘贴图片（只用于转录里显示 `[图片]` 占位，不在UI里展开 base64） */
    images?: readonly ClipboardImage[];
  } | null>(null);
  /**
   * 待发送的粘贴图片（`Ctrl+V` 累积）。
   *
   * 存 base64 而不是落盘：SDK 的 `fileToContentSection()` 正好接受 `{ base64, mime }`，
   * 于是粘贴全程不碰磁盘 —— 也就不会在 `$TMPDIR` 里留下一堆无人清理的 png。
   */
  const [pastedImages, setPastedImages] = useState<readonly ClipboardImage[]>([]);
  /** 转录显示起点（/clear 清屏用：隐藏此索引之前的消息，但不改上下文） */
  const [transcriptFrom, setTranscriptFrom] = useState(0);
  /**
   * 当前查看的 Agent 视图：`"main"` 或某个子 Agent 的视图 id。
   *
   * 只影响**消息列表的数据源**（主 Agent 的 `messages` / 子 Agent 自己的 `messages`），
   * 不改上下文、不影响发送目标：发出的消息永远属于主 Agent。
   */
  const [activeAgentId, setActiveAgentId] = useState("main");

  /** Ctrl+D 双击退出计时 */
  const ctrlDAtRef = useRef(0);

  /**
   * 通知通道：notice / error 走独立栏位，绝不进对话转录（messages）。
   */
  const noticeChannelRef = useRef<NoticeChannel | null>(null);
  if (noticeChannelRef.current == null) noticeChannelRef.current = new NoticeChannel();
  const noticeChannel = noticeChannelRef.current;
  /**
   * 通知队列（最近的在最后）。通道内部保留最近 `MAX_NOTICE_HISTORY` 条，
   * 这里只做镜像：单槽 state 会让「同一批摘要 / 分阶段进度」只剩最后一条。
   */
  const [notices, setNotices] = useState<readonly Notice[]>(noticeChannel.notices);
  useEffect(() => noticeChannel.subscribe(setNotices), [noticeChannel]);

  /**
   * SDK 的 warn / error 直接进通知栏 —— **通用通道**，不为某个功能单独接线。
   *
   * 以前 SDK 日志被整体接管到文件里（不然 `console.log` 会撕坏 Ink 的帧），代价是
   * 「SDK 说了什么」用户在界面上一个字都看不见，只能事后翻 sdk.log —— 排查成本极高
   * （连「工具文件把进程杀了」这种事都只能靠猜）。这里注册一个 sink 把 warn/error
   * 引过来：以后 SDK 任何模块只要打日志，界面上自动就有，不必为新特性再传一个回调。
   *
   * 晚绑定、启动期缓冲、去重、封顶都在 `sdk-log.ts` 里做，这里只做接线。
   */
  useEffect(() => {
    setSdkNoticeSink((level, message) => noticeChannel.push(message, level));
    return () => setSdkNoticeSink(null);
  }, [noticeChannel]);

  /**
   * 配置向导宿主（凭据 / 配置中心）：整屏接管与「关闭后让改动生效」见
   * use-wizard-host.ts。这里只提供出口：通知走通知通道、重启 / 重载走会话。
   */
  const {
    wizardStep,
    wizardConfig,
    wizardConfigPath,
    wizardPresets,
    wizardAgents,
    wizardMcp,
    wizardAgentStore,
    openWizard,
    openKeyEditor,
    closeWizard,
  } = useWizardHost({
    // 向导要读的四个快照全从这一个口子来：配置面永远开向服务端
    config: configPort,
    modelId,
    notify: (text, tone) => noticeChannel.push(text, tone),
    hasSession: () => sessionRef.current != null,
    // 向导改完某些配置后要重挂载（同一进程、新 Ink 实例）。会话 id 必须带**此刻**的：
    // 宿主手上的那个是首次挂载时的，`/new`、自动迁移、`/save <名字>` 都会让它过期。
    restart: () =>
      exit({
        restart: true,
        sessionId: sessionRef.current?.currentId,
        messages: props.messages,
      }),
    reloadSession: () => {
      void sessionRef.current
        ?.reload()
        .then(() => noticeChannel.push(t("notice.reloaded")))
        .catch((error: any) =>
          noticeChannel.push(
            t("chat.sessionReloadFailed", { error: error?.message ?? error }),
            "error",
          ),
        );
    },
  });

  /**
   * 重挂载附带的系统提示（如 `/model` 的切换结果）。
   *
   * 用 ref 而非 props 直读：本值只在首次挂载消费一次，若写进 create 的依赖数组，
   * 会把「展示一条提示」误变成「重建会话」。
   */
  const initialNoticeRef = useRef(props.initialNotice);
  /** 钩子带来的首条消息：只在会话建好后发一次，重挂载不再重发 */
  const initialPromptRef = useRef(props.initialPrompt);

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
    Promise.all([
      deps.config.readConfig(),
      deps.config.readAgentStore(),
      deps.config.readReasoningPresets(),
    ])
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
    deps
      .createSession(
        {
          agentId: props.agentId,
          // 消息**不在这里传**：远程实现只持有一个会话 id，内容由服务端快照给
          // （`props.messages` 仍用于本屏首帧渲染与 `/back` 的显示起点）
          sessionId: props.sessionId,
          // 配置面复用屏幕这一个：图片链路的端点能力要读服务端那份（见 `ChatSessionOptions.config`）
          config: deps.config,
          // 「接着上次」只是意图：接哪一段由会话实现去问（服务端存档 / 本地指针），屏幕不判断
          resume: props.resume,
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
        // shell 钩子：会话就绪后立即把原命令当**用户消息**发出去（不经命令解析）
        if (initialPromptRef.current) {
          const prompt = initialPromptRef.current;
          initialPromptRef.current = undefined;
          setTick((t) => t + 1);
          void runSubmit(prompt, { asMessage: true });
          return;
        }
        setTick((t) => t + 1);
      })
      .catch((error: any) => setBootError(error?.message ?? String(error)));
    return () => {
      disposed = true;
      frameBufferRef.current?.dispose();
      sessionRef.current?.dispose();
    };
  }, [props.agentId, props.messages, props.sessionId, props.resume]);

  // 速率采样：Spinner 的重渲染只影响它自己，不会带着状态栏一起刷，所以生成中要自己定时读快照。
  // 生成结束（busy → false）时再读一次，拿本轮平均速率并留在状态栏上。
  useEffect(() => {
    const read = () => setRate(sessionRef.current?.rateSample ?? null);
    read();
    if (!busy) return;
    const timer = setInterval(read, 250);
    return () => clearInterval(timer);
  }, [busy]);

  /** 清屏但保留上下文：把显示起点推到当前消息末尾 */
  const clearTranscript = () => {
    setTranscriptFrom(sessionRef.current?.messages.length ?? 0);
    noticeChannel.clear();
  };

  /**
   * 输入编辑（文本 / 光标 / 历史 / kill ring / undo / stash）：
   * 全部语义在 use-input-editing.ts，这里只把通知出口接上。
   */
  const {
    input,
    cursor,
    setInputText,
    insertAtCursor,
    replaceRange,
    deleteBeforeCursor,
    deleteAfterCursor,
    deleteWordBeforeCursor,
    deleteWordAfterCursor,
    deleteToStartOfLine,
    deleteToEndOfLine,
    deletePrevWhitespace,
    yank,
    undoEdit,
    toggleStash,
    moveCursor,
    moveCursorToLineStart,
    moveCursorToLineEnd,
    moveCursorUpRow,
    moveCursorDownRow,
    moveCursorByWord,
    historyPrev,
    historyNext,
    clearDraft,
  } = useInputEditing({
    initialText: props.initialInput,
    notify: (text, tone) => noticeChannel.push(text, tone),
    // 历史来自 messages（唯一真相源）：自带图片，`↑` 回到带图消息时附件也一并回来
    historySource: () => userDrafts(sessionRef.current?.messages ?? []),
    restoreImages: (images) => setPastedImages(images),
  });
  /** 斜杠候选菜单的高亮索引；输入一变就回到第一个候选 */
  const [menuIndex, setMenuIndex] = useState(0);
  useEffect(() => {
    setMenuIndex(0);
  }, [input]);
  /** 本工作区的文件清单（`@` 补全的候选源）；null = 还没问到（会话实现那一侧持有缓存） */
  const [fileIndex, setFileIndex] = useState<PathEntry[] | null>(null);
  /** 用户按 Esc 主动关掉了 `@` 菜单：输入 / 光标一变就重新允许弹出 */
  const [mentionOff, setMentionOff] = useState(false);
  useEffect(() => {
    setMentionOff(false);
  }, [input, cursor]);

  // 命令候选人
  const slash = input.startsWith("/") && !input.includes("\n") && !input.includes(" ");
  const hints: CommandHint[] = slash ? matchCommandHints(input.slice(1)) : [];
  /**
   * `@` 文件补全的上下文：光标是否停在一个 `@token` 里（判据见 `mention.ts`）。
   *
   * 与斜杠命令**互斥**：`/` 开头就是在写命令，此时不弹文件菜单。
   */
  const mention = slash || mentionOff ? null : extractMention(input, cursor);
  const fileMatches = mention && fileIndex ? rankPaths(mention.query, fileIndex) : [];
  /** 索引还没就绪：菜单先占一行「扫描中…」，否则敲下 `@` 后一片空白像没反应 */
  const scanningFiles = mention != null && fileIndex == null;
  /** 当前菜单条数（两种菜单互斥，非零的那个说了算） */
  const menuCount = slash ? hints.length : fileMatches.length;
  /**
   * 菜单**想吃**的行数：候选条数 + 「扫描中…」占位。
   *
   * 实际能拿多少由布局决定（`computeChatLayout` 按输入框上方的剩余空间放行，
   * 不设固定上限）—— 这里交上去的是「想要多少」，渲染与 IME 光标一律读回
   * `layout.hintRows`，三处同源。
   */
  const menuWant = slash ? hints.length : fileMatches.length + (scanningFiles ? 1 : 0);
  /** 菜单条目：斜杠命令带说明，`@` 路径目录带尾斜杠（提示「选中后继续下钻」） */
  const menuItems: MenuItem[] = slash
    ? hints.map((hint) => ({ key: hint.names[0]!, label: hint.label, hint: hint.description }))
    : fileMatches.map((entry) => ({
        key: entry.path,
        label: entry.dir ? `${entry.path}/` : entry.path,
      }));

  /**
   * 每次「重新唤起 `@`」都问一次本工作区的文件清单。
   *
   * 为什么问会话而不是自己扫盘：`@` 补全给出的路径必须对**跑会话的那台机器**成立。
   * 会话现在跑在服务端，屏幕这边扫本机磁盘列出的是客户端机器的文件 —— 模型拿到那些
   * 路径一律 not found。`listWorkspaceFiles()` 问的就是服务端（扫的是它的 `FileIndex`），
   * 屏幕只负责过滤与插入。
   *
   * 为什么这里不再叠一层缓存：15s TTL 已经在真正持有清单的那一侧（服务端的 `FileIndex`）。
   * 屏幕再存一份就是两份 TTL、两个真相——两边过期时间不同时，用户看到的是「刚建的
   * 文件有时在、有时不在」。每次唤起都问，刷新节奏由清单的持有者说了算。
   *
   * 失败语义与从前一致：问不到就按空清单处理，绝不让补全卡住输入框。
   */
  useEffect(() => {
    if (mention == null) return;
    // 会话还没建好就问不到；`ready` 与 `sessionRef` 同时就绪（见上面的创建 effect），
    // 所以这里直接返回，等 `ready` 变化时本 effect 再跑一次——否则 `@` 菜单会一直
    // 停在「扫描中…」。
    const session = sessionRef.current;
    if (!session) return;
    let alive = true;
    void session
      .listWorkspaceFiles()
      .then((paths) => {
        if (alive) setFileIndex(paths);
      })
      .catch(() => {
        if (alive) setFileIndex([]);
      });
    return () => {
      alive = false;
    };
    // 只在「从无菜单到有菜单」时触发：同一 token 内每敲一个键都重问毫无意义；
    // `ready` 进依赖是因为会话就绪可能晚于用户敲下的那个 `@`。
  }, [mention == null, ready]);

  /**
   * 把 `@` 菜单里高亮的那条补进草稿。
   *
   * 落字走 `replaceRange`：替换的是**整个 token**（`@src/tu` 这种半截路径、或光标停在
   * 中间时右半边残留），并且会记一条撤销快照 —— 补错了 `Ctrl+_` 能退回。
   * 目录带尾斜杠，补完菜单会重新过滤出该目录下的内容，于是可以一路钻下去。
   */
  const completeMentionSelection = () => {
    if (!mention || fileMatches.length === 0) return;
    const entry = fileMatches[Math.max(0, Math.min(menuIndex, fileMatches.length - 1))];
    if (!entry) return;
    replaceRange(mention.start, mention.end, mentionInsertText(entry.path, entry.dir));
  };

  /**
   * `Ctrl+V`：**先问剪贴板要图片，没有图片就退回粘贴文本**。
   *
   * 顺序不能反 —— 文本一旦先粘进去，再发现「其实剪贴板里是图片」就晚了（草稿里已经
   * 多了一坨东西）。所以永远是「图片优先、文本兑底」，这也就是用户按 Ctrl+V 的默认期待。
   *
   * 异步不阻塞输入：`readClipboardImage()` 要 spawn 一个子进程（几十 ms），期间用户
   * 还能继续打字；回到结果时只做一次 setState / 插字。
   */
  const pasteClipboard = async () => {
    const result = await deps.readClipboardImage();
    if (result.kind === "image") {
      if (pastedImages.length >= MAX_PASTED_IMAGES) {
        noticeChannel.push(t("notice.imageLimit", { n: MAX_PASTED_IMAGES }), "error");
        return;
      }
      setPastedImages((list) => [...list, result.image]);
      noticeChannel.push(t("notice.imagePasted", { n: pastedImages.length + 1 }));
      return;
    }
    if (result.kind === "too-large") {
      noticeChannel.push(
        t("notice.imageTooLarge", { size: formatMegabytes(result.bytes) }),
        "error",
      );
      return;
    }

    // 没有图片 → 当成普通粘贴：把剪贴板文本插到光标处
    const pasted = await deps.readClipboardText();
    if (pasted.kind === "unavailable") {
      noticeChannel.push(t("notice.clipboardUnavailable"), "error");
      return;
    }
    if (pasted.kind === "too-large") {
      noticeChannel.push(
        t("notice.textTooLarge", {
          size: Math.round(pasted.bytes / 1024),
          limit: MAX_CLIPBOARD_TEXT_BYTES / 1024,
        }),
        "error",
      );
      return;
    }
    if (pasted.text.length === 0) {
      noticeChannel.push(t("notice.clipboardEmpty"));
      return;
    }
    // 去掉末尾单个换行：剪贴板文本几乎总带一个尾换行，粘完光标原地跳行很莫妙
    insertAtCursor(pasted.text.replace(/\n$/, ""));
  };

  const runSubmit = async (text: string, options: { asMessage?: boolean } = {}) => {
    const trimmed = text.trim();
    if (!trimmed || !sessionRef.current || busy) return;
    clearDraft();
    scrollToBottom();
    // 发出去的消息永远属于主 Agent：停在子 Agent 视图上会让用户看不到自己的提问
    setActiveAgentId("main");
    noticeChannel.clear();

    // 斜杠命令：命令名怎么解析、哪些命令会调用模型（要拦输入框），都来自命令元数据
    const command = options.asMessage ? null : parseCommandInput(trimmed);
    if (command) {
      const name = command.name;
      const blocksInput = commandBlocksInput(name);
      if (blocksInput) {
        setBusy(true);
        setBusyCommand(name);
      }
      try {
        await runCommand(name, trimmed, {
          session: sessionRef.current!,
          // 命令层的配置读写（`/model`、`/agent`、`/think` …）一律走配置面：
          // 屏幕只负责把口子递下去，不替它判断本地还是远程
          config: deps.config,
          notice: (text, tone) => noticeChannel.push(text, tone),
          clearTranscript,
          rows: rows ?? 24,
          exit,
          suspendTerminal,
          openWizard,
          openKeyEditor,
          doExit,
          restartProcess,
          setPickerState,
          setConfirmState,
          setInputText,
          setEffortView,
          refreshLocale: () => bumpLocale((n) => n + 1),
        });
      } finally {
        if (blocksInput) {
          setBusy(false);
          setBusyCommand(null);
        }
      }
      return;
    }

    const base = sessionRef.current!.messages.filter((m) => m.role === AgentNS.Role.User).length;
    // 先取快照再清空：`send` 要用同一个数组，而输入区要立刻回到「没有附件」的状态
    const images = pastedImages;
    setPastedImages([]);
    setPendingUser({ text: trimmed, base, images });
    setBusy(true);
    try {
      await sessionRef.current!.send(trimmed, images);
    } finally {
      setBusy(false);
      setPendingUser(null);
    }
  };
  const doExit = () => {
    exit("done");
  };

  /**
   * 真·重启进程（`/update` 装完新版本后调用）。
   *
   * 不能复用 `exit({ restart: true })`：那条路只是 `continue` 回 `mount(<Chat/>)`，
   * 同一个进程、内存里还是旧模块图——对「磁盘上的代码变了」这种升级等于没装。
   * 这里退到 shell 的视角：**spawn 一个新的自己**（新进程重新加载新 dist），
   * 父进程在挂起态里等子进程退出，然后跟着退出。
   *
   * 三个必须注意的细节：
   *
   * 1. **在挂起态里退出**。`suspendTerminal` 的 `beginSuspend()` 会 `pauseInput()`
   *    （raw 模式关闭），而 `endSuspend()` 会 `resumeInput()` 把它重新打开。若等
   *    `suspendTerminal` 返回后再 `process.exit`，终端就停在 raw 模式，回到 shell
   *    后按键全是乱码。所以子进程一结束就**就地**退出。
   * 2. **先关鼠标上报**。`mount()` 按 Ink 实例开关它，而本实例此刻只是「挂起」并未
   *    退出 —— 不关的话，子进程若异常死亡，终端会一直把滚轮写成转义序列。
   * 3. **不转发 `process.argv.slice(2)`**。`ai --tui --new "..."` 那套是 shell 兜底
   *    钩子的一次性载荷，重启时重放会把同一条提示词再发一遍。新进程按常规启动即
   *    续接上一轮会话（重启前已落盘）。
   */
  const restartProcess = () =>
    suspendTerminal(
      () =>
        new Promise<void>((resolve) => {
          const entry = process.argv[1];
          if (!entry) {
            // 拿不到入口脚本（理论上不会发生）：不重启，退回 TUI，由调用方收尾
            resolve();
            return;
          }
          disableMouseTracking();
          const child = spawn(process.execPath, [entry], { stdio: "inherit" });
          child.on("error", () => process.exit(1));
          child.on("exit", (code) => process.exit(code ?? 0));
        }),
    );

  /** 本次会话已出现的子 Agent（渲染期现取；`sessionRef` 在首次渲染时为 null） */
  const subAgentViews = sessionRef.current?.subAgents ?? [];

  /**
   * Agent 栏目切换（← / →）：在「主 Agent + 各子 Agent」之间循环。
   *
   * 键位分流见下方两个 `useInput`：输入框**为空**或**生成中**（输入框已被 Spinner 顶替）
   * 时，左右键本来就无事可做，正好用来切换；输入框**有内容**时左右键仍然是移光标——
   * 不能为了切栏目把文本编辑的左右移动废掉。
   */
  const switchAgentView = (dir: -1 | 1) => {
    const ids = ["main", ...subAgentViews.map((item) => item.id)];
    // 旧 id 已失效（会话重建）时 indexOf 为 -1，归一后从主 Agent 起步
    const current = Math.max(0, ids.indexOf(activeAgentId));
    setActiveAgentId(ids[(current + dir + ids.length) % ids.length]!);
    scrollToBottom();
  };

  /**
   * 两个 `useInput`（空闲 / 忙碌）共用的键位上下文 —— 判定逻辑在 common-keys.ts。
   * 放这里而不是各自内联，是为了让「什么时候能滚、Ctrl+D 怎么退」只有一份定义。
   */
  const scrollKeys = { scrollByWheel, scrollByPage, scrollByLine };
  const ctrlDExit = {
    lastAt: ctrlDAtRef,
    notify: () => noticeChannel.push(t("notice.pressCtrlDAgain")),
    exit: doExit,
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
      // 回看历史类按键（滚轮 / PgUp/PgDn / ⌘[ ⌘] / ⌘; ⌘' / Alt+V）与忙碌态共用
      if (handleScrollKey(char, key, scrollKeys)) return;
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
      if (char === "d" && key.ctrl && input.length > 0) {
        // Claude Code：有草稿时删光标后一个字符（空闲态独有）
        deleteAfterCursor();
        return;
      }
      if (handleCtrlDExit(char, key, ctrlDExit)) return;
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
        // 剪贴板里有图片就附在消息上（发送时转成内容块），没有就退回粘贴文本
        void pasteClipboard();
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
        if (menuCount > 0) {
          // 同上：视觉「上」（Ctrl+P）是 +1
          setMenuIndex((i) => (up ? (i + 1) % menuCount : (i - 1 + menuCount) % menuCount));
          return;
        }
        if (up) historyPrev();
        else historyNext();
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
        // `@` 菜单开着时回车 = 补全（不发送）：让「选完继续接着写」成为默认动作，
        // 否则选完就得再敲一个空格才能换行/继续，很容易误发半截消息。
        if (mention && fileMatches.length > 0) {
          completeMentionSelection();
          return;
        }
        void runSubmit(resolveSubmitText(input, hints, menuIndex));
        return;
      }
      if (key.tab && menuCount > 0) {
        if (mention) {
          completeMentionSelection();
          return;
        }
        setInputText(`/${hints[menuIndex]?.names[0] ?? ""} `);
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (key.shift || key.meta) {
          scrollByLine(key.upArrow ? -1 : 1);
          return;
        }
        if (menuCount > 0) {
          // 底部锚定菜单里**下标大 = 视觉靠上**（`items[0]` 贴着输入框，越往后越往上），
          // 所以视觉「上」是 +1、视觉「下」是 −1；取模环绕：到顶溢出回到底部、到底溢出回到顶部。
          // 写反了方向就与视觉相反 —— 只有 ≥ 3 条候选时才能从测试里看出来。
          setMenuIndex((i) =>
            key.upArrow ? (i + 1) % menuCount : (i - 1 + menuCount) % menuCount,
          );
          return;
        }
        // 多行输入：先按**视觉行**走光标（含软折行，宽度与渲染一致），走到首/末行才翻历史
        const wrapWidth = Math.max(4, (columns ?? 80) - 4);
        if (key.upArrow ? moveCursorUpRow(wrapWidth) : moveCursorDownRow(wrapWidth)) return;
        if (key.upArrow) historyPrev();
        else historyNext();
        return;
      }
      // Agent 栏目：输入框为空时光标停在 0，←/→ 本无作用 → 拿来切换主 / 子 Agent
      if ((key.leftArrow || key.rightArrow) && input.length === 0 && subAgentViews.length > 0) {
        switchAgentView(key.leftArrow ? -1 : 1);
        return;
      }
      if (key.leftArrow) {
        if (key.ctrl || key.meta || key.super) moveCursorByWord(-1);
        else moveCursor(-1);
        return;
      }
      if (key.rightArrow) {
        if (key.ctrl || key.meta || key.super) moveCursorByWord(1);
        else moveCursor(1);
        return;
      }
      // 跨词移动的「兜底键」：macOS 上 Option+←/→ 往往发的是 ESC b / ESC f
      // （readline 的 backward-word / forward-word），并不带 leftArrow 标记；
      // 而 Ctrl+←/→ 常被系统「Mission Control → 左右切换空间」截走，应用根本收不到。
      if (char === "b" && key.meta) {
        moveCursorByWord(-1);
        return;
      }
      if (char === "f" && key.meta) {
        moveCursorByWord(1);
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
        // `@` 菜单开着时，Esc 只关菜单：清草稿太粗暴（`@` 打一半按 Esc 会连正文一起没）
        if (mention && menuWant > 0) {
          setMentionOff(true);
          return;
        }
        // 有附件时先清附件（草稿保留）——误粘一张图后总得有个退路，
        // 而又不能为了这个把 ESC 变成「清空一切」的随机键
        if (!busy && pastedImages.length > 0) {
          setPastedImages([]);
          noticeChannel.push(t("notice.imagesCleared"));
          return;
        }
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
      if (handleScrollKey(char, key, scrollKeys)) return;
      if (char === "c" && key.ctrl) {
        sessionRef.current?.abort();
        return;
      }
      if (key.escape) {
        // 忙碌期 Esc 也充当「中断」（与 Claude Code 一致）
        sessionRef.current?.abort();
        return;
      }
      if (handleCtrlDExit(char, key, ctrlDExit)) return;
      if ((key.upArrow || key.downArrow) && (key.shift || key.meta || key.super)) {
        scrollByLine(key.upArrow ? -1 : 1);
        return;
      }
      // Agent 栏目：生成中输入框已失活，←/→ 空闲 → 直接切换（此时最想看子 Agent 在干什么）
      if ((key.leftArrow || key.rightArrow) && subAgentViews.length > 0) {
        switchAgentView(key.leftArrow ? -1 : 1);
        return;
      }
      if (char === "v" && key.super) {
        scrollByPage(-1);
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
        configPath={wizardConfigPath}
        reasoningPresets={wizardPresets}
        initialStep={wizardStep}
        closeOnSave={wizardStep.kind !== "menu"}
        agents={wizardAgents}
        mcp={wizardMcp ?? undefined}
        agentStore={wizardAgentStore ?? undefined}
        // 落盘由配置面决定去处：写的是服务端那份
        onSave={(config) => deps.config.saveConfig(config)}
        onSaveMcp={(scope, cfg) => deps.config.writeMcpConfig(cfg, scope)}
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
  const subAgents = session?.subAgents ?? [];
  /** 当前查看的子 Agent；不在列表里（会话重建后 id 失效）时回落到主 Agent */
  const activeSub = subAgents.find((item) => item.id === activeAgentId) ?? null;

  const userCount = messages.filter((m) => m.role === AgentNS.Role.User).length;
  // 乐观回显只属于主 Agent 的视图（子 Agent 不会收到用户直接发的消息）
  const showPending = !activeSub && pendingUser != null && userCount <= pendingUser.base;

  // 子 Agent 视图读它**自己**的 messages（从第 0 条起，不受主会话 /clear 的显示起点影响）
  const transcript = transcriptLines(
    activeSub ? activeSub.messages : messages.slice(transcriptFrom),
    cols,
  );
  /**
   * 空对话：对话区顶部展示品牌区（logo + 标语 + 版本）。
   *
   * 判据里必须带 `showPending` —— 用户刚敲下第一条消息、乐观回显已经上屏，
   * 这时欢迎块要立刻让位，不能等消息真正落地。
   */
  const showWelcome = !activeSub && !showPending && messages.length === 0;
  if (showWelcome) transcript.unshift(...welcomeLines({ columns: cols }));
  if (showPending) {
    // 带粘贴图片的消息：乐观回显要与实际发送的结构一致（文本段 + 图片占位块），
    // 否则图片那几条会在真实消息落地前「消失」一下。
    const images = pendingUser!.images ?? [];
    transcript.push(
      ...messageToLines(
        {
          id: "__pending_user",
          role: AgentNS.Role.User,
          content:
            images.length > 0
              ? [
                  { type: "text" as const, text: pendingUser!.text },
                  ...images.map(() => ({ type: "image_url" as const, image_url: { url: "" } })),
                ]
              : pendingUser!.text,
        },
        cols,
      ),
    );
  }

  const noticeTextLines = noticeLines(notices, cols);

  /** Agent 栏目条目：无子 Agent 时整条栏目不存在（不占高度、也不接管左右键） */
  const agentTabs: AgentTab[] =
    subAgents.length > 0
      ? [
          { id: "main", label: t("agentTabs.main") },
          ...subAgents.map((item) => ({
            id: item.id,
            label: t("agentTabs.sub", { n: item.index }),
            status: item.status,
          })),
        ]
      : [];
  const activeTabId = activeSub ? activeSub.id : "main";
  const agentTabLines = agentTabs.length > 0 ? AGENT_TABS_LINES : 0;

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

  /** 附件提示行：有粘贴图片时占 1 行（与 `computeChatLayout` 的 `attachmentLines` 同一个判据） */
  const attachmentLines = pastedImages.length > 0 ? 1 : 0;

  const layout = computeChatLayout({
    columns: cols,
    rows: usableFrameRows(rows ?? 24),
    transcript,
    input,
    busy,
    hintCount: menuWant,
    noticeCount: noticeTextLines.length,
    attachmentLines,
    agentTabLines,
    overlay: confirmState ? "confirm" : pickerState ? "picker" : "none",
    pickerItems: pickerState?.items.length ?? 0,
    viewTop,
    statusBarLines: statusRows.length,
    // 空对话的品牌块落在对话区垂直中部（贴顶太空、贴底太挤）
    anchor: showWelcome ? "center" : undefined,
  });
  layoutRef.current = layout;
  const isPlaceholder = input.length === 0;
  const inputLayout = layoutInput(
    isPlaceholder ? t("input.placeholder") : input,
    isPlaceholder ? 0 : cursor,
    Math.max(4, cols - 4),
  );
  const bodyLines = inputLayout.lines;
  /**
   * 输入区可见窗口：最多 `INPUT_MAX_ROWS` 行，且**跟随光标**（与 `computeChatLayout`
   * 的 `inputHeight` 同源）。`cursorRowIndex` 是**窗口内**的行号 —— 渲染用哪一行、
   * 硬件光标 y 都基于它；用全文本的行号会让 IME 候选框跑到屏外。
   */
  const inputWin = inputWindow(bodyLines.length, inputLayout.cursorRow);
  const shownLines = bodyLines.slice(inputWin.from, inputWin.to);

  // 光标所在行的三段拆分（与 `CursorInputRow` 的渲染一一对应）
  const cursorRowIndex = inputLayout.cursorRow - inputWin.from;
  const cursorRowChars = graphemes(shownLines[cursorRowIndex] ?? "");
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
          // Agent 栏目与通知栏都夹在对话区与输入行之间：漏算会让硬件光标整体偏上
          agentTabCount: agentTabLines,
          noticeCount: noticeTextLines.length,
          attachmentCount: attachmentLines,
          hintCount: layout.hintRows,
          cursorRow: cursorRowIndex,
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
        <PickerOverlay
          title={pickerState.title}
          items={pickerState.items}
          columns={cols}
          onPick={resolvePicker}
        />
      ) : (
        <Box flexDirection="column">
          {agentTabs.length > 0 ? <AgentTabs tabs={agentTabs} activeId={activeTabId} /> : null}
          <NoticeBar lines={noticeTextLines} />
          {/* 附件提示行：必须在 NoticeBar 之后、菜单之前（与 computeInputCursorPosition 的顺序一致） */}
          {attachmentLines > 0 ? <PastedImagesBar count={pastedImages.length} /> : null}
          {/* 斜杠命令 / `@` 文件补全共用一套底部锚定菜单：行数取布局放行的 `layout.hintRows`，
              与上面 `computeChatLayout` 的 `hintCount`、下面 IME 光标的 `hintCount` 同源 */}
          {menuWant > 0 ? (
            <BottomMenu
              items={menuItems}
              selected={menuIndex}
              maxRows={layout.hintRows}
              columns={cols}
              topLine={scanningFiles ? t("mention.scanning") : undefined}
            />
          ) : null}
          <Box paddingX={1}>
            <Text color={theme.border} wrap="truncate">
              {"─".repeat(Math.max(1, cols - 2))}
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={1}>
            {busy ? (
              // 阶段随 SDK 事件推进：连接中 → 排队中 → 思考 / 输出 / 调用工具 → 等工具返回。
              // 渲染期现取（不另存 state）：chunk 与轮次边界都会触发重渲染，
              // 而 `busy` 置 true 本身也会重渲一次，捕得到首轮的「连接中」。
              // 阻塞型命令（`/update` 等）没有生成轮次，故回落到命令名，见 `busySpinnerLabel`。
              <Spinner label={busySpinnerLabel(sessionRef.current?.phase ?? null, busyCommand)} />
            ) : (
              shownLines.map((line, i) => {
                const prompt =
                  i === 0 && inputWin.from === 0 ? (
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
