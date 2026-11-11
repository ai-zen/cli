/**
 * 会话层 —— 一段会话的客户端实现（**纯客户端**：Agent 在服务端跑）。
 *
 * 它只做三件事：**连接**（借一条进程级连接，不建也不关）、**命令族**（`ChatSessionLike` 那
 * 27 个成员，大多是一行转发）、**把状态交给界面**（`SessionStream.state` 就是那些只读字段的
 * 来源）。状态机与重连**不在这里**：包里的 `SessionStream`（纯）与 `SessionChannel`（脏）
 * 是唯一实现，三个前端共用 —— 在这里再写一遍的代价不是行数而是漂移。
 *
 * ## 三件包里不管、必须留在这里的事
 *
 * 1. **失败要能被用户看见**：包里只给 `state.failure = {code, message}`（不产句子、也不认识
 *    通知栏），这里把它映回 `notifier.onNotice` —— 渲染层零改动，失败不会变成静默。
 * 2. **粘贴的图片走 `content.upload`**：端点 / 视觉能力的判据在服务端（按这段会话的实发模型
 *    名解析），客户端只递字节 —— 客户端再算一遍就是第二份会漂的答案。
 * 3. **等一轮结束的原语**（`waitForTurn`）：包里的 `send()` 立刻返回 `turnId`，而界面用
 *    `busy` 包住输入禁用，靠的是「这一轮真的结束了」—— 别删掉它让界面自己等。
 *
 * ## `session.close` 的三个时机（正确性）
 *
 * 「持有者」是唯一的活命判据，而连接**不随界面卸载消失** ——
 *「切走一段会话」于是对服务端完全不可见。三条铁律：
 *   · **`reset()`（`/new`）**：先归档 → 再开新的 → **最后**关旧的（先关再存是拿不存在的 id
 *     写盘；先关旧的再开新的，`open` 一失败两段都没了）；
 *   · **重挂载（`/load`、`/clear`、`/back`）**：旧会话由**新实例接管前的 `dispose()`** 关 ——
 *     不发这一帧，内存峰值随 `/load` 次数线性增长到宽限期；
 *   · **退出**：尽力而为（不 await）。连接随后就关，那帧可能落不了地 —— 既有取舍：把每个
 *     Ctrl+C 变成一个网络往返更糟，而崩溃能发出的帧本来就是零。
 *
 * **会话动作一律走 channel**（不管是换 id 的还是不换的）：
 *   · 换 id 的四个（`saveAs` / `migrate` / `reload` / `setAgent`）包里自己会 `applyIdChanged`
 *     + 重取快照，自己改 id 就是在旧 id 上等一个永远不来的 `session-turn-end`；
 *   · 会话级的模型动作两个（`setModel` / `setModelParams`）不换 id，但包里也会把返回的快照
 *     对齐屏幕（`modelId` / `apiModel` / `modelParams` 当场变成屏幕上的事实）。
 * 所以本文件一次都不直接赋值会话 id，也**不现取门面**：绕过去的代价是「当前 id」与
 * 「门面」在应用里成了一个会漂的配对（重连换了连接之后，两者指向的可以不是同一条）。
 */
import { AgentNS, sumUsage } from "@ai-zen/agents-core";
import type { AutoMigrateTriggerInfo, HandoffMode } from "@ai-zen/agents-sdk";
import {
  MAX_TEXT_BYTES,
  SessionChannel,
  clientWorkspacePath,
  type ChannelNoticePayload,
  type MessageContent,
  type ModelLevel,
  type ModelParams,
  type PhaseInfo,
  type SessionQuestionEvent,
  type SessionStreamState,
  type ServerConnection,
  type WorkspaceFileEntry,
} from "./server-client/index.js";
import type { ClipboardImage } from "./clipboard.js";
import { t } from "./i18n/index.js";
import { buildUserContent } from "./user-content.js";
import type {
  ChatSessionLike,
  ChatSessionNotifier,
  ChatSessionOptions,
  SubAgentView,
} from "./session/types.js";
import { noticeText } from "./session-notice.js";
import { ackNotices, flushPendingNotices } from "./pending-notices.js";
import { stripCwdNote } from "./text.js";
import { TokenRateMeter, type RateSample } from "./session-rate.js";

