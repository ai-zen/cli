/**
 * 会话层 —— 一段会话的客户端实现（**纯客户端**：Agent 在服务端跑）。
 *
 * 它只做三件事：**连接**（借一条进程级连接，不建也不关）、**命令族**（`ChatSessionLike` 那
 * 21 个成员，大多是一行转发）、**把状态交给界面**（`SessionStream.state` 就是那些只读字段的
 * 来源）。状态机与重连**不在这里**：包里的 `SessionStream`（纯）与 `SessionChannel`（脏）
 * 是唯一实现，三个前端共用 —— 在这里再写一遍的代价不是行数而是漂移。
 *
 * ## 三件包里不管、必须留在这里的事
 *
 * 1. **失败要能被用户看见**：包里只给 `state.failure = {code, message}`（不产句子、也不认识
 *    通知栏），这里把它映回 `notifier.onNotice` —— 渲染层零改动，失败不会变成静默。
 * 2. **带图提交要用 `apiModel`**（实发名）：`buildUserContent` 靠它反查端点与视觉能力，读成
 *    `modelId`（配置里的身份）在有别名时会把本来能带的图静默降级成纯文本。
 * 3. **等一轮结束的原语**（`waitForTurn`）：包里的 `send()` 立刻返回 `turnId`，而界面用
 *    `busy` 包住输入禁用，靠的是「这一轮真的结束了」（D7：别删掉它让界面自己等）。
 *
 * ## `session.close` 的三个时机（D5 × D8，正确性）
 *
 * 保活声明删掉之后「持有者」是唯一的活命判据，而 D8 让连接**不再随界面卸载消失** ——
 *「切走一段会话」于是对服务端完全不可见。三条铁律：
 *   · **`reset()`（`/new`）**：先归档 → 再开新的 → **最后**关旧的（先关再存是拿不存在的 id
 *     写盘；先关旧的再开新的，`open` 一失败两段都没了）；
 *   · **重挂载（`/load`、`/clear`、`/back`）**：旧会话由**新实例接管前的 `dispose()`** 关 ——
 *     不发这一帧，内存峰值随 `/load` 次数线性增长到宽限期；
 *   · **退出**：尽力而为（不 await）。连接随后就关，那帧可能落不了地 —— 既有取舍：把每个
 *     Ctrl+C 变成一个网络往返更糟，而崩溃能发出的帧本来就是零。
 *
 * 换 id 的四个动作（`saveAs` / `migrate` / `reload` / `setAgent`）一律走 channel：包里那几个
 * 方法自己会 `applyIdChanged` + 重取快照，自己改 id 就是 P4a 之前那个错（在旧 id 上等一个
 * 永远不来的 `turn.end`）。所以本文件一次都不直接赋值会话 id。
 */
