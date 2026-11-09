/**
 * TUI 对话会话 —— Agent 装配 + 「内容变更」信号
 *
 * 渲染以 SDK 的 `agent.messages` 为**唯一数据源**：本模块不再把流式 delta 翻译成
 * 自定义事件 / 中间模型（Block / LiveAssistant），只做两件事：
 *   1. SDK 事件到达时通知上层「messages 变了，该重渲染了」；
 *   2. 把系统级提示（notice / error）转发到独立通道（绝不写进 messages）。
 *
 * 本模块不依赖 React / Ink，可独立单测。
 */

import { AgentNS, sumUsage } from "@ai-zen/agents-core";
import type { AgentPlugin, SubAgentContext, Agent as CoreAgent } from "@ai-zen/agents-core";
import { t } from "../i18n/index.js";
import {
  AutoRefreshToolsPlugin,
  ContextGuardPlugin,
  type AutoMigrateTriggerInfo,
  type HandoffMode,
  type HandoffService,
  type SdkAgent,
} from "@ai-zen/agents-sdk";
import { createAgent, resetScope } from "../agent-creator.js";
import { readConfig } from "../config.js";
import { buildUserContent } from "../user-content.js";
import type { ClipboardImage } from "../clipboard.js";
import { CwdTrackerPlugin } from "../cwd-tracker-plugin.js";
import { SessionPersistPlugin } from "../session-persist-plugin.js";
import { SubAgentGuardInstallerPlugin } from "../sub-agent-guard-plugin.js";
import type { TokenThresholds } from "@ai-zen/agents-sdk";
import { createAutoMigratePlugin } from "../auto-migrate-confirm.js";
import { createHandoffService } from "../handoff-service.js";
import {
  generateSessionId,
  sessionStore,
  persistSession,
  sessionExists,
  listSessions,
} from "../session-store.js";
import type { SessionContext } from "../types.js";
import { stripCwdNote } from "./text.js";
import { listProjectPaths } from "./file-index.js";
import type { PathEntry } from "./mention.js";
import { TokenRateMeter, deltaText, type RateSample } from "./token-rate.js";
import { PhaseTracker, pendingToolCalls, type PhaseInfo } from "@ai-zen/agents-server";

/**
 * 把「请求即将发出」报给阶段跟踪器。
 *
 * SDK 的 `open` 事件是在 `chat.completions.create()` **await 返回之后**才发的，
 * 也就是说它只代表响应头到了；在那之前的 DNS / TCP / TLS / 服务端受理都是静黙的。
 * 所以要一个插件钩子把这一段补上——否则首轮会一直停在上一个状态。
 */
class PhasePlugin implements AgentPlugin {
  constructor(private readonly tracker: PhaseTracker) {}
  onInnerLoopStart(): void {
    this.tracker.connecting();
  }
}

/**
 * 对话会话的对外面 —— 「能渲染、能发话、能存档的一段会话」。
 *
 * 两个实现：{@link ChatSession}（在本进程里跑 Agent）与 `RemoteChatSession`（连服务端，
 * 自己是纯客户端）。UI 只认这一面，换源时屏幕上的东西一行不动 —— 这是「传输自由」
 * 在界面层的落点：屏幕不知道 Agent 跑在哪。
 *
 * 只列 UI 与命令层真用到的东西：SDK 的 `agent`、插件、TokenTracker 这些实现细节
 * 不属于这份契约。
 */
export interface ChatSessionLike {
  /** 用哪个 Agent（会话的父级是工作区，Agent 决定能力与模型） */
  readonly agentId: string;
  /** 当前模型 id（真相源是 `AgentDefinition.modelId`；空串 = 定义里没绑模型） */
  readonly modelId: string;
  /** 当前会话 id / 名称（`/save`、状态栏与「上一轮会话」指针用） */
  readonly currentId: string;
  readonly currentName: string;
  /** 对话消息（屏幕的唯一数据源） */
  readonly messages: AgentNS.Message[];
  /** 本轮内出现过的子 Agent（只活当前一轮；两个实现都给） */
  readonly subAgents: readonly SubAgentView[];
  /** 最近一轮用量；未知时 `undefined`（客户端别自己编一个） */
  readonly lastUsage?: AgentNS.Usage;
  /** 本次会话累计用量 */
  readonly totalUsage: AgentNS.Usage;
  /** 生成阶段；空闲 `null` */
  readonly phase: PhaseInfo | null;
  /** 生成速率快照（状态栏与 spinner 用） */
  readonly rateSample: RateSample;

