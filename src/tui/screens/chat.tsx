// 会话屏幕 —— 以 `session.messages` 为唯一数据源渲染（无自定义中间模型）
import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useCursor, useInput, useWindowSize } from "ink";
import type { LogSink } from "@ai-zen/agents-logger";
import type { LogNotices } from "../../log-notices.js";
import { keyDebug } from "../key-debug.js";
import { phaseLine, type PhaseFacts } from "../../session-phase.js";
import { AgentNS } from "@ai-zen/agents-core";
import { theme } from "../theme.js";
import {
  PhaseLine,
  StatusBar,
  statusBarRows,
  BottomMenu,
  PastedImagesBar,
  InboxArea,
  inboxAreaLines,
  type MenuItem,
  type StatusBarProps,
} from "../components.js";
import { graphemes, layoutInput, usableFrameRows } from "../text.js";
import {
  type ChatSessionLike,
  type ChatSessionNotifier,
  type FileEntry,
  type HostConnection,
  type NoticeView,
  type RemovedSession,
  type SessionActivity,
} from "../../session/types.js";
import type { SessionHub } from "../../sessions-registry.js";
import { boundCall } from "../../connection.js";
import type { WorkspaceHost } from "../../workspace.js";
import {
  CommandHint,
  commandBlocksInput,
  matchCommandHints,
  parseCommandInput,
} from "../../commands/registry.js";
import { ConfigWizard } from "../config-wizard/index.js";
import { computeInputCursorPosition, inputWindow } from "./input.js";
import { AGENT_TABS_LINES, computeChatLayout, pickerCapacity } from "./layout.js";
import { FrameBuffer } from "./frame-buffer.js";
import { LineView } from "./render.js";
import { messageToLines, transcriptLines } from "./messages-view.js";
import { welcomeLines } from "./welcome.js";
import { PickerOverlay, FormOverlay } from "./overlays.js";
import { CursorInputRow, type CursorPosition } from "./input-row.js";
import { chooseQuestionAnswer } from "./question-choice.js";
import { runCommand, moveAfterGone } from "../../commands/index.js";
import { t } from "../../i18n/index.js";
import { endpointHasKey } from "../../config-editor.js";
import { clearSessionNotices } from "../../pending-notices.js";
import { normalizePastedText, PasteAssembler } from "../paste.js";
import { NoticeChannel, noticeBarContent, type Notice } from "./notice.js";
import { NoticeBar } from "./notice-bar.js";
import { AgentTabs, type AgentTab } from "./agent-tabs.js";
import {
  markSubAgentEndingSpoken,
  subAgentEndingOf,
  subAgentStatusOf,
} from "../../subagent-status.js";
import { useChatViewport } from "./use-chat-viewport.js";
import { useChatOverlays } from "./use-overlays.js";
import { useWizardHost } from "./use-wizard-host.js";
import { useInputEditing } from "./use-input-editing.js";
import { extractMention, mentionInsertText, rankPaths } from "../mention.js";
import { userDrafts } from "../chat-history.js";
import {
  MAX_CLIPBOARD_TEXT_BYTES,
  readClipboardImage,
  readClipboardText,
  type ClipboardImage,
} from "../../clipboard.js";
import {
  handleClearAllNoticesKey,
  handleClearNoticesKey,
  handleCtrlDExit,
  handleOpenImageKey,
  handleScrollKey,
} from "./common-keys.js";
import { openableImageHint, openableImageLabel, openableImages } from "./message-images.js";
import {
  openFileWithSystemApp,
  writeTempImageFile,
  type OpenFileResult,
} from "../../system-editor.js";

// ==================== 会话屏幕 ====================

/**
 * `Chat` 的外部依赖。
 *
 * 全部可注入是为了让集成测试**不必** `vi.mock` 整模块 —— 模块级 mock 在
 * 进程内共享模块（`isolate: false`）时是全局生效的，会把别的测试文件也带偏。
 */
export interface ChatDeps {
  /**
   * 进程级的那**一条**连接：屏幕自己**不建**。
   *
   * 它在本层只有一个用处：配置向导的读写（`call`）。会话那一半（借它说话、断线重连）由
   * 注册表统一持有（见下一项）。一个 TUI 进程里只能有一条到宿主的连接，而「不能有两条」只能由
   * **组装根**保证（`tui/index.tsx` 建一个、往下传）。
   */
  connection: HostConnection;
  /**
   * 会话注册表：**屏幕只借会话，不管它的生死**（PRD D4）。
   *
   * 从前这两件事都在屏幕里（挂载时建、卸载时 `dispose()`），于是换一段会话（`/new`、`/load`）
   * 就等于把旧那一段的订阅摘掉 —— 而它可能还在跑。现在建与关都归注册表（进程收摊时统一关），
   * 屏幕只 `enter`（接成听众）与 `detach`（摘听众）。
   */
  sessions: SessionHub;
  /**
   * 日志出口（根造、组装根递进来）：本层只把它转给命令层（`/ws` 记工作区、`/lang` 写偏好
   * 这两件事的失败要有去处）。屏幕自己不写日志 —— 它要说的话走通知栏。
   */
  logger: LogSink;
  /**
   * 日志转成通知的那一格（根造的，与 `logger` 同一份日志）：
   *
   * 它是**进程级的**，通知栏却是**这一屏的**（每次重挂载一个新 `NoticeChannel`）。所以屏幕
   * 挂上来时把自己的栏位注册成它的入口，走了就注销 —— 晚绑定、启动期攒的那几条、去重、封顶
   * 都在 `log-notices.ts` 里，这里只做接线。
   */
  logNotices: LogNotices;
  readClipboardImage: typeof readClipboardImage;
  readClipboardText: typeof readClipboardText;
  /**
   * 用**本机默认程序**打开一个文件（图片那条路）。
   *
   * 与两个剪贴板口子同一条理由：它要 spawn 一个本机进程，而「本机没有可用的打开命令」这种事
   * 只能在这台机器上才知道。默认就是 `system-editor.ts` 那一份（与 `/editor` 同一套写法），
   * 用例换成替身就能验「按下去真的取了一次 `asset.get`、并把路径交给了它」。
   */
  openPath: (file: string) => Promise<OpenFileResult>;
  /** 把取回来的字节落到一个临时文件，返回路径（同上：默认是真实现，用例可换） */
  writeTempImage: (base64: string, mime: string) => Promise<string>;
}

/**
 * 注入面：`connection` 与 `sessions` **必给**，其余可缺省。
 *
 * 它们**不给兜底**：「一个进程一条连接」「会话归进程所有」这两件事只能由**组装根**保证，
 * 组件自己再造一个就等于两条连接、两套会话寿命 —— Symptom 不是报错，而是「多一条 driver +
 * 切会话丢订阅」，平时完全看不见。做成必填之后，漏传就是**编译**错误。
 */
export type ChatDepsInput = Pick<ChatDeps, "connection" | "sessions" | "logger" | "logNotices"> &
  Partial<Omit<ChatDeps, "connection" | "sessions" | "logger" | "logNotices">>;

