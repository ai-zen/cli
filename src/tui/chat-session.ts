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

import { AgentNS } from "@ai-zen/agents-core";
import type { SubAgentContext } from "@ai-zen/agents-core";
import { addUsage, sumMessagesUsage, ZERO_USAGE } from "../usage.js";

import {
  AutoRefreshToolsPlugin,
  ContextGuardPlugin,
  type SdkAgent,
  type TaskMigrationService,
} from "@ai-zen/agents-sdk";
import { createAgent, resetScope } from "../agent-creator.js";
import { readConfig } from "../config.js";
import { CwdTrackerPlugin } from "../cwd-tracker-plugin.js";
import { ConversationPersistPlugin } from "../conversation-persist-plugin.js";
import { SubAgentGuardInstallerPlugin } from "../sub-agent-guard-plugin.js";
import { AutoMigrateConfirmPlugin } from "../auto-migrate-confirm-plugin.js";
import { createMigrationService } from "../migration-service.js";
import { conversationRepository, generateConversationId } from "../conversation-repository.js";
import { writeLastSession } from "../session-pointer.js";
import type { ConversationContext } from "../types.js";
import { stripCwdNote } from "./text.js";

/** 会话 → UI 的对外信号 */
export interface ChatSessionNotifier {
  /** 转录可能已变化（内容以 `agent.messages` 为准）；`immediate=true` 表示应立即上屏 */
  onChange(immediate: boolean): void;
  /** 系统级提示（notice / error），走独立栏位，绝不进 messages */
  onNotice(text: string, tone: "info" | "error"): void;
}

export interface ChatSessionOptions {
  modelId: string;
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
  /** 自动迁移二次确认（由 Ink 层弹出确认框实现） */
  requestConfirm?: (question: string) => Promise<boolean>;
}

/** 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示（转发自 ./text.js） */
export { stripCwdNote };

export class ChatSession {
  readonly modelId: string;
  readonly agentId: string;
  readonly maxTokens?: number;

  currentName: string;
  currentId: string;

  private agent!: SdkAgent;
  private readonly ctx: ConversationContext;
  private readonly migrationService: TaskMigrationService;
  private readonly notifier: ChatSessionNotifier;
  private readonly requestConfirm?: (q: string) => Promise<boolean>;
  private readonly disposers: Array<() => void> = [];

  /**
   * 子 Agent 累计用量。
   * 子 Agent 是独立 Agent 实例，其 messages 不在父 Agent 的 messages 中，
   * 故在每次委派结束（onSubAgentEnd）时单独累加；会话重置（/new）时归零。
   */
  private subAgentUsage: AgentNS.Usage = { ...ZERO_USAGE };

  private constructor(
    migrationService: TaskMigrationService,
    ctx: ConversationContext,
    options: ChatSessionOptions,
    maxTokens: number | undefined,
    notifier: ChatSessionNotifier,
  ) {
    this.migrationService = migrationService;
    this.ctx = ctx;
    this.modelId = options.modelId;
    this.agentId = options.agentId || "default";
    this.maxTokens = maxTokens;
    this.currentId = ctx.currentId || generateConversationId();
    this.currentName = ctx.currentName;
    this.notifier = notifier;
    this.requestConfirm = options.requestConfirm;
  }