  send(input: string, images?: readonly ClipboardImage[]): Promise<void>;
  /** 中止本轮（Ctrl+C）：只取消这一轮，不退出 */
  abort(): void;
  /** `/new`：先归档当前对话（有内容才存），再开一段新的；返回被归档的 id */
  reset(): Promise<string | null>;
  /** 按磁盘上的新配置重建（保留消息） */
  reload(): Promise<void>;
  /** `/migrate`：交接 + 开新会话；返回交接文档路径 */
  migrate(mode?: HandoffMode): Promise<string>;
  /** `/handoff`：只产出交接文档，不动会话；返回文档路径 */
  handoff(mode?: HandoffMode): Promise<string>;
  /** `/back`：从 index 起删掉，返回被删首条用户消息的原文（预填输入框） */
  rollbackTo(index: number): Promise<string>;
  /** 落盘当前会话（并更新「上一轮会话」指针） */
  save(): Promise<string>;
  /** 另存为指定 id；返回实际生效的 id */
  saveAs(id: string): Promise<string>;
  /** 本工作区已存档的会话（`/load` 的列表；不解析内容） */
  listSaved(): Promise<Array<{ id: string }>>;
  /** 某个 id 是否已有存档（`/save <名字>` 的重名判断） */
  exists(id: string): Promise<boolean>;
  /**
   * 本工作区的文件清单（`@` 补全用）。
   *
   * 为什么它在会话契约里：清单必须来自**会话真正跑在哪个目录**——那目录属于服务端。
   * 远程实现问服务端（`workspace.files`），进程内实现扫本机；屏幕只负责过滤与插入。
   */
  listWorkspaceFiles(): Promise<PathEntry[]>;
  /** 释放资源（卸监听 / 断连接） */
  dispose(): void;
}

/** 会话 → UI 的对外信号 */
export interface ChatSessionNotifier {
  /** 转录可能已变化（内容以 `agent.messages` 为准）；`immediate=true` 表示应立即上屏 */
  onChange(immediate: boolean): void;
  /** 系统级提示（notice / error），走独立栏位，绝不进 messages */
  onNotice(text: string, tone: "info" | "error"): void;
}

/**
 * 子 Agent 的执行状态。
 *
 * 内联在 Agent 栏目的标签上（`●` / `✓` / `✖`），**不往通知栏推**：通知栏为进度多出
 * 一行，整帧高度就会跟着跳（多行通知踩过同一坑）。
 */
export type SubAgentStatus = "running" | "done" | "failed";

/**
 * 子 Agent 视图：委派期间收集，供对话屏的 Agent 栏目切换查看。
 *
 * 为何能一直可读：core 的 `AgentTool` / `AgentToolLazy` 在 `exec()` 里 `new Agent(...)` /
 * `buildAgent()` 出子 Agent，委派结束后**实例不销毁**（`onSubAgentEnd` 只是钩子），
 * 所以 `agent.messages` 始终是本子 Agent 的完整对话。这里只要持有引用，栏目就能回看。
 *
 * 生命周期：**只活在当前这一轮的内循环里**。栏目能做的事只有「切换看」，而子 Agent
 * 是内循环中工具调用的产物；一旦本轮内循环全部结束（`send()` 即将返回），主 Agent 已经
 * 给出最终答案，子 Agent 只剩历史价值，留着只会白占一行。
 * 因此清空发生在 `send()` 的 `finally`（异常 / 中止同样清）；`reset()` / `reload()` /
 * `migrate()` 换了 Agent 或会话也一并清空一一它们只换 `agent`，不重建本类实例。
 */
export interface SubAgentView {
  /** 稳定 id（React key / 选中态标识） */
  id: string;
  /** 出现序号（从 1 起）：栏目标签直接叫「子AGENT1」，序号就是展示的一部分 */
  index: number;
  /**
   * 这个子 Agent 到目前为止的完整对话。
   *
   * 这里**刻意不是子 Agent 实例**：实例只存在于「Agent 跑在这个进程里」那种形态
   * （`CoreAgent.messages`）。远程时对话在服务端，客户端能拿到的是数据而不是对象。
   * 契约写成数据，进程内 / 远程两个实现才共用同一份接口，屏幕也只需要「读消息」。
   */
  messages: AgentNS.Message[];
  /** 执行状态（渲染期读，故设为可变字段） */
  status: SubAgentStatus;
}

