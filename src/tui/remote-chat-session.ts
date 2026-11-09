/**
 * 远程对话会话 —— TUI 的「纯客户端」实现。
 *
 * 屏幕上的一切都从服务端来：消息走 `session.snapshot` 与事件，存档/交接/迁移走方法调用。
 * 本进程**不跑 Agent、不碰会话文件、不读 Skill** —— 它只需要一条到服务端的连接。
 *
 * ## 三处与服务端分工有关的细节
 *
 * 1. **`send()` 等到本轮结束才 resolve**。服务端的 `session.send` 是「立刻回 `turnId`、
 *    过程走事件」，而界面用 `await send()` 包着 busy 状态与输入禁用。所以这里把它等成
 *    语义上的一轮：拿到回执后挂起，直到同一 `turnId` 的 `turn.end` 到达。
 * 2. **正文靠事件拼、结束后用快照纠正**。增量（`message.delta`）拼出一个临时 assistant
 *    消息让屏幕能滚起来；`turn.end` 一到就重新要一份 `snapshot`，用服务端那份替换本地
 *    —— 客户端只做「暂时的不准确」，不做第二份真相。
 * 3. **换 id 的方法（`migrate` / `saveAs`）以返回值里的 `sessionId` 为准**。服务端在旧
 *    id 上收尾、再把活会话挪到新键；客户端拿到响应后立刻跟着换，之后的事件才过滤得上。
 *
 * ## cwd 归属服务端（本文件不再上送客户端自己的当前目录）
 *
 * 客户端只递 `workspaceId`，工作目录由服务端 `workspace.resolve` 给出：远程部署时
 * 服务端在一台机器上、TUI 在另一台上，客户端把自己进程的 cwd 送上去等于**让客户端替
 * 服务端决定会话跑在哪个目录**——而那个目录在服务端很可能根本不存在（于是要么开出一个
 * 空目录、要么直接失败）。所以：
 *
 *   · `openWith` 不带路径，服务端用它自己的工作目录解析出 `workspaceId` + **规范化后的**
 *     绝对路径；本类持有的 `this.path` 是那个返回值，不是构造参数里抄来的副本
 *     （`reset()` 再开新会话时还在同一个工作区里，靠的就是它）；
 *   · `@` 补全的清单（`listWorkspaceFiles`）同样问服务端（`workspace.files`）—— 清单
 *     必须来自会话真正跑在哪个目录，那是服务端的事实；
 *   · 续接（`resume`）问 `session.last`：哪一段是「上一轮」也只存在于服务端。
 *
 * ## 子 Agent 栏目（Agent 标签页）
 *
 * 栏目里的东西全**由服务端给**：`session.subAgent.started` 说「来了一个，序号是几、
 * id 是什么」，`message.delta` 带 `subAgentId` 时属于它，`session.subAgent.ended`
 * 收尾。客户端只做两件事：把增量拼到那个子 Agent 自己的临时消息上（让屏幕能滚），
 * 以及拉一次 `session.subAgent.snapshot` 把已有内容补齐 —— 合并规则见
 * {@link mergeSubAgentSnapshot}（那里也是唯一需要处理竞态的地方）。
 *
 * ## 现在还没有的两样（协议里就没有，不是 bug）
 *
 * 图片粘贴、按阈值自动迁移。前者在界面上是「说清楚」而不是静默丢弃：带图提交会
 * 明确提示本次只发了文字。
 */

import { AgentNS, sumUsage } from "@ai-zen/agents-core";
import type { HandoffMode } from "@ai-zen/agents-sdk";
import {
  MAX_FRAME_BYTES,
  SESSION_EVENTS,
  SESSION_METHODS,
  type MessageContent,
  type PhaseInfo,
  type ServerEvent,
  type SessionSnapshotResult,
} from "@ai-zen/agents-server";
import type { ClipboardImage } from "../clipboard.js";
import { AI_ZEN_DIR, readConfig } from "../config.js";
import { t } from "../i18n/index.js";
import { ensureServer } from "../server-client/ensure-server.js";
import { RemoteSessions } from "../server-client/sessions.js";
import type { ServerClient } from "../server-client/types.js";
import { buildUserContent } from "../user-content.js";
import { CLI_VERSION } from "../version.js";
import type {
  ChatSessionLike,
  ChatSessionNotifier,
  ChatSessionOptions,
  SubAgentView,
} from "./chat-session.js";
import type { PathEntry } from "./mention.js";
import { noticeText } from "./notice-text.js";
import { stripCwdNote } from "./text.js";
import { TokenRateMeter, type RateSample } from "./token-rate.js";

/** 客户端的身份：只进握手首帧与服务端日志，不参与鉴权 */
export const REMOTE_CLIENT_INFO = { name: "@ai-zen/cli", version: CLI_VERSION };