/**
 * 开一段会话的输入：**就是会话契约那一份**去掉已经单独递进来的那样（连接）。
 *
 * 不另立一个平行类型：多一份"这里也有 agentId / sessionId / resume"的定义，就会多一处漂 ——
 * 而它们本来就是同一组意图。
 */
export type OpenRemoteSessionInput = Omit<ChatSessionOptions, "connection">;

export class RemoteChatSession implements ChatSessionLike {
  private readonly connection: ServerConnection;
  private readonly notifier: ChatSessionNotifier;
  /**
   * 自动迁移时「问用户用哪种方式交接」的回调（缺省 = 没人能问）。
   *
   * 与 `ChatSessionOptions.requestMode` 是**同一个**对象：TUI 传的就是那个与手动 `/migrate`、
   * `/handoff` 共用的三选一选择器，所以自动这条路径上没有第二套文案。
   */
  private readonly requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
  private readonly rate = new TokenRateMeter();

  /** 这一段的 I/O（订阅 / 请求 / 重连）：`/new` 会整条换掉，所以不是 readonly */
  private channel: SessionChannel;
  /** 换 channel 时要解掉的上一条状态订阅 */
  private offStream: (() => void) | null = null;
  /** 在等的那一轮（`waitForTurn()` 靠它落地）；只在「受理了一轮」到「它结束」之间非空 */
  private pendingTurnId: number | null = null;
  /** 已经报过的那条失败（`state.failure` 会一直躺在状态里，同一条只进一次通知栏） */
  private reportedFailure: SessionStreamState["failure"] | null = null;
  /** 速率表正在计的这一轮（收尾时定格一次，别每帧都算） */
  private rateRunning = false;
  /**
   * 速率采样游标：上一帧读到的那条消息（下标）与它当时的正文/推理长度。
   *
   * 速率只要「这一帧新增了多少字」，而这个事实就在正在拼的那条消息身上 —— 不另开一条
   * 增量通道，也不存第二份文本，只记两个长度做差。
   */
  private rateCursor = { index: -1, text: 0, reasoning: 0 };
  /** 这一轮开始时整段会话的用量基线（收尾时用差值得到本轮真实产出 token） */
  private rateBaseline = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  /** 已经显式 `close()` 过：不重复发那一帧 */
  private closed = false;
  /** 已经 `dispose()`：此后不再往界面上推任何东西 */
  private disposed = false;
  /** 「连接换了一条」的订阅（重连之后要重新补看一次通知槽位） */
  private offOpen: (() => void) | null = null;

  private constructor(
    connection: ServerConnection,
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
  ) {
    this.connection = connection;
    this.notifier = notifier;
    this.requestMode = input.requestMode;
    this.channel = this.newChannel();
    this.useChannel(this.channel);
    // 建好 / 重建一条连接之后各补看一次：通知是**有状态的槽位**（不是发一次就没的广播），
    // 「这条连接建立之前登记过什么」只能问服务端要（见 `flushPendingNotices`）
    this.offOpen = connection.onOpen(() => void this.flushNotices());
  }