export interface ChatSessionOptions {
  agentId?: string;
  messages?: AgentNS.Message[];
  sessionId?: string;
  sessionName?: string;
  /**
   * 续接该工作区的「上一轮会话」（有就接着，没有就开新的）。
   *
   * 为什么是**意图**而不是数据：这件事的答案（哪一段是上一轮）原本只存在于本地存档里，
   * 客户端自己去读就是又一份会漂的真相。远程实现问服务端（`session.last`），进程内实现
   * 读本地指针；屏幕层只说「我要接着上次」，不说接哪一段。
   *
   * 给了明确的 `sessionId` 时以它为准（`/load` 选中的那段）。
   */
  resume?: boolean;
  /**
   * 自动迁移时的执行者选择（由 Ink 层弹出选择器实现）。
   * 返回 `null` 表示跳过本次迁移；未提供时按默认执行者（原 agent 自交接）直接迁移。
   */
  requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
  /**
   * 可注入的 Agent 工厂 / Scope 重置。缺省用真实实现；测试注入假实现即可，
   * **不必** `vi.mock("../agent-creator.js")` —— 进程内共享模块时模块级 mock 会串。
   */
  deps?: {
    createAgent?: typeof createAgent;
    resetScope?: typeof resetScope;
  };
}

/** 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示（转发自 ./text.js） */
export { stripCwdNote };

export class ChatSession implements ChatSessionLike {
  /**
   * 当前模型 id —— 从 Agent 定义读，**不再单独存一份**。
   *
   * 模型的唯一真相源是 `AgentDefinition.modelId`：会话不记模型，配置也没有
   * `defaultModel`。这样状态栏、落盘与 SDK 实发请求用的永远是同一个值。
   */
  get modelId(): string {
    return this.agent.definition.modelId ?? "";
  }

  readonly agentId: string;
  /** 当前模型的上下文阈值（交接软线 + 阻断硬线），缺省时不装护栏插件 */
  readonly tokenThresholds?: TokenThresholds;

  /**
   * 会话 id / 名称的**唯一真相源是 `ctx`**（`SessionContext`）。
   *
   * 为什么必须代理而不是各存一份：自动迁移由 SDK 的 `AutoMigratePlugin` 直接驱动
   * `HandoffService.migrate()`，**不经过本类任何方法**，新 id 只会写进 `ctx.currentId`
   * （`onMigrated` 钩子）。若本类另持一份 `currentId`，自动迁移后它就停在旧值上，
   * 而 `SessionPersistPlugin.getId()` 读的正是这份旧值——于是 prune 之后的
   * 「系统提示 + 交接断点」会被写进**旧会话文件**，把已保存的完整历史覆盖掉。
   */
  get currentId(): string {
    return this.ctx.currentId;
  }
  set currentId(id: string) {
    this.ctx.currentId = id;
  }

  get currentName(): string {
    return this.ctx.currentName;
  }
  set currentName(name: string) {
    this.ctx.currentName = name;
  }

  private agent!: SdkAgent;
  private readonly ctx: SessionContext;
  private readonly handoffService: HandoffService;
  private readonly notifier: ChatSessionNotifier;
  private readonly requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
  private readonly disposers: Array<() => void> = [];
  /** 生成过程的 token 速率统计（状态栏展示，见 `token-rate.ts`） */
  private readonly rate = new TokenRateMeter();
  /** 当前生成阶段（消息栏 spinner 文案，见 `phase.ts`） */
  private readonly phaseTracker = new PhaseTracker();
  /** 本次会话中已出现的子 Agent（只保留当前一轮，见 {@link SubAgentView} 的生命周期说明） */
  private subAgentViews: SubAgentView[] = [];
  /**
   * 视图 id → 子 Agent 实例。
   *
   * 视图对外只暴露 `messages`，但**事件监听要按实例认领**（`sub-agent-end` / `error`
   * 的载荷是实例而不是 id）。所以实例仍留在本类里，只做内部索引，不进公开契约。
   */
  private subAgentAgents = new Map<string, CoreAgent>();
  /** 展示序号（每轮归零，标签回到「子AGENT1」） */
  private subAgentSeq = 0;
  /**
   * 视图 id 序号（**永久递增，每轮也不清零**）。
   *
   * 与展示序号分开是必要的：若 id 也跟着归零，下一轮的 `sub-1` 会与上一轮同名，
   * 而选中态是按 id 匹配的——残留的选中 id 会突然「接上」新一轮的子 Agent。
   */
  private subAgentIdSeq = 0;
  /** Agent 工厂 / Scope 重置（构造时可注入，见 `ChatSessionOptions.deps`） */
  private readonly createAgentFn: typeof createAgent;
  private readonly resetScopeFn: typeof resetScope;