export interface ChatScreenProps {
  agentId?: string;
  /** 依赖注入（测试用；剪贴板两个可缺省） */
  deps: ChatDepsInput;
  /**
   * 启动时进入的工作区（PRD D30）：首屏的新会话开在它里面。
   *
   * 只是**首屏**的那一个：`/ws` 切过之后由会话自己记着「下一个新会话往哪开」（不重建会话，
   * 这一段会话仍然属于它建出来的那个工作区）。
   */
  workspaceId?: string;
  /**
   * 这次连的是哪台宿主（是不是本机 + 记忆键）。
   *
   * `/ws` 拿它回答两件事：新建时能不能默认当前目录（只有本机），以及「上次进入的是哪个」
   * 该记在哪一格。它是连接的事实，由组装根（`tui/index.tsx`）算一次递下来。
   */
  workspaceHost: WorkspaceHost;
  messages?: AgentNS.Message[];
  sessionId?: string;
  /**
   * 「接着该工作区上一次的会话」—— 只表达**意图**，不带数据。
   *
   * 为什么屏幕层不自己判断「有没有上一次」：哪一段算上一次，真相在服务端（指针 + 存档）。
   * 屏幕去读一遍就是第二份会漂的真相，而且永远得出「没有上次」——所以这里只把意图
   * 透传给会话层。
   */
  resume?: boolean;
  /** 重挂载时的初始输入（/back 撤回后用于预填） */
  initialInput?: string;
  /**
   * 重挂载时一起挂回输入的 Asset id（`/back` 撤回的那条消息里带的图，按原顺序）。
   *
   * 与 `initialInput` 是同一次回填的两半：文字进草稿、Asset 挂回输入（PRD 3.9）。
   */
  initialAssetIds?: readonly string[];
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
  /**
   * 启动期**已经知道**的那一句失败（开会话那一步宿主回的错，如模型不可解析）。
   *
   * 给了它就说明会话这一层已经试过、而且没开成：首帧直接上失败屏（`chat.bootFailed`，
   * 按 `k` 开配置中心），**不再重试一次** —— 同一个错问两遍没有任何好处。不给（常态）
   * 就是本屏自己去开，开不出来才由下面那个 `enter` 的 `catch` 落到同一个失败屏。
   */
  bootError?: string;
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
 * 手上这一批在动时由**契约事实**推出来（`phaseLine`：忙闲 + 那条消息的 status / 思考 / 正文 /
 * 工具调用）；但 `/update`、`/migrate` 这类**阻塞输入的命令**执行时根本没有「在忙」的那一格，
 * `phaseLine` 会回 `null` —— 与生成毫无关系。命令期间改显命令名，至少能看出「在跑哪条命令」，
 * 具体进度由命令自己 push 通知（查版本 / 开始安装 …）。
 */
export function workingSpinnerLabel(facts: PhaseFacts | null, command: string | null): string {
  const phase = facts ? phaseLine(facts) : null;
  if (phase) return phase;
  return command ? t("cmd.running", { name: command }) : t("phase.working");
}

export function Chat(props: ChatScreenProps) {
  /**
   * 依赖：`connection` 与 `sessions` 由组装根注入（**没有兜底**），剪贴板两项缺省走真实实现。
   *
   * 为什么它们没有兜底：见 `ChatDepsInput` 的注释 —— 组件里再造一条连接、或自己管一段会话的
   * 生死，是「一个进程两条连接」「切会话丢订阅」这两个病唯一还没堵住的入口。
   */
  const deps: ChatDeps = {
    readClipboardImage,
    readClipboardText,
    openPath: (file) => openFileWithSystemApp(file),
    writeTempImage: (base64, mime) => writeTempImageFile(base64, mime),
    ...props.deps,
  };
  const { exit, suspendTerminal } = useApp();
  const { setCursorPosition } = useCursor();
  const { columns, rows } = useWindowSize();

  /** 覆盖层（选择器 / 表单）：弹窗与 resolve 生命周期见 use-overlays.ts */
  const { pickerState, setPickerState, resolvePicker, formState, setFormState, resolveForm } =
    useChatOverlays();
  const sessionRef = useRef<ChatSessionLike | null>(null);
  /**
   * 会话实例（渲染期现取）。首帧为 `null`；创建那个 effect 把 `ready` 翻成 `true` 之后
   * 就有值了 —— 屏幕上的每一个事实都是从这里**现取**的，不另存副本。
   */
  const session = sessionRef.current;
  /** 宿主的忙闲那一格（`working` / `idle`；`null` = 还没读到） */
  const activity: SessionActivity | null = session?.status ?? null;
  /**
   * 「正在交接」（PRD 4.5 / 1.3）：这一段在写交接文档，记忆还没换完。
   *
   * 判据是会话层现读的那一格（`session.changed` 的 `handoff_started` 置、`memory_replaced` 收；
   * 重连时由 `session.state` 的 `handoff` 读回来）—— 屏幕不自己攒这个状态，因为「什么时候开始、
   * 什么时候收口」只有宿主知道。
   *
   * 交接期间界面要**拦住人**：不给发、只留中断（= 放弃交接、回滚到交接前）。宿主那边照收不误
   * （PRD 4.5 只关输出开关、不关输入开关），所以**拦在客户端这一侧**，否则用户会以为话已经受理了。
   */
  const handoffSince = session?.handoffSince ?? null;
  const handingOff = handoffSince !== null;
  const [bootError, setBootError] = useState<string | null>(props.bootError ?? null);
  const [ready, setReady] = useState(false);
  /** 视口：滚动状态与翻页 / 按行 / 滚轮换算（唯一入口见 use-chat-viewport.ts） */
  const { viewTop, layoutRef, scrollByPage, scrollByLine, scrollByWheel, scrollToBottom } =
    useChatViewport();

  /**
   * 手上有没有活 —— **两半合成，没有一格是自己的**：
   *
   *   · 生成那一半读契约的忙闲格（`session.status === "working"`，宿主报的观测值）；
   *   · 命令那一半是本地的（`blockingCommand`）：`/update`、`/migrate` 这类**阻塞输入的命令**没有
   *     「在忙」那一格可读，它们的进度也要一条阶段行。
   *
   * 从前这里是一个 `useState` 标志，问题就出在「它是我们记的」：一次失败之后它会停在 true、
   * 与宿主的真相脱钩。现在生成那一半由宿主说了算，界面只是读。
   *
   * 它**不**决定输入框能不能用：在动的时候也得能打字、能发（PRD 需求 2、3）。
   */
  const [blockingCommand, setBlockingCommand] = useState<string | null>(null);
  /**
   * 速率的**刷新计数**。
   *
   * 速率是采样值（`session.rateSample` 每读一次都可能不一样），它挂在状态栏那一块上，而状态栏
   * 只在重渲染时才会重新读一遍。所以这里留一个空计数：生成中每 250ms 加一，纯粹为催一帧。
   * 数字本身**不在这里存** —— 存一份就会与采样器分叉（它有自己的时间窗）。
   */
  const [, bumpRate] = useState(0);
  /**
   * 当前模型 id —— **从会话现取**（`stream.state.modelId` 的一手透传）。
   *
   * 为什么不用 `useState`（创建会话时灌一次）：`/model` 走 `session.reload()` 之后快照已经
   * 换了模型，灌下来的那份还停在首挂载时的值 —— 状态栏报的是一个已经不生效的模型。
   * 派生值就该现取。
   */
  const modelId = session?.modelId ?? "";
  /**
   * 语言切换计数（`/lang`）：`t()` 是模块级函数，语言变了已渲染的文案不会自更新，
   * 递增这个计数只为逼 React 重跑一遍渲染函数。
   */
  const [, bumpLocale] = useState(0);
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
    /** 本条附带的粘贴图片（只用于转录里显示 `[图片]` 占位，不在 UI 里展开 base64） */
    images?: readonly ClipboardImage[];
  } | null>(null);
  /**
   * 待发送的粘贴图片（`Ctrl+V` 累积）。
   *
   * 存 base64 而不是落盘：提交时它被解成字节交给服务端（`content.upload`），
   * 于是粘贴全程不碰磁盘 —— 也就不会在 `$TMPDIR` 里留下一堆无人清理的 png。
   */
  const [pastedImages, setPastedImages] = useState<readonly ClipboardImage[]>([]);
  /**
   * 撤回带回来的 Asset id（`/back` 回填的那几张图）。
   *
   * 与 `pastedImages` 分开存：那个装的是**还没上传**的剪贴板字节（发送那一刻才传），这个装的是
   * **已经传上去过的**Asset —— 撤回给回来的就是 id，再传一遍既浪费也不是同一份（PRD 1.8：
   * 同一张图全机只存一份，按内容认）。
   *
   * 初值取重挂载带过来的那一格：撤回之后这一屏是**新**挂载的实例，Asset 只能从 props 接。
   */
  const [restoredAssetIds, setRestoredAssetIds] = useState<readonly string[]>(
    () => props.initialAssetIds ?? [],
  );
  /** 转录显示起点（/clear 清屏用：隐藏此索引之前的消息，但不改上下文） */
  const [transcriptFrom, setTranscriptFrom] = useState(0);
  /**
   * 当前查看的 Agent 视图：`"main"` 或某个子 Agent 的视图 id。
   *
   * 只影响**消息列表的数据源**（主 Agent 的 `messages` / 子 Agent 自己的 `messages`），
   * 不改上下文、不影响发送目标：发出的消息永远属于主 Agent。
   */
  const [activeAgentId, setActiveAgentId] = useState("main");

  /**
   * 括号粘贴的拼装器：一段粘贴可能被终端拆成几块写进来，这里把它们拼回整段再插一次。
   *
   * 认不出来时会退化成「每块当打字插入」—— 那也是老行为，不会比从前更糟。
   */
  const pasteRef = useRef<PasteAssembler | null>(null);
  if (pasteRef.current == null) pasteRef.current = new PasteAssembler();

  /** Ctrl+D 双击退出计时 */
  const ctrlDAtRef = useRef(0);

  /**
   * 通知通道：notice / error 走独立栏位，绝不进会话转录（messages）。
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
   * CLI 自己的 warn / error 直接进通知栏 —— **通用通道**，不为某个功能单独接线。
   *
   * 光把日志写进文件（不然 `console.log` 会撕坏 Ink 的帧）的代价是「日志说了什么」用户在界面上
   * 一个字都看不见，只能事后翻 `cli.log` —— 排查成本极高（连「工具文件把进程杀了」这种事都
   * 只能靠猜）。这里把屏上的通知栏注册成日志那一格的入口：任何一处 `logger.warn/error`，界面上
   * 自动就有，不必为新特性再传一个回调。
   *
   * `origin: "log"` 是这条链的记号：它跟着「发送那一刻清空」走（`clearNoticesOnSend`），
   * 与业务提示（宿主转来的、CLI 自己说的那句话）同批退场 —— 两档都在用户开口时清掉。
   */
  useEffect(() => {
    deps.logNotices.setSink((level, message) => noticeChannel.push(message, level, "log"));
    return () => deps.logNotices.setSink(null);
  }, [deps.logNotices, noticeChannel]);