  /** 创建会话：装配 Agent、插件与「变更信号」 */
  static async create(
    options: ChatSessionOptions,
    notifier: ChatSessionNotifier,
  ): Promise<ChatSession> {
    const config = await readConfig();
    const model = config.models.find((m) => m.id === options.modelId);
    const maxTokens =
      model?.maxContextTokens ??
      (model?.maxContextChars ? Math.floor(model.maxContextChars / 4) : undefined);

    const agent = await createAgent({ messages: options.messages, agentId: options.agentId });
    const currentId = options.conversationId || generateConversationId();
    const ctx: ConversationContext = {
      agent,
      input: "",
      currentName: options.conversationName || currentId,
      currentId,
      modelId: options.modelId,
      agentId: options.agentId,
      running: true,
    };
    const migrationService = createMigrationService(ctx, {
      // 迁移进度/结果经通知通道渲染，避免直接写 stdout 撕裂画面
      log: (text) => notifier.onNotice(text, "info"),
    });
    ctx.migrationService = migrationService;

    const session = new ChatSession(migrationService, ctx, options, maxTokens, notifier);
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
   * 本会话累计 token 用量 = 父 Agent 全部 assistant 消息的 usage 之和 + 子 Agent 累计。
   *
   * 每轮请求都会重发完整历史，故「各 assistant 消息 usage 之和」即计费口径的累计消耗。
   */
  get totalUsage(): AgentNS.Usage {
    return addUsage(sumMessagesUsage(this.agent.messages), this.subAgentUsage);
  }

  /** 发送一条消息；内容变化经 `notifier.onChange` 通知，`resolve` 表示本轮结束 */
  async send(input: string): Promise<void> {
    try {
      await this.agent.send(input);
    } catch (error: any) {
      this.notifier.onNotice(error?.message ?? String(error), "error");
    } finally {
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
    this.ctx.currentId = this.currentId;
    this.currentName = this.currentId;
    this.ctx.currentName = this.currentName;
    this.subAgentUsage = { ...ZERO_USAGE };
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

  /** 手动任务迁移（/migrate）：与自动迁移共用同一服务实例 */
  async migrate(): Promise<void> {
    if (!this.messages.some((m) => m.role === AgentNS.Role.User)) {
      throw new Error("当前对话还没有可迁移的内容");
    }
    await this.migrationService.migrate({ agent: this.agent });
    // 迁移后服务会开启新会话，同步会话元信息
    this.currentName = this.ctx.currentName;
    this.currentId = this.ctx.currentId ?? generateConversationId();
    this.notifier.onChange(true);
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
      modelId: this.modelId,
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
  }

  // ==================== 内部：装配 Agent 与插件 ====================

  private async attach(agent: SdkAgent): Promise<void> {
    agent.use(new CwdTrackerPlugin());
    agent.use(new AutoRefreshToolsPlugin());
    agent.use(
      new ConversationPersistPlugin({
        getId: () => this.currentId,
        agentId: this.agentId,
        modelId: this.modelId,
        cwd: process.cwd(),
        onError: (text) => this.notifier.onNotice(text, "info"),
      }),
    );

    if (this.maxTokens && this.maxTokens > 0) {
      agent.use(new ContextGuardPlugin({ maxTokens: this.maxTokens }));
      agent.use(
        new AutoMigrateConfirmPlugin({
          service: this.migrationService,
          maxTokens: this.maxTokens,
          // TUI 下由 Ink 层提供确认通道
          shouldConfirm: () => Boolean(this.requestConfirm),
          confirm: (info) =>
            this.requestConfirm!(
              `上下文即将超限（${info.promptTokens}/${info.maxTokens} tokens），是否立即执行任务迁移？`,
            ),
          log: (text) => this.notifier.onNotice(text, "info"),
        }),
      );
      agent.use(new SubAgentGuardInstallerPlugin({ maxTokens: this.maxTokens }));
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
    const onChunk = () => notify(false);
    const onParsed = () => notify(true);
    const onFinally = () => notify(true);
    const onError = (error: any) => {
      this.notifier.onNotice(error?.message ?? String(error), "error");
      notify(true);
    };

    const onSubStart = ({ subAgent, toolCallContext }: SubAgentContext) => {
      const name = toolCallContext?.tool_call?.function?.name || "子任务";
      this.notifier.onNotice(`🧩 子任务 ${name} 运行中…`, "info");
      subAgent.events.on("open", onOpen);
      subAgent.events.on("chunk-parsed", onChunk);
      subAgent.events.on("error", onError);
      notify(true);
    };
    const onSubEnd = ({ subAgent, toolCallContext }: SubAgentContext) => {
      const name = toolCallContext?.tool_call?.function?.name || "子任务";
      // 子 Agent 的 messages 不在父 Agent 中，委派结束时把它的用量并入本会话累计
      this.subAgentUsage = addUsage(
        this.subAgentUsage,
        sumMessagesUsage(subAgent.messages),
      );
      this.notifier.onNotice(`✓ 子任务 ${name} 完成`, "info");
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