  /**
   * 借一条现成的连接开（或续接）一段会话。
   *
   * 连接的生命周期**归调用方**（TUI：`tui/index.tsx` 那个模块级实例；stdio：这个入口自己造
   * 的那一个），本类既不建也不关。三处顺序在包里的 `channel.open()`：先订阅再 `attach`
   * （否则漏掉开头的 `phase`）、`events.watch` 先于 `attach`、最后拉一次快照。
   */
  static async open(
    connection: ServerConnection,
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
  ): Promise<RemoteChatSession> {
    const session = new RemoteChatSession(connection, input, notifier);
    try {
      /**
       * 客户端 cwd 只在**本地**服务端时才递上去（判据在包里的 `local-host.ts`）。
       *
       * 递出去的是**意图**（「我想在这个目录开会话」），服务端规范化之后把答案写进
       * `channel.path` —— `/new` 复用工作区时读的是那个答案，所以这里不必再另记一份
       * 「当初说了什么」。
       */
      const client = await connection.client();
      const path = input.path ?? clientWorkspacePath(client.address.host);
      await session.channel.open({
        ...(path !== undefined ? { path } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.resume !== undefined ? { resume: input.resume } : {}),
        ...(input.persist !== undefined ? { persist: input.persist } : {}),
      });
      /**
       * 会话开好了再补看一次：上面那条 `onOpen` 触发时 `currentId` 还是空的（会话还没开），
       * 只补了全局那一半 —— 会话内的那些要等快照能取才看得到。
       */
      await session.flushNotices();
    } catch (error) {
      // 半开的那条 channel 也要摘干净（它的 `onClose` 订阅会跟着实例一起活）；
      // 顺便把构造时挂上的「连接换了」那条订阅也摘掉 —— 连接是共享的，留着就是一个
      // 指向已废弃实例的监听者，每次重连都白跑一次。
      session.dispose();
      await session.channel.close().catch(() => {});
      throw error;
    }
    return session;
  }

  /**
   * 造一条新的 channel（同一连接、同一套策略）。
   *
   * 三个回调各答一件应用才知道的事：有没有人能回答服务端的提问、机器码怎么变成句子
   * （`forwardNotice`：上屏之后当场用事件里的 id 确认掉）、屏幕该不该重画。
   */
  private newChannel(): SessionChannel {
    return new SessionChannel({
      connection: this.connection,
      policy: {
        answerQuestion: (event) => this.answerQuestion(event),
        onNotice: (payload) => this.forwardNotice(payload),
        onChange: (immediate) => this.notifyChange(immediate),
      },
    });
  }

  /** 换用一条 channel：解掉旧订阅、挂上新的（`/new` 的唯一换法） */
  private useChannel(channel: SessionChannel): void {
    this.channel = channel;
    this.offStream?.();
    this.offStream = channel.stream.onChange((state) => this.onStreamState(state));
  }

  /**
   * 状态机每次变更时补的两件事。
   *
   * 顺序上它**先于**那次「该重画了」：包里 `finishTurn()` 是先 `settle` 再 `failTurn` 再
   * `notify`，所以失败在这里报出去时，屏幕还没被要求重画 —— 用户看到错误与看到结果同一帧。
   */
  private onStreamState(state: SessionStreamState): void {
    if (this.disposed) return;
    if (state.failure && state.failure !== this.reportedFailure) {
      this.reportedFailure = state.failure;
      this.notifier.onNotice(state.failure.message, "error");
    }
    this.sampleRate(state);
    // 这一轮结束了：速率定格（`live` → 本轮平均），与包里 `finishTurn` 落定同一时机
    if (this.rateRunning && state.status !== "streaming") {
      this.rateRunning = false;
      // 真实产出 token：本轮新增消息的用量之和（含子 Agent 委派），由 core 的 `sumUsage` 给
      const used = sumUsage(state.messages);
      this.rate.setExact(used.completion_tokens - this.rateBaseline.completion_tokens);
      this.rate.finish();
    }
  }