/**
 * 子 Agent 的本地拼接状态（一个子 Agent 一条）。
 *
 * 与主 Agent 的 `streaming` 同形状、同策略：增量先拼在一条临时消息上让屏幕能滚起来，
 * 权威内容以服务端快照为准。差别只在「一个子 Agent 从 `started` 到 `turn.end` 只拼一条」：
 * 这期间它可能有多轮 assistant（工具调用），拆成多条会让输出断成几段，而主 Agent 那边
 * 也是这么拼的 —— 一轮收尾时整份清空，不存在「拼错了要修」的问题。
 */
export interface SubAgentStream {
  /** 临时消息：同时也是 `SubAgentView.messages` 里的那一条（增量就地改它，屏幕才跟得上） */
  message: AgentNS.Message;
  /** 累计正文（= `message.content`，单独存一份，省得每次从联合类型里往外捞） */
  text: string;
  /** 累计推理内容（推理模型才有） */
  reasoning: string;
}

/**
 * 把服务端快照与本地已拼出的增量合并成一份消息列表 —— 「快照与增量怎么合并」的唯一实现。
 *
 * ## 为什么不能直接拿快照替换
 *
 * `session.subAgent.started` 一到就去要快照，但这个往返可能比第一批 `message.delta` 还慢
 * （子任务越小越明显）。`view.messages = snapshot.messages` 会把这几片已经上屏的正文换回
 * 快照那一刻的旧内容 —— 屏幕上是「答案忽然短了一截」，而且本轮不会再补上。
 * 反过来，快照里的东西也不能丢：工具调用、已完成的 assistant 消息只有服务端有。
 *
 * ## 为什么「本地更全」是安全的假设
 *
 * 同一条连接上的帧是有序的：快照是服务端处理请求那一刻的**副本**，之后到达的增量只存在
 * 于本地。所以合并方向永远是「取信息多的那份」，不必担心本地这份更旧。
 *
 * ## 规则
 *
 * 1. 本地没有增量 → 直接用快照（大多数情况：`started` 时子 Agent 还没吐字）。
 * 2. 快照末尾那条 assistant 的正文是本地累计正文的**前缀** → 它们是同一段（core 在流式
 *    开始前就把占位消息追加进了 `messages`，之后就地改它）。取本地的（更全），并让后续
 *    增量继续拼在这一条上 —— 否则同一段会被拆成两条消息在屏幕上闪。
 * 3. 否则快照末尾不是「正在拼的那一段」：用「服务端已知 assistant 正文按序拼接」对齐，只接
 *    上多出来的尾巴 ——
 *      · 本地以它开头：那截尾巴是快照序列化之后才到的新一段，接在后面；
 *      · 本地是它的结尾：这一段服务端已经收下了（内容块形态的 assistant 落在这一支），丢掉本地；
 *      · 都对不上：宁可重复也不吞字 —— 重复看得见，吞了是静默丢内容。
 *
 * 导出只为单测：这条竞态靠真 socket 复现不了（要凑时序），而它恰恰是最容易写错的地方。
 */
export function mergeSubAgentSnapshot(
  snapshot: readonly AgentNS.Message[],
  stream: SubAgentStream | null,
): { messages: AgentNS.Message[]; stream: SubAgentStream | null } {
  const base = [...snapshot];
  if (!stream || (!stream.text && !stream.reasoning)) return { messages: base, stream };

  const tail = base.at(-1);
  const tailText =
    tail && tail.role === AgentNS.Role.Assistant && typeof tail.content === "string"
      ? tail.content
      : null;

  // 规则 2：同一段，本地更全
  if (tailText !== null && stream.text.startsWith(tailText)) {
    const merged = withAssistantText(tail!, stream.text, stream.reasoning);
    base[base.length - 1] = merged;
    return { messages: base, stream: { ...stream, message: merged } };
  }

  // 规则 3：对齐「服务端已知的 assistant 正文」，只接上多出来的那截
  const confirmed = base
    .filter(
      (message) =>
        message.role === AgentNS.Role.Assistant && typeof message.content === "string",
    )
    .map((message) => message.content as string)
    .join("");
  if (confirmed.endsWith(stream.text)) return { messages: base, stream: null };

  const rest = stream.text.startsWith(confirmed) ? stream.text.slice(confirmed.length) : stream.text;
  const appended = withAssistantText(
    { role: AgentNS.Role.Assistant, content: "" } as AgentNS.Message,
    rest,
    stream.reasoning,
  );
  return { messages: [...base, appended], stream: { ...stream, message: appended, text: rest } };
}

