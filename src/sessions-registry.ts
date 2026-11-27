/**
 * 会话注册表 —— 会话归进程所有，屏幕只是借一段来看。
 *
 * 从前一段会话的创建与释放挂在会话屏上：屏幕挂载时建、卸载时 `dispose()`。而换会话（`/new`、
 * `/load`）是「卸载旧屏 + 挂新屏」，于是每换一次，旧那一段会话的订阅就被摘掉 —— 宿主那边它还
 * 在跑（`RunRegistry` 独立于连接），客户端这边却再也收不到它的任何事件。「切过去不影响原来那段」
 * 在服务端早就成立，缺的只是客户端别丢订阅。
 *
 * 于是把「谁活着」搬到这里：一段会话开出来就归注册表，`dispose()` 只在进程收摊时统一调用；屏幕
 * 挂上来只是接成它的听众（`enter`），走的时候只摘听众（`detach`）。
 *
 * 两个不能省的细节：
 *
 * 1. 索引读的是活值：这一层存的是一个数组，查的时候读 `session.sessionId` 这个此刻的值 —— 会话
 *    id 一旦定下来就不再变（交接是原地换记忆），所以这一格不会漂；存数组仍然是更省事的那一种
 *    （顺序即打开顺序，列表天然有顺序）。
 * 2. 后台会话的通知不占当前屏：通知按会话归位 —— 当前没有屏幕看那一段时先暂存在它自己那一格
 *    （`channel.notices`），等它被切过来（`enter`）再一次性交给那一屏。通知栏是这一段会话的
 *    栏位，后台那段的句子不应该出现在别人的屏幕上。
 */

import { createRemoteChatSession } from "./session.js";
import type { LogSink } from "@ai-zen/agents-logger";
import { phaseLine } from "./session-phase.js";
import type { Unsubscribe } from "./server-client/index.js";
import type {
  ChatSessionLike,
  ChatSessionNotifier,
  ChatSessionOptions,
  CreateChatSession,
  HostConnection,
  NoticeOrigin,
  NoticeTone,
  RemovedSession,
  SessionActivity,
} from "./session/types.js";

/** 后台会话暂存通知的上限（再多也只留最近的这些：用户看到一屏就够判断了） */
const MAX_BACKGROUND_NOTICES = 20;

/** 宿主提问时怎么作答（屏幕给的） */
type QuestionHandler = NonNullable<ChatSessionOptions["onQuestion"]>;

/**
 * 一段会话「怎么作答」的那一格 —— 每段会话各持一个，可晚绑。
 *
 * 会话可能在屏幕挂上来之前就开好（启动期要先知道模型，见 `tui/index.tsx` 的
 * `openTargetSession`），而作答只有屏幕做得了（它要弹选择器）。所以会话拿到的是一个转发器，
 * 读的是它自己这一格：屏幕 `enter` 时把自己的那一个写进来，屏幕走了就置回 `null`。
 *
 * 为什么按会话分而不是共用一个：后台那段会话推的题会被答到当前那一屏的选择器上 —— 用户以为
 * 眼前这一段被提问了，答完的字符串却回给了后台那段。屏幕与题对不上，比没人答更糟。
 */
interface QuestionSlot {
  handler: QuestionHandler | null;
}

/** 一条暂存下来的通知（与 `ChatSessionNotifier.onNotice` 同形） */
interface QueuedNotice {
  text: string;
  tone: NoticeTone;
  /** 来源（`app` / `log`）：暂存的这几条里可能有日志上浮来的，交出去时不能把它丢掉 */
  origin?: NoticeOrigin;
}

/**
 * 一段会话在注册表里的那一格。
 *
 * `channel` 与 `session` 分开是因为顺序：会话在开的过程中就会推东西（打开时会补看宿主上还挂着
 * 的通知），而那时 `session` 这个字段还没被赋值。把「谁在看」与「暂存了什么」放进一个先立得住
 * 的小对象里，notifier 就能在会话到手之前成形。
 */