  /**
   * 生成中采样一次速率。
   *
   * 数据源就是**正在拼的那条消息**（本轮最后一条 assistant）：它的正文与推理就地增长，
   * 这一帧比上一帧多出来的那一段就是要计的字数。为什么不逐片看原始 chunk：那要求这一层
   * 认识 `choices[0].delta` 的形状，于是折 chunk 的规则在这里出现了第二份 —— 而屏幕上
   * 的字本来就来自这条消息，读它不需要任何转换。
   */
  private sampleRate(state: SessionStreamState): void {
    if (!this.rateRunning) return;
    const index = state.messages.length - 1;
    if (index < 0) return;
    const message = state.messages[index]!;
    if (message.role !== AgentNS.Role.Assistant) return;

    const text = typeof message.content === "string" ? message.content : "";
    const reasoning = message.reasoning_content ?? "";
    // 换了一条消息（工具轮次之间 / 收尾对齐后）：游标从头算
    if (this.rateCursor.index !== index) this.rateCursor = { index, text: 0, reasoning: 0 };
    // 变短只可能是快照对齐把内容换成了服务端那份（更短的那份不是新增），不计、只跟随
    const fromText = text.length > this.rateCursor.text ? this.rateCursor.text : text.length;
    const fromReasoning =
      reasoning.length > this.rateCursor.reasoning ? this.rateCursor.reasoning : reasoning.length;
    const added = text.slice(fromText) + reasoning.slice(fromReasoning);
    if (added) this.rate.addDelta(added);
    this.rateCursor = { index, text: text.length, reasoning: reasoning.length };
  }

  // ==================== 对外面（ChatSessionLike） ====================

  get agentId(): string {
    return this.channel.agentId;
  }
  get modelId(): string {
    return this.channel.stream.state.modelId;
  }
  get modelLevel(): ModelLevel {
    return this.channel.stream.state.modelLevel;
  }
  get currentId(): string {
    return this.channel.stream.state.sessionId;
  }
  get messages(): AgentNS.Message[] {
    return this.channel.stream.state.messages;
  }
  /**
   * 本轮出现过的子 Agent。屏幕每帧现取，所以直接给状态里那份 —— 状态每次变更都是**新对象**
   * （`SessionStream.commit` 的约定），React 那边照样看得出变化。
   */
  get subAgents(): readonly SubAgentView[] {
    return this.channel.stream.state.subAgents;
  }
  get lastUsage(): AgentNS.Usage | undefined {
    return this.channel.stream.state.lastUsage;
  }
  get totalUsage(): AgentNS.Usage {
    return this.channel.stream.state.totalUsage;
  }
  get phase(): PhaseInfo | null {
    return this.channel.stream.state.phase;
  }
  get rateSample(): RateSample {
    return this.rate.snapshot();
  }
  /** 发一轮（**受理即回**：拿到 `turnId` 就返回）；等它结束用 {@link waitForTurn} */
  async send(input: string, images: readonly ClipboardImage[] = []): Promise<void> {
    try {
      const content = await this.buildContent(input, images);
      if (content === null) return; // 图片全被降级/过滤，且已给过说明
      this.rate.begin();
      this.rateRunning = true;
      this.rateCursor = { index: -1, text: 0, reasoning: 0 };
      this.rateBaseline = sumUsage(this.messages);
      this.pendingTurnId = await this.channel.send(content);
    } catch (error: any) {
      this.rateRunning = false;
      this.rate.finish();
      // `turn-busy` / `handoff-in-flight` / 连接已断：那是「这轮没发出去」，包成「本轮失败」
      // 只会让界面以为它跑过。也不能抛 —— 调用方那些 await 周围没有 catch，未处理 rejection
      // 会直接杀掉进程。
      this.notifier.onNotice(error?.message ?? String(error), "error");
    }
  }

  /**
   * 等**最近发出去的那一轮**结束。落定判据在包里（`session-turn-end` 到了，或重连后发现服务端已
   * 空闲 —— 两条走同一条收尾路径），所以这里只管等。
   *
   * 连不回来时包会 reject（那一轮不可能再结束了，而界面必须能恢复输入）。失败原因**通常
   * 已经由 `state.failure` 报过**（包在 reject 前先 `failTurn`），所以只在状态里没有这条时
   * 补报 —— 同一件事说两遍会让通知栏看起来像出了两个错。
   */
  async waitForTurn(): Promise<void> {
    const turnId = this.pendingTurnId;
    if (turnId == null) return;
    const channel = this.channel;
    try {
      await channel.waitForTurn(turnId);
    } catch (error: any) {
      const text = error?.message ?? String(error);
      if (channel.stream.state.failure?.message !== text) {
        this.notifier.onNotice(text, "error");
      }
    } finally {
      if (this.pendingTurnId === turnId) this.pendingTurnId = null;
    }
  }

