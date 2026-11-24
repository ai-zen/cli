/**
 * 会话层 —— 一段会话的客户端实现（**纯客户端**：Agent 在宿主里跑）。
 *
 * ## 这一层现在做四件事
 *
 * 1. **读事实**：镜像（`connection.open(sessionId)` 一次取全 + `HostEvent` 增量，见
 *    `server-client/mirror.ts`）、模型与档位（`api.config.get` 与 `api.config.agents.get`，
 *    派生成 `ModelState` / `ThinkingState`）、挂着的题（`api.question.list`）；
 * 2. **转发命令**：`agent.send` / `agent.wake` / 三道开关 / `session.*` —— 大多是一行；
 * 3. **把状态交给界面**：`ChatSessionLike` 那些只读字段；
 * 4. **两样契约里没有、但界面要的推算**：阶段那句话（消费方算）、生成速率（本文件算，按
 *    「正文长度的差」采 —— 新契约没有增量事件，每次 `message.changed` 推的是整条消息）。
 *
 * ## 为什么速率还能估出来
 *
 * 旧契约的 `message.delta` 给的是「这一片多了什么」；新契约流式期间每片推一条
 * `message.changed`，载荷是**整条消息**。于是速率改成：每来一次 `message.changed`，拿镜像里
 * 那条消息的正文与推理长度与上一帧比，多出来的那一段就是要计的字数（`sampleRate`）。收尾
 * 仍然用消息上的 `usage` 差值定格成平均（`finishRate`）。
 *
 * ## 这一层不攒的东西
 *
 * 消息与四件事都不在这里攒：它们在镜像里（宿主的整条消息直接 replace，没有「折 chunk」这一步）。
 * 这一层只订阅事件去**催帧、采样、放行等结局的人**。
 */

import { AgentNS, addUsage, sumUsage } from "@ai-zen/agents-core";
import type { LogSink } from "@ai-zen/agents-logger";
import type { AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_RECONNECT_POLICY,
  reconnectUntilConnected,
  uploadAssets,
  sessionIdOf,
  type AssetSource,
  type Unsubscribe,
} from "./server-client/index.js";
import type { ClipboardImage } from "./clipboard.js";
import { statusBlocksOf, type StatusBlock } from "./status-blocks.js";
import { cliEnv } from "./env.js";
// 会话层自己要说的话只有一两句（「未能叫起来」），它们也得跟着界面语言走
import { t } from "./i18n/index.js";
import { readMemoryFile } from "./local-memory.js";
import { flushPendingNotices } from "./pending-notices.js";
import { noticeText, noticeTone } from "./session-notice.js";
import { TokenRateMeter, type RateSample } from "./session-rate.js";
import { buildMessageInput, contentOfInput } from "./user-content.js";
import type {
  ChatSessionLike,
  ChatSessionNotifier,
  ChatSessionOptions,
  FileEntry,
  FolderFact,
  HandoffOptions,
  HostConnection,
  HostEvent,
  InboxItem,
  MessageInput,
  ModelState,
  NoticeView,
  QuestionView,
  ScopeReloadReport,
  SessionActivity,
  SessionSnapshot,
  ThinkingState,
  WorkspaceFiles,
} from "./session/types.js";

/**
 * 开一段会话的输入：**就是会话契约那一份**去掉已经单独递进来的那样（连接）。
 *
 * 不另立一个平行类型：多一份「这里也有 agentId / sessionId」的定义，就多一处漂 ——
 * 而它们本来就是同一组意图。
 */
export type OpenRemoteSessionInput = Omit<ChatSessionOptions, "connection">;

/** 断线之后最多再敲几次门（连不上就不假装还在连：留一条通知给人看） */
const RECONNECT_POLICY = { ...DEFAULT_RECONNECT_POLICY, maxAttempts: 5 };

/** 等结局时的重新评估间隔：事件是主要来路，这个只是「万一漏了一脚」的兜底 */
const WAIT_RECHECK_MS = 500;

/** 这条消息带不带可归因的用量：自身那次响应（`usage`）或这次委派（`subAgentUsage`） */
function carriesUsage(message: AgentNS.Message): boolean {
  return message.usage !== undefined || message.subAgentUsage !== undefined;
}

export class RemoteChatSession implements ChatSessionLike {
  private readonly connection: HostConnection;
  private readonly notifier: ChatSessionNotifier;
  /** 宿主提问时怎么作答（缺省 = 没人能答，见 `onQuestion`） */
  private readonly questionHandler?: (question: QuestionView) => Promise<string | null>;
  /** 挂在这条连接上的订阅（整组摘：`dispose` 时一次卸干净） */
  private readonly offs: Unsubscribe[];
  private readonly rate = new TokenRateMeter();
  /** 这一段会话的镜像：会话行、消息、四件事、队列，全部由 CLI 自己维护（见 `mirror.ts`） */
  private mirror: Awaited<ReturnType<HostConnection["open"]>>;
  private readonly sessionIdValue: string;

  /** 配置那一份（模型表 + 档位表）；`null` = 还没读到 */
  private configValue: { config: AppConfig; presets: ReasoningPresets } | null = null;
  /** AgentDefinition 上绑的模型 id（`source` 那一格与 `/think` 的回落都看它）；`undefined` = 还没读到 */
  private definitionModelId: string | null | undefined = undefined;
  /** 这段会话所在工作区的 cwd（宿主这一版只在 `workspace.list` 里给） */
  private workspaceCwdValue: string | null = null;
  /** 挂着的题（`question.list` 一次 + `question.asked` 事件；题不落库，只活在内存里） */
  private questionsValue: QuestionView[] = [];
  /** 交接开始的那一刻（宿主只报「在不在交接」，不报开始时刻；这里记第一次看见它的时间） */
  private handoffSinceValue: string | null = null;

  /**
   * 发出去那一刻手上已有的消息 id。`waitForReply` 靠它判「这一句有了下文了吗」——
   * **不是**「一轮」的标记，只是一次集合差，问完就丢。
   */
  private sentBaseline: Set<string> | null = null;
  /** 正在跑的补拉；`waitForReply` 要等它写进 messages 才交还控制权 */
  private catchingUp: Promise<void> | null = null;
  /** 等下文的人（`waitForReply` / 重新评估） */
  private readonly waiters: Array<() => void> = [];
  /** 已经报过的那条失败（同一条消息的 `error` 只进一次通知栏） */
  private readonly reportedProblems = new Set<string>();
  /** 正在问的那道题（同一道题只问一次） */
  private readonly asking = new Set<string>();
  /** 速率表正在计的这一批 */
  private rateRunning = false;
  /** 速率采样游标：上一帧读到的那条消息正文 / 推理各多长 */
  private rateCursor = { text: 0, reasoning: 0 };
  /** 这一批开始时整段会话的累计 `completion_tokens`（收尾用差值得到真实产出） */
  private rateBaseline = 0;
  /** `/ws` 选中的那个工作区：下一个新开的会话落在它里面 */
  private nextWorkspaceId: string | null = null;
  /** 已经 `dispose()`：此后不再往界面上推任何东西 */
  private disposed = false;