import { AgentNS } from "@ai-zen/agents-core";
import type { AutoMigrateTriggerInfo, HandoffMode } from "@ai-zen/agents-sdk";
import {
  MAX_FRAME_BYTES,
  RemoteSessions,
  SessionChannel,
  clientWorkspacePath,
  createConfigPort,
  type ChannelNoticePayload,
  type ConfigPort,
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
import { stripCwdNote } from "./text.js";
import { TokenRateMeter, type RateSample } from "./session-rate.js";

/** 会话层的注入点 —— **只剩配置面**（连接归组装根、重连归包里的 `SessionChannel`） */
export interface RemoteChatSessionDeps {
  /**
   * 配置面（拼图片内容块要读**服务端**的端点 / 视觉能力）。
   *
   * 缺省由传进来的那条 `connection` 派生一个（同一条连接上的第二个端口是免费的）；
   * 注入只为了测试（不碰真配置根）。
   */
  config?: ConfigPort;
}

/**
 * 开一段会话的输入：**就是会话契约那一份**去掉已经单独递进来的两样（连接 / 配置面）。
 *
 * 不另立一个平行类型：多一份"这里也有 agentId / sessionId / resume"的定义，就会多一处漂 ——
 * 而它们本来就是同一组意图。
 */
export type OpenRemoteSessionInput = Omit<ChatSessionOptions, "connection" | "config">;

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
  /** 配置面：拼图片内容块时按**服务端**的端点能力判断（客户端本机那份是另一份事实） */
  private readonly configPort: ConfigPort;
  private readonly rate = new TokenRateMeter();

  /** 这一段的 I/O（订阅 / 请求 / 重连）：`/new` 会整条换掉，所以不是 readonly */
  private channel: SessionChannel;
  /** 换 channel 时要解掉的上一条状态订阅 */
  private offStream: (() => void) | null = null;
  /**
   * 客户端**希望**会话跑在哪个目录（`open` 的入参，不是服务端规范化的结果）。
   *
   * 只为一件事存在：`/new` 要在**同一个工作区**里开新会话。包里的规范化路径不对外
   * （`SessionChannel` 没有 `path` 出口），而把客户端 cwd 再算一次就是第二份会漂的答案 ——
   * 所以记的是「当初说了什么」。远端（不说）时它是 `undefined`，`/new` 照旧不说。
   */
  private requestedPath: string | undefined;
  /** 在等的那一轮（`waitForTurn()` 靠它落地）；只在「受理了一轮」到「它结束」之间非空 */
  private pendingTurnId: number | null = null;
  /** 已经报过的那条失败（`state.failure` 会一直躺在状态里，同一条只进一次通知栏） */
  private reportedFailure: SessionStreamState["failure"] | null = null;
  /** 速率表正在计的这一轮（收尾时定格一次，别每帧都算） */
  private rateRunning = false;
  /** 已经显式 `close()` 过：不重复发那一帧 */
  private closed = false;
  /** 已经 `dispose()`：此后不再往界面上推任何东西 */
  private disposed = false;

  private constructor(
    connection: ServerConnection,
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
    deps: RemoteChatSessionDeps,
  ) {
    this.connection = connection;
    this.notifier = notifier;
    this.requestMode = input.requestMode;
    this.configPort = deps.config ?? createConfigPort(connection);
    this.channel = this.newChannel();
    this.useChannel(this.channel);
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
    deps: RemoteChatSessionDeps = {},
  ): Promise<RemoteChatSession> {
    const session = new RemoteChatSession(connection, input, notifier, deps);
    try {
      // 客户端 cwd 只在**本地**服务端时才递上去（判据在包里的 `local-host.ts`）
      const client = await connection.client();
      const path = input.path ?? clientWorkspacePath(client.address.host);
      session.requestedPath = path;
      await session.channel.open({
        ...(path !== undefined ? { path } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.resume !== undefined ? { resume: input.resume } : {}),
        ...(input.persist !== undefined ? { persist: input.persist } : {}),
      });
    } catch (error) {
      // 半开的那条 channel 也要摘干净（它的 `onClose` 订阅会跟着实例一起活）
      await session.channel.close().catch(() => {});
      throw error;
    }
    return session;
  }

  /**
   * 造一条新的 channel（同一连接、同一套策略）。
   *
   * 四个回调各答一件应用才知道的事：有没有人能回答服务端的提问、机器码怎么变成句子、
   * 屏幕该不该重画、原始增量怎么喂给速率表（速率是纯展示口径，不属于状态机）。
   */
  private newChannel(): SessionChannel {
    return new SessionChannel({
      connection: this.connection,
      policy: {
        answerQuestion: (event) => this.answerQuestion(event),
        onNotice: (payload) => this.forwardNotice(payload),
        onChange: (immediate) => this.notifyChange(immediate),
        onDelta: (event) => {
          // 子 Agent 的 token 也是真从网络来的，一起算；流末 chunk 带真实产物 token 数，
          // 用它校准（只靠字符估算会偏，中文尤其明显）
          this.rate.addDelta(event.text + event.reasoning);
          this.rate.addExact(event.usage?.completionTokens);
        },
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
    // 这一轮结束了：速率定格（`live` → 本轮平均），与旧实现 `finishTurn` 同一时机
    if (this.rateRunning && state.status !== "streaming") {
      this.rateRunning = false;
      this.rate.finish();
    }
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
   * 等**最近发出去的那一轮**结束。落定判据在包里（`turn.end` 到了，或重连后发现服务端已
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
    // 取消是「请求服务端停」：`session.cancel` 掐掉本轮与进行中的交接，随后 `turn.end` 到达
    void this.channel.abort();
  }

  /**
   * `/new`：先归档当前对话（有内容才存），再开一段新的，**最后**关掉旧的（三步顺序见文件头）。
   *
   * 为什么换一条新的 channel 而不是在同一条上再 `open()`：一段会话的 id 只在它自己那条通道
   * 里成立；换段就换通道 —— 这样旧的那段在关掉之前完整可读，新的一段从零开始（与「上一段
   * 跑到第几轮」有关的计数不该跟着走）。
   */
  async reset(): Promise<string | null> {
    const previous = this.channel;
    const hasContent = previous.stream.state.messages.some(
      (message) => message.role === AgentNS.Role.User,
    );
    const archivedId = hasContent ? await previous.save() : null;

    const next = this.newChannel();
    try {
      await next.open({
        ...(this.requestedPath !== undefined ? { path: this.requestedPath } : {}),
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
   * 换**这一段会话**的模型（`session.model.set`）；`modelParamsSet` 同理。
   *
   * 包里没有对应方法（`SessionChannel` 覆的是生命周期与换 id 的那几个动作），所以直接问
   * 门面 —— 参数拼装仍然只有 `RemoteSessions` 那一份，不是第二份实现。
   */
  async setModel(modelId: string): Promise<void> {
    await (await this.sessionFacade()).modelSet(this.currentId, modelId);
  }

  /** 改**这一段会话**的模型参数（`null` = 清掉这一层覆盖）；理由同上 */
  async setModelParams(params: ModelParams | null): Promise<void> {
    await (await this.sessionFacade()).modelParamsSet(this.currentId, params);
  }

  async handoff(mode?: HandoffMode): Promise<string> {
    const path = await this.channel.handoff(mode);
    this.notifyChange(true);
    return path;
  }

  async migrate(mode?: HandoffMode): Promise<string> {
    // 换 id 归 channel（`adopt`）：不跟着换，这一轮的 `turn.end` 会从新 id 上来，
    // 状态机还在旧 id 上等 —— 界面永久卡在「生成中」
    const path = await this.channel.migrate(mode);
    this.notifyChange(true);
    return path;
  }

  /** 撤回；服务端给原文，工作目录备注由客户端剥（那是客户端自己拼进去的） */
  async rollbackTo(index: number): Promise<string> {
    return stripCwdNote(await this.channel.rollback(index));
  }

  async save(): Promise<string> {
    return await this.channel.save();
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
    void this.close();
  }

  // ==================== 内部 ====================

  /** 当前连接上的门面（只为那两个「不换 id 的会话级模型动作」；每次现取，别缓存） */
  private async sessionFacade(): Promise<RemoteSessions> {
    return new RemoteSessions(await this.connection.client());
  }

  /**
   * 拼出这一条要发的内容：纯文本，或「文本 + 图片」内容块（与进程内模式同一段逻辑）。
   *
   * 唯一的远程约束是帧大小：图片是 base64 内联的，超限帧会让服务端判协议错误、**断掉整条
   * 连接**。所以先量一下：装不下就发文字，并明确告知图片没带上。
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
      config: await this.configPort.readConfig(),
      // **实发**模型名（不是配置里的身份）：起过别名时两者不同，读错了会把带图提交静默降级
      apiModelName: this.channel.stream.state.apiModel || undefined,
    });
    for (const warning of warnings) this.notifier.onNotice(warning, "info");

    if (typeof content === "string") return content; // 一张图都没转成功：文字照发

    const bytes = Buffer.byteLength(JSON.stringify(content), "utf-8");
    if (bytes > MAX_FRAME_BYTES) {
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

  /** 服务端的机器码 → CLI 词典里的句子（服务端一句自然语言都不产） */
  private forwardNotice(payload: ChannelNoticePayload): void {
    if (this.disposed) return;
    this.notifier.onNotice(noticeText(payload.code, payload.params), toneOf(payload.level));
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
      requestMode: options.requestMode,
    },
    notifier,
    { config: options.config },
  );
}