  private constructor(
    handoffService: HandoffService,
    ctx: SessionContext,
    options: ChatSessionOptions,
    tokenThresholds: TokenThresholds | undefined,
    notifier: ChatSessionNotifier,
  ) {
    this.handoffService = handoffService;
    this.ctx = ctx;
    this.agentId = options.agentId || "default";
    this.tokenThresholds = tokenThresholds;
    this.currentId = ctx.currentId || generateSessionId();
    this.currentName = ctx.currentName;
    this.notifier = notifier;
    this.requestMode = options.requestMode;
    this.createAgentFn = options.deps?.createAgent ?? createAgent;
    this.resetScopeFn = options.deps?.resetScope ?? resetScope;
  }

  /** 创建会话：装配 Agent、插件与「变更信号」 */
  static async create(
    options: ChatSessionOptions,
    notifier: ChatSessionNotifier,
  ): Promise<ChatSession> {
    const config = await readConfig();

    /**
     * 续接：进程内实现读**本地指针**。
     *
     * 远程实现问服务端的 `session.last`，这里读 `last-session.json` —— 两条路回答的是同一个
     * 问题（「这个工作区的上一轮是哪段」），只是数据在哪一侧。指针缺失、或指向的存档已被
     * 删掉时**当新会话开**：宁可开一段新的，也不能把用户领进一段空对话。
     */
    let resumed = {
      messages: options.messages,
      agentId: options.agentId,
      sessionId: options.sessionId,
      sessionName: options.sessionName,
    };
    if (options.resume && !options.sessionId) {
      const store = await sessionStore();
      const pointer = await store.lastSession();
      const record = pointer ? await store.read(pointer.id) : null;
      if (record) {
        // 模型由 Agent 定义决定（旧存档里的 modelId 一律忽略）
        resumed = {
          messages: record.messages,
          agentId: record.agentId,
          sessionId: record.id,
          sessionName: record.id,
        };
      }
    }

    // 先建 Agent：模型来自 Agent 定义（`createAgent` 内部解析 modelId），
    // 阈值再按该模型查配置——不存在「CLI 以为的模型」与「实发模型」两套值。
    const createAgentFn = options.deps?.createAgent ?? createAgent;
    const agent = await createAgentFn({ messages: resumed.messages, agentId: resumed.agentId });
    const model = config.models.find((m) => m.id === agent.definition.modelId);
    // 阈值由配置直接给出（旧字段已在 SDK 的 ConfigManager.read() 里迁移过）
    const tokenThresholds = model?.tokenThresholds;

    const currentId = resumed.sessionId || generateSessionId();
    const ctx: SessionContext = {
      agent,
      currentName: resumed.sessionName || currentId,
      currentId,
      agentId: resumed.agentId,
    };
    const handoffService = createHandoffService(ctx, {
      // 迁移进度/结果经通知通道渲染，避免直接写 stdout 撕裂画面
      log: (text) => notifier.onNotice(text, "info"),
    });
    ctx.handoffService = handoffService;

    const session = new ChatSession(handoffService, ctx, options, tokenThresholds, notifier);
    session.agent = agent;
    await session.attach(agent);
    return session;
  }

  /** 对话消息（唯一真相源） */
  get messages(): AgentNS.Message[] {
    return this.agent.messages;
  }

  /** 本次会话已出现的子 Agent（按出现顺序）；对话屏据此渲染 Agent 栏目 */
  get subAgents(): readonly SubAgentView[] {
    return this.subAgentViews;
  }

  /** 最近一次响应的 token 用量（供「本轮 / 当前上下文占用」展示与阈值判定） */
  get lastUsage(): AgentNS.Usage | undefined {
    return this.agent.lastUsage;
  }

  /**
   * 本会话累计 token 用量。
   *
   * 逐消息求和（`sumUsage`）：含各 assistant 消息的 `usage`（自身响应）与工具消息的
   * `subAgentUsage`（内部委派——含所有层级子 Agent）。每轮请求都会重发完整历史，
   * 故求和即计费口径的累计消耗；且随消息持久化，续接 / `/load` 亦不丢。
   */
  get totalUsage(): AgentNS.Usage {
    return sumUsage(this.agent.messages);
  }