  private constructor(
    connection: HostConnection,
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
    opened: OpenedSession,
  ) {
    this.connection = connection;
    this.notifier = notifier;
    this.questionHandler = input.onQuestion;
    this.mirror = opened.mirror;
    this.sessionIdValue = opened.mirror.session.id;
    this.configValue = opened.config;
    this.definitionModelId = opened.definitionModelId;
    this.workspaceCwdValue = opened.workspaceCwd;
    this.handoffSinceValue = opened.mirror.snapshot().handingOff ? new Date().toISOString() : null;

    // 订阅挂在**连接对象**上（不是某条 socket）：重连换的是底层 socket，这个对象不变。
    // 每一条事件都先过镜像（连接层那一侧已经折过一遍），这里只负责「催一帧」「采一次速率」。
    this.offs = [
      connection.subscribe(
        (event) => this.onEvent(event),
        (error) => this.onStreamError(error),
      ),
    ];
  }

  /**
   * 借一条现成的连接开（或续接）一段会话。
   *
   * 连接的生命周期**归调用方**（TUI 是 `connectHost` 拿到的那个 client，stdio 是自己连的那条），
   * 本类既不建也不关。
   */
  static async open(
    connection: HostConnection,
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
    logger: LogSink,
  ): Promise<RemoteChatSession> {
    const opened = await openSession(connection, input, logger);
    const session = new RemoteChatSession(connection, input, notifier, opened);
    if (input.remember !== false) {
      await rememberSession(opened.mirror.session.workspaceId, opened.mirror.session.id, logger);
    }
    // 建好之后补两样只在「打开这一刻」问得到的东西：挂着的题、以及连接建立之前登记过的通知
    await session.refreshQuestions();
    await session.flushNotices();
    return session;
  }

  // ==================== 对外面（ChatSessionLike） ====================

  /**
   * 附件上限：宿主这一版**不报**（`hello` 那一帧没有 limits 了），恒 `null`。
   *
   * 于是粘贴的本地预检只能用 `clipboard.ts` 的兜底常量 —— 那与宿主真实的上限**可能不一致**
   * （见那个文件的注释）。
   */
  get attachmentLimits(): ChatSessionLike["attachmentLimits"] {
    return null;
  }

  get agentId(): string {
    return this.mirror.session.agentId;
  }
  get sessionId(): string {
    return this.sessionIdValue;
  }
  get workspaceId(): string {
    return this.mirror.session.workspaceId;
  }
  /** 当前选中的工作区（`/ws` 切过就是新的那个） */
  get currentWorkspaceId(): string {
    return this.nextWorkspaceId ?? this.mirror.session.workspaceId;
  }
  get name(): string {
    return this.mirror.session.name;
  }
  get folder(): FolderFact {
    const workspace = this.workspaceCwd;
    // 目录在不在宿主这一版不报（`workspace.list` 只给 cwd）：说「不知道」，不编一个「还在」
    return { cwd: workspace ?? "", exists: null };
  }
  get messages(): AgentNS.Message[] {
    return [...this.mirror.messages];
  }
  get subAgents(): ChatSessionLike["subAgents"] {
    return this.mirror.roster;
  }

  get status(): SessionActivity | null {
    return this.mirror.snapshot().status;
  }
  get inputPaused(): boolean | null {
    return this.mirror.snapshot().inputPaused;
  }
  get outputPaused(): boolean | null {
    return this.mirror.snapshot().outputPaused;
  }
  get alive(): boolean | null {
    return this.mirror.snapshot().alive;
  }
  get handoffSince(): string | null {
    return this.mirror.snapshot().handingOff ? (this.handoffSinceValue ?? "") : null;
  }

  /**
   * 状态栏的块：**读的时候才拼**（`status-blocks.ts` 的 `statusBlocksOf`）。
   *
   * 这里刻意不缓存一份拼好的副本：缓存的副本没有刷新通道，于是聊天过程中模型名、思考档会全部
   * 冻在打开会话那一刻 —— 那正是这一层以前的表现。
   */
  get blocks(): StatusBlock[] {
    const snapshot = this.mirror.snapshot();
    return statusBlocksOf({
      model: this.model,
      thinking: this.thinking,
      // 速率是客户端自己的采样（`session-rate.ts`）：生成中读实时、手上没活时读这一批的平均
      rate: this.rate.snapshot(),
      working: snapshot.status === "working",
      // 四件事各一格（PRD 4.4）：直取镜像，不推算、不合成
      status: snapshot.status,
      inputPaused: snapshot.inputPaused,
      outputPaused: snapshot.outputPaused,
      alive: snapshot.alive,
      // 用量同样由客户端自己算（见 `lastTotalTokens` / `totalTokens`）
      lastTokens: this.lastTotalTokens(),
      totalTokens: this.totalTokens(),
    });
  }

  /** 这段会话现在用的模型（派生视图：会话行 + 配置里的模型表，见 `session/types.ts` 文件头） */
  get model(): ModelState {
    const modelId = this.mirror.session.modelId;
    const row =
      modelId === null ? undefined : this.configValue?.config.models.find((m) => m.id === modelId);
    return {
      modelId,
      name: row?.name ?? modelId ?? "",
      vision: row?.vision === true,
      // 会话行上那个 id 与 AgentDefinition 绑的是同一个 → 这一段的模型来自定义；否则来自这一段自己
      source: modelId !== null && modelId === this.definitionModelId ? "agent" : "session",
    };
  }

  /**
   * 思考强度的现状（派生视图）。
   *
   * 档位表来自 `api.config.get()` 的 `presets`，表由**生效模型**的 `reasoningPreset` 指过来
   * —— 用 AgentDefinition 上那个模型去查会读错表，这段会话换过模型时两边不是同一个。生效模型为空时
   * 回落成 AgentDefinition 绑的那个（它才是「跟随 AgentDefinition」时真正会生效的那一个）。
   */
  get thinking(): ThinkingState {
    const effective = this.mirror.session.modelId ?? this.definitionModelId ?? null;
    const model =
      effective === null
        ? undefined
        : this.configValue?.config.models.find((m) => m.id === effective);
    const preset = model?.reasoningPreset ?? null;
    const levels =
      preset === null ? [] : Object.keys(this.configValue?.presets[preset]?.levels ?? {});
    const selected = this.mirror.session.thinkingLevel;
    if (levels.length === 0) {
      return { preset, levels, selected, source: "not_adjustable", params: {} };
    }
    return {
      preset,
      levels,
      selected,
      source: selected === null ? "following_default" : "manual",
      params: {},
    };
  }