interface Entry {
  session: ChatSessionLike;
  channel: Channel;
  /** 这一段「怎么作答」：只有听这一段的那个屏幕才写得进来（见 `QuestionSlot`） */
  questionSlot: QuestionSlot;
}

/** 一段会话的听众与后台通知（`session` 还没到手时它就要能用） */
interface Channel {
  /** 此刻正在听这一段的屏幕；`null` = 没人看（后台跑着） */
  sink: ChatSessionNotifier | null;
  /** 没人看的时候暂存的通知，切过来时一次性交给那一屏 */
  notices: QueuedNotice[];
}

/**
 * 把一条通知交给看这一段的那一屏；没人看就暂存进它自己那一格（切过来时再交出去）。
 *
 * 暂存的不是「宿主那份通知」而是那句话本身：宿主那边显示即消费，错过这一次就再也补不回来。
 */
function announce(channel: Channel, text: string, tone: NoticeTone, origin?: NoticeOrigin): void {
  if (channel.sink) {
    channel.sink.onNotice(text, tone, origin);
    return;
  }
  channel.notices.push({ text, tone, origin });
  if (channel.notices.length > MAX_BACKGROUND_NOTICES) channel.notices.shift();
}

/**
 * 活跃会话列表里的一行 —— 本进程挂着的那些（另一半来自宿主的 `session.list`）。
 *
 * 只放命令层真正要显示的那几样事实：哪一段、叫什么、忙闲与存活、在忙什么（那一行文案）、还有
 * 几条排队没送出去、这段是几点开的。任何一条都是读会话的活值，不存副本。
 *
 * 「这一轮从几点开始」这一格确实没有：新契约不报这一项（没有运行边界，就没有起点可报）。列表上
 * 留着的是会话自己的时刻（`SessionView.createdAt`，排序也用它）—— 那是契约里真有的东西，不因为
 * 「运行起点」这一项消失就一起删掉。
 */
export interface LiveSession {
  sessionId: string;
  /** 会话名（宿主给的那个标题；自动名也在这一个字段上） */
  name: string;
  /** 忙闲那一格（`working` / `idle`）；`null` = 还没读到 */
  status: SessionActivity | null;
  /** 存活那一格：这一段此刻有没有 `Agent` */
  alive: boolean | null;
  /**
   * 在忙时「在忙什么」的那一行文案（`session-phase.ts` 从忙闲 + 消息现推）；空闲时为 `null`。
   *
   * 它是读的时候算的，不是存在这一行里的字段：同一份事实换个时刻读就是另一句。
   */
  phaseText: string | null;
  /**
   * 还没落成消息的排队条数。
   *
   * 这里只要一个数（跨进程的会话列表只说得出一句「还有几条没送出去」），它由会话那边的
   * `session.inboxPending` 派生（= `session.inbox.length`）—— 不在这里拿 `InboxItem` 另算一遍。
   */
  inboxPending: number;
  /**
   * 这段会话是什么时候开的（`SessionView.createdAt`，ISO 8601）。
   *
   * 列表里那一行「{time} 起」就从它算 —— 契约不报「这一轮从几点开始」，但会话自己的起点是
   * 真有的（宿主也按它排列表），不因为前面那个没了就把它一起删掉。
   */
  createdAt: string;
}

/**
 * 屏幕与命令层要的那一面。
 *
 * 刻意只留这几件事：借一段会话（`enter`）、还回去（`detach`）、开一段新的（`newSegment`）、
 * 看清单（`list`）、从登记里摘掉一段（`drop`）、以及「这一次删除是我自己叫的」
 * （`expectOwnRemoval`）。注册表还有 `open`（启动期先把会话开好）与 `disposeAll`（进程收摊），
 * 但那两个归组装根（`tui/index.tsx`）调 —— 屏幕拿不到它们，于是「屏幕自己把会话开好 / 关掉」
 * 这条路径不会在某个 effect 里出现。`drop` 是唯一一条「由屏幕那一侧发起、真的把一段会话从登记
 * 里拿走」的路径，调用它的是 `/delete` 与 `/ws delete`（宿主已经把那些硬删了）。
 */