  abort(): void {
    // 取消是「请求服务端停」：`session.cancel` 掐掉本轮与进行中的交接，随后 `session-turn-end` 到达
    void this.channel.abort();
  }

  /**
   * `/new`：先归档当前对话（有内容才存），再开一段新的，**最后**关掉旧的（三步顺序见文件头）。
   *
   * 为什么换一条新的 channel 而不是在同一条上再 `open()`：一段会话的 id 只在它自己那条通道
   * 里成立；换段就换通道 —— 这样旧的那段在关掉之前完整可读，新的一段从零开始（与「上一段
   * 跑到第几轮」有关的计数不该跟着走）。
   *
   * ## 新会话落在哪个工作区（包里给的是答案，不是意图）
   *
   * 用 `channel.path`：它是 `open()` 之后服务端 `workspace.resolve` 回来的**规范化路径**，
   * 也就是「这段会话真正跑在哪个目录」。应用自己记的「当初请求的那个 path」只是**意图**：
   * 相对路径、带 `..`、末尾多一条斜杠，甚至两机部署时那个路径在服务端压根不存在（客户端
   * 与服务端不是同一台机器）。有答案就不该再抱着意图。
   */
  async reset(): Promise<string | null> {
    const previous = this.channel;
    /**
     * 先取工作区路径再动任何东西：它在 `open()` 里由 `workspace.resolve` 写定，所以正常情况
     * 一定有值。拿不到只有一种解释 —— 这条 channel 没走完 `open()`（本类的不变量被破了）。
     *
     * 这时**明确拒绝**，不兜底：客户端自己算一份（自己进程的 cwd 之类）就是第二份会漂的答案，
     * 在远端部署时会静默落进服务端的另一个工作区。`/new` 失败好过悄悄换工作区。
     * 位置放在 `save()` 之前：拒绝时不留下任何副作用，当前这段会话原样可用。
     */
    const path = previous.path;
    if (path === undefined) {
      throw new Error("reset: 服务端没有给出工作区路径（这段会话没有走完 open()）");
    }
    const hasContent = previous.stream.state.messages.some(
      (message) => message.role === AgentNS.Role.User,
    );
    const archivedId = hasContent ? await previous.save() : null;

    const next = this.newChannel();
    try {
      await next.open({
        path,
        // 同一个 Agent：`/new` 换的是会话，不是身份
        ...(previous.agentId ? { agentId: previous.agentId } : {}),
      });
    } catch (error) {
      // 新的没开出来：旧的原样留着（`this.channel` 还没换）
      await next.close().catch(() => {});
      throw error;
    }

    this.useChannel(next);
    this.rate.reset();
    this.pendingTurnId = null;
    await previous.close();
    this.notifyChange(true);
    return archivedId;
  }

  async reload(): Promise<void> {
    await this.channel.reload();
    this.notifyChange(true);
  }

  /** 换 Agent：服务端按新定义重建、保留消息、更新会话的 `agentId`（`agentId` 也归 channel 记） */
  async setAgent(agentId: string): Promise<void> {
    await this.channel.setAgent(agentId);
    this.notifyChange(true);
  }