  get view(): SessionSnapshot {
    return this.mirror.session;
  }

  /** 当前模型 id（这段会话的生效模型，宿主给的） */
  get modelId(): string | null {
    return this.mirror.session.modelId;
  }

  /** 排队 InboxEntry（镜像里的那一格：`session.open` 的 `inbox` + `agent.inbox` 事件） */
  get inbox(): readonly InboxItem[] {
    return this.mirror.snapshot().inbox;
  }

  /** 排队条数 —— **派生**自 {@link inbox} */
  get inboxPending(): number {
    return this.inbox.length;
  }

  get questions(): readonly QuestionView[] {
    return this.questionsValue;
  }
  get rateSample(): RateSample {
    return this.rate.snapshot();
  }

  /**
   * 发一句（**死/不知道就先叫起来，再投递**；受理即回）；等它真的有了下文用 {@link waitForReply}。
   *
   * ## 发之前先判死活
   *
   * PRD 4.1「生死」的第三条起跑路：「客户端点发送时先判这段是死是活，死的就调接口复活、再投递」。
   * 宿主那一侧 **不做** 这一步：带 `sessionId` 而这一段没有 Agent 时，`agent.send` 只回
   * `not_found`（「先唤醒再投递是客户端的编排」就写在 `modules/api/agent.ts` 里）。
   *
   * 所以判在**这一层**：所有发话入口共用它，而不是每个入口各写一遍。判据是**镜像里死活那一格
   * 现读**（`alive`：打开时 `session.open` 报一次，之后按 `agent.alive` 换）：
   *
   *   · `true` —— 已有 Agent，那一次 `wake` 是白跑的往返，**不打**；
   *   · `false` —— 打开那一刻 `live` 就是 `null`（宿主口径：没有 Agent 即是死），先叫再投；
   *   · `null` —— 还没读到，不当成「活」，也先叫一声（有 Agent 时宿主的 `wake` 是空操作）。
   *
   * 唤醒或投递没成，就到这里为止：**不重试、不兜底**（与全仓「不重试」同一条口径），宿主原话
   * 照传。唤醒那一句额外缀上「未能叫起来」的上下文，投递被拒（比如中间那一段被杀掉）只报原话。
   * 没叫起来就**不投递** —— 发出去半句比没发更糟。
   *
   * ## 其余三件不在这里
   *
   * **不开开关**（「用户点发送就是继续」那一手是 {@link resume}）、**不判阶段**、**不替宿主兜底**：
   * 忙不忙不是判据 —— 活着就收下入队，什么时候取走是它自己的事。
   *
   * 同步拒绝（有问题挡着 / 目标已死 / 连接已断）不进事件通道：那是「这句没发出去」，报进通知栏，
   * promise 照常 resolve。抛出去只会让调用方变成未处理的 rejection。
   */
  async send(
    input: string,
    images: readonly ClipboardImage[] = [],
    assetIds: readonly string[] = [],
  ): Promise<void> {
    try {
      const built = await buildMessageInput({
        text: input,
        images,
        // 上传必须发生在 `agent.send` **之前**：段上的 `__asset_id` 指的是「已经传上去的那几张」
        upload: (sources: readonly AssetSource[]) => uploadAssets(this.connection, sources),
      });
      for (const warning of built.warnings) this.notifier.onNotice(warning, "info");
      // 撤回带回来的 Asset 已经传上去过了（id 就是那一次上传的凭证），不再传一遍
      const content = withRestoredAssets(built.input, assetIds);

      // ① 先判死活（镜像里那一格，现读）：死 / 还没读到就先叫一声，再投递。
      // 确知活着就跳过这一步 —— `agent.wake` 往返一次只为得到「本来就有」这个答案不值。
      if (this.alive !== true) {
        try {
          await this.wake();
        } catch (error: unknown) {
          // 叫不起来就不投：不重试、不兜底（本机装配真的失败时重叫多少次都一样）
          this.sentBaseline = null;
          this.notifier.onNotice(t("notice.startFailed", { error: messageOf(error) }), "error");
          return;
        }
      }

      // ② 投递。先记下「发之前有哪些消息」：等结局时靠它判「这一句有下文了吗」（问完就丢）
      this.sentBaseline = new Set(this.mirror.messages.map((message) => message.id));

      const messageId = newMessageId();
      await this.connection.api.runtime.agent.send.mutate({
        workspaceId: this.mirror.session.workspaceId,
        agentId: this.mirror.session.agentId,
        content,
        messageId,
        sessionId: this.sessionIdValue,
      });

      // 速率表从这里起算：它的分子是「这一批产出的 token」，分母是真正在收内容的那段时间
      this.rate.begin();
      this.rateRunning = true;
      this.rateCursor = { text: 0, reasoning: 0 };
      this.rateBaseline = this.completionTokens();

      this.notifyChange(true);
    } catch (error) {
      this.rateRunning = false;
      this.rate.finish();
      this.sentBaseline = null;
      this.notifier.onNotice(messageOf(error), "error");
    }
  }

  /**
   * 复活：**确保这段会话有 agent**（`agent.wake`，PRD 1.2 / PLAN §5.1）。
   *
   * 已经有 Agent 时宿主是空操作。失败**不吞**（装配可能真的失败）：「按发送」那条路得知道这句
   * 到底有没有发出去，所以错往上抛，由调用方说清楚。
   */
  async wake(): Promise<void> {
    await this.connection.api.runtime.agent.wake.mutate({ sessionId: this.sessionIdValue });
    this.notifyChange(true);
  }

  /** 暂停：**只关输出开关**（`agent.pause`，PRD 4.4）。留给程序化与内部用，界面上不暴露 */
  async pauseOutput(): Promise<void> {
    await this.connection.api.runtime.agent.pauseOutput.mutate({ sessionId: this.sessionIdValue });
    this.notifyChange(true);
  }

  /**
   * 继续：**只开输出开关、不投任何东西**（`agent.resume`，PRD 4.4）。
   *
   * 错照旧往上抛：调用方（`runSubmit`）得说清楚「开开关没成，所以这句没发」。
   */
  async resumeOutput(): Promise<void> {
    await this.connection.api.runtime.agent.resumeOutput.mutate({ sessionId: this.sessionIdValue });
    this.notifyChange(true);
  }