  /** 当前速率快照：生成中看 `live`（实时），结束后看 `average`（本轮平均） */
  get rateSample(): RateSample {
    return this.rate.snapshot();
  }

  /** 当前生成阶段；空闲时为 null（消息栏据此显示「处理中」或不起 spinner） */
  get phase(): PhaseInfo | null {
    return this.pendingPhase(this.phaseTracker.phase);
  }

  /**
   * 把 `tool-waiting` 里的工具名收窄到**仍在跑**的那几个。
   *
   * 阶段本身是事件快照，而「谁跑完了」只能从结果消息的状态看出来（结果消息在执行前
   * 就以 `pending` 追加、跑完才翻终态）。这一步放在**读取时**做而不是在事件里改状态：
   * `tool-call-end` 与消息翻状态发生在同一时刻，读时算一遍既不会漏，也不需维护第二份状态。
   * 并行调 `edit` + `exec` 时，edit 一落地这里就只剩 `exec`，标签不再说错话。
   */
  private pendingPhase(phase: PhaseInfo | null): PhaseInfo | null {
    if (!phase || phase.kind !== "tool-waiting" || !phase.calls?.length) return phase;
    const pending = pendingToolCalls(phase.calls, this.agent.messages);
    // 全都结束了（下一轮 `connecting` 马上就到）：留全部名字，别把标签闪成「等待工具返回…」
    const shown = pending.length > 0 ? pending : phase.calls;
    return { ...phase, tools: shown.map((call) => call.name) };
  }

  /** 清空 Agent 栏目（新一轮输入 / 换 Agent / 换会话时调用；序号一并归零） */
  private clearSubAgents(): void {
    this.subAgentViews = [];
    this.subAgentAgents.clear();
    this.subAgentSeq = 0;
  }

  /** 按实例找回它的视图（`sub-agent-end` / `error` 的载荷是实例，不是 id） */
  private viewOf(agent: CoreAgent): SubAgentView | undefined {
    for (const [id, instance] of this.subAgentAgents) {
      if (instance === agent) return this.subAgentViews.find((item) => item.id === id);
    }
    return undefined;
  }

  /**
   * 发送一条消息；内容变化经 `notifier.onChange` 通知，`resolve` 表示本轮结束。
   *
   * `images` 非空时，消息内容由「文本段 + 图片内容块」组成（转换规则与降级全在
   * `user-content.ts`）：这是粘贴图片唯一的入口，不另开一条发送路径。
   */
  async send(input: string, images: readonly ClipboardImage[] = []): Promise<void> {
    this.rate.begin();
    this.phaseTracker.connecting();
    try {
      if (images.length === 0) {
        await this.agent.send(input);
      } else {
        const config = await readConfig();
        const { content, warnings } = await buildUserContent({
          text: input,
          images,
          config,
          // 端点 / 视觉能力按**实发模型名**反查：`file_id` 是端点维度资源，传错端点会 not found
          apiModelName: this.agent.model,
        });
        for (const warning of warnings) this.notifier.onNotice(warning, "info");
        await this.agent.send(content);
      }
    } catch (error: any) {
      this.notifier.onNotice(error?.message ?? String(error), "error");
    } finally {
      this.rate.finish();
      this.phaseTracker.reset();
      // 本轮内循环（含全部工具调用）已结束：子 Agent 只剩历史价值，栏目随之消失。
      // 放 `finally` 是为了中止 / 出错时也不留残影；序号一并归零，下一轮又是「子AGENT1」。
      this.clearSubAgents();
      this.notifier.onChange(true);
    }
  }

  /** 中止当前请求（Ctrl+C 语义：仅取消本轮，不退出） */
  abort(): void {
    // 交接/迁移的取消句柄在服务里，不在这里：`self` 之外的路径（尤其是自动迁移，它由
    // SDK 插件直接驱动、不经过本类）拿不到任何可传的 signal，只有服务自己持有的那个开关
    // 能拦住。服务负责「停下 + 回到交接前」（不重试、不降级、不迁移、截掉交接回合），
    // `agent.abort()` 负责立即掐断正在流的这一轮。
    this.handoffService.abort();
    this.agent.abort();
  }

