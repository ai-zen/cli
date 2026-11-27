/**
 * TUI 入口 —— 屏幕循环与终端状态安全
 *
 * 流程：启动界面 → 连接门（先试上次那台，不行就摆连接屏）→ 凭据预检（缺 API Key 时先引导输入）
 * → 会话屏（未带 `--new` 时把「接着上次」的意图交给会话层，由它去问宿主）。
 * 会话屏内 `/new`、`/back`、`/load`、`/sessions` 通过重挂载（新 Ink 实例 + 原生清屏）实现；
 * 会话屏退出即结束进程 —— 只有 `/shutdown` 是例外：宿主被关掉了，它回到连接门（带着
 * 一句「宿主已关闭」），让用户决定重新拉起一台还是改连别处。
 *
 * 终端安全：SIGINT / SIGTERM / 未捕获异常均卸载 Ink，恢复 raw mode 与光标。
 *
 * 一个进程只有一条连接，一份会话注册表
 *
 * `connectHost` 建的那条 `Client` 是本文件唯一的连接：会话层借它说话、配置向导借它读写、
 * 启动预检借它问配置。它住在 `runTui` 的作用域里（重挂载循环之外），退出时由这里关掉。
 *
 * 会话同理，只是多一层：重挂载换的只是「看哪一段」，会话本身归进程所有。
 * 那份注册表（`SessionRegistry`）建在重挂载循环之外，切一段不丢另一段的订阅 —— 于是
 * 「切过去，原来那段继续跑」在客户端也成立，而不只成立在宿主那边。
 */

import { render, useApp, type Instance } from "ink";
import type { LogSink } from "@ai-zen/agents-logger";
import { connectHost, readConnectPlan } from "../connection.js";
import type { CliEnv } from "../env.js";
import { agentListOf, toDefinition, topLevelAgents } from "../agents-store.js";
import type { AgentDefinition, AppConfig, McpEntry, ReasoningPresets } from "../config.js";
import { resolveCredential } from "../config-editor.js";
import type { ChatSessionLike, HostConnection, WorkspaceSnapshot } from "../session/types.js";
import type { ConnectionSettings } from "../server-client/index.js";
import {
  enterWorkspace,
  rememberWorkspace,
  workspaceHost,
  type WorkspaceHost,
} from "../workspace.js";
import { ConfigWizard, type WizardCloseResult } from "./config-wizard/index.js";
import { Chat } from "./screens/index.js";
import { ConnectScreen } from "./screens/connect.js";
import { WorkspacePickScreen, type WorkspacePickResult } from "./screens/workspace-pick.js";
import { HostDownloadScreen } from "./screens/host-download.js";
import type { HostDownloadScreenResult } from "./screens/host-download.js";
import { settleConnection, type ConnectScreenResult } from "./connection-gate.js";
import { keyDebugStart } from "./key-debug.js";
import { disableMouseTracking, enableMouseTracking } from "./mouse.js";
import { quietCursor } from "./cursor-quiet.js";
import { disableBracketedPaste, enableBracketedPaste } from "./paste.js";
import { initLocale, syncLocaleToHost } from "../i18n/preferences.js";
import { t } from "../i18n/index.js";
import { SessionRegistry } from "../sessions-registry.js";
import type { LogNotices } from "../log-notices.js";
import type { AgentNS } from "@ai-zen/agents-core";

/** ANSI：清屏 + 光标归位 + 显示光标（屏幕间切换时从头绘制，避免行偏移） */
const CLEAR_SCREEN = "\x1b[2J\x1b[H\x1b[?25h";

/**
 * 本进程那一条连接 —— 一个 TUI 进程只有一份。
 *
 * 为什么它建在 `runChat` 的重挂载循环之外
 *
 * `/load`、`/new`、`/back` 都是「卸载当前 Ink 实例 → 再 `mount(<Chat/>)`」，而连接如果建在
 * 循环里（或建在组件里），切一次会话就重连一次：宿主那边多一条 driver，客户端这边丢掉全部在飞
 * 事件（还包括「刚断线」的误报）。
 *
 * 但「在循环之外」不等于「在模块里」：它需要的事实（`CliEnv` + 连接门选定的那份设置）由根
 * （`CliApp`）递进来、由连接门定下。放在模块级就得去全局拿 —— 那样「这个 TUI 连的是哪台」
 * 又要读实现才知道，而它是本文件最该一眼看出来的一件事。
 */