  /**
   * 等**这一句**真的有了下文。
   *
   * 判据全部来自契约事实，没有一条是「一轮」：
   *   · 发出去之后出现了新消息（用户那句写进 messages、或答复那条冒出来）；
   *   · 忙闲那一格回到了 `idle`（= 手上没活且队列真空）；
   *   · 没有一条 AgentDefinition 消息还停在 `pending` / `writing`。
   */
  async waitForReply(): Promise<void> {
    for (;;) {
      if (this.hasReply()) {
        if (this.catchingUp) await this.catchingUp;
        return;
      }
      await this.nextSignal();
    }
  }

  abort(): void {
    void this.connection.api.runtime.agent.abort
      .mutate({ sessionId: this.sessionIdValue })
      .catch((error: unknown) => this.notifier.onNotice(messageOf(error), "error"));
  }

  /** `/ws` 选中之后：下一个新开的会话落在那个工作区（这一段不动） */
  selectWorkspace(workspaceId: string): void {
    this.nextWorkspaceId = workspaceId;
  }

  /**
   * 让宿主重新发现能力（MCP 服务器、工具、skill、subagent），再把这一段手里的事实重取一次。
   *
   * 刷新是宿主那一侧的事（`scope.reload`）：Scope 按目录活在宿主进程里，客户端连容器都摸
   * 不到，能做的只有说一句「现在刷一遍」。回执里的数字就是那一手的结果，原样交回调用方 ——
   * 「刷了几份、有没有没刷成的」只有宿主答得上来，这里不自己编。
   *
   * 后两步（模型表 / 题）留着：刷新之后手里那几份事实本来就可能变，重取一次是本该做的。
   */
  async reload(): Promise<ScopeReloadReport> {
    const report = await this.connection.api.runtime.scope.reload.mutate();
    await this.refreshModelFacts();
    await this.refreshQuestions();
    this.notifyChange(true);
    return report;
  }

  /** 换**这一段会话**的模型（`session.updateModel`，PRD F-B4） */
  async updateModel(modelId: string | null): Promise<void> {
    if (modelId === null) {
      // 宿主这一版只收一个真实存在的模型 id（`modelId: z.string()`）：`null` 那条「回到 AgentDefinition
      // 定义」的路没有对应 procedure，如实拒绝，不偷偷换成定义上那个 id
      throw new Error(
        "宿主这一版没有「回到助手定义上那个模型」的入口（`session.updateModel` 只收 id）",
      );
    }
    await this.connection.api.session.updateModel.mutate({
      sessionId: this.sessionIdValue,
      modelId,
    });
    await this.resync();
    this.notifyChange(true);
  }

  /** 改这一段的**名字**（`session.rename`）。id 与其余几格一个字不动 */
  async rename(name: string): Promise<void> {
    await this.connection.api.session.rename.mutate({ sessionId: this.sessionIdValue, name });
    await this.resync();
    this.notifyChange(true);
  }

  /** 置顶 / 取消置顶这一段（`session.pin`） */
  async pin(pinned: boolean): Promise<void> {
    await this.connection.api.session.pin.mutate({ sessionId: this.sessionIdValue, pinned });
    await this.resync();
    this.notifyChange(true);
  }

  /** 改**这一段会话**的思考档位（`null` = 跟随 AgentDefinition 默认，`session.updateThinkingLevel`） */
  async updateThinkingLevel(level: string | null): Promise<void> {
    await this.connection.api.session.updateThinkingLevel.mutate({
      sessionId: this.sessionIdValue,
      level,
    });
    await this.resync();
    this.notifyChange(true);
  }

  /**
   * 撤回到某条用户消息**之前**（`session.rewind`）：其后消息硬删，被撤回的内容由宿主给回来。
   *
   * 回的是**输入那一份载体**（{@link MessageInput}），不是光秃秃的内容：那条消息里带的图在段上
   * 留着 Asset id，拆出来放进 `assetIds` —— 输入框那一侧才谈得上「把图也带回来」（PRD 3.9：
   * 输入历史＝这段会话里的用户消息，带图的那条连图一起恢复）。
   */
  async rewind(beforeMessageId: string): Promise<MessageInput> {
    const { content } = await this.connection.api.session.rewind.mutate({
      sessionId: this.sessionIdValue,
      messageId: beforeMessageId,
    });
    await this.resync();
    this.notifyChange(true);
    return { content, assetIds: assetIdsOfContent(content) };
  }

  /**
   * 交接（`handoff.start`）：**只回「开始了」**。
   *
   * 执行者（`mode`）只在**调用方显式挑过**时才发下去：不给时这一格不出现，执行者由宿主的缺省
   * 定 —— 与这一格加进来之前的每一趟一致（`handoff.start` 收的是可选 `mode`）。「之后接什么」
   * （旧 `then`）仍然没有：宿主这一版没有那一格。
   *
   * ## 死会话先叫起来
   *
   * 宿主那四条判据的第一条就是「这一段**有活着的 Agent**」，而刚打开、还没说过话的那一段
   * （宿主重启之后每一段都是这一种）一条 Agent 都没有 —— 直接发只会拿回一句「没有运行中的Agent，
   * 无法交接」，用户看到的是「我什么都没做，它凭什么交接不了」。
   *
   * 唤醒是**客户端的编排**（`modules/api/agent.ts` 里写着「先唤醒再投递」是客户端的事，宿主不做
   * 兜底），所以判据放在这里，与 {@link send} 同一套：镜像里死活那一格不是 `true` 就先
   * {@link wake}（`null` 也算「没读到」，叫一声；有 Agent 时宿主的 `wake` 是空操作）。
   *
   * 叫不起来就**不交接**：装配真的失败时（模型不可解析、缺凭证），错的原文照旧往上抛，由
   * `/handoff` 那一层报成「交接失败：<原话>」—— 不重试、不兜底。
   */
  async handoff(options: HandoffOptions = {}): Promise<void> {
    if (this.alive !== true) await this.wake();
    await this.connection.api.handoff.start.mutate({
      sessionId: this.sessionIdValue,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
    });
    this.notifyChange(true);
  }