  /**
   * 重置会话（/new）：先把当前对话归档（有内容才存），再清空历史并重建 Agent。
   *
   * 归档必须先于 `currentId` 切换：`save()` 按 `this.currentId` 落盘，若先换 id
   * 会把旧内容写到新会话文件上（等于旧对话丢失）。返回被归档的会话 id，
   * 无内容可存时返回 null。
   */
  async reset(): Promise<string | null> {
    const hasContent = this.agent.messages.some((m) => m.role === AgentNS.Role.User);
    const archivedId = hasContent ? await this.save() : null;

    this.dispose();
    this.clearSubAgents();
    const agent = await this.createAgentFn({
      agentId: this.agentId === "default" ? undefined : this.agentId,
    });
    this.agent = agent;
    this.ctx.agent = agent;
    this.currentId = generateSessionId();
    this.currentName = this.currentId;
    await this.attach(agent);
    this.notifier.onChange(true);

    return archivedId;
  }

  /**
   * 应用外部配置变更（如 `/config` 改了当前端点的 API Key / Base URL）：
   * **保留消息与上下文**，按磁盘上的新配置重建 Agent。
   *
   * 关键：`getScope()` 是持有配置快照的单例，必须连同 Scope 一起重建，
   * 否则端点凭据仍是旧的（这也是 `resetScope()` 要 `dispose` 旧实例的原因）。
   */
  async reload(): Promise<void> {
    const messages = [...this.agent.messages];
    this.dispose();
    this.clearSubAgents();
    await this.resetScopeFn();
    const agent = await this.createAgentFn({
      messages,
      agentId: this.agentId === "default" ? undefined : this.agentId,
    });
    this.agent = agent;
    this.ctx.agent = agent;
    await this.attach(agent);
    this.notifier.onChange(true);
  }

  /** 手动任务迁移（`/migrate`）：交接 + 开新会话；与自动迁移共用同一服务实例 */
  async migrate(mode?: HandoffMode): Promise<string> {
    if (!this.messages.some((m) => m.role === AgentNS.Role.User)) {
      throw new Error(t("chat.noMigratable"));
    }
    // 取消通道在服务里（`abort()` → `handoffService.abort()`），这里不再自带 AbortController
    const ctx = await this.handoffService.migrate({ agent: this.agent, mode });
    // 迁移后服务会开启新会话：新 id 已写进 ctx（唯一真相源），这里只需同步名称并刷新界面
    this.currentName = this.currentId;
    this.clearSubAgents();
    this.notifier.onChange(true);
    return ctx.handoffPath;
  }

  /**
   * 只产出交接文档（`/handoff`）：不切换会话、不改动历史。
   *
   * 交接回合（指令 + 工具调用 + 回执）会留在 `agent.messages` 里，
   * 用户可继续要求细化同一份文档（重写同一路径即可）。被取消时相反：整个交接回合
   * 会被服务截掉，会话回到交接前。
   */
  async handoff(mode?: HandoffMode): Promise<string> {
    if (!this.messages.some((m) => m.role === AgentNS.Role.User)) {
      throw new Error(t("chat.noHandoffable"));
    }
    const ctx = await this.handoffService.handoff({ agent: this.agent, mode });
    this.notifier.onChange(true);
    return ctx.handoffPath;
  }

  /** 撤回：删除索引 index 起的消息，返回被撤回的首条用户消息文本（用于预填输入） */
  async rollbackTo(index: number): Promise<string> {
    if (index < 0 || index >= this.agent.messages.length) return "";
    const removed = this.agent.messages.splice(index);
    const firstUser = removed.find((m) => m.role === AgentNS.Role.User);
    if (typeof firstUser?.content !== "string") return "";
    return stripCwdNote(firstUser.content);
  }

  /** 本工作区已存档的会话（`/load` 的列表）；进程内模式直接读盘 */
  async listSaved(): Promise<Array<{ id: string }>> {
    return await listSessions();
  }

  /** 某个 id 是否已有存档（`/save <名字>` 的重名判断） */
  async exists(id: string): Promise<boolean> {
    return await sessionExists(id);
  }

  /**
   * 本工作区的文件清单。
   *
   * 进程内模式下「工作区」就是本进程的 cwd（会话就地跑）；远程实现才会去问服务端。
   * 这正是两边唯一的区别 —— 屏幕层不需要知道是哪一种。
   */
  async listWorkspaceFiles(): Promise<PathEntry[]> {
    return await listProjectPaths(process.cwd());
  }

  /** 保存当前对话到存档 */
  async save(): Promise<string> {
    return persistSession({
      id: this.currentId,
      agentId: this.agentId,
      messages: this.agent.messages,
    });
  }