/** 写一条 assistant 消息的正文/推理，其余字段（`tool_calls` 等）原样保留 */
function withAssistantText(
  message: AgentNS.Message,
  text: string,
  reasoning: string,
): AgentNS.Message {
  const next = { ...message, role: AgentNS.Role.Assistant, content: text } as AgentNS.Message;
  if (reasoning) next.reasoning_content = reasoning;
  return next;
}

/** 开一段远程会话需要的最小输入 */
export interface OpenRemoteSessionInput {
  /**
   * 工作目录。**建议不要给**：不给就用服务端自己的工作目录（cwd 归属服务端）。
   *
   * 给了也只是「我希望是这里」，路径仍由服务端规范化 —— 客户端手上那份是**它自己**
   * 那边的路径，两机部署时服务端不一定有那个目录。留这个口子只因为同一台机器上
   * 「换个目录再开一段」确实存在（测试也用得上）。
   */
  path?: string;
  agentId?: string;
  /** 续接已有存档：只给 id，消息由服务端从存档装 */
  sessionId?: string;
  /**
   * 续接本工作区的「上一轮会话」（有就接着，没有就开新的）。
   *
   * 与 `ChatSessionOptions.resume` 同一个口径：这是**意图**，不是数据。哪一段是
   * 「上一轮」只存在于服务端（指针 + 存档），客户端自己去读就是又一份会漂的真相。
   * 给了明确的 `sessionId` 时以它为准（用户已经指名道姓了）。
   */
  resume?: boolean;
}

export class RemoteChatSession implements ChatSessionLike {
  readonly agentId: string;
  /**
   * 工作区路径 —— **服务端规范化后**的那个（`workspace.resolve` 的返回值）。
   *
   * `/new` 要在同一个工作区里开新会话：路径若取自客户端进程的 cwd，远程部署时就会
   * 在服务端开出一个不相干的目录。
   */
  private readonly path: string;
  private readonly client: ServerClient;
  private readonly sessions: RemoteSessions;
  private readonly notifier: ChatSessionNotifier;
  private readonly rate = new TokenRateMeter();
  private readonly offs: Array<() => void> = [];

  private sessionId: string;
  private workspaceId: string;
  private modelIdValue = "";
  /** 实发模型名：拼图片内容块时按它反查端点与视觉能力（`file_id` 是端点维度资源） */
  private apiModelValue = "";
  /** 服务端给的权威消息（事件期间的增量也追加在这里，收尾时整体换成快照） */
  private currentMessages: AgentNS.Message[] = [];
  /** 正在流式累积的那条 assistant 消息；不在生成中时 `null` */
  private streaming: { message: AgentNS.Message; text: string; reasoning: string } | null = null;
  private currentPhase: PhaseInfo | null = null;
  private lastUsageValue: AgentNS.Usage | undefined;
  /** 本轮等待中的 `turn.end`（`send()` 的 promise 靠它落地） */
  private pendingTurn: { turnId: number; resolve: () => void } | null = null;
  /** 最近一次收到的 `turn.end` 的轮次：挡住「事件比回执先到」那种竞态 */
  private lastEndedTurn = 0;
  /**
   * 本次会话出现过的子 Agent（按 `session.subAgent.started` 的顺序）。
   *
   * **只活当前这一轮**：`turn.end` 一到就清空（见 {@link finishTurn}），与进程内实现
   * `send()` 的 `finally` 等价 —— 那一轮内循环已经结束，子 Agent 只剩历史价值，留着
   * 只会白占一行。换会话（`reset` / `reload` / `migrate` / `session.idChanged`）同样清空。
   *
   * 注意这里**没有本地计数器**：`id` 与 `index` 都是服务端在 `started` 里给的（`index`
   * 本轮从 1 起）。客户端自己数就会多出第二份会漂的答案，而「哪个是子AGENT2」只有
   * 服务端知道（它才是分配方）。
   */
  private subAgentViews: SubAgentView[] = [];
  /** 子 Agent id → 它正在拼的临时消息（见 {@link SubAgentStream}） */
  private readonly subAgentStreams = new Map<string, SubAgentStream>();

  private constructor(
    client: ServerClient,
    sessions: RemoteSessions,
    input: { path: string; agentId: string; sessionId: string; workspaceId: string },
    notifier: ChatSessionNotifier,
  ) {
    this.client = client;
    this.sessions = sessions;
    this.notifier = notifier;
    this.path = input.path;
    this.agentId = input.agentId;
    this.sessionId = input.sessionId;
    this.workspaceId = input.workspaceId;
    this.wire();
  }

