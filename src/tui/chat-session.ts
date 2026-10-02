/**
 * TUI 对话会话 —— Agent 装配与结构化流式事件
 *
 * 与旧的行式渲染器（`src/conversation-runner.ts`）不同，这里把流式 delta
 * 翻译成**结构化事件**交给 React 层渲染，而非直接写 stdout，从而支持 Ink 的
 * 可控重绘（增量、无撕裂）。
 *
 * 本模块不依赖 React / Ink，可独立单测。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { SubAgentContext } from "@ai-zen/agents-core";
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

/** 流式事件：由 React 层消费并拼接成消息块 */
export type ChatEvent =
  | { type: "user"; text: string }
  | { type: "assistant-start" }
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "tool"; index: number; name?: string; args?: string }
  | { type: "subagent-start"; name: string }
  | { type: "subagent-end"; name: string }
  | { type: "notice"; text: string }
  | { type: "error"; text: string }
  | { type: "done" };

export type ChatEventHandler = (e: ChatEvent) => void;

export interface ChatSessionOptions {
  modelId: string;
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
  /** 自动迁移二次确认（由 Ink 层弹出确认框实现） */
  requestConfirm?: (question: string) => Promise<boolean>;
}

/** 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示 */
export function stripCwdNote(text: string): string {
  return text.replace(/\n+(?:\[工作目录变更\]\n)?当前工作目录: [^\n]*$/, "");
}

export class ChatSession {
  readonly modelId: string;
  readonly agentId: string;
  readonly maxTokens?: number;

  currentName: string;
  currentId: string;

  private agent!: SdkAgent;
  private readonly ctx: ConversationContext;
  private readonly migrationService: TaskMigrationService;
  private readonly onEvent: ChatEventHandler;
  private readonly requestConfirm?: (q: string) => Promise<boolean>;
  private readonly disposers: Array<() => void> = [];

  private constructor(
    migrationService: TaskMigrationService,
    ctx: ConversationContext,
    options: ChatSessionOptions,
    maxTokens: number | undefined,
    onEvent: ChatEventHandler,
  ) {
    this.migrationService = migrationService;
    this.ctx = ctx;
    this.modelId = options.modelId;
    this.agentId = options.agentId || "default";
    this.maxTokens = maxTokens;
    this.currentId = ctx.currentId || generateConversationId();
    this.currentName = ctx.currentName;
    this.onEvent = onEvent;
    this.requestConfirm = options.requestConfirm;
  }

  /** 创建会话：装配 Agent、插件与流式事件 */
  static async create(
    options: ChatSessionOptions,
    onEvent: ChatEventHandler,
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
      // 迁移进度/结果经 Ink 渲染为 notice 块，避免直接写 stdout 撕裂画面
      log: (text) => onEvent({ type: "notice", text }),
    });
    ctx.migrationService = migrationService;

    const session = new ChatSession(migrationService, ctx, options, maxTokens, onEvent);
    session.agent = agent;
    await session.attach(agent);
    return session;
  }

  get messages(): AgentNS.Message[] {
    return this.agent.messages;
  }

  /** 最近一次响应的 token 用量 */
  get lastUsage(): AgentNS.Usage | undefined {
    return this.agent.lastUsage;
  }

  /** 发送一条消息；事件通过 `onEvent` 持续回传；resolve 表示本轮结束 */
  async send(input: string): Promise<void> {
    this.onEvent({ type: "user", text: input });
    try {
      await this.agent.send(input);
    } catch (error: any) {
      this.onEvent({ type: "error", text: error?.message ?? String(error) });
    } finally {
      this.onEvent({ type: "done" });
    }
  }

  /** 中止当前请求（Ctrl+C 语义：仅取消本轮，不退出） */
  abort(): void {
    this.agent.abort();
  }

  /** 重置会话（/new）：清空历史并重建 Agent */
  async reset(): Promise<void> {
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
    await this.attach(agent);
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
    await writeLastSession(id);
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
        onError: (text) => this.onEvent({ type: "notice", text }),
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
          log: (text) => this.onEvent({ type: "notice", text }),
        }),
      );
      agent.use(new SubAgentGuardInstallerPlugin({ maxTokens: this.maxTokens }));
    }

    this.wire(agent);
    await agent.init();
  }

  private wire(agent: SdkAgent): void {
    const onOpen = () => this.onEvent({ type: "assistant-start" });
    const onChunk = (chunk: AgentNS.StreamResponseData) => this.emitDelta(chunk);
    const onError = (error: any) =>
      this.onEvent({ type: "error", text: error?.message ?? String(error) });

    const onSubStart = ({ subAgent, toolCallContext }: SubAgentContext) => {
      const name = toolCallContext?.tool_call?.function?.name || "子任务";
      this.onEvent({ type: "subagent-start", name });
      subAgent.events.on("open", onOpen);
      subAgent.events.on("chunk", onChunk);
      subAgent.events.on("error", onError);
    };
    const onSubEnd = ({ toolCallContext }: SubAgentContext) => {
      const name = toolCallContext?.tool_call?.function?.name || "子任务";
      this.onEvent({ type: "subagent-end", name });
    };

    agent.events.on("open", onOpen);
    agent.events.on("chunk", onChunk);
    agent.events.on("error", onError);
    agent.events.on("sub-agent-start", onSubStart);
    agent.events.on("sub-agent-end", onSubEnd);

    this.disposers.push(() => {
      agent.events.off("open", onOpen);
      agent.events.off("chunk", onChunk);
      agent.events.off("error", onError);
      agent.events.off("sub-agent-start", onSubStart);
      agent.events.off("sub-agent-end", onSubEnd);
    });
  }

  /** 把流式 delta 翻译为结构化事件 */
  private emitDelta(chunk: AgentNS.StreamResponseData): void {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;

    if (delta.reasoning_content) {
      this.onEvent({ type: "reasoning", text: delta.reasoning_content });
    }

    if (delta.content) {
      if (typeof delta.content === "string") {
        this.onEvent({ type: "content", text: delta.content });
      } else if (Array.isArray(delta.content)) {
        for (const part of delta.content) {
          if (part.type === "text" && part.text) {
            this.onEvent({ type: "content", text: part.text });
          } else if (part.type === "image_url") {
            this.onEvent({ type: "notice", text: `[图片: ${part.image_url.url}]` });
          }
        }
      }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        this.onEvent({
          type: "tool",
          index: tc.index ?? 0,
          name: tc.function?.name,
          args: tc.function?.arguments,
        });
      }
    }
  }
}