  /**
   * 把当前会话存成指定文件名（`/save <名字>`），成功后 `currentId` 与 last-session
   * 指针一并跟过去，于是后续自动落盘直接写新文件。
   *
   * 实现是「写新文件 → 删旧文件」，而不是 `fs.rename`：
   *   · rename 要求旧文件**已存在**，而刚开的新会话还没落过盘（会 ENOENT）；
   *   · 覆盖已有目标在 Windows 上还得先 unlink，跨平台两边都得写分支；
   *   · 写新文件时父目录由 store `write()` 的 `mkdir(recursive)` 负责（`/save a/b` 可用）。
   * 中途被杀最多留下两份副本（可读、无损），不会丢内容。
   */
  async saveAs(id: string): Promise<string> {
    const previous = this.currentId;
    await persistSession({
      id,
      agentId: this.agentId,
      messages: this.agent.messages,
    });
    if (id === previous) return id; // 自己盖自己：不删
    // 旧文件不能留：同一份对话出现两条记录会让 `/load` 里分不清哪条是新的
    await (await sessionStore()).remove(previous);
    this.currentId = id;
    this.currentName = id;
    return id;
  }

  /** 释放事件监听（重建 Agent 时调用，避免监听器泄漏） */
  dispose(): void {
    for (const off of this.disposers.splice(0)) off();
    this.rate.reset();
    this.phaseTracker.reset();
  }

  // ==================== 内部：装配 Agent 与插件 ====================

  private async attach(agent: SdkAgent): Promise<void> {
    agent.use(new PhasePlugin(this.phaseTracker));
    agent.use(new CwdTrackerPlugin());
    agent.use(new AutoRefreshToolsPlugin());
    agent.use(
      new SessionPersistPlugin({
        getId: () => this.currentId,
        agentId: this.agentId,
        // 每轮自动落盘失败是真错误（用户会以为什么都没丢）—— 走 error 语气
        onError: (text) => this.notifier.onNotice(text, "error"),
      }),
    );

    if (this.tokenThresholds) {
      const { handoff, guard } = this.tokenThresholds;
      // 硬线：请求前用量超过 guard 即中断本轮（绝对值，不再有 ratio/放宽档）。
      // 交接/迁移回合本身就是"上下文最满"时才发起的，由护栏自己让行（谁做限制谁放宽）
      agent.use(
        new ContextGuardPlugin({
          guardTokens: guard,
          isSuspended: () => this.handoffService.busy,
        }),
      );
      agent.use(
        createAutoMigratePlugin({
          service: this.handoffService,
          handoffTokens: handoff,
          // TUI 下由 Ink 层提供执行者选择器；无选择通道时按默认执行者（原 agent 自交接）迁移
          shouldConfirm: () => Boolean(this.requestMode),
          choose: (info) => this.requestMode!(info),
          log: (text) => this.notifier.onNotice(text, "info"),
        }),
      );
      agent.use(new SubAgentGuardInstallerPlugin({ guardTokens: guard }));
    }

    this.wire(agent);
    await agent.init();
  }