/**
 * 告别并终止进程。
 *
 * Ink 卸载后，进程仍可能被残留句柄（TTY stdin 处于 flowing、SDK 的 Timeout/Immediate 等）
 * 挂住，导致「返回 shell 却不退出、终端不归还」。这里显式恢复终端、暂停 stdin 并 exit，
 * 保证退出即干净交还 shell（Windows 下 TTY 写为异步，用回调 + 兜底定时器双保险）。
 */
function farewell(): void {
  // 先关鼠标上报：不关的话，回到 shell 后每次滚轮都会在提示符前吐一串 `^[[<64;…M`
  try {
    disableMouseTracking();
  } catch {
    /* ignore */
  }
  // 括号粘贴同理：不关的话，shell 里的粘贴会被终端一直包在 `CSI 200~ … CSI 201~` 里
  try {
    disableBracketedPaste();
  } catch {
    /* ignore */
  }
  try {
    (process.stdin as { setRawMode?: (v: boolean) => void }).setRawMode?.(false);
  } catch {
    /* ignore */
  }
  // `pause()` 不接失败：`Readable.pause()` 只把 flowing 置 false 并 emit，没有抛出点
  // （上面两处不一样：`stream.write` 在流已销毁时同步抛，`setRawMode` 在 handle 没了时抛）
  process.stdin.pause();
  const finish = () => process.exit(0);
  process.stdout.write(`\x1b[?25h${t("app.goodbye")}`, finish);
  setTimeout(finish, 250);
}

/** 当前活动的 Ink 实例（用于信号处理时兜底卸载） */
let activeInstance: Instance | null = null;

/**
 * Ink 渲染选项（集中声明，便于单测锁定关键决策）。
 *
 * `kittyKeyboard` 刻意取 `disabled`，关闭 Kitty 键盘协议的「自动查询」：
 *
 * - Ink 的 `auto` 模式会在每个实例创建时发送一次 `CSI ? u` 查询，终端则回
 *   `CSI ? 0 u`（flags=0，不支持）。本 TUI 会反复挂载（启动界面 → 会话屏 →
 *   配置向导 …），于是应答源源不断；
 * - 应答一旦被拆包（前导 ESC 被 Ink 的「待定转义刷新定时器」当作一次独立的
 *   Escape 键消费），残留在后一个 chunk 里的 `[?0u` 会退化成普通文本被当作输入
 *   插入输入框（已实测重现）；
 * - 而该协议的收益（Ctrl / Alt / Shift + Enter 换行）在本环境本就不生效——
 *   换行由不依赖终端协议的 `Ctrl+N` / `Ctrl+J` 承担。
 */
export const RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: false,
  // 只重绘「变化的行」，而不是每帧擦除 + 重写整屏（Ink 默认 false，走 createStandard）。
  // 流式高频下把每帧输出量从 O(屏幕大小) 降到 O(变化量)，显著减轻 SSH 带宽 / 背压压力。
  incrementalRendering: true,
  kittyKeyboard: { mode: "disabled" },
} as const;

/**
 * 挂一个 Ink 实例，返回它的结局（`useApp().exit(payload)` 那一份）。
 *
 * `clear: false` 只有下载屏用：它在启动路径上、而且多数时候一个字节都不画（本机「有就上」那条
 * 快路），此时擦一下屏反而多一次闪屏。
 */
function mount(
  node: Parameters<typeof render>[0],
  options: { clear?: boolean } = {},
): Promise<unknown> {
  if (options.clear !== false) process.stdout.write(CLEAR_SCREEN);
  // 鼠标上报随实例生命周期开关：本 TUI 会反复挂载（启动屏 → 会话屏 → 配置向导），
  // 每个实例结束时都关掉，避免「已卸载却仍在收鼠标事件」。
  enableMouseTracking();
  // 括号粘贴一起来：粘贴进来的整段由 `[200~ … [201~` 包住，屏上才认得出「这是一段文本」
  enableBracketedPaste();
  // 流一条「不显示光标」的流给 Ink：位置照旧逐帧上报（输入法候选框要靠它），但 `?25h` 被拦掉
  // —— 否则流式期间每秒十几对「藏/显」，光标会一直闪（`cursor-quiet.ts` 里写了为什么）。
  const instance = render(node, { ...RENDER_OPTIONS, stdout: quietCursor(process.stdout) });
  activeInstance = instance;
  return instance.waitUntilExit().finally(() => {
    disableMouseTracking();
    disableBracketedPaste();
    if (activeInstance === instance) activeInstance = null;
  });
}