  /**
   * `@` 补全的文件清单（`workspace.files`）：项目 `cwd` 下的相对路径，正斜杠、字典序、上限 500 条。
   *
   * 清单必须来自**会话真正跑在哪个目录** —— 那目录属于宿主，客户端在远端读不到那台机器的盘。
   * `workspaceId` 就取**这一段会话自己的那一个**（`session.open` 回来的会话行，见
   * {@link workspaceId}），不取 `/ws` 之后那个「下一段落在哪」：`@` 列的是这一段读得到的文件。
   *
   * `query` 交给宿主先筛（大小写不敏感的子串）省掉整份清单过 wire；屏幕拿回来仍按 `rankPaths`
   * 本地排序 —— 「先筛」与「怎么排」是两件事。宿主一次列完（没有旧契约那套「第一次还在扫、
   * 过一会儿再问」），所以这里只回 `ready` / `unavailable` 两态。
   *
   * 问不到时**不抛**：`@` 是输入框里的一个菜单，抛出去就成了「打不出字」。于是推一条通知
   * （失败时用宿主的原话，这一族别的调用也是这么报的）再如实交回一份空清单 —— 屏幕照旧按
   * `state` 分支，「没有可提的文件」而不是一片安静。
   */
  async listWorkspaceFiles(query = ""): Promise<WorkspaceFiles> {
    const workspaceId = this.mirror.session.workspaceId;
    // 还没有项目上下文（会话行上没给 workspaceId）：报一句、回空清单，不抛
    if (!workspaceId) {
      this.notifier.onNotice(t("notice.mentionNoWorkspace"), "info");
      return { state: "unavailable", entries: [] };
    }
    try {
      const { files } = await this.connection.api.workspace.files.query({
        workspaceId,
        ...(query === "" ? {} : { query }),
      });
      return { state: "ready", entries: files.map(toFileEntry) };
    } catch (error) {
      this.notifier.onNotice(messageOf(error), "error");
      return { state: "unavailable", entries: [] };
    }
  }

  /**
   * 清空这段会话的排队区（`agent.clearInbox`）—— 回宿主数的那个条数。
   *
   * 排队区分两处存（Agent 内存里的队列、`inbox` 表里的行），怎么清是宿主的判据（有活 Agent 就
   * 走内核作废，没有就直接清库行并自己推一条空队列），客户端只认它回来的 `cleared`。
   *
   * 失败照这一族别的调用一样**抛出去**（`rename` / `pin` 那些也是 `await` 完就完）：`/free` 要的
   * 是「清干净了没有」，吞掉就成了假装清成功 —— 这与从前那句「宿主没有这条 procedure」不是一回事。
   */
  async clearInbox(): Promise<number> {
    const { cleared } = await this.connection.api.runtime.agent.clearInbox.mutate({
      sessionId: this.sessionIdValue,
    });
    return cleared;
  }

  /**
   * 某个 subagent 自己的消息（它挂在某个工具调用下面，PRD 4.6 / F-I7）。
   *
   * subagent 的话不入库（宿主那边只有事件），所以镜像那一栏就是唯一的来源；镜像里没有
   * （本客户端打开时它已经散场）就回空数组 —— 不去问一条不存在的 `message.list`。
   */
  async listSubAgentMessages(toolCallId: string): Promise<AgentNS.Message[]> {
    return [...this.mirror.subAgent(toolCallId)];
  }

  /** 屏幕渲染期现取 subagent 的消息（**不发请求**） */
  subAgentMessages(toolCallId: string): AgentNS.Message[] {
    return [...this.mirror.subAgent(toolCallId)];
  }