  /**
   * 连接服务端并打开（或续接）一段会话。
   *
   * `watch()` 必须在 `open()` 之前：`open` 之后服务端可能立刻推 `session.phase`，
   * 订阅晚一步就会漏掉开头的阶段（屏幕停在上一个状态不动）。
   */
  static async create(
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
  ): Promise<RemoteChatSession> {
    const { client } = await ensureServer({ aiZenDir: AI_ZEN_DIR, clientInfo: REMOTE_CLIENT_INFO });
    return await RemoteChatSession.openWith(client, input, notifier);
  }

  /** 用一条已有连接开会话（测试注入连接用；`create` 是它的「自备连接」版本） */
  static async openWith(
    client: ServerClient,
    input: OpenRemoteSessionInput,
    notifier: ChatSessionNotifier,
  ): Promise<RemoteChatSession> {
    const sessions = new RemoteSessions(client);
    await sessions.watch();

    /**
     * 工作区在**这一处**解析，且只解析这一处。
     *
     * `sessions.open()` 门面内部也会 `resolveWorkspace`，但那用的是我们递给它的
     * `workspace.path`（已规范化，幂等）；真正需要对齐的是「问 `last` 的工作区」与
     * 「开会话的工作区」——分两处各解析一次，就多出两个能漂的答案。所以顺序是：
     * 解析一次 → 用它的 id 问上一轮 → 用它的 path 开会话。
     */
    const workspace = await sessions.resolveWorkspace(input.path);

    /**
     * 续接：`resume` 只是意图，**哪一段是上一轮**只有服务端知道（`session.last`）。
     *
     * 明确的 `sessionId` 永远优先：`/load` 已经指定了具体那一段，再拿指针覆盖它
     * 就成了「悄悄换了用户点的东西」。
     */
    const lastId =
      input.sessionId || input.resume !== true
        ? null
        : (await sessions.last(workspace.workspaceId)).sessionId;
    const sessionId = input.sessionId ?? lastId ?? undefined;

    /**
     * 有明确目标 id（用户点的 `/load`，或 `session.last` 指的上一轮）就走 `attach`，
     * 否则才 `open` 一段新的。
     *
     * 为什么不能一律 `open`：那段会话很可能**还在服务端活着**（上次 TUI 只是断开了
     * 连接，Agent 与 MCP 连接都没销毁），而 `open`/`create` 对活着的 id 是「拒绝」
     * （不静默顶掉正在跑的会话）。于是「接着上次」会撞在 `session-exists` 上 ——
     * 用户看到的是「打不开自己上一轮会话」。`attach` 的语义就是「这段我要接上」。
     */
    const opened = sessionId
      ? await sessions.attach({
          workspaceId: workspace.workspaceId,
          // 递回**服务端规范化后的**路径：两处说的是同一个工作区
          path: workspace.path,
          sessionId,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        })
      : await sessions.open({
          path: workspace.path,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        });

    const session = new RemoteChatSession(
      client,
      sessions,
      {
        path: workspace.path,
        agentId: opened.agentId,
        sessionId: opened.sessionId,
        workspaceId: workspace.workspaceId,
      },
      notifier,
    );
    // 续接时的历史也在这份快照里：服务端 `session.create` 已经把存档消息装进了 Agent，
    // 客户端不搬、不拼，屏幕上的第一条都来自服务端。
    session.applySnapshot(await sessions.snapshot(opened.sessionId));
    return session;
  }

  // ==================== 对外面（ChatSessionLike） ====================

  get modelId(): string {
    return this.modelIdValue;
  }

  get currentId(): string {
    return this.sessionId;
  }

  get currentName(): string {
    return this.sessionId;
  }

  get messages(): AgentNS.Message[] {
    return this.currentMessages;
  }

  /**
   * 本次会话已出现的子 Agent（按出现顺序）。
   *
   * 屏幕每帧现取（`session?.subAgents ?? []`），所以这里返回活数组即可：清空、追加都
   * 会被下一次渲染看到，不需要额外的信号渠道。
   */
  get subAgents(): readonly SubAgentView[] {
    return this.subAgentViews;
  }

  get lastUsage(): AgentNS.Usage | undefined {
    return this.lastUsageValue;
  }

  get totalUsage(): AgentNS.Usage {
    return sumUsage(this.currentMessages);
  }

  get phase(): PhaseInfo | null {
    return this.currentPhase;
  }

  get rateSample(): RateSample {
    return this.rate.snapshot();
  }

  async send(input: string, images: readonly ClipboardImage[] = []): Promise<void> {
    this.rate.begin();
    try {
      const content = await this.buildContent(input, images);
      if (content === null) return; // 图片全被降级/过滤，且已给过说明
      const { turnId } = await this.sessions.send(this.sessionId, content);
      await this.waitForTurn(turnId);
    } finally {
      this.rate.finish();
    }
  }