export interface SessionHub {
  /** 挂到「这一段」上：本进程已经挂着就取现成的，没有就开一段；顺带把这一屏接成它的听众 */
  enter(
    options: Omit<ChatSessionOptions, "connection">,
    sink: ChatSessionNotifier,
  ): Promise<ChatSessionLike>;
  /** 屏幕走了：只摘听众，不动会话（它还在后台跑） */
  detach(sink: ChatSessionNotifier): void;
  /**
   * `/new`：同一个 AgentDefinition、当前选中的工作区开一段新会话，返回新会话的 id。
   *
   * 与「换成已有的某一段」不同，这一条得由持有会话的一方做：AgentDefinition 与工作区（`/ws` 选过
   * 的那个）都在当前这段会话上。旧那一段什么都不变：它留在注册表里继续跑。
   */
  newSegment(): Promise<string>;
  /** 本进程挂着的会话（`/sessions` 列表的一半） */
  list(): readonly LiveSession[];
  /**
   * `/delete` 成功之后：把这一段从本进程的登记里摘掉（连同它的订阅）。
   *
   * 宿主已经把那段硬删了，而注册表里还挂着它时会做两件错事：后续「切回去」指向一段已经不存在的
   * 东西；那一段的订阅与镜像也一直留着。所以摘干净 —— 先摘登记（此后不再往那一段投任何东西），
   * 再换屏（见 `commands/handlers.ts` 的 `cmdDelete`）。
   *
   * 不在登记里（别的客户端删的、或已经摘过一次）：空操作，不报错。
   *
   * 别处删掉的那几段不走这个口：它们由 `session.removed` 那条事件推过来，注册表自己摘（
   * `SessionRegistry` 的 `onRemoved`）—— 那条路上没有调用方等在那里调 `drop`。
   */
  drop(sessionId: string): void;
  /**
   * 这一次删除是本进程自己叫宿主做的（`/delete`、`/ws delete`）：这期间回来的 `session.removed`
   * 只摘登记，不再演一遍「别处删掉了这一段」（不出声、不换屏）—— 收尾由发起删除的那条命令自己
   * 做。
   *
   * 要提前报名而不是删完再说，是因为宿主在 mutation 里就把事件推到这条流上，它到得比那次调用的
   * 回执早。等回执写进 `messages` 再报名，屏幕已经被那一次惊动过一次了。
   *
   * 回一个「收尾完了」：发起的那条命令在它自己的收尾之后调它（失败也要调 —— 否则那一条事件不会
   * 到来，这一段以后被别处删掉时就不出声了）。
   */
  expectOwnRemoval(): () => void;
}

/**
 * 注册表本体。
 *
 * 生命周期挂在连接上：一段会话就是某条连接上的那一段，连接没了（`/shutdown` 之后回到连接门）
 * 它的订阅也就没有意义。所以它由组装根在「拿到连接之后、会话屏之前」建一次，在这一程结束时
 * `disposeAll()` —— 见 `tui/index.tsx` 的 `runTui`。
 */
export class SessionRegistry implements SessionHub {
  private readonly connection: HostConnection;
  private readonly factory: CreateChatSession;
  /** 按打开顺序（列表的天然顺序）；查「某一段」时读 `session.sessionId` 这个活值 */
  private readonly entries: Entry[] = [];
  /**
   * 正在开的那一段：同一个 `sessionId` 只开一次。
   *
   * 为什么要挡：屏幕的挂载 effect 可能连着跑两遍（依赖变了、重挂载），而开一段会话是两次往返
   * 加一条订阅 —— 开两遍就是两条 driver、两套订阅，之后每一条事件都被处理两次。
   */
  private readonly opening = new Map<string, Promise<Entry>>();
  /** 最近一次 `enter` 的那一段（`/new` 要知道「当前是哪一段」才问得出 AgentDefinition 与工作区） */
  private current: Entry | null = null;
  /**
   * 这条事件流上的那一条订阅（只听 `session.removed`，见 `onRemoved`）。
   *
   * 提在这里是因为它归注册表而不是某一段会话：一段会话的生存期短于它，而「这一段没了」这条事实
   * 恰恰要活到那一段被摘干净之后才算处理完。
   */
  private readonly offs: Unsubscribe[] = [];
  /** 「这一次删除是我自己叫的」已经报名了几次（见 `expectOwnRemoval`） */
  private ownRemovals = 0;