  /**
   * 换**这一段会话**的模型（`session.model.set`）：写这一段存档的 `modelId` 并重建 Agent。
   *
   * 走 `channel.setModel`（与 `saveAs` / `rollback` 同级），**不**自己现取 `RemoteSessions`
   * 门面：门面是「按 id 说话」的无状态薄封装，它不知道「当前这一段是哪个 id」，而应用里那份
   * 「当前 id」会漂（重连换了连接、`saveAs` / 自动迁移换了 id）。绕过去就得在两个会变的
   * 东西之间维持一个配对。
   *
   * 屏幕对齐**只靠这一句**：包里拿到快照就 `applySnapshot`（新的 `modelId` / `apiModel` /
   * `modelParams` 立刻是屏幕上的事实），所以这里**不要**再补一次 `reload()` —— 那是多一个
   * 往返、多一次「该重画了」，而屏幕上的东西一个字都不会多。`notifyChange` 只是把这次状态
   * 跃变告诉界面（包里的 `applySnapshot` 不替应用决定什么时候上屏）。
   */
  async setModel(modelId: string): Promise<void> {
    await this.channel.setModel(modelId);
    this.notifyChange(true);
  }

  /**
   * 改**这一段会话**的模型参数（`session.modelParams.set`）；理由同 {@link setModel}。
   *
   * `null` 是**合法值**，语义是「清掉这一层覆盖」（回到模型出厂参数）—— 包里按 `params: null`
   * 发出去，所以这里不能把它当成「调用方没给」而跳过。
   */
  async setModelParams(params: ModelParams | null): Promise<void> {
    await this.channel.setModelParams(params);
    this.notifyChange(true);
  }

  async handoff(mode?: HandoffMode): Promise<string> {
    const path = await this.channel.handoff(mode);
    this.notifyChange(true);
    return path;
  }

  async migrate(mode?: HandoffMode): Promise<string> {
    // 换 id 归 channel（`adopt`）：不跟着换，这一轮的 `session-turn-end` 会从新 id 上来，
    // 状态机还在旧 id 上等 —— 界面永久卡在「生成中」
    const path = await this.channel.migrate(mode);
    this.notifyChange(true);
    return path;
  }

  /** 撤回；服务端给原文，工作目录备注由客户端剥（那是客户端自己拼进去的） */
  async rollbackTo(index: number): Promise<string> {
    return stripCwdNote(await this.channel.rollback(index));
  }

  /**
   * 落盘当前会话（缺省同时把它设成本工作区的「上一轮会话」）。
   *
   * `setAsLast: false` 是**一次性调用的归档**（`ai "…" --save`）：stdio 要写档但不挪续接
   * 指针 —— 否则连跑几条 `cat … | ai --save` 之后，下次 `ai` 会续接到最后一条管道结果上。
   * 选项原样透传给 channel：只有它知道「当前这一段是哪个 id」，而 `RemoteSessions` 是
   * 「按 id 说话」的无状态门面。
   *
   * 对外契约（`ChatSessionLike.save`）仍然是无参形态：缺省行为不变，选项只是「这一段会话」
   * 的附带能力，不往界面上扩散。
   */
  async save(options?: { setAsLast?: boolean }): Promise<string> {
    return await this.channel.save(options);
  }

  async saveAs(id: string): Promise<string> {
    return await this.channel.saveAs(id);
  }

  /** 本工作区可续接的会话（`/load` 与 `exists` 用）：服务端回合并清单，这里只留 id */
  async listSaved(): Promise<Array<{ id: string }>> {
    return (await this.channel.listSaved()).map((entry) => ({ id: entry.sessionId }));
  }

  async exists(id: string): Promise<boolean> {
    return await this.channel.exists(id);
  }

  /**
   * 本工作区的文件清单（`@` 补全用）—— 问服务端要：清单必须来自**会话真正跑在哪个目录**，
   * 扫客户端自己的 cwd 在两机部署时列的是另一台机器的文件。
   */
  async listWorkspaceFiles(): Promise<WorkspaceFileEntry[]> {
    return await this.channel.listWorkspaceFiles();
  }