  /**
   * 订阅 SDK 事件，仅把它们当作「messages 可能已变化」的信号：
   * - `chunk-parsed`（每片 delta 应用后）：高频 → 走合帧（`immediate=false`）；
   * - `open` / `parsed` / `finally`：轮次边界 → 立即上屏；
   * - `error`：转发到通知通道。
   */
  private wire(agent: SdkAgent): void {
    const notify = (immediate: boolean) => this.notifier.onChange(immediate);

    const onOpen = () => {
      this.phaseTracker.opened();
      notify(true);
    };
    /**
     * 每片 delta 应用后：除了通知重渲染，还要把这段文本计入速率统计。
     *
     * 子 Agent 的 chunk 也走这个回调（`onSubStart` 里同样订阅），因此速率包含
     * 委派出去的子任务输出——它们也是真实从网络接收的 token。
     */
    const onChunk = (_receiver: unknown, chunk: any) => {
      this.rate.addDelta(deltaText(chunk));
      // 流末 chunk 携带真实用量（`stream_options.include_usage`）：多轮工具调用逐轮累加
      this.rate.addExact(chunk?.usage?.completion_tokens);
      this.phaseTracker.delta(chunk);
      notify(false);
    };
    const onParsed = (receiver: unknown) => {
      // 该轮带工具调用 → 接下来是工具执行（模型不在跑），阶段转「等工具返回」
      this.phaseTracker.streamEnded(receiver);
      notify(true);
    };

    /** 子 Agent 的事件：只重绘，不推进主阶段（理由见 `onSubStart`） */
    const onSubOpen = () => notify(true);
    const onSubChunk = (_receiver: unknown, chunk: any) => {
      this.rate.addDelta(deltaText(chunk));
      this.rate.addExact(chunk?.usage?.completion_tokens);
      notify(false);
    };
    const onFinally = () => notify(true);
    const onError = (error: any) => {
      this.notifier.onNotice(error?.message ?? String(error), "error");
      notify(true);
    };
    /**
     * 单个工具结束（core 的 `tool-call-end`）：只当「该重绘了」的信号。
     *
     * 不在这里推阶段 —— 这一轮仍是 `tool-waiting`，变的只是「还在等谁」，那个由
     * `phase` 读取时算（见 `pendingPhase`）。没有这条订阅，并行工具里先完成的那个
     * 永远等不到重绘，标签就一直把已完成的名字念下去。
     */
    const onToolCallEnd = () => notify(true);

    const onSubStart = ({ subAgent }: SubAgentContext) => {
      // 执行状态内联到栏目标签（`●` / `✓` / `✖`），**不再推「子任务运行中」通知**：
      // 那种通知让通知栏凭空多出一行，整帧高度跟着跳。
      const index = ++this.subAgentSeq;
      const view: SubAgentView = {
        id: `sub-${++this.subAgentIdSeq}`,
        index,
        // 存的是数组引用：SDK 每次往实例里 push 消息，这里跟着变（与改造前等价）
        messages: subAgent.messages,
        status: "running",
      };
      this.subAgentViews.push(view);
      this.subAgentAgents.set(view.id, subAgent);
      // 记进 Agent 栏目：实例在委派结束后仍保留 messages，所以这里存引用即可随时回看。
      // 不看 `sub_agent_*` 与 `call_skill_sub_agent` 的差别——两条路径现在都走 core 的
      // AgentToolLazy，全部会在 onSubAgentStart 出现。
      // 子 Agent 的流只计入速率并触发重绘，**不推进主阶段**：此刻主 Agent 正在等
      // 这个工具（委派）返回，阶段应停在「等待 xxx 返回」；而子 Agent 自己的思考 / 输出
      // 是工具内部的事，拿它的 delta 去改主阶段，界面会变成「输出中」——正好盖掉了
      // 用户最需要知道的那句话。
      // 这里挂的监听**不需要**在 `onSubEnd` 撤销：子 Agent 实例是「每次委派新建」的
      // （core 的 `AgentTool.exec()` 里 `new Agent(...)`、`AgentToolLazy.exec()` 里
      // `buildAgent(...)`），随本次 run 结束回收，监听器跟着走。别为此再加 off。
      subAgent.events.on("open", onSubOpen);
      subAgent.events.on("chunk-parsed", onSubChunk);
      // 出错要落到标签上（✖）；错误信息仍送通知栏——那是错误，不是进度
      subAgent.events.on("error", (error: any) => {
        view.status = "failed";
        this.notifier.onNotice(error?.message ?? String(error), "error");
        notify(true);
      });
      notify(true);
    };
    const onSubEnd = ({ subAgent }: SubAgentContext) => {
      // 只把「还在跑」的置为完成：失败已由 error 监听标成 failed，不能被这里覆盖
      const view = this.viewOf(subAgent);
      if (view && view.status === "running") view.status = "done";
      notify(true);
    };

    agent.events.on("open", onOpen);
    agent.events.on("chunk-parsed", onChunk);
    agent.events.on("parsed", onParsed);
    agent.events.on("finally", onFinally);
    agent.events.on("error", onError);
    agent.events.on("sub-agent-start", onSubStart);
    agent.events.on("sub-agent-end", onSubEnd);
    agent.events.on("tool-call-end", onToolCallEnd);

    this.disposers.push(() => {
      agent.events.off("open", onOpen);
      agent.events.off("chunk-parsed", onChunk);
      agent.events.off("parsed", onParsed);
      agent.events.off("finally", onFinally);
      agent.events.off("error", onError);
      agent.events.off("sub-agent-start", onSubStart);
      agent.events.off("sub-agent-end", onSubEnd);
      agent.events.off("tool-call-end", onToolCallEnd);
    });
  }
}