  /** 卸载这段（屏幕的 effect cleanup、stdio 的收尾、Ctrl+C 的共同出口） */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    // 不再跟着这段会话：镜像留着就是一份没人看的多余订阅
    this.connection.closeMirror(this.sessionIdValue);
    this.release();
  }

  // ==================== 事件 ====================

  /**
   * 每一条事件都从这里过；镜像已经折过一遍（连接层那一侧），这里只做界面那几件事。
   *
   * ## 两类事件的两种刷新：合帧与立即
   *
   * 流式期间宿主**每吐一小段就推一条 `message.changed`**（一次回答可以几十上百条），而每一条
   * 都触发一次 React 重渲染就等价于「每个 delta 一次全量布局重算 + 整帧重建」—— SSH 弱网下会
   * 把 pty 缓冲填满、把界面拖死（`tui/screens/frame-buffer.ts` 的文件头就是这件事）。
   *
   * 所以：**内容变化进合帧缓冲**（`immediate: false`，由屏幕按 `STREAM_FRAME_MS` 批量上屏），
   * 而**其余事件立即上屏** —— 用户按了发、回答结束了、出错了、通知到了，这几类让人等 60ms 就是
   * 「按了回车半天不显示」。流尾不会丢：最后那条 `agent.status` / `done` 走立即那条路，
   * 而 `FrameBuffer.push(immediate)` 会先把积压的一起吐出来。
   */
  private onEvent(event: HostEvent): void {
    if (this.disposed) return;
    if (event.type === "notice") {
      if (event.notice.sessionId !== null && event.notice.sessionId !== this.sessionIdValue) return;
      this.forwardNotice(event.notice);
      return;
    }
    if (event.type === "notice.cleared") {
      if (event.sessionId !== undefined && event.sessionId !== this.sessionIdValue) return;
      this.signal();
      this.notifyChange(true);
      return;
    }
    if (event.type === "question.asked") {
      if (event.sessionId !== this.sessionIdValue) return;
      void this.onQuestion(event.question);
      return;
    }
    if (event.type === "question.answered") {
      if (event.sessionId !== this.sessionIdValue) return;
      this.questionsValue = this.questionsValue.filter((item) => item.id !== event.questionId);
      this.signal();
      this.notifyChange(true);
      return;
    }
    if (sessionIdOf(event) !== this.sessionIdValue) return;

    /** 这一条是不是「只是内容长了一点」（进合帧）而不是「发生了一件事」（立即上屏） */
    let contentOnly = false;
    switch (event.type) {
      case "agent.status":
        // 落回 `idle` 就是「可以收尾看一眼了」：补拉一次读数 + 定格速率
        if (event.status === "idle") this.scheduleCatchUp();
        break;
      case "message.added":
      case "message.changed":
        this.reportProblem(event.message);
        if (event.type === "message.changed") this.sampleRate(event.message);
        contentOnly = true;
        break;
      case "session.handoff":
        this.handoffSinceValue = event.handingOff ? new Date().toISOString() : null;
        break;
      default:
        break;
    }

    this.signal();
    this.notifyChange(!contentOnly);
  }

  /**
   * 事件流自己报错（宿主断流 / 订阅断了）。
   *
   * 「要不要一直重试」是这里定的：给 5 次、退避封顶 10 秒；还没连上就推一条通知说清，而不是让
   * 界面永远停在「看起来在连」。连上之后**补什么**由这里决定：再打一次 `session.open`（宿主
   * 一次取全，没有增量要补）。
   */
  private onStreamError(error: unknown): void {
    if (this.disposed) return;
    void reconnectUntilConnected(this.connection, { policy: RECONNECT_POLICY })
      .then(() => this.resync())
      .catch((failure: unknown) => {
        this.notifier.onNotice(
          `与宿主的连接断了，重连 ${RECONNECT_POLICY.maxAttempts} 次仍未成功：${messageOf(failure)}`,
          "error",
        );
      });
    void error;
  }

  /** 一条通知 → 通知栏（句子与四档语气都是宿主给的，这里只把语气收成三档颜色） */
  private forwardNotice(notice: NoticeView): void {
    this.showNotice(notice);
  }

  /**
   * 问题对象 → 交给界面作答（`question.answer`），答完那道题就没了。
   *
   * 没人能答时**不作答**：这道题会一直挂着，宿主会用 `question_pending` 拒绝后续发送 ——
   * 替用户选一个选项等于替他做决定。但题目本身要让人看见，所以那句题干进通知栏。
   */
  private async onQuestion(question: QuestionView): Promise<void> {
    this.replaceQuestion(question);
    this.notifyChange(true);
    if (this.disposed) return;
    if (this.asking.has(question.id)) return;

    const handler = this.questionHandler;
    if (!handler) {
      this.notifier.onNotice(question.message, "info");
      return;
    }
    this.asking.add(question.id);
    try {
      const value = await handler(question);
      if (value === null) {
        this.notifier.onNotice(question.message, "info");
        return;
      }
      await this.connection.api.question.answer.mutate({ questionId: question.id, value });
      this.questionsValue = this.questionsValue.filter((item) => item.id !== question.id);
      this.notifyChange(true);
    } catch (error) {
      this.notifier.onNotice(messageOf(error), "error");
    } finally {
      this.asking.delete(question.id);
    }
  }

  // ==================== 内部 ====================

  /** 这段会话所在工作区的 cwd（读配置之前可以先没有） */
  private get workspaceCwd(): string | null {
    return this.workspaceCwdValue;
  }

  /** 忙闲落回 `idle`（或重连补拉完成）：补拉一次 + 定格速率，然后放行等下文的人 */
  private scheduleCatchUp(): void {
    if (this.catchingUp) return;
    this.catchingUp = this.catchUp().finally(() => {
      this.catchingUp = null;
      this.signal();
    });
  }

  private async catchUp(): Promise<void> {
    await this.resync();
    this.finishRate();
    this.sentBaseline = null;
    this.release();
    this.notifyChange(true);
  }

  /** 这一句是不是已经有下文了（见 `waitForReply` 的三条判据） */
  private hasReply(): boolean {
    const baseline = this.sentBaseline;
    if (baseline === null) return true;
    const snapshot = this.mirror.snapshot();
    if (snapshot.status === null) return false;
    if (snapshot.status === "working") return false;
    const messages = snapshot.messages;
    if (!messages.some((message) => !baseline.has(message.id))) return false;
    return !messages.some(
      (message) =>
        message.role === AgentNS.Role.Assistant &&
        (message.status === AgentNS.MessageStatus.Pending ||
          message.status === AgentNS.MessageStatus.Writing),
    );
  }

  /** 等下一脚（事件为主，定时重评估兜底；`dispose` 之后一律放行，不把人挂死） */
  private nextSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => finish(), WAIT_RECHECK_MS);
      const finish = () => {
        clearTimeout(timer);
        const index = this.waiters.indexOf(finish);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      };
      this.waiters.push(finish);
    });
  }

  /** 放行所有在等的人（重复调用无害） */
  private release(): void {
    for (const finish of this.waiters.splice(0)) finish();
  }

  /** 催一下等结局的人（每一条事件之后都叫一次：判据是现读的，叫人先醒来看一眼没有坏处） */
  private signal(): void {
    if (this.waiters.length === 0) return;
    for (const finish of this.waiters.splice(0)) finish();
  }

  /**
   * 生成中采样一次速率。
   *
   * 数据源是**镜像里那条消息**：它的正文与推理就地增长，这一帧比上一帧多出来的那一段就是要计
   * 的字数。新契约没有增量事件，所以「这一片多了什么」只能这样量 —— 而且屏幕上的字本来就来
   * 自这条消息。
   */
  private sampleRate(message: AgentNS.Message): void {
    if (!this.rateRunning) return;
    const text = typeof message.content === "string" ? message.content : "";
    const reasoning = message.reasoning_content ?? "";
    const { text: fromText, reasoning: fromReasoning } = this.rateCursor;
    const added =
      text.slice(text.length > fromText ? fromText : text.length) +
      reasoning.slice(reasoning.length > fromReasoning ? fromReasoning : reasoning.length);
    if (added) this.rate.addDelta(added);
    this.rateCursor = { text: text.length, reasoning: reasoning.length };
  }

  /** 手上这一批跑完：速率定格成「平均」（真实 `completion_tokens` 的差值） */
  private finishRate(): void {
    if (!this.rateRunning) return;
    this.rateRunning = false;
    this.rate.setExact(this.completionTokens() - this.rateBaseline);
    this.rate.finish();
  }

  /** 整段会话的累计产出 token（把每条 AgentDefinition 消息上的 `usage` 加起来） */
  private completionTokens(): number {
    let total = 0;
    for (const message of this.mirror.messages) {
      const used = message.usage?.completion_tokens;
      if (typeof used === "number" && Number.isFinite(used)) total += used;
    }
    return total;
  }

  /** 本次用掉的 token：**最后一条带 `usage` 的 assistant 消息** */
  private lastTotalTokens(): number | null {
    const messages = this.mirror.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (message.role !== AgentNS.Role.Assistant) continue;
      const used = message.usage?.total_tokens;
      if (typeof used === "number" && Number.isFinite(used)) return used;
    }
    return null;
  }

  /**
   * 整段会话累计的 token：**消息上的两格一次求和**（`usage` + `subAgentUsage`，用 core 的
   * `sumUsage()`）。还在跑的那几次委派只能拿栏里消息上的 `usage` 现加。
   */
  private totalTokens(): number | null {
    const main = this.mirror.messages;
    let total = sumUsage(main);
    let seen = main.some(carriesUsage);

    const accounted = new Set<string>();
    for (const message of main) {
      if (message.subAgentUsage && message.tool_call_id) accounted.add(message.tool_call_id);
    }
    for (const column of this.mirror.snapshot().subAgents) {
      if (accounted.has(column.toolCallId)) continue;
      for (const message of column.messages) {
        if (!carriesUsage(message)) continue;
        seen = true;
        if (message.usage) total = addUsage(total, message.usage);
      }
    }

    return seen ? total.total_tokens : null;
  }

  /** 把镜像补回现在（再打一次 `session.open`，四格整份换掉） */
  private async resync(): Promise<void> {
    try {
      this.mirror = await this.connection.resync(this.sessionIdValue);
    } catch (error) {
      this.notifier.onNotice(messageOf(error), "error");
    }
  }

  /** 重取模型 / 档位那两格（配置与 AgentDefinition） */
  private async refreshModelFacts(): Promise<void> {
    try {
      this.configValue = await this.connection.api.config.get.query();
    } catch {
      // 读不到就是「不知道模型表」：`model` / `thinking` 会回落成 id 与空档位表，不编
    }
    try {
      const { definition } = await this.connection.api.config.agents.get.query({
        agentId: this.mirror.session.agentId,
      });
      this.definitionModelId = definition.modelId ?? null;
    } catch {
      // 定义没了（AgentDefinition 被删）：模型那一格回空，`source` 那一格跟着落到 `session`
      this.definitionModelId = null;
    }
  }

  /** 补一次挂着的题（题不落库、只活在宿主的进程里，所以打开时要问一次） */
  private async refreshQuestions(): Promise<void> {
    try {
      const questions = await this.connection.api.question.list.query({
        sessionId: this.sessionIdValue,
      });
      this.questionsValue = questions;
    } catch (error) {
      // 问不到要说一句：挂着的题不上屏，用户就没法作答 —— 而宿主会用 `question_pending`
      // 把所有后续发送都拒掉。开会话照旧不被打断（这里只报不改流程），但不许一声不吭。
      this.notifier.onNotice(t("notice.questionsReadFailed", { error: messageOf(error) }), "error");
    }
  }

  /** 把宿主此刻还挂着的通知补上屏（启动 / 重连之后各一次）；失败一律吞掉（尽力而为） */
  private async flushNotices(): Promise<void> {
    if (this.disposed) return;
    try {
      await flushPendingNotices({
        connection: this.connection,
        sessionId: this.sessionIdValue,
        // 显示即消费：上屏了的那几条由 `flushPendingNotices` 按 id 逐条清；
        // 屏已经卸载时 `showNotice` 回 `false`，那一条就不清（谁也没看见的东西不能被清掉）
        onNotice: (notice) => this.showNotice(notice),
      });
    } catch (error) {
      this.notifier.onNotice(
        t("notice.noticesCatchupFailed", { error: messageOf(error) }),
        "error",
      );
    }
  }

  /**
   * 一条通知上屏；回「真的上屏了吗」。
   *
   * 那一格返回值是给补看用的（`pending-notices.ts` 的逐条清）：屏已经卸载时这条谁也没看见，
   * 它就不能被从宿主那里清掉 —— 清掉了下次也没得补。
   */
  private showNotice(notice: NoticeView): boolean {
    if (this.disposed) return false;
    this.notifier.onNotice(noticeText(notice), noticeTone(notice.level), noticeOrigin(notice));
    return true;
  }

  /** 那条消息上「回显用的失败事实」（PRD 4.15）：同一条只进一次通知栏 */
  private reportProblem(message: AgentNS.Message): void {
    const problem = message.error;
    if (!problem) return;
    const key = `${message.id}\u0000${problem.code}\u0000${problem.message}`;
    if (this.reportedProblems.has(key)) return;
    this.reportedProblems.add(key);
    this.notifier.onNotice(problem.message, "error");
  }

  /** 现场里那道题换成新的那一版（同一 id 就地替换） */
  private replaceQuestion(question: QuestionView): void {
    const others = this.questionsValue.filter((item) => item.id !== question.id);
    this.questionsValue = [...others, question];
  }

  /** 「屏幕该重画了」；卸载之后一律不再推 */
  private notifyChange(immediate: boolean): void {
    if (this.disposed) return;
    this.notifier.onChange(immediate);
  }
}