/**
 * 建一条到宿主的连接（连接门过完之后才调）。
 *
 * `ensureHost` 在这一步会「有就上、没有就拉起一个」：门里试的那一次已经证明这份设置能连上
 * （本机那条路上宿主已经被下载屏拉起来了，这里读到发现文件就直接握手），所以不会出现「探活说
 * 行、真连不行」的分叉 —— 探活走的就是同一个 `connectHost`。
 */
async function openConnection(env: CliEnv, settings: ConnectionSettings): Promise<HostConnection> {
  const { client } = await connectHost({ env, settings });
  return client;
}

/**
 * 首启凭据门 —— 还没有可用密钥时，先摆「选服务商 → 填密钥 → 定首要模型」那一条链。
 *
 * 它就是同一个配置向导（`ConfigWizard`）的首启形态：读写都走那一条连接（`api`），
 * 所以「这个屏上写进去的密钥」与「宿主真正拿去发请求的那一份」是同一份。
 *
 * 为什么入口是 `onboarding` 而不是直接跳「填密钥」：旧版拿默认模型反推出一个端点，一上屏就
 * 要求那个厂商的密钥 —— 服务商是它替用户挑的。现在第一家由用户选（清单带 ✓/✗），
 * 与 `/model` 切换前的那道检查共用同一套判据（`resolveCredential`）。
 */
function CredentialGate({
  host,
  workspaceId,
  config,
  presets,
  agents,
  servers,
}: {
  host: HostConnection;
  workspaceId: string;
  config: AppConfig;
  presets: ReasoningPresets;
  agents: AgentDefinition[];
  servers: McpEntry[];
}) {
  const { exit } = useApp();
  return (
    <ConfigWizard
      host={{ api: host.api }}
      workspaceId={workspaceId}
      config={config}
      presets={presets}
      agents={agents.map(toDefinition)}
      servers={servers}
      onboarding
      closeOnSave
      initialStep={{ kind: "onboarding" }}
      onClose={(result) => exit(result)}
    />
  );
}

/**
 * 端点凭据预检：返回 `false` 表示用户放弃配置（调用方应退出）。
 *
 * 配置本身残缺（模型 / 端点不存在）时不在此拦截 —— 交给会话屏报错，
 * 那里可按 `k` 打开配置中心自行修配置。
 *
 * 三份快照（配置 / AgentDefinition 清单 / 发现视图）只在真要开屏时才读：向导整屏接管要用它们。
 *
 * 用户换了服务商，那一段会话的模型也得跟着换
 *
 * 会话行上的 `modelId` 在建行那一刻就写定了（`session.create` 把三级解析的结果落进去），
 * 因此「把所选服务商的首要模型设成默认项」并不能改变这一段会话实际用哪个模型 —— 三级解析里
 * 会话级先赢。所以向导回来的 `onboardedModelId` 要在这里落到会话上，否则屏幕上会用着一段
 * 「模型属于 A 家、密钥属于 B 家」的会话。
 */
async function ensureCredential(
  connection: HostConnection,
  workspaceId: string,
  session: ChatSessionLike,
): Promise<boolean> {
  // 凭据要从实际会用它的那一份配置里取：在宿主，不是本机磁盘
  const { config, presets } = await connection.api.config.get.query();
  const credential = resolveCredential(config, session.modelId ?? undefined);
  if (!credential || credential.configured) return true;

  const [agents, { servers }] = await Promise.all([
    connection.api.config.agents.list.query(),
    connection.api.config.mcp.list.query({ workspaceId }),
  ]);

  const result = (await mount(
    <CredentialGate
      host={connection}
      workspaceId={workspaceId}
      config={config}
      presets={presets}
      agents={agents.map(toDefinition)}
      servers={servers}
    />,
  )) as WizardCloseResult | undefined;

  const onboarded = result?.onboardedModelId;
  if (onboarded && onboarded !== session.modelId) {
    try {
      // 这一段还是草稿（第一条消息之前不落库），换模型只是一次会话行写入
      await session.updateModel(onboarded);
    } catch (error: any) {
      // 换不成就降到「只把默认项设对了」：下一段会话会是那个模型，这一屏仍能进去发话
      process.stderr.write(`\n${t("app.modelSwitchFailed", { error: error?.message ?? error })}\n`);
    }
  }
  return Boolean(result?.dirty);
}

