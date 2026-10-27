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
import type { SubAgentContext } from "@ai-zen/agents-core";
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
import { CwdTrackerPlugin } from "../cwd-tracker-plugin.js";
import { ConversationPersistPlugin } from "../conversation-persist-plugin.js";
import { SubAgentGuardInstallerPlugin } from "../sub-agent-guard-plugin.js";
import type { TokenThresholds } from "@ai-zen/agents-sdk";
import { createAutoMigratePlugin } from "../auto-migrate-confirm.js";
import { createHandoffService } from "../handoff-service.js";
import { conversationRepository, generateConversationId } from "../conversation-repository.js";
import { writeLastSession } from "../session-pointer.js";
import type { ConversationContext } from "../types.js";
import { stripCwdNote } from "./text.js";
import { TokenRateMeter, deltaText, type RateSample } from "./token-rate.js";

/** 会话 → UI 的对外信号 */
export interface ChatSessionNotifier {
  /** 转录可能已变化（内容以 `agent.messages` 为准）；`immediate=true` 表示应立即上屏 */
  onChange(immediate: boolean): void;
  /** 系统级提示（notice / error），走独立栏位，绝不进 messages */
  onNotice(text: string, tone: "info" | "error"): void;
}

export interface ChatSessionOptions {
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
  /**
   * 自动迁移时的执行者选择（由 Ink 层弹出选择器实现）。
   * 返回 `null` 表示跳过本次迁移；未提供时按默认执行者（原 agent 自交接）直接迁移。
   */
  requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
}

/** 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示（转发自 ./text.js） */
export { stripCwdNote };

export class ChatSession {
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
   * 会话 id / 名称的**唯一真相源是 `ctx`**（`ConversationContext`）。
   *
   * 为什么必须代理而不是各存一份：自动迁移由 SDK 的 `AutoMigratePlugin` 直接驱动
   * `HandoffService.migrate()`，**不经过本类任何方法**，新 id 只会写进 `ctx.currentId`
   * （`onMigrated` 钩子）。若本类另持一份 `currentId`，自动迁移后它就停在旧值上，
   * 而 `ConversationPersistPlugin.getId()` 读的正是这份旧值——于是 prune 之后的
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
  private readonly ctx: ConversationContext;
  private readonly handoffService: HandoffService;
  private readonly notifier: ChatSessionNotifier;
  private readonly requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
  private readonly disposers: Array<() => void> = [];
  /** 生成过程的 token 速率统计（状态栏展示，见 `token-rate.ts`） */
  private readonly rate = new TokenRateMeter();

  private constructor(
    handoffService: HandoffService,
    ctx: ConversationContext,
    options: ChatSessionOptions,
    tokenThresholds: TokenThresholds | undefined,
    notifier: ChatSessionNotifier,
  ) {
    this.handoffService = handoffService;
    this.ctx = ctx;
    this.agentId = options.agentId || "default";
    this.tokenThresholds = tokenThresholds;
    this.currentId = ctx.currentId || generateConversationId();
    this.currentName = ctx.currentName;
    this.notifier = notifier;
    this.requestMode = options.requestMode;
  }