  /**
   * `logger` 是会话层那两件本机记忆（读续接目标 / 记住这一段的 id）的日志出口 —— 由组装根从
   * `CliApp` 手里接了再递进来，注册表只是把它交给缺省构造入口（`createRemoteChatSession`）。
   * 这样「会话层写日志」不需要一个全局口子，也不需要屏幕去关心。
   */
  constructor(
    connection: HostConnection,
    logger: LogSink,
    factory: CreateChatSession = (options, notifier) =>
      createRemoteChatSession(options, notifier, logger),
  ) {
    this.connection = connection;
    this.factory = factory;
    // 别处删掉的那一段要当场知道：等下一次 `session.list` 才发现的话，屏幕上那一段已经不存在
    // 了，而本进程的登记里还挂着它（后续「切回去」指向一段读不回来的东西）。
    this.offs.push(
      connection.subscribe((event) => {
        if (event.type === "session.removed") this.onRemoved(event.sessionId);
      }),
    );
  }

  /**
   * 组装根用：启动期先把这段会话开好（只备好，不接听众）。
   *
   * 屏幕挂上来时走 `enter`，按 id 取现成的这一段（同一个 `sessionId` 只开一次）—— 于是「启动期
   * 开会话问模型」与「屏幕开会话」不会变成两次 `connection.open`、两套镜像订阅。
   *
   * 这里不写作答者：没有屏幕可问，这一段的那一格就留着 `null`（题进通知栏，等屏幕挂上来再显示），
   * 哪一屏挂上来由 `enter` 写。
   *
   * 不放进 `SessionHub`：屏幕没有「先把会话开好」这个动作，它只有「借一段来看」。
   */
  async open(options: Omit<ChatSessionOptions, "connection">): Promise<ChatSessionLike> {
    const entry = await this.openEntry(options);
    this.current = entry;
    return entry.session;
  }

  async enter(
    options: Omit<ChatSessionOptions, "connection">,
    sink: ChatSessionNotifier,
  ): Promise<ChatSessionLike> {
    // 作答的那一格要等拿到 entry 才写得进去 —— 这时才知道是哪一段，而它只属于这一段。
    // 会话在开的过程中推的题因此仍然没有人作答（slot 还是 `null`）：题进通知栏暂存，
    // 屏幕挂上来之后才显示。
    const entry = await this.openEntry(options);
    if (options.onQuestion) entry.questionSlot.handler = options.onQuestion;
    entry.channel.sink = sink;
    this.current = entry;
    // 后台暂存的通知现在才有人看：切过来才显示，不占当时那一屏
    for (const notice of entry.channel.notices.splice(0)) {
      sink.onNotice(notice.text, notice.tone, notice.origin);
    }
    return entry.session;
  }

  detach(sink: ChatSessionNotifier): void {
    // 按听众身份摘，而不是「把当前这一段摘掉」：重挂载时新屏可能已经接上了（它的 `enter`
    // 先写进 `messages`），照位置摘会把新屏的听众一起摘掉，那一段此后再也推不动界面。
    for (const entry of this.entries) {
      if (entry.channel.sink !== sink) continue;
      entry.channel.sink = null;
      // 作答那一格跟着听众一起摘：那一屏已经不在了，往它那里投题没有去处
      // （题会进通知栏等屏幕挂上来）
      entry.questionSlot.handler = null;
    }
  }