  /** 把这段会话交还给服务端（**当场回收**）；重复调不再发帧（`session.close` 本身是幂等的） */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.channel.close();
  }

  /**
   * 卸载这一段（`chat.tsx` 的 effect cleanup、`stdio` 的收尾、Ctrl+C 的共同出口）。
   *
   * 先置 `disposed` 再关：之后不会再重连（channel 自己也会摘掉「断了」的订阅），也不再往
   * 界面上推任何东西。`session.close` **不 await** —— 理由与代价见文件头「退出」那一条。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offStream?.();
    this.offStream = null;
    // 连接是共享的（一条进程一条），这条「补看」订阅必须跟着本实例一起摘掉
    this.offOpen?.();
    this.offOpen = null;
    void this.close();
  }

  // ==================== 内部 ====================

  /**
   * 拼出这一条要发的内容：纯文本，或「文本 + 内容块」。
   *
   * 图片**字节**走 `content.upload`（同一条连接上的第二条 WS 消息，前 4 字节是请求 id），
   * 但换回来的**那一块**仍然随 `session.send` 的**文本**消息走：端点不支持 Files API 时
   * 服务端给的是 base64 内联的 data URL，所以这条照样会被八张图撑爆。
   *
   * 唯一的远程约束就是文本消息的大小上限（`MAX_TEXT_BYTES`，8 MiB）：超限的文本消息会让
   * 服务端判协议错误、**断掉整条连接**。所以先量一下：装不下就发文字，并明确告知图片没带上
   * （不静默丢消息，也不冒险把连接弄断）。
   *
   * @returns 要发的内容；`null` = 什么都不发（已给过说明）
   */
  private async buildContent(
    input: string,
    images: readonly ClipboardImage[],
  ): Promise<MessageContent | null> {
    if (images.length === 0) return input;

    const { content, warnings } = await buildUserContent({
      text: input,
      images,
      // 转换在服务端：端点 / 视觉能力按**这段会话**的实发模型名解析，客户端只递字节
      upload: (image) => this.channel.uploadContent(image),
    });
    for (const warning of warnings) this.notifier.onNotice(warning, "info");

    if (typeof content === "string") return content; // 一张图都没转成功：文字照发

    const bytes = Buffer.byteLength(JSON.stringify(content), "utf-8");
    if (bytes > MAX_TEXT_BYTES) {
      this.notifier.onNotice(
        t("notice.remoteImagesTooLarge", { size: (bytes / 1024 / 1024).toFixed(1) }),
        "error",
      );
      return input;
    }
    return content;
  }

  /**
   * 服务端提问 → 用户（或兜底）。
   *
   * 包里已经把两条降级写好了：**没注入**（无头 / 测试）与**回调抛错**都回服务端给的
   * `fallback`。这里只补一件包里做不到的事：把协议里的「问题」翻译成选择器要的两个数。
   * 分派留在应用侧是因为「哪一类问题弹哪个选择器」是界面决定；不认识的 kind 一律回
   * `fallback` —— 沉默的代价不是「等一会儿」，服务端要等满超时才降级，那一轮就卡在迁移里。
   */
  private async answerQuestion(event: SessionQuestionEvent): Promise<string | null> {
    if (event.kind !== "handoff-mode" || !this.requestMode) return event.fallback;
    return await this.requestMode({
      promptTokens: Number(event.params.promptTokens ?? 0),
      handoffTokens: Number(event.params.handoffTokens ?? 0),
    });
  }

  /**
   * 把服务端此刻还挂着的通知补上屏（启动 / 重连之后各一次）。
   *
   * 两类都走 {@link showNotice} —— 也就是**既有的**通知栏渲染路径（`session-notice` 事件用
   * 的就是它），补看这条路上没有第二套 UI。三步（查 / 显示 / 确认）的顺序、以及「两个入口
   * 一份 id、**一次**确认」都写在 `pending-notices.ts` 的文件头。
   *
   * 失败一律吞掉：这是「把错过的补上」的尽力而为，连不上 / 服务端没注册 `notice.*` /
   * 会话刚被别的客户端关掉，都不该让开会话或重连失败。
   */
  private async flushNotices(): Promise<void> {
    if (this.disposed) return;
    try {
      const client = await this.connection.client();
      await flushPendingNotices({
        client,
        // 还没开会话时只有全局那一半（`/new` 换 id 之后读的是新 id，见 `currentId`）
        sessionId: this.currentId || undefined,
        // 只上屏：确认由 `flushPendingNotices` 收齐 id 之后**一次**发出去（见它的文件头）
        onNotice: (payload) => this.showNotice(payload),
      });
    } catch {
      // 见方法头：补看是尽力而为，不升级成通知（否则「没连上」会先说一遍、再说一遍）
    }
  }

  /**
   * 实时推过来的一条通知（`session-notice` / `server-notice`）：**上屏之后当场确认**。
   *
   * 事件里的 `id` 与槽位是**同一个值**，所以确认不必回头再查一遍列表 —— 这个 id 本身就是
   * `notice.ack { ids }` 的凭据。少了这一步，同一条通知会一直躺在服务端，下次连上来时被
   * 补看再念一遍（上一版为此在本地记了一份「哪几条念过」的表：那份表既确认不掉槽位，又得
   * 与服务端保持同步 —— 拿到 id 之后它就是多余的了）。
   */
  private forwardNotice(payload: ChannelNoticePayload): void {
    this.showNotice(payload);
    void this.ackNotice(payload.id);
  }

  /** 一条通知上屏：服务端的机器码 → CLI 词典里的句子（服务端一句自然语言都不产） */
  private showNotice(payload: ChannelNoticePayload): void {
    if (this.disposed) return;
    this.notifier.onNotice(noticeText(payload.code, payload.params), toneOf(payload.level));
  }

  /**
   * 确认一条（`notice.ack { ids: [id] }`），失败一律吞掉。
   *
   * 不 await：本方法由事件回调同步调用（`policy.onNotice` 返回 `void`），把这条连接上的
   * 事件处理卡在一个往返上毫无好处；而确认失败也不算错 —— 那条通知只会在下次补看时再上
   * 一次屏，比打断正在收事件的会话好。
   */
  private async ackNotice(id: string): Promise<void> {
    try {
      const client = await this.connection.client();
      await ackNotices(client, [id]);
    } catch {
      // 见方法头：确认是尽力而为
    }
  }

  /** 「屏幕该重画了」；卸载之后一律不再推（那一代的 `notifier` 已经没人听了） */
  private notifyChange(immediate: boolean): void {
    if (this.disposed) return;
    this.notifier.onChange(immediate);
  }
}