  abort(): void {
    // 取消是「请求服务端停」：`session.cancel` 会掐本轮请求与进行中的交接，随后 `turn.end` 到达
    void this.sessions.cancel(this.sessionId).catch(() => {});
  }

  async reset(): Promise<string | null> {
    const hasContent = this.currentMessages.some((message) => message.role === AgentNS.Role.User);
    const archivedId = hasContent ? await this.save() : null;

    // 用 `this.path`（服务端规范化后的工作区路径）而不是客户端 cwd：`/new` 是「同一个
    // 工作区里换一段会话」，换到客户端进程的目录就等于替服务端换了地方
    const opened = await this.sessions.open({ path: this.path, agentId: this.agentId });
    this.sessionId = opened.sessionId;
    this.clearSubAgents();
    this.currentMessages = [];
    this.streaming = null;
    this.currentPhase = null;
    this.lastUsageValue = undefined;
    this.notifier.onChange(true);
    return archivedId;
  }

  async reload(): Promise<void> {
    // 重建 Agent 之后旧的子 Agent 已经不属于它了（与进程内实现 `reload()` 同步）
    this.clearSubAgents();
    this.applySnapshot(await this.sessions.reload(this.sessionId));
    this.notifier.onChange(true);
  }

  async handoff(mode?: HandoffMode): Promise<string> {
    const result = await this.sessions.handoff(this.sessionId, mode);
    this.applyMessages(result.messages);
    this.notifier.onChange(true);
    return result.handoffPath;
  }

  async migrate(mode?: HandoffMode): Promise<string> {
    const result = await this.sessions.migrate(this.sessionId, mode);
    // 先换 id：换完之后旧 id 的事件一律过滤掉，新会话的事件才接得上
    this.sessionId = result.sessionId;
    // 会话换了，栏目里那些是旧会话的子 Agent（与进程内实现 `migrate()` 同步）
    this.clearSubAgents();
    this.currentPhase = null;
    this.applyMessages(result.messages);
    this.notifier.onChange(true);
    return result.handoffPath;
  }

  async rollbackTo(index: number): Promise<string> {
    const result = await this.sessions.rollback(this.sessionId, index);
    this.applyMessages(result.messages);
    this.notifier.onChange(true);
    // 服务端给原文，工作目录备注由客户端剥（那是客户端自己拼进去的）
    return stripCwdNote(result.prompt);
  }

  async save(): Promise<string> {
    return (await this.sessions.save(this.sessionId)).sessionId;
  }

  async saveAs(id: string): Promise<string> {
    this.sessionId = (await this.sessions.saveAs(this.sessionId, id)).sessionId;
    return this.sessionId;
  }