  async newSegment(): Promise<string> {
    const current = this.current;
    if (!current) {
      // 只有从会话屏里输入 `/new` 才会走到这里，而那时已经 `enter` 过一段
      throw new Error("还没有会话：先进入一段会话再开新的");
    }
    const agentId = await this.defaultAgentIdFor(current.session.agentId, (text, tone) =>
      announce(current.channel, text, tone),
    );
    /**
     * 建一段新会话 —— `session.create` 只写库：不唤醒 Agent，也不投递任何东西。于是这一段开出来
     * 时没有 Agent，第一次发消息时会话层会先唤醒再投递。
     */
    const { session } = await this.connection.api.session.create.mutate({
      // 「下一个新会话落在哪」认 `currentWorkspaceId`（`/ws` 选过就是新的那个）
      workspaceId: current.session.currentWorkspaceId,
      agentId,
    });
    // 现在就开出来（而不是等下一屏挂载时再开）：于是这一段立刻在注册表里，`/sessions` 看得见它
    await this.openEntry({ sessionId: session.id });
    return session.id;
  }

  /**
   * 下一段会话用哪个 AgentDefinition：宿主配置里的默认 AgentDefinition（`config.get` 的
   * `defaultAgent`）。
   *
   * 从前的实现抄的是当前这一段的 `agentId`，于是 `/agent` 写完默认 AgentDefinition 之后 `/new`
   * 出来的还是旧 AgentDefinition。
   *
   * 问不到（连接断了 / 宿主没给）就退回当前这一段：宁可按一个确定的来，也不要让 `/new`
   * 因为一条附加查询失败而开不了。但退回这件事要说出来。
   */
  private async defaultAgentIdFor(
    fallback: string,
    tell: (text: string, tone: NoticeTone) => void,
  ): Promise<string> {
    try {
      const { config } = await this.connection.api.config.get.query();
      return config.defaultAgent ?? fallback;
    } catch (error) {
      tell(
        `默认助手问不到，这一段按当前用的助手开：${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
      return fallback;
    }
  }

  list(): readonly LiveSession[] {
    return this.entries.map((entry) => ({
      sessionId: entry.session.sessionId,
      name: entry.session.name,
      status: entry.session.status,
      alive: entry.session.alive,
      // 在忙什么：从忙闲 + 消息现推（`phaseLine` 是纯函数，读几次都一样）
      phaseText: phaseLine({
        status: entry.session.status,
        messages: entry.session.messages,
        // `/sessions` 那一行也要说得出「这段在交接」，否则它看起来只是闲着
        handingOff: entry.session.handoffSince !== null,
      }),
      // 派生值：会话那边 `inboxPending` = `inbox.length`（不在这里重算）
      inboxPending: entry.session.inboxPending,
      // 这一段的起点（会话行上的 `createdAt`，宿主按它排序；上层要 ISO 8601）
      createdAt: new Date(entry.session.view.createdAt).toISOString(),
    }));
  }

  /**
   * 从登记里摘掉一段（`/delete` 的那一步）。
   *
   * 与 `detach` 的区别是「这一段还算不算本进程的」：`detach` 只是没人看它了（它还在后台跑，还
   * 归注册表），这里是真的再也不归本进程了 —— 宿主那边已经把它硬删掉。
   *
   * 解订阅走的是摘掉它自己的那一套（`session.dispose()`，`disposeAll` 也是这一句）：注册表不
   * 绕过会话去动它的内部字段，也不自己拼一份「退订清单」。
   */
  drop(sessionId: string): void {
    const index = this.entries.findIndex((entry) => entry.session.sessionId === sessionId);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    // 正在开的那一格里也把它擦掉：它已经不存在了，开出来也没地方交
    this.opening.delete(sessionId);
    if (entry !== undefined && this.current === entry) this.current = null;
    // 订阅真正解掉的那一手（`dispose()` 是幂等的，重复摘不会出事）
    entry?.session.dispose();
  }

  /**
   * 宿主说「这一段没了」（`session.removed`）。
   *
   * 三种处境分得很清楚：
   *
   *   · 不在登记里（本进程没开过、或者自己刚刚摘过）：什么都不做 —— 与自己那条删除路不打架；
   *   · 后台那一段（不是这一屏正看着的）：只摘登记，不打扰当前这一屏、不换屏；
   *   · 这一屏正看着的那一段：先摘登记（此后不再往那一段投东西），再把这件事交给那一屏
   *     （`notifier.onRemoved`）—— 往哪换由屏幕收尾，注册表不管屏幕的事。
   *
   * 删项目连带删掉的那几段会各来一条：每一条都照上面走一遍，而「正看着的那一段」只有一条，所以
   * 报出来的也只有那一条（其余几条在这一屏看来只是「少了几段后台会话」）。
   *
   * 自己叫的那几次删除另算（`expectOwnRemoval`）：那时收尾在发起删除的那条命令手里。
   */
  private onRemoved(sessionId: string): void {
    const entry = this.entries.find((item) => item.session.sessionId === sessionId);
    if (entry === undefined) return;
    // 摘之前先把它的事实取走：`drop` 之后那一段就再也读不到这一格了
    const wasCurrent = this.current === entry;
    const sink = entry.channel.sink;
    const removed: RemovedSession = {
      sessionId,
      workspaceId: entry.session.workspaceId,
    };
    this.drop(sessionId);
    if (!wasCurrent || this.ownRemovals > 0) return;
    sink?.onRemoved?.(removed);
  }

  /**
   * 这一次删除是本进程自己叫的（`/delete`、`/ws delete`）—— 见 `SessionHub.expectOwnRemoval`。
   */
  expectOwnRemoval(): () => void {
    this.ownRemovals += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.ownRemovals -= 1;
    };
  }

  /** 进程收摊：每一段都 `dispose()` 一次（各一次，不多不少 —— `entries` 一次清空） */
  disposeAll(): void {
    for (const off of this.offs.splice(0)) off();
    for (const entry of this.entries.splice(0)) entry.session.dispose();
    this.current = null;
    this.opening.clear();
    this.ownRemovals = 0;
  }

  /**
   * 取「这一段」的会话：本进程挂着就现成的，否则开一段。
   *
   * 只有点名了 `sessionId` 才能去重：没点名（首屏的「接着上次」）之前，谁也不知道会落到
   * 哪一段上 —— 那时没有可去重的键，于是先开一段，开出来之后它就带名字了。
   */
  private async openEntry(options: Omit<ChatSessionOptions, "connection">): Promise<Entry> {
    const sessionId = options.sessionId;
    if (sessionId !== undefined) {
      const existing = this.entries.find((entry) => entry.session.sessionId === sessionId);
      if (existing) return existing;
      const inFlight = this.opening.get(sessionId);
      if (inFlight) return await inFlight;
    }

    const opening = this.createEntry(options);
    if (sessionId !== undefined) this.opening.set(sessionId, opening);
    try {
      return await opening;
    } finally {
      if (sessionId !== undefined) this.opening.delete(sessionId);
    }
  }

  /** 真去开一段：会话 + 它的那一格（notifier 在会话到手之前就成形，见 `Entry`） */
  private async createEntry(options: Omit<ChatSessionOptions, "connection">): Promise<Entry> {
    const channel: Channel = { sink: null, notices: [] };
    const notifier: ChatSessionNotifier = {
      onChange: (immediate) => channel.sink?.onChange(immediate),
      onNotice: (text, tone, origin) => announce(channel, text, tone, origin),
    };
    // 这一段自己的作答那一格（`QuestionSlot`）：转发器每次现读，屏幕晚绑也接得上
    const questionSlot: QuestionSlot = { handler: null };
    const session = await this.factory(
      {
        ...options,
        connection: this.connection,
        // 作答走这一段的格子：会话开出来时屏幕可能还没挂上来（启动期先开会话问模型），
        // 那时格子是空的，如实回 `null`（题干会进通知栏）；只有听这一段的那一屏会写进来。
        onQuestion: async (question) =>
          questionSlot.handler ? await questionSlot.handler(question) : null,
      },
      notifier,
    );
    const entry: Entry = { session, channel, questionSlot };
    this.entries.push(entry);
    return entry;
  }
}