/** 通知语气：界面只分两档（普通 / 红），`warn` 归到红那一档 */
function toneOf(level: "info" | "warn" | "error"): "info" | "error" {
  return level === "info" ? "info" : "error";
}

/**
 * `ChatDeps.createSession` 的实现：借那**一条**连接开一段会话。
 *
 * 有明确的会话 id 时**不递 agentId**：那段会话是谁跑的，存档里写着（服务端 `attach` 取
 * `record.agentId`）。宿主手上那个是首次挂载时的快照，`/agent` 换过就旧了 —— 递上去只会
 * 把存档里的真值顶掉。
 */
export async function createRemoteChatSession(
  options: ChatSessionOptions,
  notifier: ChatSessionNotifier,
): Promise<ChatSessionLike> {
  return await RemoteChatSession.open(
    options.connection,
    {
      agentId: options.sessionId ? undefined : options.agentId,
      sessionId: options.sessionId,
      resume: options.resume,
      // 契约里有的字段就照递：少写一个，调用方传了也静默不生效 —— 而「静默不生效」是这个
      // 仓最讨厌的那类错（今天只有 stdio 传 `persist`，它直接调 `open`，所以漏了也看不出来；
      // 下一个从屏幕层传的人就会踩）
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.persist !== undefined ? { persist: options.persist } : {}),
      requestMode: options.requestMode,
    },
    notifier,
  );
}