interface ChatTarget {
  agentId?: string;
  /**
   * 这次启动进入的工作区（`enterInitialWorkspace` 定的）：新会话就开在它里面。
   *
   * 它不是 `process.cwd()` 推出来的：本机那条用当前目录，远端那条是「上次进入的那个」或
   * 用户在屏上选的。
   */
  workspaceId: string;
  messages?: AgentNS.Message[];
  sessionId?: string;
  /**
   * 「接着该工作区上一次的会话」—— 只是意图，不带任何数据。
   *
   * 为什么不由这里读盘：会话根本不在本机磁盘上，读本地存档只会得出「从来没有上次会话」。
   * 哪一段算上一次，交给会话实现去问宿主。
   */
  resume?: boolean;
}

/**
 * 这一屏的目标：哪个 AgentDefinition + 哪个工作区。
 *
 * 模型不在这里算，也一并不在这里校验 —— 「这段会话实际用哪个模型」只有会话说得准
 * （见 `openTargetSession`）。客户端自己拿 AgentDefinition 加全局兜底推一遍，等于把宿主那套
 * 三级解析（会话级 → AgentDefinition → 全局）抄成两级：会话级覆盖存在时它必然算错，而错的后果不是报错，
 * 是「状态栏显示 A、实发请求 B」。
 */
async function resolveTarget(connection: HostConnection, workspaceId: string): Promise<ChatTarget> {
  // 默认 AgentDefinition 与 AgentDefinition 都由宿主给（`config.get` + `agentDefinition.list`）：子 Agent 不是入口，
  // 定义里有没有 `function` 明说了这件事，客户端按它挑
  const [{ config }, definitions] = await Promise.all([
    connection.api.config.get.query(),
    connection.api.config.agents.list.query(),
  ]);
  const list = agentListOf(definitions, config);
  const agentId = list.defaultAgentId ?? topLevelAgents(list)[0]?.id;
  if (!agentId) throw new Error(t("app.noAgents"));
  return { agentId, workspaceId };
}

/**
 * 按目标把会话开好（`registry.open`：只备好一段会话，先不接听众）。
 *
 * 这一步发生在凭据预检之前：预检要知道「这个模型属于哪个端点、有没有 Key」，而模型
 * 只由会话说得准（`SessionView.model.modelId`，宿主在 `session.create` 里按三级解析算出来、
 * 落在会话行上）。先开会话的代价是零：草稿会话不落库（R56），第一条用户消息之前 `session.list`
 * 里看不到它。
 *
 * 开不出来（模型不可解析 / 指向的模型已经不在配置里）不在这里退出：宿主已经把那句话说清楚了
 * （`error.modelUnresolved`，按连接语言渲染好），交给会话屏的失败分支去报 —— 那里按 `k` 就能
 * 打开配置中心修，启动期直接 farewell 只会让人连修的地方都摸不到。
 */
