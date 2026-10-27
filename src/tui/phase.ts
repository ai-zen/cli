/**
 * 生成阶段 —— 消息栏那一行提示的六态判定（纯逻辑，不依赖 React / Ink / SDK）
 *
 * 原先那里只有一个「思考中…」，但一轮对话里模型实际会走过几个阶段，用同一个词概括
 * 在多数时候是**说错话**：等首 token 时并没有在思考，工具执行时更是模型根本没在跑。
 * 于是按数据来源把阶段拆细：
 *
 * | 阶段 | 判据 | 用户真正关心什么 |
 * |------|------|------------------|
 * | `connecting` | `onInnerLoopStart`（请求即将发出）→ `open`（响应头到达） | 是不是网络卡住了 |
 * | `queued` | `open` 之后、首个内容 chunk 之前 | 服务端排队 / 冷启动，还没开始吐字 |
 * | `thinking` | 收到 `reasoning_content` delta | 推理模型中 |
 * | `tool-calling` | 收到 `tool_calls` / `function_call` delta | 模型正在决定调哪个工具、拼参数 |
 * | `tool-waiting` | 流结束（`parsed`）且该轮带工具调用 | 工具在执行，等结果回来才能继续 |
 * | `streaming` | 收到 `content` delta | 正在输出正文 |
 *
 * 判据只用**事件与 delta 的形状**，不读文案、不猜时序；多轮工具调用时阶段会自然
 * 回到 `connecting`（下一轮请求前由插件钩子重置）。
 */

import { t } from "../i18n/index.js";

/** 生成阶段（见文件头表格） */
export type PhaseKind =
  | "connecting"
  | "queued"
  | "thinking"
  | "tool-calling"
  | "tool-waiting"
  | "streaming";

export interface PhaseInfo {
  kind: PhaseKind;
  /** 工具名（`tool-calling` / `tool-waiting` 时有值；流式早期可能还没吐到 name） */
  tool?: string;
}

/**
 * 阶段跟踪器。生命周期由 `ChatSession` 驱动：
 * `connecting()` → `opened()` → 若干 `delta()` → `streamEnded()` →（下一轮）`connecting()` …
 * 一轮结束调 `reset()`。
 */
export class PhaseTracker {
  private current: PhaseInfo | null = null;

  /** 当前阶段；空闲（没有在生成的轮次）时为 null */
  get phase(): PhaseInfo | null {
    return this.current;
  }

  /** 清空（一轮结束 / 重建会话时调用） */
  reset(): void {
    this.current = null;
  }

  /** 请求已发出、等响应头（DNS / TCP / TLS / 服务端受理都在这一段） */
  connecting(): void {
    this.current = { kind: "connecting" };
  }

  /**
   * 响应头已到（SDK 的 `open` 事件）——连接建立，进入「等首 token」。
   *
   * 注意不能在这里直接进 `thinking`：`open` 只说明服务端受理了请求，
   * 推理模型冷启动排几十秒是常事，那段等待被叫成「思考中」就是在骗人。
   */
  opened(): void {
    this.current = { kind: "queued" };
  }

  /**
   * 收到一个流式 chunk：按 delta 的实际内容推进阶段。
   *
   * 优先级是 `tool_calls` > `content` > `reasoning_content`：一个 chunk 里同时出现
   * 时，靠后的才代表「模型现在在干什么」（决定调工具 → 工具参数；已经出正文 →
   * 思考阶段结束）。三者都没有（如只带 `usage` 的收尾 chunk）则保持原阶段不变。
   */
  delta(chunk: unknown): void {
    const delta = (chunk as any)?.choices?.[0]?.delta;
    if (!delta || typeof delta !== "object") return;

    const toolCall = Array.isArray(delta.tool_calls) ? delta.tool_calls[0] : undefined;
    if (toolCall || delta.function_call) {
      // 工具名只在首个 delta 里给出，后续 delta 只带参数片段 → 沿用已知的名字
      const name: string | undefined =
        toolCall?.function?.name || delta.function_call?.name || this.current?.tool;
      this.current = { kind: "tool-calling", tool: name || undefined };
      return;
    }
    if (delta.content) {
      this.current = { kind: "streaming" };
      return;
    }
    if (delta.reasoning_content) {
      this.current = { kind: "thinking" };
    }
  }

  /**
   * 流结束（SDK 的 `parsed` 事件，参数是本轮 assistant 消息）。
   *
   * 本轮带工具调用 → 接下来是工具执行，模型不在跑；不带 → 由调用方 `reset()`。
   */
  streamEnded(receiver: unknown): void {
    const message = receiver as any;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0 && !message?.function_call) return;
    const name: string | undefined =
      calls[0]?.function?.name || message?.function_call?.name || this.current?.tool;
    this.current = { kind: "tool-waiting", tool: name || undefined };
  }
}

/** 阶段对应的提示文案（中英由词典决定，这里只做分发） */
export function phaseLabel(phase: PhaseInfo | null): string {
  if (!phase) return t("phase.working");
  switch (phase.kind) {
    case "connecting":
      return t("phase.connecting");
    case "queued":
      return t("phase.queued");
    case "thinking":
      return t("phase.thinking");
    case "streaming":
      return t("phase.streaming");
    case "tool-calling":
      return phase.tool
        ? t("phase.toolCallingWith", { name: phase.tool })
        : t("phase.toolCalling");
    case "tool-waiting":
      return phase.tool
        ? t("phase.toolWaitingWith", { name: phase.tool })
        : t("phase.toolWaiting");
  }
}