  async listSaved(): Promise<Array<{ id: string }>> {
    return (await this.sessions.listSaved(this.workspaceId)).sessions;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.listSaved()).some((ref) => ref.id === id);
  }

  /**
   * 本工作区的文件清单（`@` 补全用）—— 问服务端要（`workspace.files`）。
   *
   * 清单必须来自**会话真正跑在哪个目录**：那是服务端的磁盘事实（Agent 的 cwd、工具读
   * 相对路径的基准都在那边）。扫客户端自己的 cwd，在「TUI 连远端服务端」这种形态下会
   * 列出另一台机器上的文件 —— 用户选中一个路径送过去，服务端根本没有那个文件。
   *
   * 形状两端逐字对齐（`{ path, dir }`，路径相对工作区根、`/` 分隔、目录条目带
   * `dir: true`），所以这里不做映射：多一层搬运只会多一处会漂的翻译。
   */
  async listWorkspaceFiles(): Promise<PathEntry[]> {
    return (await this.sessions.files(this.workspaceId)).entries;
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    // 挂着的 `send()` 不能永远悬着：连接没了，本轮只能算结束
    this.resolveTurn();
    this.client.close();
  }

  // ==================== 内部 ====================

  /**
   * 拼出这一条要发的内容：纯文本，或「文本 + 图片」内容块。
   *
   * 与进程内模式走**同一段**逻辑（`buildUserContent`）：内联还是 Files API 的
   * `file_id`、模型支不支持视觉，都按**实发模型名**反查端点 —— 那是端点维度的事，
   * 换一份实现就会漂。
   *
   * 唯一的远程约束是帧大小：内容块里的图片是 base64 内联的，一张 20MB 的图编码后
   * 远超单帧上限，而超限帧会让服务端直接判协议错误、**断掉整条连接**。所以这里先量
   * 一下：装不下就发文字（用户至少把话说出去了），并明确告知图片没带上。
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
      config: await readConfig(),
      apiModelName: this.apiModelValue || undefined,
    });
    for (const warning of warnings) this.notifier.onNotice(warning, "info");

    // 降级成纯文本（一张图都没转成功）：文字照发
    if (typeof content === "string") return content;

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
   * 订阅事件并按 `sessionId` 过滤。
   *
   * 过滤不是可选优化：同一条连接可以先后服务好几段会话（`/load`、`/migrate` 换了 id），
   * 不过滤就会把上一段会话的事件拼进当前这段。
   */
  private wire(): void {
    const mine = <E extends ServerEvent["event"]>(
      event: E,
      handler: (payload: Extract<ServerEvent, { event: E }>) => void,
    ) => {
      this.offs.push(
        this.client.on(event, (payload) => {
          if ((payload as { sessionId?: string }).sessionId !== this.sessionId) return;
          handler(payload);
        }),
      );
    };

    mine(SESSION_EVENTS.phase, (event) => {
      this.currentPhase = event.phase;
      // 每个 chunk 都会带一条 phase：走合帧，别把渲染压到每片一次；回到空闲才立即上屏
      this.notifier.onChange(event.phase === null);
    });

    mine(SESSION_EVENTS.delta, (event) => {
      // 子 Agent 的 token 也是真从网络来的，速率里算上（进程内实现的 `onSubChunk` 同样计）
      this.rate.addDelta(event.text + event.reasoning);
      if (event.subAgentId) {
        // 带 `subAgentId` 的增量属于那个子 Agent：拼到它自己的临时消息上，**不碰**主会话的
        // 拼接状态（`streaming`），也不改 `phase` —— 子 Agent 的流是工具内部的事，主阶段
        // 此刻应停在「等待 xxx 返回」（与进程内实现同一条规矩：子 Agent 的增量不推进主阶段）。
        this.applySubAgentDelta(event.subAgentId, event.text, event.reasoning);
      } else {
        this.applyDelta(event.text, event.reasoning);
      }
      this.notifier.onChange(false);
    });

    /**
     * 子 Agent 开工：标签上多一个「子AGENT{n}」。
     *
     * `index` / `subAgentId` 都用服务端给的：序号是本轮内从 1 起（`started` 携带），
     * id 是稳定值（React key 与选中态都靠它，不能每轮重编）。
     */
    mine(SESSION_EVENTS.subAgentStarted, (event) => {
      this.subAgentViews.push({
        id: event.subAgentId,
        index: event.index,
        messages: [],
        status: "running",
      });
      // 立刻拉一次快照：`started` 说明它已经在跑，服务端此刻可能已经有内容（任务描述、
      // 上一轮工具调用）。首次通常只是一条空占位，但这一下让「中途接上连接」与「增量先于
      // 快照到达」都收敛到同一份数据上（合并规则见 `mergeSubAgentSnapshot`）。
      //
      // 失败不升级成通知：这次拉取只是「把已有内容补上」，增量照样拼、`turn.end` 照样清，
      // 连接真断了会有别的信号。
      void this.syncSubAgent(event.subAgentId).catch(() => {});
      // 标签立刻上屏（「它开跑了」这件事不该等一个往返）：此刻内容是空的，增量一到就填
      this.notifier.onChange(true);
    });

    /** 子 Agent 收尾：只改状态（正文由增量与快照负责，这里不再拉一次） */
    mine(SESSION_EVENTS.subAgentEnded, (event) => {
      const view = this.subAgentViews.find((item) => item.id === event.subAgentId);
      if (!view) return;
      // **failed 不能被 done 覆盖**：core 的 `onSubAgentEnd` 在 `finally` 里分发，出错的那次
      // 也照样会来一条 end —— 无脑覆盖会把 ✖ 擦成 ✓，用户以为子任务成功了。
      if (!(view.status === "failed" && event.status === "done")) view.status = event.status;
      this.notifier.onChange(true);
    });

    mine(SESSION_EVENTS.turnEnd, (event) => {
      void this.finishTurn(event.turnId, event.error?.message);
    });

    /**
     * 服务端换 id（迁移 / 另存为 / **一轮进行中的自动迁移**）。
     *
     * 这里没有 `mine()` 那层 `sessionId` 过滤：这条事件的载荷说的是「`from` 那段会话
     * 现在叫 `sessionId` 了」，旧 id 已经不存在，用 `from` 认领。
     * 不跟着换的后果很硬：自动迁移发生在一轮内部，客户端会在旧 id 上等一个永远不会到的
     * `turn.end`，界面就永久卡在「生成中」。
     */
    this.offs.push(
      this.client.on(SESSION_EVENTS.idChanged, (event) => {
        if (event.from !== this.sessionId) return;
        this.sessionId = event.sessionId;
        // 换了会话，Agent 栏目里那些就是上一段会话的东西了（同 `migrate()` 的清空）
        this.clearSubAgents();
        // 迁移已经把历史剔成「模板 + 断点」：屏幕上的那份已经作废，重取一次
        void this.syncFromServer()
          .catch(() => {})
          .finally(() => this.notifier.onChange(true));
      }),
    );

    /**
     * 对话内通知（包括子 Agent 出错时的 `subAgentFailed`）。
     *
     * 一律走「code → 本地词典」这条路：服务端只给 `{ code, params }`，不给句子。
     * `subAgentFailed` 的模板只是把 `params.message` 原样吐出来 —— 与今天进程内实现
     * 直接把 `error.message` 推上通知栏**逐字一致**，所以这里不必为它单开一条分支
     * （多一条分支就多一处会与词典说不同话的地方）。
     */
    mine(SESSION_EVENTS.notice, (event) => {
      this.notifier.onNotice(noticeText(event.code, event.params), toneOf(event.level));
    });

    // 全局通知不属于任何会话：切会话也不该消失，所以不过滤 sessionId
    this.offs.push(
      this.client.on(SESSION_EVENTS.globalNotice, (event) => {
        this.notifier.onNotice(noticeText(event.code, event.params), toneOf(event.level));
      }),
    );
  }

  /**
   * 清空 Agent 栏目。
   *
   * 调用点对应进程内实现的每一处 `clearSubAgents()`：`turn.end`（= 那边的 `send()` 收尾）、
   * `reset` / `reload` / `migrate`、以及 `session.idChanged`（自动迁移换会话）。
   * 远程侧没有“计数器”要归零：`id` 与 `index` 都是服务端给的，清掉列表就够。
   */
  private clearSubAgents(): void {
    this.subAgentViews = [];
    this.subAgentStreams.clear();
  }

  /**
   * 子 Agent 的增量：拼到**它自己**的临时消息上。
   *
   * 与 `applyDelta` 是同一套拼接策略（临时消息 + 快照纠正），但**状态完全不共享**：
   * 主会话的 `streaming` / `currentMessages` / `lastEndedTurn` 一个都不碰 —— 共享就会让
   * 主会话里凭空多出子 Agent 的正文，或者把主会话的临时消息提前收尾。
   */
  private applySubAgentDelta(subAgentId: string, text: string, reasoning: string): void {
    const view = this.subAgentViews.find((item) => item.id === subAgentId);
    // 没有 `started` 就没有这个标签（`index` 是服务端在 started 里给的，客户端编不出来）。
    // 严格按 sessionId 过滤后这只会发生在「中途接上连接」时，而那时快照才是数据的来源。
    if (!view) return;

    let stream = this.subAgentStreams.get(subAgentId);
    if (!stream) {
      const message = { role: AgentNS.Role.Assistant, content: "" } as AgentNS.Message;
      stream = { message, text: "", reasoning: "" };
      this.subAgentStreams.set(subAgentId, stream);
      view.messages.push(message);
    }
    stream.text += text;
    stream.reasoning += reasoning;
    // 就地改这两个字段：屏幕读的是同一个对象，不必每次新建一条消息
    stream.message.content = stream.text;
    if (stream.reasoning) stream.message.reasoning_content = stream.reasoning;
  }

  /**
   * 拉一次子 Agent 快照并合并进视图（合并规则见 {@link mergeSubAgentSnapshot}）。
   *
   * 换会话时列表已经被清空，所以迟到的快照自然落空 —— 不必再比一次 `sessionId`。
   */
  private async syncSubAgent(subAgentId: string): Promise<void> {
    // 只用到 `messages`：`index` / `status` 已经由 `started` / `ended` 事件给过，
    // 同一份事实不在这条路上读第二遍（否则两个来源说法不同时得二选一，又多一处判定）。
    const snapshot = await this.sessions.subAgentSnapshot(this.sessionId, subAgentId);
    const view = this.subAgentViews.find((item) => item.id === subAgentId);
    if (!view) return;

    const merged = mergeSubAgentSnapshot(
      snapshot.messages as AgentNS.Message[],
      this.subAgentStreams.get(subAgentId) ?? null,
    );
    view.messages = merged.messages;
    if (merged.stream) this.subAgentStreams.set(subAgentId, merged.stream);
    else this.subAgentStreams.delete(subAgentId);
  }

  /** 增量落到一条**暂时的** assistant 消息上（`turn.end` 之后会被快照替换掉） */
  private applyDelta(text: string, reasoning: string): void {
    if (!this.streaming) {
      const message = { role: AgentNS.Role.Assistant, content: "" } as AgentNS.Message;
      this.streaming = { message, text: "", reasoning: "" };
      this.currentMessages.push(message);
    }
    const streaming = this.streaming;
    streaming.text += text;
    streaming.reasoning += reasoning;
    // 就地改这两个字段：屏幕读的是同一个对象，不必每次新建一条消息
    streaming.message.content = streaming.text;
    if (streaming.reasoning) {
      (streaming.message as unknown as { reasoning_content?: string }).reasoning_content =
        streaming.reasoning;
    }
  }

  /**
   * 一轮收尾：用快照换成服务端那份权威结果。
   *
   * 为什么不自己把流拼完整：工具调用、思考内容、`omit` 标记、用量都只有服务端有；
   * 客户端拼出来的只是一个「能滚动的近似」，回合结束后必须被真件替换掉。
   */
  private async finishTurn(turnId: number, failure?: string): Promise<void> {
    this.lastEndedTurn = Math.max(this.lastEndedTurn, turnId);
    this.streaming = null;
    // 本轮内循环（含全部委派）已结束：子 Agent 只剩历史价值，栏目随之消失 —— 与进程内
    // 实现 `send()` 的 `finally` 等价（中止 / 出错也走到这里，不留残影）。
    // 放在取快照之前：快照只描述主会话，栏目不该被它带着复活。
    this.clearSubAgents();
    this.currentPhase = null;
    this.rate.finish();
    try {
      this.applySnapshot(await this.sessions.snapshot(this.sessionId));
    } catch {
      // 拿不到快照（服务端刚重启 / 连接断了）：本地那份仍然可读，下一轮还会再同步
    }
    if (failure) this.notifier.onNotice(failure, "error");
    this.resolveTurn(turnId);
    this.notifier.onChange(true);
  }

  /**
   * 等这一轮结束。
   *
   * 事件可能**比回执先到**（`session.send` 先推 `connecting` 再回 `turnId`，一轮太快时
   * 连 `turn.end` 都可能在回执之前落地），所以先看 `lastEndedTurn` 再挂 promise。
   *
   * 这里**不**去要快照“补一下”：快照是回合开始前的状态，它的回执若晚于第一批增量
   * 到达，就会把已经拼出来的正文抹掉（本地列表被整个换掉，而流式那条已经不在里面）。
   * 快照只在一个地方用：真正的 `turn.end`（见 `finishTurn`）。
   */
  private async waitForTurn(turnId: number): Promise<void> {
    if (this.lastEndedTurn >= turnId) return;
    // 从判断到挂 promise 之间没有 await：中间不会被事件插进来
    await new Promise<void>((resolve) => {
      this.pendingTurn = { turnId, resolve };
    });
  }

  /** 唤醒等待中的 `send()`；带 turnId 时只唤醒它自己等的那一轮 */
  private resolveTurn(turnId?: number): void {
    if (turnId !== undefined && this.pendingTurn && this.pendingTurn.turnId !== turnId) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    pending?.resolve();
  }

  private applySnapshot(snapshot: SessionSnapshotResult): void {
    this.applyMessages(snapshot.messages);
    this.currentPhase = snapshot.phase;
    this.modelIdValue = snapshot.modelId;
    this.apiModelValue = snapshot.apiModel;
    this.lastUsageValue = snapshot.lastUsage as AgentNS.Usage | undefined;
  }

  private async syncFromServer(): Promise<void> {
    this.applySnapshot(await this.sessions.snapshot(this.sessionId));
  }

  private applyMessages(messages: unknown[]): void {
    this.currentMessages = [...(messages as AgentNS.Message[])];
  }
}

/** 通知语气：界面只分两档（普通 / 红），`warn` 归到红那一档 */
function toneOf(level: "info" | "warn" | "error"): "info" | "error" {
  return level === "info" ? "info" : "error";
}

/**
 * `ChatDeps.createSession` 的默认实现：连服务端（没有就拉起）并开一段会话。
 *
 * **不上送任何路径**：cwd 归属服务端。这里曾经发的是客户端进程的当前目录，等于让
 * 客户端替服务端决定会话跑在哪 —— 远程部署时那是**这台**机器上的目录，服务端那边很可能
 * 根本不存在（轻则开出一个不相干的新目录，重则直接失败）。
 * 服务端不给路径时用它自己的工作目录，那才是会话真正跑的地方。
 *
 * `resume` / `sessionId` 原样透传：一个说「接着上次」，一个说「就这一段」，
 * 两者的优先级由 `openWith` 处理（明确的 id 优先）。
 */
export async function createRemoteChatSession(
  options: ChatSessionOptions,
  notifier: ChatSessionNotifier,
): Promise<ChatSessionLike> {
  return await RemoteChatSession.create(
    { agentId: options.agentId, sessionId: options.sessionId, resume: options.resume },
    notifier,
  );
}