async function openTargetSession(
  sessions: SessionRegistry,
  target: ChatTarget,
): Promise<{ session: ChatSessionLike } | { bootError: string }> {
  try {
    const session = await sessions.open({
      agentId: target.agentId,
      workspaceId: target.workspaceId,
      resume: target.resume,
    });
    return { session };
  } catch (error: unknown) {
    return { bootError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 启动时进入工作区：本机用当前目录；远端用上次进入的那个；都没有 → 摆一块选择屏。
 *
 * `null` = 用户放弃了（屏上按了 Esc）—— 与连接门同一类结局，由 `runTui` 收摊。
 *
 * 「进哪个」的判据全在 `workspace.ts` 那份 `enterWorkspace`：这里只提供事实（当前目录）与
 * 最后一步（把屏上选中的那个记成「上次进入的那个」）。
 */
async function enterInitialWorkspace(
  connection: HostConnection,
  host: WorkspaceHost,
  logger: LogSink,
): Promise<WorkspaceSnapshot | null> {
  const entered = await enterWorkspace({ connection, host, cwd: process.cwd(), logger });
  if (entered) return entered;
  const result = (await mount(<WorkspacePickScreen connection={connection} />)) as
    WorkspacePickResult | undefined;
  if (!result || result.kind !== "chosen") return null;
  // 屏上选中的那个就是「上次进入的那个」：下次启动直接进它（`enterWorkspace` 不会再问）
  await rememberWorkspace(host, result.workspace.id, logger);
  return result.workspace;
}

/**
 * 「接着上次」的意图。
 *
 * 这里只有意图、没有数据：上一次是哪一段只有会话实现的那一侧知道（服务端存档 /
 * 本地指针），客户端自己去读一遍就是又一份会漂的真相。窗口层说「接着上次」，
 * 会话层负责找出接哪一段；找不到就当新会话开。
 */
function resumeLastSession(target: ChatTarget): ChatTarget {
  return { ...target, resume: true };
}

/**
 * 运行会话屏；`/new`、`/back`、`/load`、`/sessions` 通过重挂载（新 Ink 实例 + 原生清屏）
 * 实现，其余退出直接结束。
 *
 * 重挂载换的只是「这一屏看哪一段」：会话本身归 `sessions`（进程级），所以换屏不会把另一段
 * 正在跑的会话的订阅弄丢。
 */
/**
 * `runChat` 只需要「这一屏怎么开」的那两个开关，外加日志出口：`env` 在 `runTui` 里已经变成了
 * 那一条连接，再往下传一份事实只会给“到底以哪份为准”留口子；而 `logger` 是屏幕要原样交给命令层
 * 的那一个口子（它不是「事实」，是「一句话往哪写」）。
 */
type ChatRunOptions = Pick<RunTuiOptions, "initialPrompt" | "newSession" | "logger" | "logNotices">;

/**
 * 这一屏的两种结局。
 *
 * `host-closed` 是「这一屏没有会话可看了」：`/shutdown`（宿主被关掉了，这条连接已经没有对端）
 * 与「这一屏正看着的那一段被删了、哪儿也没有别的会话」两种。两条路的共同点是「重挂载会话屏没
 * 意义」（它得先有一段会话），于是下一屏是回到「连哪台」那一步（`runTui` 的循环）。
 */
type ChatOutcome = { kind: "done" } | { kind: "host-closed"; reason: string };

async function runChat(
  connection: HostConnection,
  host: WorkspaceHost,
  sessions: SessionRegistry,
  target: ChatTarget,
  options: ChatRunOptions,
  /**
   * 启动期已经知道的那一句失败（开会话那一步宿主回的错）。
   *
   * 只对首屏有效：重挂载（在配置中心改完配置之后）要真的再开一次 —— 那是这条路上唯一的
   * 出口（修完配置回到屏上就该跑起来），所以挂载之后立刻置空。
   */
  bootError?: string,
): Promise<ChatOutcome> {
  let current = target;
  let messages = target.messages;
  let initialInput: string | undefined;
  /** 撤回回填的那几张 Asset（与 `initialInput` 同一次回填的两半，见 `CommandExitValue`） */
  let initialAssetIds: string[] | undefined;
  /** 重挂载后要展示一次的系统提示（如 `/model` 的写入结果；旧实例已卸载，新屏是它唯一的去处） */
  let initialNotice: string | undefined;
  /**
   * shell 钩子（`ai --tui --new "$@"`）带来的首条消息。
   * 只发一次：挂载后置空，否则重挂载（切模型 / `/lang` 等）会反复重发。
   */
  let initialPrompt = options.initialPrompt;
  /**
   * 「接着上次」是一次性意图：只对首屏有效。
   *
   * 重挂载（`/load`、/model 重启）带的是已经拿到手的 `messages` / `sessionId`，
   * 若让 resume 一直跟着，第二次挂载会一边给 id 一边让会话「再找一次上次」，
   * 两者指向不同会话时就成了「以为在接着聊、其实换了段会话」。
   */
  let resume = target.resume;

  while (true) {
    const result = await mount(
      <Chat
        agentId={current.agentId}
        // 启动时进入的那个工作区：首屏的新会话开在它里面（`/ws` 切过之后只在屏幕里生效，
        // 本屏重挂载时带着的 `sessionId` 会把真值从宿主那边取回来）
        workspaceId={current.workspaceId}
        // 「这台宿主是不是本机」：`/ws new` 只有本机才默认当前目录
        workspaceHost={host}
        messages={messages}
        sessionId={current.sessionId}
        resume={resume}
        // 启动期就知道开不出来（配置残缺）：首帧直接报它，不再重试一次开会话
        bootError={bootError}
        // 把那一条连接与那份会话注册表交给会话屏。两样都没有兜底：屏幕自己造一条连接
        // 就是一个进程两条到宿主的连接；屏幕自己管会话存活就是切一段丢一段的订阅。
        deps={{ connection, sessions, logger: options.logger, logNotices: options.logNotices }}
        initialInput={initialInput}
        initialAssetIds={initialAssetIds}
        initialNotice={initialNotice}
        initialPrompt={initialPrompt}
      />,
    );
    initialPrompt = undefined;
    resume = false;
    bootError = undefined;

    if (result && typeof result === "object") {
      const value = result as {
        restart?: boolean;
        load?: {
          agentId?: string;
          messages?: AgentNS.Message[];
          sessionId?: string;
        };
        messages?: AgentNS.Message[];
        initialInput?: string;
        initialAssetIds?: string[];
        sessionId?: string;
        /** 重挂载后展示一次的系统提示 */
        notice?: string;
        /**
         * 回连接屏：带的是写在连接屏上的那句话（`/shutdown`、以及「这一段会话没了、也没别的
         * 会话可看」那一条）
         */
        backToConnect?: string;
      };
      // 先去这一支：宿主已经没了，重挂载会话屏没有意义（它要先有宿主）
      if (value.backToConnect !== undefined) {
        return { kind: "host-closed", reason: value.backToConnect };
      }
      if (value.load) {
        // /load、/new、/sessions 选中：换成另一段会话，重挂载会话屏。
        // 换的只是「这一屏看哪一段」—— 旧那一段的会话留在注册表里继续跑。
        // 工作区跟着那一段会话自己那个（宿主会按 id 回给它）
        current = {
          ...current,
          agentId: value.load.agentId,
          sessionId: value.load.sessionId,
        };
        messages = value.load.messages;
        initialInput = undefined;
        initialAssetIds = undefined;
        // 旧屏的通知栏跟着卸载了：`/new` 要把那句话带到新屏上（见 `CommandExitValue.notice`）
        initialNotice = value.notice;
        continue;
      }
      if (value.restart) {
        messages = value.messages ?? messages;
        initialInput = value.initialInput;
        initialAssetIds = value.initialAssetIds;
        initialNotice = value.notice;
        /**
         * 会话 id 跟着一起换：会话侧可能已经换过 id（`/new` 开了新的、自动迁移换了位置、
         * `/save <名字>` 改了名字），而这里手上那个还是首次挂载时的。带旧 id 重挂载会
         * 接回另一段会话，或撞 `session-missing`。
         */
        if (value.sessionId) {
          current = {
            ...current,
            sessionId: value.sessionId,
          };
        }
        continue;
      }
    }
    return { kind: "done" };
  }
}

/** `runTui()` 的可选参数 */
export interface RunTuiOptions {
  /**
   * 进入会话屏后自动作为首条消息发送的内容。
   *
   * 来源只有一处：shell 兜底钩子 `ai --tui --new "$@"`（命令不存在时把原命令带进来）。
   * 不预填到输入框——钩子的语义就是「这条命令执行不了，需要处理」，等用户再敲一次回车没有意义。
   */
  initialPrompt?: string;
  /**
   * `--new`：开一条新会话，跳过「接着该目录上一次的会话」。
   *
   * 默认（不带 `--new`）保持续接意图：`ai` 回到上次的会话是常用预期。
   * 具体接哪一段由会话实现问服务端，客户端不读本地存档。
   */
  newSession?: boolean;
  /**
   * 本进程的事实（配置根 / 显式地址与凭证）—— 由根（`CliApp`）递进来。
   *
   * 没有缺省：TUI 不读 `process.env`。上面那两个开关是「这一屏怎么开」，这一项是「连哪台、
   * 拿什么进门」—— 两者混成一个可选参数的结果，就是“忘了传”静默地连回本机。
   */
  env: CliEnv;
  /**
   * 日志出口 —— 由根（`CliApp`）递进来。
   *
   * 没有缺省：TUI 不读全局日志口。它会一路传给三五处会写日志的地方（界面偏好 / 工作区记忆 /
   * 会话续接 / 命令层），每一处都在自己的签名里收它 —— 「这一行是谁写的」不必读实现才知道。
   */
  logger: LogSink;
  /**
   * 日志转成通知的那一格（根造的，与日志同一份）：会话屏注册自己的通知栏作它的入口，
   * `warn` / `error` 于是上屏（去重 / 封顶 / 界面未起时先留几条在 `log-notices.ts`）。
   */
  logNotices: LogNotices;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const uninstallSignals = installSignalSafety();
  // 界面语言在任何渲染之前定下来：首次启动按系统语言识别并落盘，
  // 之后以 preferences.json 为准（`/lang` 可随时改）。
  await initLocale(options.logger);
  // 按键诊断：AIZ_DEBUG_KEYS=1 时把终端环境 + 每次按键写进日志（默认关闭，零开销）
  keyDebugStart();

  /**
   * 进程级那一条连接：一次 `runTui` 只建一次，且在重挂载循环之外。
   *
   * 它等连接门过了才建 —— 门里用户可能把目标换掉（从本机改成某台远程），而一条
   * 连接是照着那一刻的设置建的。所以它住在门后的那个作用域里；收摊时真正要用的只是「关掉它」
   * 这一个动作，单独记一个函数就够（不在外面留一个可空的对象）。
   */
  let closeConnection: (() => void) | null = null;

  /**
   * 「回到连接门」的那句话（`/shutdown` 关掉宿主之后带回来的）。
   *
   * 它只在门里当「开场就摆屏」的原因用：本机那一路上「先试一次」等于再拉起一个宿主，
   * 正好把用户刚才按下的那一下抵消掉 —— 关了又开，等于没关。
   */
  let gateReason: string | undefined;
  /** shell 钩子的首条消息只发一次：回到门里再开一屏时不能再发一遍 */
  let chatOptions: ChatRunOptions = options;

  try {
    /**
     * 「连上 → 进工作区 → 开会话屏」这三步是个循环：`/shutdown` 之后要回到第一步。
     *
     * 只转一圈是常态（屏正常结束就退出）；只有「宿主被关掉」这一种结局会转第二圈。
     */
    for (;;) {
      /**
       * 连接门：先看上次那台还能不能用，不行就摆一块屏（理由与顺序见 `connection-gate.ts`）。
       *
       * 这一句取代了从前那句「直接 `resolveTarget()`，失败就报一行 `bootFailed` 退出」——
       * 那时的症状是：服务端不可达时 TUI 没有任何可操作的界面，用户除了改环境变量没有别的办法。
       */
      const gate = await settleConnection({
        initial: await readConnectPlan(options.env),
        env: options.env,
        // 上一屏是 `/shutdown` 结束的：开场就摆屏，不去拉起一个刚被关掉的宿主
        ...(gateReason === undefined ? {} : { openWith: { reason: gateReason } }),
        showConnectScreen: (input) =>
          mount(
            <ConnectScreen initial={input.initial} reason={input.reason} connect={input.connect} />,
          ).then((result) => (result as ConnectScreenResult | undefined) ?? { kind: "exit" }),
        /** 本机拉起宿主的那块屏：阶段、真原因、`R` 重试、`Esc` 折回连接屏 */
        showHostDownloadScreen: (input) =>
          mount(<HostDownloadScreen connect={input.connect} />, { clear: false }).then(
            (result) =>
              (result as HostDownloadScreenResult | undefined) ?? {
                kind: "fallback",
                reason: t("download.cancelled"),
              },
          ),
      });
      if (!gate.ok) {
        farewell();
        return;
      }
      // 门过了：连哪台已经定下（可能是用户在屏上刚选的），现在才建那一条连接
      const connection = await openConnection(options.env, gate.settings);
      closeConnection = () => void connection.close();
      /**
       * 把本机语言同步给宿主一次：宿主渲染的句子（题、通知、错误）得跟界面说同一门语言。
       *
       * 方向只有这一个——宿主的语言不回头覆盖本机偏好（理由见 `syncLocaleToHost`）。
       */
      await syncLocaleToHost(
        {
          read: async () => (await connection.api.config.get.query()).config.language,
          write: async (locale) => {
            await connection.api.config.update.mutate({ language: locale });
          },
        },
        options.logger,
      );
      /**
       * 会话注册表：建在重挂载循环之外（`runChat` 里那些 `/load` `/back` 只是换屏）。
       *
       * 它归连接所有：一段会话就是这条连接上的那一段，`/shutdown` 之后回到连接门、
       * 重开一条连接，上一轮会话的订阅已经没有意义了（它们在 `finally` 里统一关掉）。
       */
      const sessions = new SessionRegistry(connection, options.logger);
      try {
        /**
         * 进入工作区：本机用当前目录，远端用上次进入的那个，都没有就摆一块选择屏。
         *
         * 它发生在建会话之前：会话层只收一个 `workspaceId`，不再拿本机 cwd 去猜
         * —— 猜的后果是把这台机器的路径登记到另一台机器的工作区表上。
         */
        const host = workspaceHost(gate.settings);
        let workspace: WorkspaceSnapshot | null = null;
        try {
          workspace = await enterInitialWorkspace(connection, host, options.logger);
        } catch (error: any) {
          process.stderr.write(`\n${t("app.bootFailed", { error: error?.message ?? error })}\n`);
        }
        if (!workspace) {
          farewell();
          return;
        }

        // 直达会话：AgentDefinition 身份由宿主给（`agent.list`）—— 这一层只负责「哪个 AgentDefinition + 哪个工作区」，
        // 「接不接上次」只在这里定：不带 `--new` 就带上 resume 意图，带上就一定是新会话。
        let target: ChatTarget | null = null;
        try {
          target = await resolveTarget(connection, workspace.id);
        } catch (error: any) {
          process.stderr.write(`\n${t("app.bootFailed", { error: error?.message ?? error })}\n`);
        }
        if (!target) {
          farewell();
          return;
        }
        // 顺序很重要：`--new` 是「我不要上次」的明确表态，这一步不把 resume 加回来
        if (!options.newSession) target = resumeLastSession(target);

        // 开/续接会话在凭据预检之前：模型只在开会话那一步才定下来（宿主按
        // 「会话级 → AgentDefinition → 全局」算，写进会话行），客户端自己算不出一模一样的那个值。
        const opened = await openTargetSession(sessions, target);
        let bootError: string | undefined;
        if ("bootError" in opened) {
          // 配置残缺（模型不可解析 / 指向的模型被删）：不在启动期退出，落到会话屏的失败分支
          bootError = opened.bootError;
        } else {
          // 端点凭据预检：还没有可用密钥时先摆首启引导（选服务商 → 填密钥 → 定首要模型），
          // 而不是「报错即退出」。判据就是这一段会话实际在用的模型（`resolveCredential`）——
          // 与实发请求用的是同一个值。
          if (!(await ensureCredential(connection, workspace.id, opened.session))) {
            farewell();
            return;
          }
          // 这一屏看的就是已经开好的那一段：把 id 递下去，屏幕挂上来时只是接成听众
          // （`enter` 按 id 取现成的，不会再开一遍）；「接着上次」在开会话那一步已经用掉了
          target = { ...target, sessionId: opened.session.sessionId, resume: undefined };
        }

        const outcome = await runChat(connection, host, sessions, target, chatOptions, bootError);
        chatOptions = { ...chatOptions, initialPrompt: undefined };
        if (outcome.kind === "done") break;

        /**
         * 宿主被关掉了：先把这条已经没有对端的连接断掉，再回门里。
         *
         * 不断的话，会话层那条「断了就重连」的退避还在跑（它盯的是同一台已经没了的宿主）。
         */
        closeConnection?.();
        closeConnection = null;
        gateReason = outcome.reason;
      } finally {
        // 这一程到此为止（正常退出 / 宿主被关掉）：每一段会话的订阅先摘干净，再断连接。
        // 从前这一步是「最后一代屏幕卸载时 dispose 自己那一段」—— 而现在只有当前那一段会
        // 被卸（切走的那几段留在后台跑），所以收摊由持有全部会话的这一层做。
        sessions.disposeAll();
      }
    }
    farewell();
  } finally {
    uninstallSignals();
    activeInstance = null;
    /**
     * 断掉这条进程级连接。
     *
     * 它现在不随界面卸载而消失（切会话不重连），所以退出时由
     * 这里显式关掉 —— 否则进程要等事件循环里的这条 socket 自己超时才能退。
     *
     * 顺序：会话的订阅在这一程结束时已经由 `sessions.disposeAll()` 摘干净了
     * （`/shutdown` 那一路是先断连接、后摘订阅；`untrack` 只是本地一张表，断线之后调也安全）。
     *
     * `?.` 是因为连接门里用户可能直接退了：那时一条连接都没建过（`endpoints` 还是 `null`），
     * 而「没建过」不该被当成「要关一条不存在的连接」。
     */
    closeConnection?.();
  }
}

/** 安装信号与异常兜底：任何异常退出路径都先卸载 Ink，避免「花屏终端」 */
function installSignalSafety(): () => void {
  const restore = () => {
    try {
      activeInstance?.unmount();
    } catch {
      /* 忽略 */
    }
    // 每条异常退出路径都把终端鼠标上报关掉，否则终端会持续把滚轮写成转义序列
    try {
      disableMouseTracking();
    } catch {
      /* 忽略 */
    }
    // 括号粘贴也一样（理由见 `farewell`）
    try {
      disableBracketedPaste();
    } catch {
      /* 忽略 */
    }
    // 光标：`quietCursor` 把「显示光标」那一半拦掉了，这条路（异常 / 信号）没有 `farewell`
    // 兜着，得自己还回去 —— 不然回到 shell 里没有光标
    try {
      process.stdout.write("\x1b[?25h");
    } catch {
      /* 忽略 */
    }
    activeInstance = null;
  };
  const onSigint = () => {
    restore();
    process.exit(130);
  };
  const onSigterm = () => {
    restore();
    process.exit(143);
  };
  const onFatal = (error: unknown) => {
    restore();
    process.stderr.write(`\n${t("app.unexpected", { error: (error as any)?.message ?? error })}\n`);
    process.exit(1);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  };
}