  /**
   * 配置向导宿主（凭据 / 配置中心）：整屏接管与「关闭后让改动生效」见
   * use-wizard-host.ts。这里只提供出口：通知走通知通道、重启 / 重载走会话。
   */
  const {
    wizardStep,
    wizardConfig,
    wizardPresets,
    wizardAgents,
    wizardServers,
    wizardSessionsByAgent,
    openWizard,
    openKeyEditor,
    closeWizard,
  } = useWizardHost({
    // 向导的读写都走**这一条**连接：读快照（`config.get` / `agentDefinition.list` / `mcp.list`）
    // 与写（`config.*` / `agentDefinition.*` / `mcp.*`）落在同一条连接、同一份真相上
    api: deps.connection.api,
    modelId,
    workspaceId: session?.workspaceId ?? props.workspaceId ?? "",
    notify: (text, tone) => noticeChannel.push(text, tone),
    hasSession: () => sessionRef.current != null,
    // 向导改完某些配置后要重挂载（同一进程、新 Ink 实例）。会话 id 必须带**此刻**的：
    // 宿主手上的那个是首次挂载时的，`/new` 会让它过期。
    restart: () =>
      exit({
        restart: true,
        sessionId: sessionRef.current?.sessionId,
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
   * 转录内容始终从 `session.messages` 现取，tick 只负责「告诉 React 该重画了」。
   */
  const [, setTick] = useState(0);
  const frameBufferRef = useRef<FrameBuffer<null> | null>(null);
  if (frameBufferRef.current == null) {
    frameBufferRef.current = new FrameBuffer<null>(() => setTick((t) => t + 1));
  }

  // 创建会话
  useEffect(() => {
    let disposed = false;
    // 启动期已经知道开不出来（配置残缺）：会话层不必再问一遍宿主，首帧就按那一句上失败屏
    if (props.bootError !== undefined) return () => frameBufferRef.current?.dispose();
    /**
     * 这一屏正看着的那一段被**别处**删掉了（另一个终端 / 桌面端；`session.removed` 由注册表转
     * 过来，见 `sessions-registry.ts` 的 `onRemoved`）。
     *
     * 两件事：说一句「这一段会话已经被删掉了」，然后换到同一个项目里最近的那一段（`session.list`，
     * 宿主已经把顺序排好）。那个项目里一段都不剩时就回连接屏，并说清可以用 `/new` 开一段 ——
     * 这一屏没有会话可看了，留在这里只会让人对着一段不存在的东西敲字。
     *
     * 收尾本身与 `/delete`、`/ws delete` 共用同一套（`moveAfterGone`）：换到哪一段、没地方可换
     * 时说什么，只有一处。摘登记已经由注册表做过了（它先摘、再告诉这一屏）。
     */
    const closeAfterRemoved = async (removed: RemovedSession): Promise<void> => {
      try {
        await moveAfterGone(
          {
            api: deps.connection.api,
            notice: (text, tone) => noticeChannel.push(text, tone),
            exit,
          },
          {
            gone: [removed.sessionId],
            scope: { workspaceId: removed.workspaceId },
            notice: t("chat.sessionRemoved"),
            emptyHint: t("cmd.delete.noOtherSession"),
            whenEmpty: "connect",
          },
        );
      } catch {
        // 连「同项目里还有哪几段」都问不出来（连接断了）：至少不把这一屏停在一段已经不存在的
        // 会话上 —— 回连接屏，那一句已经把发生的事说清楚了
        exit({ backToConnect: t("chat.sessionRemoved") });
      }
    };
    const notifier: ChatSessionNotifier = {
      onChange: (immediate) => {
        if (disposed) return;
        frameBufferRef.current?.push(null, immediate);
      },
      onNotice: (text, tone, origin) => {
        // `origin` 原样透传：宿主转来的那条可能带着 `log`（日志上浮），发送那一刻要清掉它
        if (!disposed) noticeChannel.push(text, tone, origin);
      },
      onRemoved: (removed) => {
        if (disposed) return;
        void closeAfterRemoved(removed);
      },
    };
    deps.sessions
      .enter(
        {
          agentId: props.agentId,
          // 消息**不在这里传**：远程实现只持有一个会话 id，内容由宿主快照给
          // （`props.messages` 仍用于本屏首帧渲染与 `/back` 的显示起点）
          sessionId: props.sessionId,
          // 「接着上次」只是意图：接哪一段由会话实现去问宿主，屏幕不判断
          resume: props.resume,
          // 启动时进入的那个工作区（本机当前目录 / 远端上次进入的那个 / 屏上选的那个）：
          // 会话层只认它，不再拿 `process.cwd()` 去猜
          workspaceId: props.workspaceId,
          // 宿主问过来一道题（到交接线、或者要确认不可撤销的动作）时怎么作答。
          // 没人答就返回 `null`：这道题会一直挂着，宿主以 `question_pending` 拒绝后续发送 ——
          // 替用户选一个选项等于替他做决定。
          // 交接题答完之后的后续动作全在宿主那一侧（`question.answer` 的 `effects` 会说
          // 「当场开始了没有 / 为什么没有」），这一屏不必再记一条记号去猜「搬没搬」——
          // 新契约的交接是**原地换记忆**，会话 id 不变，屏幕上什么都不会跳。
          onQuestion: async (question) => await chooseQuestionAnswer(setFormState, question),
        },
        notifier,
      )
      .then((session) => {
        if (disposed) {
          // 屏等会话开好之前就走了（`/new` 的重挂载就是这个时序）：会话仍在注册表里，
          // 只是把刚接上的听众摘掉 —— **不** `dispose()`，它可能还在后台跑
          deps.sessions.detach(notifier);
          return;
        }
        sessionRef.current = session;
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
      // **只摘听众**：会话归进程所有（PRD D4），切走的那一段还要接着跑 —— 在这里
      // `dispose()` 就是把它的订阅丢在半路（它从此再也收不到 `run.state` 与增量）。
      deps.sessions.detach(notifier);
    };
  }, [
    deps.sessions,
    props.agentId,
    props.bootError,
    props.messages,
    props.sessionId,
    props.resume,
    props.workspaceId,
  ]);

  // 速率刷新：状态栏那一块只在重渲染时重新读采样器，所以在动的时候每 250ms 催一帧。
  // 手上没活时也读一次 —— 那一下拿到的是这一批的平均值。
  useEffect(() => {
    bumpRate((n) => n + 1);
    if (activity !== "working") return;
    const timer = setInterval(() => bumpRate((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [activity]);

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
    // （两种图都回来：内联字节与已经传上去的 Asset id）
    historySource: () => userDrafts(sessionRef.current?.messages ?? []),
    restoreAttachments: (images, assetIds) => {
      setPastedImages(images);
      setRestoredAssetIds(assetIds);
    },
  });
  /**
   * 往草稿里写的**唯一入口**（打字 / 换行 / 粘贴都走它）。
   *
   * 交接期间它空转：PRD 4.5「输入框不给打字」。挡在这一个口而不是在每个按键分支里各挡一遍 ——
   * 否则以后再加一条写入路就会漏掉交接态（粘贴与 Ctrl+J 从前正是这样各写各的）。
   */
  const typeIntoDraft = handingOff ? () => {} : insertAtCursor;
  /** 斜杠候选菜单的高亮索引；输入一变就回到第一个候选 */
  const [menuIndex, setMenuIndex] = useState(0);
  useEffect(() => {
    setMenuIndex(0);
  }, [input]);
  /**
   * 本工作区的文件 InboxEntry（`@` 补全的候选源，宿主 `workspace.files` 的相对路径原样）。
   *
   * `null` = 还没问到；`[]` = 问到了但没有（或问失败）。两者分开，菜单才能在不该弹的时候
   * 真的不弹。
   */
  const [fileIndex, setFileIndex] = useState<FileEntry[] | null>(null);
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
  /**
   * 菜单项：斜杠命令带说明，`@` 路径目录带尾斜杠（提示「选中后继续下钻」）。
   *
   * 忙时那几条（`needsIdle`）在说明前面标一句「忙时不可用」：判据与入口那道门同一个
   * （`CommandMeta.needsIdle`），所以菜单说不可用的，按下去真会被拦。
   */
  const menuItems: MenuItem[] = slash
    ? hints.map((hint) => ({
        key: hint.names[0]!,
        label: hint.label,
        // 忙闲那一格在 `activity` 上（`working` 那个合成值在此处还没定义：它要算上阻塞命令）
        hint:
          hint.needsIdle === true && activity === "working"
            ? `${t("cmd.menuNeedsIdle")} · ${hint.description}`
            : hint.description,
      }))
    : fileMatches.map((entry) => ({
        key: entry.path,
        // 目录带尾斜杠（提示「选中后继续下钻」）；判据是宿主给的 `kind`
        label: entry.kind === "directory" ? `${entry.path}/` : entry.path,
      }));

  /**
   * 每次「重新唤起 `@`」都问一次本工作区的文件清单。
   *
   * 为什么问会话而不是自己扫盘：`@` 补全给出的路径必须对**跑会话的那台机器**成立。
   * 会话跑在宿主里，屏幕这边扫本机磁盘列出的是客户端机器的文件 —— 模型拿到那些路径一律
   * not found。`listWorkspaceFiles()` 问的就是宿主（`workspace.files`），屏幕只负责过滤与插入。
   *
   * 为什么这里不再叠一层缓存：宿主那边每次都是**现走一遍目录**（一次 `workspace.files` 就是一
   * 次真扫，没有 TTL、没有缓存可对齐）。屏幕再存一份就是两份真相——屏幕那份过期时，用户看到的
   * 是「刚建的文件有时在、有时不在」。每次唤起都问，刷新节奏由清单的持有者说了算。
   *
   * ## 为什么要轮询（那一档 `scanning`）
   *
   * 宿主这一版是 `workspace.files` 一次列完，回的清单已经是有定论的那一份，这一圈通常一问就落
   * 到 `ready` / `unavailable` 上。循环留着是因为 `WorkspaceFiles.state` 里还有 `scanning` 那一
   * 档（旧契约「先回扫着、回头再问」）：真回到那一档时保持 `fileIndex === null`（屏幕继续挂
   * 「扫描中…」），过一会儿重问。上限 20 × 500ms ≈ 10s；真超了就当空清单（绝不把输入框卡在
   * 「扫描中」）。
   */
  useEffect(() => {
    if (mention == null) return;
    // 会话还没建好就问不到；`ready` 与 `sessionRef` 同时就绪（见上面的创建 effect），
    // 所以这里直接返回，等 `ready` 变化时本 effect 再跑一次——否则 `@` 菜单会一直
    // 停在「扫描中…」。
    const session = sessionRef.current;
    if (!session) return;
    let alive = true;
    void (async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const listed = await session.listWorkspaceFiles().catch(() => null);
        if (!alive) return;
        // 问不到（宿主没这条方法 / 连接断了）：按空清单处理，绝不让补全卡住输入框
        if (listed === null) {
          setFileIndex([]);
          return;
        }
        if (listed.state !== "scanning") {
          setFileIndex(listed.entries);
          return;
        }
        // 还在扫：保持 null（菜单继续显示「扫描中…」），过一会儿再问
        setFileIndex(null);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (alive) setFileIndex([]);
    })();
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
    replaceRange(mention.start, mention.end, mentionInsertText(entry));
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
    /**
     * 不再预判（`dev-docs/prd/09-attachments.md` 的「不在客户端预判」）：剪贴板里有什么就收什么，
     * 不比大小、不数张数。字节上限给无限大，读剪贴板这一步只把字节取回来。
     *
     * 上限由宿主判：超了是宿主那一次 `invalid_params`，那一句原话经 `session.send` 上屏
     * （`session.ts` 的 `send` 把宿主的话原样交给通知栏），不另编一句取代它。
     */
    const result = await deps.readClipboardImage({}, Number.POSITIVE_INFINITY);
    if (result.kind === "image") {
      setPastedImages((list) => [...list, result.image]);
      // 只报「输入框里现在挂着几张」这个事实（粘贴的 + 撤回带回的），不拿它跟上限比
      noticeChannel.push(
        t("notice.imagePasted", { n: pastedImages.length + restoredAssetIds.length + 1 }),
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
    // 与终端粘贴走**同一份**归一（`paste.ts`）：`\r\n` 收成 `\n`、去掉其余控制字符与尾换行
    typeIntoDraft(normalizePastedText(pasted.text));
  };

  /**
   * 发送那一刻清空通知：本地队列一条不留，宿主上**这一段会话**的那一份也清。
   *
   * ## 为什么两档一起清
   *
   * `log` 档（日志上浮的）本来就是「刚才那阵发生了什么」，发送即过期；`app` 档（宿主说的、
   * CLI 自己说的）以前留着等用户处理，代价是它们顶着输入框陪下一轮对话 —— 而用户一开口，就
   * 已经开始讲新的一件事了。所以发送 = 这一批通知的生命周期结束。
   *
   * ## 为什么连宿主那一份也清
   *
   * 不清的话，下次重连补看（`flushPendingNotices`）会把同一批再上屏一遍 —— 用户明的已经
   * “翻篇”了的东西又来一次。清的只是**这一段会话**：不带 `sessionId` 的清全部是另一档
   * （`Ctrl+G`，要明说，PRD 那条规矩），这里绝不顺手做。
   *
   * 清不掉不报：这一刻用户要成的是「把这句话发出去」，拿清通知的失败挡在他面前说不通；
   * 要报失败的是 `Ctrl+X` 那条路（它本身就是「清」这个动作）。
   */
  const clearNoticesOnSend = () => {
    noticeChannel.clear();
    const sessionId = sessionRef.current?.sessionId;
    if (!sessionId) return;
    void clearSessionNotices(deps.connection, sessionId).catch(() => {});
  };

  const runSubmit = async (text: string, options: { asMessage?: boolean } = {}) => {
    const trimmed = text.trim();
    if (!trimmed || !sessionRef.current) return;
    /**
     * 交接期间**不发**（PRD 4.5 / 1.3）。
     *
     * 与下面那条「忙也照发」不冲突，两件事的判据不同：忙是「手上有活」，宿主活着就收（PRD 4.2）；
     * **交接是「记忆马上要被换掉」**，这时收下的话要等换完才被取走，而且用户看不见任何受理迹象
     * —— 让他以为发出去了，比直接告诉他「现在不行」坏得多。
     *
     * `clearDraft()` 在这条之后（没走到），所以草稿留住：交接结束接着发就行。
     */
    if (handingOff) {
      noticeChannel.push(t("notice.handoffBlocksInput"));
      return;
    }
    /**
     * 这一屏是否由**本次提交**接管那两样本地的东西（乐观回显、阻塞命令的阶段行）。
     *
     * 手上已经有活时提交照发 —— 客户端**不加**「运行中禁止发送」的分支：宿主那边忙不是拒绝的
     * 理由（活着就收下入队，PRD 4.2）。但乐观回显是**这一句**的，不该在别人的活还在跑时被
     * 我们收掉；阻塞命令名同理。
     */
    const ownsWorking = !working;
    clearDraft();
    scrollToBottom();
    // 发出去的消息永远属于主 Agent：停在子 Agent 视图上会让用户看不到自己的提问
    setActiveAgentId("main");
    /**
     * 发送那一刻清空通知（本地队列 + 宿主这一段），按下就清，不等发送结果。
     *
     * 时机：恰好在这一句**被受理**之后、命令 / 消息分流之前 —— 那时草稿已经清掉、光标已经
     * 回到底部，通知栏再留着上一批话就是纯噪声。（清什么、为什么连宿主那份也清，见
     * `clearNoticesOnSend`。）
     */
    clearNoticesOnSend();

    // 斜杠命令：命令名怎么解析、哪些命令会调用模型（要拦输入框），都来自命令元数据
    const command = options.asMessage ? null : parseCommandInput(trimmed);
    if (command) {
      const name = command.name;
      // 阻塞型命令（`/update` / `/migrate`）执行期间接管输入框：它们不产出回答，
      // 阶段行只能靠命令名说话（见 `workingSpinnerLabel`）。同样只在「没在跑别的」时接管。
      const blocksInput = commandBlocksInput(name) && ownsWorking;
      if (blocksInput) setBlockingCommand(name);
      try {
        await runCommand(name, trimmed, {
          session: sessionRef.current!,
          // 命令层的配置 / AgentDefinition / 模型 / 宿主域读写（`/model`、`/agent`、`/think` …）一律说契约方法：
          // 屏幕只负责把这一条连接递下去，不替它判断本地还是远程
          call: boundCall(deps.connection),
          // 会话域 / 工作区域直连的那一面（口径③）：`/ws`、`/model` 要的就是它
          api: deps.connection.api,
          // 这台宿主是不是本机：`/ws new` 只有本机才能默认当前目录
          workspaceHost: props.workspaceHost,
          // 日志出口：`/ws` 记工作区、`/lang` 写偏好这两处失败要说一句
          logger: deps.logger,
          notice: (text, tone) => noticeChannel.push(text, tone),
          clearTranscript,
          exit,
          suspendTerminal,
          // 命令层不需要关闭结果（要「等它关掉、并知道成没成」的是下面那个 `ensureKey`）：
          // 这里把它拍回 `void`，免得命令层多一个它不该关心的类型。
          openWizard: async (step) => {
            await openWizard(step);
          },
          openKeyEditor,
          // 「让这个端点的密钥就位」：与首启引导用的是同一屏（`edit` 的 apiKey 那一步），
          // 差别只在开完之后要**等它关闭**，再读一次配置回答「现在到底有没有钥匙」——
          // `/model` 拿这个答案决定切不切，而不是在没钥匙的情况下把会话行先改了。
          ensureKey: async (endpointId: string) => {
            const closed = await openWizard({ kind: "edit", field: "apiKey", endpointId });
            if (!closed?.dirty) return false;
            const { config } = await deps.connection.api.config.get.query();
            return endpointHasKey(config, endpointId);
          },
          doExit,
          // 覆盖层入口：命令层拿到的是 Promise，不是 React setter（见 `ChatCommandHost`）
          pick: (title, items) =>
            new Promise<string | null>((resolve) => setPickerState({ title, items, resolve })),
          // `/new` 与 `/sessions` 都要「换会话」这件事，而会话归进程所有（PRD D4）：
          // 屏幕只把注册表的两个口子转下去，自己不决定开与关
          newSession: () => deps.sessions.newSegment(),
          liveSessions: deps.sessions.list(),
          // `/delete` 删完之后把这一段从本进程的登记里摘掉（连带它的订阅）：摘登记归注册表，
          // 命令层只说「这一段已经不在了」
          dropSession: (sessionId) => deps.sessions.drop(sessionId),
          // 这一次删除是本进程自己叫的：`session.removed` 回来时不用再演一遍「别处删掉了这一段」
          // （那一下会先惊动这一屏，紧接着命令自己的收尾又来一遍）
          expectOwnRemoval: () => deps.sessions.expectOwnRemoval(),
          setInputText,
          // 状态栏的思考档现在**从会话现取**（`session.thinking` → `statusBlocksOf` 的身份块）：
          // `/think` 写完那一刻 `session.setThinking` 回来的那份就是新的现状，会话随即通知重绘。
          // 命令层这个回调因此不再写进 messages 任何状态（它保留是因为 `ChatCommandHost` 是一份跨前端的接口）。
          setEffortView: () => {},
          refreshLocale: () => bumpLocale((n) => n + 1),
        });
      } finally {
        if (blocksInput) setBlockingCommand(null);
      }
      return;
    }

    const base = sessionRef.current!.messages.filter((m) => m.role === AgentNS.Role.User).length;
    // 先取快照再清空：`send` 要用同一个数组，而输入区要立刻回到「没有附件」的状态
    const images = pastedImages;
    // 撤回带回来的那几张已经传上去了：不重传，只把 id 交下去（顺序即原消息里的）
    const restored = restoredAssetIds;
    setPastedImages([]);
    setRestoredAssetIds([]);
    if (ownsWorking) setPendingUser({ text: trimmed, base, images });
    const session = sessionRef.current!;
    try {
      /**
       * **「按发送」是一个复合动作：复活 → 开开关 → 投递**（PLAN §5.1）。三步里只有两步在屏幕这边：
       *
       *   1. 复活（`!alive` → `agent.wake`）：**归会话层的 `send()`**（PRD 4.1「客户端点发送时
       *      先判这段是死是活，死的就调接口复活、再投递」）。放在会话层而不是这一屏：所有发话
       *      入口（这一屏、将来任何前端）共用它，屏幕这边再叫一次 `start()` 就是在醒了之后再
       *      白叫一次（两次往返做同一件事）；用户杀掉一段或宿主重启之后还能不能发进去，也不该
       *      看哪一个前端在发；
       *   2. `outputPaused` → `resume()`：「用户点发送就是继续」（PRD 4.4）—— 开关关着时投进去
       *      只会排队、用户等的是一个回答；
       *   3. `send()`：投递。
       *
       * 这三件是两个正交接口的三种用法（复活 / 动开关 / 入队），所以**没有一步替另一步做事**。
       * 判据是**当时读到的**那一格，读什么做什么 —— 不做「反正调一下也无害」的预调：`resume` 在
       * 交接期间会被宿主拒（`handoff_in_progress`），白调一次就是让一次正常发送多失败一次。
       *
       * 哪一步没成就说清哪一步、后面那步**不做**（发出去半句比没发更糟），也不重试、不回退 ——
       * 用户按一下再说一次就是重试。开开关失败这一句在屏幕这边说（它能做、没做成），复活与投递
       * 失败那句由会话层自己报（它报的才是宿主原话）。
       */
      if (session.outputPaused === true) {
        try {
          await session.resumeOutput();
        } catch (error) {
          noticeChannel.push(
            t("notice.resumeFailed", {
              error: error instanceof Error ? error.message : String(error),
            }),
            "error",
          );
          return;
        }
      }
      // 最后一步就是投（死的先叫起来也是它自己那一手）：`send` 受理即回，`waitForReply` 才是
      // 「这一句有了下文」。事件可能比 `send` 的回执先到，所以这两句不能合成一句。
      await session.send(trimmed, images, [...restored]);
      await session.waitForReply();
    } finally {
      if (ownsWorking) setPendingUser(null);
    }
  };
  const doExit = () => {
    exit("done");
  };

  /** 名册上那些 subagent（`session.state.subAgents` 原样，渲染期现取） */
  const subAgentViews = sessionRef.current?.subAgents ?? [];
  /**
   * subagent 那一栏的**签名**：谁、在哪一格（`working` / `idle` / `ended`）。
   *
   * 它同时是「要不要重取这个 subagent 的消息」的判据 —— 名册上的一次变化（它散场了、又开始
   * 动了）就该重新问一次；只按 id 记住会很安静地停在一份旧会话上。
   */
  const subAgentSignature = subAgentViews
    .map((item) => `${item.toolCallId}:${item.state}`)
    .join(",");
  /**
   * 名册每一行此刻的状态（名册那一格 + 它自己消息上的结局）。
   *
   * 栏目圆点与「结束了说一句」读的都必须是这一份 —— 两处各算一次的话，完全可能出现圆点是红的
   * 而通知说「已完成」。
   */
  const subAgentStates = subAgentViews.map((item) => ({
    fact: item,
    status: subAgentStatusOf(item, sessionRef.current?.subAgentMessages(item.toolCallId) ?? []),
  }));
  /**
   * 上面那份的**签名**：谁、在哪一格。
   *
   * 名册每次渲染都是新数组（会话层现拼的），按数组进依赖会让下面那条 effect 每帧都跑一遍；
   * 而「有结局了」本身就是一个会重复抵达的事实，必须靠这份签名收成一次。
   */
  const subAgentStateSignature = subAgentStates
    .map(({ fact, status }) => `${fact.toolCallId}:${status}`)
    .join(",");
  /**
   * subagent 结束了要说一句（`PRD 3.9`「出现了哪些、各自什么状态、失败必须显示失败」）。
   *
   * 圆点变色只是「看得见」：它说不出是哪一个、也说不出为什么 —— 而失败的原话就写在它那条
   * 结局消息上（`error.message`），照传，不另编一句取代。完成的也报一声：栏目随后会自动收起，
   * 收起之后再没人提它，用户分不出「完事了」与「被静默丢掉」。
   *
   * 同一条结局只说一次（记账见 `markSubAgentEndingSpoken`：键是那条结局消息的 id），于是重挂载
   * （`/model`、`/lang`）之后不会重说。
   */
  useEffect(() => {
    for (const { fact } of subAgentStates) {
      const ending = subAgentEndingOf(
        fact,
        sessionRef.current?.subAgentMessages(fact.toolCallId) ?? [],
      );
      if (!ending) continue;
      if (!markSubAgentEndingSpoken(ending.key)) continue;
      if (ending.ending === "error") {
        noticeChannel.push(
          ending.reason === undefined
            ? t("notice.subAgentFailed", { name: fact.name })
            : t("notice.subAgentFailedWhy", { name: fact.name, error: ending.reason }),
          "error",
        );
      } else if (ending.ending === "aborted") {
        noticeChannel.push(t("notice.subAgentAborted", { name: fact.name }));
      } else {
        noticeChannel.push(t("notice.subAgentDone", { name: fact.name }));
      }
    }
    // 只在「谁、什么状态」变了时重跑（签名就是这件事的唯一说法）
  }, [subAgentStateSignature]);
  /**
   * 正在看的那个子 Agent 自己的消息（`message.list` 带 `toolCallId` 取回）。
   *
   * 主视图不看它；切到某个子 Agent 时按需取，`toolCallId` 一起存着 —— 换栏目的一瞬间旧那份
   * 还留在 state 里，靠这个字段判断「它是不是当前这个的」。
   */
  const [subMessages, setSubMessages] = useState<{
    toolCallId: string;
    messages: AgentNS.Message[];
  } | null>(null);
  useEffect(() => {
    if (activeAgentId === "main") return;
    const current = sessionRef.current;
    if (!current) return;
    let alive = true;
    const toolCallId = activeAgentId;
    void current
      .listSubAgentMessages(toolCallId)
      .then((messages) => {
        if (alive) setSubMessages({ toolCallId, messages });
      })
      .catch((error: unknown) => {
        // 谁会走到：`message.list`（带 `toolCallId`）被宿主拒 —— 那段会话已删、或那个工具调用的
        // 子消息已经被清理。那一条不该把整屏报错，但「子 Agent 什么都没说」与「读不出来」是
        // 两件事：先说一句，再按空会话渲染。
        if (!alive) return;
        noticeChannel.push(
          t("chat.subAgentMessagesFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
        setSubMessages({ toolCallId, messages: [] });
      });
    return () => {
      alive = false;
    };
  }, [activeAgentId, ready, subAgentSignature]);

  /**
   * Agent 栏目切换（← / →）：在「主 Agent + 各子 Agent」之间循环。
   *
   * 键位分流见下方的 `useInput`：输入框**为空**时左右键本来就无处可做，正好用来切换；
   * 输入框**有内容**时左右键仍然是移光标（生成中也一样 —— 输入框一直在，那两键就一直是
   * 编辑键）—— 不能为了切栏目把文本编辑的左右移动废掉。
   */
  const switchAgentView = (dir: -1 | 1) => {
    const ids = ["main", ...subAgentViews.map((item) => item.toolCallId)];
    // 旧 id 已失效（会话重建）时 indexOf 为 -1，归一后从主 Agent 起步
    const current = Math.max(0, ids.indexOf(activeAgentId));
    setActiveAgentId(ids[(current + dir + ids.length) % ids.length]!);
    scrollToBottom();
  };

  /**
   * `useInput` 的键位上下文 —— 判定逻辑在 common-keys.ts。
   * 放这里而不是各自内联，是为了让「什么时候能滚、Ctrl+D 怎么退」只有一份定义。
   */
  const scrollKeys = { scrollByWheel, scrollByPage, scrollByLine };
  const ctrlDExit = {
    lastAt: ctrlDAtRef,
    notify: () => noticeChannel.push(t("notice.pressCtrlDAgain")),
    exit: doExit,
  };

  /**
   * 通知栏的「清这一段」（`Ctrl+X`，提示就写在栏位最后一行）。
   *
   * 两件事分开做：本地队列先清（用户按下就得看到反应），宿主那边清的是**这一段会话**的
   * 通知（`clearSessionNotices` 的按会话口径）。
   *
   * ## 清成功之后**不吭声**
   *
   * 栏位空的时候连提示那一行都不画（`noticeBarContent`），所以「队列空了」这件事本身
   * 就是屏幕上看得见的回执 —— 再 push 一句「已清空本会话的通知」，等于把刚清掉的栏位又
   * 撑起一行：用户按一次冒一条，栏位永远不是空的，那条通知唯一的功能就是让「清空」白做一次。
   *
   * 失败必须说：按下的就是「清」这个动作，而它只影响「下次重连要不要再播一遍」，闷掉
   * 会让用户以为清干净了。
   *
   * 整个库那一档（清全部）是另一个键、另一条路：见下面的 `clearAllNotices`。
   */
  const clearNotices = () => {
    noticeChannel.clear();
    const sessionId = sessionRef.current?.sessionId;
    if (!sessionId) return;
    void clearSessionNotices(deps.connection, sessionId).catch((error: unknown) => {
      noticeChannel.push(
        t("notice.deleteAllFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    });
  };
  const clearNoticesKeys = { clear: clearNotices };

  /**
   * 通知栏的「清全部」（三档粒度里的第三档）。
   *
   * ## 为什么这一档要先问一次，且把「连累谁」写在问题里
   *
   * 契约里 `notice.deleteAll` 不给 `sessionId` 就是清**整个宿主库**：全局通知（不属于任何一段会话，
   * 哪儿都看得见）与别的会话还没上屏的通知都会一起没。`prd/08-client.md` 的通知那一节写着
   * 「清全部要明说，不能顺手全清」—— 所以问题里点名那两件事，别给人事后才发现别处也没了的
   * 机会；选了「否」一个方法都不调。
   *
   * ## 顺序：先数、再问、最后清
   *
   * 条数从**清之前**那次 `notice.list`（不带 `sessionId` = 整个库）数出来 —— 清完就问不出来了，
   * 而「清掉了什么」这句话里必须有数。列不出来就停在这里（什么都不清）。
   *
   * 本地队列也一起清：那些句子在宿主那边已经没了，留着它们等于挂着一批不存在的通知；清完再
   * push 那一句总结，屏幕上说的就是刚发生的事。
   */
  const clearAllNotices = async () => {
    let all: readonly NoticeView[];
    try {
      all = await deps.connection.api.notice.list.query({});
    } catch (error) {
      noticeChannel.push(
        t("notice.deleteAllAllListFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
      return;
    }
    const answer = await new Promise<string | null>((resolve) =>
      setPickerState({
        title: t("notice.deleteAllAllTitle", { n: all.length }),
        items: [
          { label: t("notice.deleteAllAllConfirm"), value: "yes" },
          { label: t("notice.deleteAllAllCancel"), value: "no" },
        ],
        resolve,
      }),
    );
    // 选了「否」（Esc / 覆盖层被关掉也是这一支）：一个方法都不调
    if (answer !== "yes") {
      noticeChannel.push(t("notice.deleteAllAllCancelled"));
      return;
    }
    try {
      // **不带** `sessionId` 的那一次：清的是整个库（含全局与别的会话的）
      await deps.connection.api.notice.deleteAll.mutate({});
    } catch (error) {
      noticeChannel.push(
        t("notice.deleteAllAllFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
      return;
    }
    noticeChannel.clear();
    noticeChannel.push(t("notice.deleteAllAllDone", { n: all.length }));
  };
  const clearAllNoticesKeys = { ask: () => void clearAllNotices() };

  /**
   * 把这一段里的一张图取回来、交给本机默认程序打开（`Ctrl+O`）。
   *
   * ## 为什么不是「打开最后一张」
   *
   * 一条消息里可以有好几张，一段会话里可以有好几条 —— 替用户猜一张，猜错了就是他看到的东西
   * 与他点的不一致。所以先列出来让人挑：每一条带「第几条消息、第几张」与手里已有的尺寸 /
   * 文件名（`message-images.ts`）。
   *
   * ## 三步，每一笔失败都说清是哪一种
   *
   *   1. `asset.get` 取字节 —— 宿主说没有了就是「这张图已经不在了」（删过消息 / 删过会话）；
   *   2. 落到临时文件 —— 写不进去就说写到哪一步失败（文件系统的事，不是宿主的）；
   *   3. 交给本机默认程序 —— `system-editor.ts` 的 `openFileWithSystemApp` 三种结果分得开：
   *      打开了 / 这台机器没有可用的打开命令 / 命令跑了但没成。后两种都把**文件路径**带上：
   *      字节已经取回来了，用户自己拖进看图器就行。
   *
   * 三步都不静默：它们都是用户按了键之后的动作，一声不响等于让用户以为键坏了。
   */
  const openImage = async () => {
    const images = openableImages(sessionRef.current?.messages ?? []);
    if (images.length === 0) {
      noticeChannel.push(t("notice.imagePickEmpty"));
      return;
    }
    const picked = await new Promise<string | null>((resolve) =>
      setPickerState({
        title: t("notice.imagePickTitle"),
        items: images.map((image, index) => ({
          label: openableImageLabel(image),
          hint: openableImageHint(image),
          value: String(index),
        })),
        resolve,
      }),
    );
    if (picked === null) return;
    const image = images[Number(picked)];
    if (image === undefined) return;

    let payload: { mime: string; base64: string };
    try {
      payload = await deps.connection.api.asset.get.query({ assetId: image.assetId });
    } catch (error) {
      noticeChannel.push(
        t("notice.imageGone", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
      return;
    }

    let file: string;
    try {
      file = await deps.writeTempImage(payload.base64, payload.mime);
    } catch (error) {
      noticeChannel.push(
        t("notice.imageTempFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
      return;
    }

    const opened = await deps.openPath(file);
    if (opened.kind === "opened") {
      noticeChannel.push(t("notice.imageOpened", { path: file }));
      return;
    }
    if (opened.kind === "no-command") {
      noticeChannel.push(
        t("notice.imageNoOpener", { command: opened.command, path: file }),
        "error",
      );
      return;
    }
    noticeChannel.push(
      t("notice.imageOpenFailed", {
        command: opened.command,
        code: opened.code ?? "?",
        path: file,
      }),
      "error",
    );
  };
  const openImageKeys = { open: () => void openImage() };

  // 输入处理
  useInput(
    (char, key) => {
      // 按键诊断（AIZ_DEBUG_KEYS=1）：必须在任何 return 之前记录，否则被吞掉的键不会留痕
      keyDebug(char, key);
      /**
       * 粘贴优先于一切按键语义：`CSI 200~ … CSI 201~` 之间是**一段文本**，里面的 `\r` 不是回车、
       * `\t` 不是 Tab、`/` 不是命令 —— 整段一次插进草稿（见 `tui/paste.ts`）。
       *
       * 必须排在所有分支之前：排在后面的话，多行粘贴的第一行会被当成回车发出去。
       */
      const paste = pasteRef.current!.feed(char);
      if (paste.kind === "pending") return;
      if (paste.kind === "text") {
        if (paste.text.length > 0) typeIntoDraft(paste.text);
        return;
      }
      if (bootError) {
        if (char === "k" || char === "K") {
          void openWizard({ kind: "menu" });
          return;
        }
        if (key.return || key.escape) exit("done");
        return;
      }
      // 回看历史类按键（滚轮 / PgUp/PgDn / Ctrl+B · Ctrl+F / ⌘[ ⌘] / ⌘; ⌘'）与忙碌态共用
      if (handleScrollKey(char, key, scrollKeys)) return;
      // 换行：Ctrl+Enter（部分终端把它报成 Ctrl+J，两处都收）与 Shift+Enter。
      // 不用 Alt：Alt 系在本产品里一概不当快捷键（它被终端与 shell 抢得太多）
      if (key.return && (key.ctrl || key.shift)) {
        typeIntoDraft("\n");
        return;
      }
      if (char === "c" && key.ctrl) {
        // Claude Code：生成中中断；空闲时有草稿就先清空，已空则退出
        if (working) sessionRef.current?.abort();
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
      if (handleClearNoticesKey(char, key, clearNoticesKeys)) return;
      // 三档里的第三档：清全部（它只开那一问，确认之后才发 `notice.deleteAll`）
      if (handleClearAllNoticesKey(char, key, clearAllNoticesKeys)) return;
      // 图片在终端里只能是个占位：这个键把选中的那一张交给本机默认程序
      if (handleOpenImageKey(char, key, openImageKeys)) return;
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
        yank();
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
        typeIntoDraft("\n");
        return;
      }
      // Ctrl+P / Ctrl+N：历史上下（Claude Code 语义；换行用 Ctrl+J）
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
      // 按词删除：Ctrl+Backspace 删前一个词、Ctrl+Delete 删后一个词（⌘ 一并收：macOS 的
      // ⌘⌫ 有的终端会带 super 位）。
      // 必须在下面「单字符 Backspace/Delete」之前判定，否则带修饰键的删除只掉一个字符。
      if (key.backspace && (key.ctrl || key.super)) {
        deleteWordBeforeCursor();
        return;
      }
      if (key.delete && (key.ctrl || key.super)) {
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
        if (key.shift) {
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
        if (key.ctrl || key.super) moveCursorByWord(-1);
        else moveCursor(-1);
        return;
      }
      if (key.rightArrow) {
        if (key.ctrl || key.super) moveCursorByWord(1);
        else moveCursor(1);
        return;
      }
      // 跨词移动只剩 Ctrl+←/→ 与 Ctrl+A / Ctrl+E（A/E 管行首行尾）。
      // 不用 Alt：Option+←/→ 与 Esc b / Esc f 那两条都是 Alt 系键位，本产品一概不收。
      if (key.home) {
        moveCursorToLineStart();
        return;
      }
      if (key.end) {
        moveCursorToLineEnd();
        return;
      }
      if (key.escape) {
        // 交接期间 Esc 只有一件事：中断（= 放弃交接、回滚到交接前，PRD 4.5）。
        // 这时没有「清草稿」这个选项 —— 交接期间的草稿是用户等换完之后要发的那句。
        // 也不受 `working` 约束：独立交接那一路没有流可看，`working` 可能是 idle。
        if (handingOff) {
          sessionRef.current?.abort();
          noticeChannel.push(t("notice.handoffAborted"));
          return;
        }
        // `@` 菜单开着时，Esc 只关菜单：清草稿太粗暴（`@` 打一半按 Esc 会连正文一起没）
        if (mention && menuWant > 0) {
          setMentionOff(true);
          return;
        }
        // 在动时 Esc = 中断在途（Claude Code 语义）。
        //
        // **这一档必须压在「开关关 → 继续」之上**：开关关着而手上还有活是一个**正常组合** ——
        // 暂停（`pause`）与中断都只是把输出开关关上，已经取在手上的那批照常跑完（PRD 4.4
        // 「暂停只是关输出开关」）。那时用户按 Esc 想的是「立刻停」，不是「继续」：中断才是
        // 把手上的活掐断的那个动作，把它让给 resume 等于「想停一下反而给它开开关」。
        if (working) {
          sessionRef.current?.abort();
          return;
        }
        // 开关关着、手上没活 → Esc 就是「继续」（PRD 4.4 的「继续 ⇄ 中断」互切：忙时这一个键
        // 是中断，闲而开关关时它是继续）。
        //
        // 失败如实报：交接期间宿主会拒它（`handoff_in_progress`），而这一次按键是用户按下
        // 去的，静默失败等于让他以为开关开了。不吞、也不重试 —— 用户再按一下就是重试。
        const current = sessionRef.current;
        if (current?.outputPaused === true) {
          void current.resumeOutput().catch((error: unknown) => {
            noticeChannel.push(
              t("notice.resumeFailed", {
                error: error instanceof Error ? error.message : String(error),
              }),
              "error",
            );
          });
          return;
        }
        // 有附件时先清附件（草稿保留）——误粘一张图后总得有个退路，
        // 而又不能为了这个把 ESC 变成「清空一切」的随机键。撤回带回来的那几张也算附件。
        if (pastedImages.length > 0 || restoredAssetIds.length > 0) {
          setPastedImages([]);
          setRestoredAssetIds([]);
          noticeChannel.push(t("notice.imagesCleared"));
          return;
        }
        // 闲着、开关也开着：清空草稿并回到底部（老行为）
        setInputText("");
        scrollToBottom();
        return;
      }
      if (key.backspace) {
        if (handingOff) return;
        deleteBeforeCursor();
        return;
      }
      if (key.delete) {
        if (handingOff) return;
        deleteAfterCursor();
        return;
      }
      if (char && !key.ctrl && !key.meta && !key.super) {
        typeIntoDraft(char);
      }
    },
    // 这**一个**处理器管全部按键，生成中也一样：运行中要能打字、能发、能用 `/` 命令
    // （PRD 需求 3）。曾经的主 / 忙两个处理器靠「忙时输入框整块被 Spinner 顶替」分流，
    // 那样一来运行中的按键无处可去，只能只留中止 / 退出 / 回看 —— 现在输入框一直在，
    // 就不该再有两套键位：两套的分歧（哪个键在忙时归谁）是历史上漂移的根源。
    // 只留覆盖层（选择器 / 配置向导）这一个失活条件：它们整屏接管了键盘。
    { isActive: !pickerState && !formState && !wizardStep },
  );

  // 配置向导：整屏接管（凭据设置 / 配置中心），关闭后回到会话屏
  // 读与写都走**同一条**连接（`deps.connection.api`），快照是打开那一刻读齐的那三份
  if (wizardStep && wizardConfig && wizardPresets && wizardAgents && wizardServers) {
    return (
      <ConfigWizard
        host={{ api: deps.connection.api }}
        workspaceId={session?.workspaceId ?? props.workspaceId ?? ""}
        config={wizardConfig}
        presets={wizardPresets}
        agents={wizardAgents.agents}
        servers={wizardServers}
        sessionsByAgent={wizardSessionsByAgent}
        initialStep={wizardStep}
        closeOnSave={wizardStep.kind !== "menu"}
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

  const cols = columns ?? 80;
  /**
   * 选择器覆盖层一次能画几条候选（窗高）：候选比它多时列表自己滚动，而不是溢出屏幕或被截断。
   *
   * 唯一一处算式是 `layout.ts` 的 `pickerCapacity`（它知道覆盖层与状态栏各占几行）——
   * 布局预留高度（`pickerItems`）与覆盖层的 `maxRows` 都读这一个数，差一行输入框就会位移。
   */
  const pickerRows = pickerCapacity(rows ?? 24);

  const messages = session?.messages ?? [];
  const subAgents = session?.subAgents ?? [];
  /** 手上有没有活：宿主的忙闲那一格，或者一条阻塞型命令正在跑（见 `blockingCommand` 的注释） */
  const generating = activity === "working";
  const working = generating || blockingCommand !== null;
  /**
   * 阶段行要的现读事实（忙闲 + 消息）：`phaseLine` 是一支纯函数，不存任何状态。
   *
   * **队里那几句不进来**：排队区（`InboxArea`）已经把它们的原话逐条摆出来了，阶段行只回答
   * 「这一任此刻在干什么」—— 见 `session-phase.ts` 的文件头。
   */
  const phaseFacts: PhaseFacts = {
    status: activity,
    messages,
    handingOff,
  };
  /** 当前查看的子 Agent；不在列表里（换了一次之后过期）时回落到主 Agent */
  const activeSub = subAgents.find((item) => item.toolCallId === activeAgentId) ?? null;

  const userCount = messages.filter((m) => m.role === AgentNS.Role.User).length;
  // 乐观回显只属于主 Agent 的视图（子 Agent 不会收到用户直接发的消息）
  const showPending = !activeSub && pendingUser != null && userCount <= pendingUser.base;

  /**
   * 子 Agent 视图读它**自己**的 messages（从第 0 条起，不受主会话清屏的显示起点影响）。
   *
   * 每次都从会话现取：这一次跑着的那个走**流式**那份（宿主带 `toolCallId` 推过来的增量），
   * 已经结束或上一次的走库里那份缓存。于是渲染不会停在「切过去的第一帧」。
   */
  const liveSubMessages = activeSub ? (session?.subAgentMessages(activeSub.toolCallId) ?? []) : [];
  const cachedSubMessages =
    subMessages && activeSub && subMessages.toolCallId === activeSub.toolCallId
      ? subMessages.messages
      : [];
  const subTranscript = liveSubMessages.length > 0 ? liveSubMessages : cachedSubMessages;
  /**
   * 转录的起点（`/clear` 推到末尾的那个下标）。
   *
   * 消息**变短**之后它可能落在末尾之外 —— 交接换记忆（这一段 id 不变，记忆换成「系统提示 +
   * 断点消息」）就是最典型的一次：拿一个大于长度的下标去 `slice`，得到的是**一片空白**，用户
   * 看到的是「换完之后屏幕上什么都没有」。所以起点越界就回落到整段。
   */
  const transcriptStart = transcriptFrom > messages.length ? 0 : transcriptFrom;
  const transcript = transcriptLines(
    activeSub ? subTranscript : messages.slice(transcriptStart),
    cols,
  );
  /**
   * 空会话：会话区顶部展示品牌区（logo + 标语 + 版本）。
   *
   * 判据里必须带 `showPending` —— 用户刚敲下第一条消息、乐观回显已经上屏，
   * 这时欢迎块要立刻让位，不能等消息真正写进 messages。
   */
  const showWelcome = !activeSub && !showPending && messages.length === 0;
  if (showWelcome) transcript.unshift(...welcomeLines({ columns: cols }));
  if (showPending) {
    // 带粘贴图片的消息：乐观回显要与实际发送的结构一致（文本段 + 图片占位块），
    // 否则图片那几条会在真实消息写进 messages 前「消失」一下。
    const images = pendingUser!.images ?? [];
    transcript.push(
      ...messageToLines(
        {
          id: "__pending_user",
          createdAt: Date.now(),
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

  /**
   * 通知栏：正文行 + 「全部清空」那一行提示（高度同源，见 `noticeBarContent`）。
   *
   * 高度必须用它的 `height` 而不是 `lines.length` —— 提示占的那一行也要算进布局与硬件光标，
   * 否则输入框会整体偏一行。
   */
  const noticeBar = noticeBarContent(notices, cols);

  /**
   * Agent 栏目 InboxEntry：无子 Agent 时整条栏目不存在（不占高度、也不接管左右键）。
   *
   * 标签用宿主给的 `name`（这次委派叫什么），不再自己在客户端编号 —— 编号是客户端现算的
   * 一份真相，与宿主那份快照对不上时用户会看到「子 AGENT2」跑着另一个 AgentDefinition。
   *
   * 状态是**名册那一格 + 它自己消息上的结局**（`subAgentStatusOf`）：名册不报「出错 / 被叫停」，
   * 但那两件事就写在它栏里最后一条消息的 `status` / `error` 上 —— 能算的就把它算回来
   *（`PRD 3.9`「失败必须显示失败」）。它一条消息都没有时才停在名册那一格。
   */
  /**
   * 栏目什么时候该收起来（PRD 3.9「本次结束栏目自动收起」）。
   *
   * 名册是宿主的事实，而宿主的清空点在 core 外循环的**下一批开头** —— 于是这一段答完之后，
   * 那条栏目会连同几个绿点一直挂着，直到用户下次说话。客户端手里已经有「这一段闲下来了」
   * 这个事实（`activity === "idle"`），配上名册里还有没有在动 / 还挂着的项，就能按 PRD 的
   * 字面收起来（`ended` 是名册给的「已经散场」那一格）。
   *
   * 收的只是**显示**：名册一个字不动，`subAgentMessages` 照样取得到。用户正停在某个子栏时
   * 不收 —— 那会把他正看着的东西抽走，还断了他切回主栏的路。
   */
  const subAgentsSettled =
    activeSub === null && activity === "idle" && subAgents.every((item) => item.state === "ended");

  const agentTabs: AgentTab[] =
    subAgents.length > 0 && !subAgentsSettled
      ? [
          { id: "main", label: t("agentTabs.main") },
          ...subAgentStates.map(({ fact, status }) => ({
            id: fact.toolCallId,
            label: fact.name,
            status,
          })),
        ]
      : [];
  const activeTabId = activeSub ? activeSub.toolCallId : "main";
  const agentTabLines = agentTabs.length > 0 ? AGENT_TABS_LINES : 0;

  // 状态栏：先按当前状态算出「折行后实际几行」，交给布局预留高度（否则窄屏下一旦提示折行，
  // 整帧就会高出一行，把输入框顶出屏幕）。这里用 `viewTop` 状态判断滚动，而不是
  // `layout.scrolled` —— 后者要等布局算完才有，会与行数测量形成循环。
  const statusProps: StatusBarProps = {
    // 块由会话层用活事实现拼（`status-blocks.ts`），客户端只决定摆几块、怎么说
    blocks: session?.blocks ?? [],
    // 「输出开关关且手上没活」时 Esc 是**继续**而不是中断（PRD 4.4 的「继续 ⇄ 中断」互切），
    // 提示得跟着状态说 —— 否则用户停在那里看提示，以为 Esc 只能中断。
    // 放在「翻历史」之前：开关关是会话的持续状态（Esc 的语义真的变了），翻历史只是视口的临时模样。
    // 交接期间不算：那时 Esc 只有一个含义（放弃交接），提示不能与按键打架。
    hint: !ready
      ? t("input.hint.initializing")
      : session?.outputPaused === true && !working && !handingOff
        ? t("input.hint.paused")
        : viewTop != null
          ? t("input.hint.scrolling")
          : t("input.hint.ready"),
    columns: cols,
  };
  const statusRows = statusBarRows(statusProps, cols);

  /**
   * 附件提示行：有附件时占 1 行（与 `computeChatLayout` 的 `attachmentLines` 同一个判据）。
   *
   * 两路附件合计一个数：粘贴进来的 + 撤回带回来的。它们对用户是同一件事（输入里挂着几张图），
   * 分开画两行只会多占一行高度（那一行在这里是稀缺资源，见 `PastedImagesBar`）。
   */
  const attachmentCount = pastedImages.length + restoredAssetIds.length;
  const attachmentLines = attachmentCount > 0 ? 1 : 0;

  /**
   * 阶段行：忙碌时那**一行**「连接中 → 排队中 → 思考中 → 输出中 → 调用工具 X」，**恒为 0 或 1 行**。
   *
   * 文案由 `workingSpinnerLabel` 从**契约事实**推（忙闲 + 那条消息的 status / 思考 / 正文 /
   * 工具调用 + 队里还有几条；阻塞命令期间回落到命令名），这里只负责它住在**分隔线之上** ——
   * 于是它只占自己那一行，输入框不必为它让位（PRD 需求 2）。手上没活时它不存在，不占行。
   */
  // 交接期间即使手上没活（独立交接那一路没有流）也要占这一行：它要说的是「正在交接」，
  // 不是「忙不忙」（PRD 4.5）。
  const phaseText = working || handingOff ? workingSpinnerLabel(phaseFacts, blockingCommand) : null;
  const phaseLines = phaseText ? 1 : 0;

  /**
   * 排队区：还压在队里、没被取走的那几句（`session.state.inbox` 现读），住在阶段行**之后**、
   * 分割线**之上**。
   *
   * 行数走 `inboxAreaLines()`（0～3）—— 与 `phaseLines` 同一条路进 `computeChatLayout`，
   * 并同步给 IME 光标的 `inboxCount`：三处同一个数，输入框与候选框就不会错位一行。
   * 放上面而不是塞进输入框那个 `Box`：那里的行数与光标定位是耦合的。
   */
  const inboxItems = session?.inbox ?? [];
  const inboxLines = inboxAreaLines(inboxItems.length);

  const layout = computeChatLayout({
    columns: cols,
    rows: usableFrameRows(rows ?? 24),
    transcript,
    input,
    hintCount: menuWant,
    noticeCount: noticeBar.height,
    attachmentLines,
    phaseLines,
    inboxLines,
    agentTabLines,
    overlay: pickerState ? "picker" : formState ? "form" : "none",
    // 覆盖层只会画出窗口装得下的那几条（`SelectList` 的视窗），所以布局也按同一个数预留高度
    pickerItems: pickerState ? Math.min(pickerState.items.length, pickerRows) : 0,
    // 表单：一格一行，另**常驻**预留一行给校验失败那句 —— 错误一冒出来就顶高一行，
    // 底下的状态栏会被推出屏幕（用户正看着的东西跳一下也难受）
    formRows: formState ? Object.keys(formState.schema.properties).length + 1 : 0,
    viewTop,
    statusBarLines: statusRows.length,
    // 空会话的品牌块落在会话区垂直中部（贴顶太空、贴底太挤）
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
  // 生成中同样要定位 —— 输入框一直在、一直可编辑（PRD 需求 3），候选框也就得跟着走。
  if (!pickerState && !formState) {
    const measured = imePosition && imePosition.key === cursorKey ? imePosition.position : null;
    setCursorPosition(
      measured ??
        computeInputCursorPosition({
          transcriptLines: layout.lines.length,
          // Agent 栏目 / 通知栏 / 附件行 / 阶段行 / 排队区都夹在会话区与输入行之间：
          // 漏算任何一段都会让硬件光标整体偏上（阶段行与排队区是后加的）。
          agentTabCount: agentTabLines,
          noticeCount: noticeBar.height,
          attachmentCount: attachmentLines,
          hintCount: layout.hintRows,
          phaseCount: phaseLines,
          inboxCount: inboxLines,
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

      {pickerState ? (
        <PickerOverlay
          title={pickerState.title}
          items={pickerState.items}
          columns={cols}
          maxRows={pickerRows}
          onPick={resolvePicker}
        />
      ) : formState ? (
        <FormOverlay
          title={formState.title}
          schema={formState.schema}
          onAnswer={resolveForm}
          onCancel={() => resolveForm({ action: "cancel" })}
        />
      ) : (
        <Box flexDirection="column">
          {agentTabs.length > 0 ? <AgentTabs tabs={agentTabs} activeId={activeTabId} /> : null}
          <NoticeBar lines={noticeBar.lines} hint={noticeBar.hint} />
          {/* 附件提示行：必须在 NoticeBar 之后、菜单之前（与 computeInputCursorPosition 的顺序一致） */}
          {attachmentLines > 0 ? <PastedImagesBar count={attachmentCount} /> : null}
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
          {/* 阶段行：紧贴分割线**之上**，只占自己那一行（不在输入框里）——
              `computeChatLayout` 的 `phaseLines` 与 IME 光标的 `phaseCount` 都按它算 */}
          {phaseText ? <PhaseLine label={phaseText} /> : null}
          {/* 排队区：紧贴在分割线**之上**（阶段行之后）—— 0 条时整块不渲染、不占行。
              `computeChatLayout` 的 `inboxLines` 与 IME 光标的 `inboxCount` 都按它算 */}
          <InboxArea items={inboxItems} />
          <Box paddingX={1}>
            <Text color={theme.border} wrap="truncate">
              {"─".repeat(Math.max(1, cols - 2))}
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={1}>
            {shownLines.map((line, i) => {
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
            })}
          </Box>
        </Box>
      )}

      <StatusBar {...statusProps} />
    </Box>
  );
}