  /** 创建会话：装配 Agent、插件与「变更信号」 */
  static async create(
    options: ChatSessionOptions,
    notifier: ChatSessionNotifier,
  ): Promise<ChatSession> {
    const config = await readConfig();

    // 先建 Agent：模型来自 Agent 定义（`createAgent` 内部解析 modelId），
    // 阈值再按该模型查配置——不存在「CLI 以为的模型」与「实发模型」两套值。
    const agent = await createAgent({ messages: options.messages, agentId: options.agentId });
    const model = config.models.find((m) => m.id === agent.definition.modelId);
    // 阈值由配置直接给出（旧字段已在 SDK 的 ConfigManager.read() 里迁移过）
    const tokenThresholds = model?.tokenThresholds;

    const currentId = options.conversationId || generateConversationId();
    const ctx: ConversationContext = {
      agent,
      input: "",
      currentName: options.conversationName || currentId,
      currentId,
      agentId: options.agentId,
      running: true,
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

  /** 发送一条消息；内容变化经 `notifier.onChange` 通知，`resolve` 表示本轮结束 */
  async send(input: string): Promise<void> {
    this.rate.begin();
    try {
      await this.agent.send(input);
    } catch (error: any) {
      this.notifier.onNotice(error?.message ?? String(error), "error");
    } finally {
      this.rate.finish();
      this.notifier.onChange(true);
    }
  }

  /** 中止当前请求（Ctrl+C 语义：仅取消本轮，不退出） */
  abort(): void {
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
    const agent = await createAgent({
      agentId: this.agentId === "default" ? undefined : this.agentId,
    });
    this.agent = agent;
    this.ctx.agent = agent;
    this.currentId = generateConversationId();
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
    await resetScope();
    const agent = await createAgent({
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
    const ctx = await this.handoffService.migrate({
      agent: this.agent,
      mode,
      conversationId: this.currentId,
    });
    // 迁移后服务会开启新会话：新 id 已写进 ctx（唯一真相源），这里只需同步名称并刷新界面
    this.currentName = this.currentId;
    this.notifier.onChange(true);
    return ctx.handoffPath;
  }

  /**
   * 只产出交接文档（`/handoff`）：不切换会话、不改动历史。
   *
   * 交接回合（指令 + 工具调用 + 回执）会留在 `agent.messages` 里，
   * 用户可继续要求细化同一份文档（重写同一路径即可）。
   */
  async handoff(mode?: HandoffMode): Promise<string> {
    if (!this.messages.some((m) => m.role === AgentNS.Role.User)) {
      throw new Error(t("chat.noHandoffable"));
    }
    const ctx = await this.handoffService.handoff({
      agent: this.agent,
      mode,
      conversationId: this.currentId,
    });
    this.notifier.onChange(true);
    return ctx.handoffPath;
  }

  /** 撤回：删除索引 index 起的消息，返回被撤回的首条用户消息文本（用于预填输入） */
  rollbackTo(index: number): string {
    if (index < 0 || index >= this.agent.messages.length) return "";
    const removed = this.agent.messages.splice(index);
    const firstUser = removed.find((m) => m.role === AgentNS.Role.User);
    if (typeof firstUser?.content !== "string") return "";
    return stripCwdNote(firstUser.content);
  }

  /** 保存当前对话到存档 */
  async save(): Promise<string> {
    const id = this.currentId;
    const existing = await conversationRepository.read(id);
    const now = new Date().toISOString();
    await conversationRepository.write({
      id,
      agentId: this.agentId,
      messages: this.agent.messages,
      cwd: process.cwd(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await writeLastSession(process.cwd(), id);
    return id;
  }

  /** 释放事件监听（重建 Agent 时调用，避免监听器泄漏） */
  dispose(): void {
    for (const off of this.disposers.splice(0)) off();
    this.rate.reset();
  }

  // ==================== 内部：装配 Agent 与插件 ====================

  private async attach(agent: SdkAgent): Promise<void> {
    agent.use(new CwdTrackerPlugin());
    agent.use(new AutoRefreshToolsPlugin());
    agent.use(
      new ConversationPersistPlugin({
        getId: () => this.currentId,
        agentId: this.agentId,
        cwd: process.cwd(),
        onError: (text) => this.notifier.onNotice(text, "info"),
      }),
    );

    if (this.tokenThresholds) {
      const { handoff, guard } = this.tokenThresholds;
      // 硬线：请求前用量超过 guard 即中断本轮（绝对值，不再有 ratio/放宽档）
      agent.use(new ContextGuardPlugin({ guardTokens: guard }));
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

    const onOpen = () => notify(true);
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
      notify(false);
    };
    const onParsed = () => notify(true);
    const onFinally = () => notify(true);
    const onError = (error: any) => {
      this.notifier.onNotice(error?.message ?? String(error), "error");
      notify(true);
    };

    const onSubStart = ({ subAgent, toolCallContext }: SubAgentContext) => {
      const name = toolCallContext?.tool_call?.function?.name || t("chat.subagentLabel");
      this.notifier.onNotice(t("chat.subagentRunning", { name }), "info");
      subAgent.events.on("open", onOpen);
      subAgent.events.on("chunk-parsed", onChunk);
      subAgent.events.on("error", onError);
      notify(true);
    };
    const onSubEnd = ({ toolCallContext }: SubAgentContext) => {
      const name = toolCallContext?.tool_call?.function?.name || t("chat.subagentLabel");
      // 子 Agent 的用量由 core 在委派边界钉到父侧 tool 消息的 subAgentUsage 上，
      // 故此处只需提示，累计经 sumUsage(agent.messages) 自然包含
      this.notifier.onNotice(t("chat.subagentDone", { name }), "info");
      notify(true);
    };

    agent.events.on("open", onOpen);
    agent.events.on("chunk-parsed", onChunk);
    agent.events.on("parsed", onParsed);
    agent.events.on("finally", onFinally);
    agent.events.on("error", onError);
    agent.events.on("sub-agent-start", onSubStart);
    agent.events.on("sub-agent-end", onSubEnd);

    this.disposers.push(() => {
      agent.events.off("open", onOpen);
      agent.events.off("chunk-parsed", onChunk);
      agent.events.off("parsed", onParsed);
      agent.events.off("finally", onFinally);
      agent.events.off("error", onError);
      agent.events.off("sub-agent-start", onSubStart);
      agent.events.off("sub-agent-end", onSubEnd);
    });
  }
}