/**
 * 通知的来源：宿主这一版**不报**这一格（只剩 `level` / `code` / `message`），于是只有一条判据
 * —— 日志上浮那批的 `code` 由 `log-notices.ts` 发出来的那几个键值，其余一律 `app`。
 */
function noticeOrigin(notice: NoticeView): "log" | "app" {
  return notice.code.startsWith("log.") ? "log" : "app";
}

/**
 * 注册表（`sessions-registry.ts`）的缺省构造入口：借那**一条**连接开一段会话。
 *
 * 有明确的 `sessionId` 时**不递 agentId**：那段会话是谁跑的由宿主记着（PRD L7）。
 */
export async function createRemoteChatSession(
  options: ChatSessionOptions,
  notifier: ChatSessionNotifier,
  logger: LogSink,
): Promise<ChatSessionLike> {
  return await RemoteChatSession.open(
    options.connection,
    {
      agentId: options.sessionId ? undefined : options.agentId,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.remember !== undefined ? { remember: options.remember } : {}),
      ...(options.onQuestion !== undefined ? { onQuestion: options.onQuestion } : {}),
    },
    notifier,
    logger,
  );
}

/** 打开一段会话之后手上有的那几样 */
interface OpenedSession {
  mirror: Awaited<ReturnType<HostConnection["open"]>>;
  config: { config: AppConfig; presets: ReasoningPresets } | null;
  definitionModelId: string | null;
  /** 这段会话所在工作区的 cwd（目录事实那一格用） */
  workspaceCwd: string | null;
}

/**
 * 打开（或新建）要用的那段会话。
 *
 * 三种入口，优先级写在参数上：
 *   1. 给了 `sessionId` → 按 id 打开（`/load` 选中的那段）；
 *   2. 给了 `resume` 且本机记着这个工作区上次打开的那段 → 打开它（PRD F-A6：续接是客户端的记忆）；
 *   3. 都没命中 → 新建（`session.create` 只建行；唤醒与投递留给第一次发话）。
 *
 * 「落在哪个工作区」只认 `workspaceId`：会话层**不看 cwd**（PRD D30）。
 */
async function openSession(
  connection: HostConnection,
  input: OpenRemoteSessionInput,
  logger: LogSink,
): Promise<OpenedSession> {
  if (input.sessionId) return await loadSession(connection, input.sessionId);

  const workspaceId = input.workspaceId;
  if (workspaceId === undefined) {
    // 走到这里说明入口没先进入工作区：远端宿主上那条路必须由用户选（`/ws`）
    throw new Error("还没有进入工作区：先用 /ws 选一个（远端宿主上的目录只有你知道）");
  }
  if (input.resume) {
    const remembered = await recallSession(workspaceId, logger);
    if (remembered) {
      try {
        return await loadSession(connection, remembered);
      } catch (error) {
        // 记着的那个 id 在宿主上已经没了（被删 / 宿主换了库）：报一句，这次开一段新的
        logger.warn(`没能续接上一次那一段（${remembered}）：${messageOf(error)}（这次开一段新的）`);
      }
    }
  }

  const agentId = input.agentId ?? (await defaultAgentId(connection));
  /**
   * 建一段新会话 —— `session.create` 只写库：不唤醒 Agent，也不投递任何东西。于是刚建出来的
   * 这一段是一段没有 Agent 的会话，第一次发话时 {@link RemoteChatSession.send} 会先叫起来再投。
   */
  const { session } = await connection.api.session.create.mutate({ workspaceId, agentId });
  return await loadSession(connection, session.id);
}

/** 取一段会话的镜像 + 那两格派生事实要的配置 */
async function loadSession(connection: HostConnection, sessionId: string): Promise<OpenedSession> {
  const mirror = await connection.open(sessionId);
  const config = await readConfig(connection);
  let definitionModelId: string | null = null;
  try {
    const { definition } = await connection.api.config.agents.get.query({
      agentId: mirror.session.agentId,
    });
    definitionModelId = definition.modelId ?? null;
  } catch {
    // 定义没了（AgentDefinition 被删）：模型那一格回空，下游按「这一段的模型来自会话」处理
  }
  const workspaceCwd = await readWorkspaceCwd(connection, mirror.session.workspaceId);
  return { mirror, config, definitionModelId, workspaceCwd };
}

/** 这段会话所在工作区的 cwd（`workspace.list` + find：宿主这一版没有 `workspace.get`） */
async function readWorkspaceCwd(
  connection: HostConnection,
  workspaceId: string,
): Promise<string | null> {
  try {
    const workspaces = await connection.api.workspace.list.query();
    return workspaces.find((workspace) => workspace.id === workspaceId)?.cwd ?? null;
  } catch {
    return null;
  }
}

/** 读一份配置（模型表 + 档位表）；读不到就是 `null`（派生视图会回落到 id 与空表） */
async function readConfig(
  connection: HostConnection,
): Promise<{ config: AppConfig; presets: ReasoningPresets } | null> {
  try {
    return await connection.api.config.get.query();
  } catch {
    return null;
  }
}

/** 没点名 AgentDefinition 时用宿主配置里的默认 AgentDefinition（缺省项归宿主，客户端不猜） */
async function defaultAgentId(connection: HostConnection): Promise<string> {
  const { config } = await connection.api.config.get.query();
  const agentId = config.defaultAgent;
  if (!agentId) {
    throw new Error("宿主配置里没有默认助手（`config.defaultAgent`）：先配置一个助手再开会话");
  }
  return agentId;
}

// ---------------------------------------------------------------------------
// 「上次打开的那段会话」—— 本机的一小块记忆（PRD F-A6：续接是客户端的记忆）
// ---------------------------------------------------------------------------

/** 记忆文件：`<aiZenDir>/cli/last-session.json`（键是工作区 id） */
function memoryPath(): string {
  return join(cliEnv().aiZenDir, "cli", "last-session.json");
}

/** 这个项目上次打开的是哪一段（`null` = 没有可用的记忆） */
async function recallSession(workspaceId: string, logger: LogSink): Promise<string | null> {
  const read = await readMemoryFile(memoryPath(), logger);
  if (read.kind !== "value") return null;
  const value = read.entries[workspaceId];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 记住这个项目现在打开的是哪一段；写失败只是「下次不续接」，但要说一句 */
async function rememberSession(
  workspaceId: string,
  sessionId: string,
  logger: LogSink,
): Promise<void> {
  const path = memoryPath();
  const read = await readMemoryFile(path, logger);
  // 读不出来就不写：那一份里别的项目记着的那一段我们没看到，写下去等于把它们抹掉
  if (read.kind === "broken") return;
  const entries = read.kind === "value" ? read.entries : {};
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ ...entries, [workspaceId]: sessionId }, null, 2));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`记不住 ${path}：${reason}（下次在这个项目里不续接那一段）`);
  }
}

/** 一条新消息 id（客户端给的那个 id：宿主据它认「写进 messages 的是哪一条」） */
function newMessageId(): string {
  return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 宿主 `workspace.files` 给的是**路径字符串**，`FileEntry` 要三格（屏幕按 `kind` 决定要不要补
 * 尾斜杠）。
 *
 * 那份清单只收普通文件（宿主那边目录不进清单），所以 `kind` 恒 `"file"`、`name` 是路径最后一段。
 * 于是「逐段敲路径」靠的是子序列匹配（`@src/tui` 能直达 `src/tui/screens/chat.tsx`），而不是
 * 先选中一个目录再钻进去。
 */
function toFileEntry(path: string): FileEntry {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file" };
}

/** 抛出值 → 一句人话 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 内容段 ↔ Asset id（撤回回填时把图带回去）
// ---------------------------------------------------------------------------

/**
 * 段上的本地标记：指回数据根下的一份 Asset。
 *
 * 写它的是 `user-content.ts`（`contentOfInput`），宿主 `ASSET_ID_KEY` 是同一个词；这里只读，
 * 不造第二个名字。
 */
const ASSET_ID_KEY = "__asset_id";

/**
 * 一条消息的内容 → 它挂着的 Asset id（**按原顺序、不去重**）。
 *
 * 不去重是有意的：同一张图在同一条消息里出现两次，用户就是放了两次 —— 去重会让撤回之后
 * 少一张，而那是静默改用户的消息。
 */
function assetIdsOfContent(content: AgentNS.MessageContent | undefined): string[] {
  if (content === undefined || typeof content === "string") return [];
  const ids: string[] = [];
  for (const section of content) {
    const assetId = (section as { [ASSET_ID_KEY]?: unknown })[ASSET_ID_KEY];
    if (typeof assetId === "string" && assetId.length > 0) ids.push(assetId);
  }
  return ids;
}

/**
 * 把已经传上去的 Asset（撤回回填的那几张）挂进这次要发的内容里。
 *
 * 它们排在**这一次新粘贴的之前**：原消息里本来就在前面，用户新贴的是后加的。Asset 段由
 * `contentOfInput` 拼（段上那个标记键只有 `user-content.ts` 认），这里只决定摆在哪一段后面 ——
 * 文字在最前，之后依次是撤回带回来的、这次传上去的。
 */
function withRestoredAssets(
  content: AgentNS.MessageContent,
  assetIds: readonly string[],
): AgentNS.MessageContent {
  if (assetIds.length === 0) return content;
  if (typeof content === "string") return contentOfInput({ content, assetIds: [...assetIds] });
  const assets = contentOfInput({ content: "", assetIds: [...assetIds] });
  const assetSections = typeof assets === "string" ? [] : assets;
  const firstAssetAt = content.findIndex((section) => section.type !== "text");
  const cut = firstAssetAt < 0 ? content.length : firstAssetAt;
  return [...content.slice(0, cut), ...assetSections, ...content.slice(cut)];
}
