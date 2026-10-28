/**
 * 通知通道 —— 系统级提示（notice / error）的旁路，与对话转录严格分离。
 *
 * 为什么不能塞进 `agent.messages`：那份数组会被 `formatHistory()` **原样发给模型**，
 * 把「配置已更新 / 已中止 / 保存失败」这类 UI 提示写进去，等于往上下文里灌噪声，
 * 甚至带偏模型行为。所以 notice / error 走这条独立通道，由对话屏订阅后渲染到
 * 输入框上方的独立栏位，**绝不进入 messages**。
 *
 * ## 为什么是队列，而不是「只留最新一条」
 *
 * 订阅端一度是单值 state，于是 `push` 多次只有最后一条能显示。而实际存在两类连续推送：
 *
 *   1. **同一批摘要**（配置中心关闭时逐条 push 变更）→ 只剩最后一条，前面的变更说明丢失；
 *   2. **进度流**（交接 / 迁移分阶段 push）→ 阶段提示互相覆盖，用户看不到完整过程。
 *
 * 改为保留最近 {@link MAX_NOTICE_HISTORY} 条的队列，两类都能看见。同时第 1 类在调用侧
 * 会合成**一条多行**（见 `chat.tsx::closeWizard`），避免一批摘要把整个栏位占满；
 * 第 2 类本来就是流式的，各阶段自然各占一条。
 *
 * 纯逻辑、不依赖 React，可独立单测。
 */

import { wrapText } from "../text.js";

export interface Notice {
  text: string;
  tone: "info" | "error";
  /** 递增序号：同一文本重复推送也能被 React 依赖感知为「新通知」，用于渲染 key */
  seq: number;
}

/** 订阅回调收到的是**当前全部通知**（最近的在最后），而不是单个增量 */
export type NoticeListener = (notices: readonly Notice[]) => void;

/** 通知保留条数：新通知挤掉最旧的。进度类提示会连续到达，需要保留最近几步 */
export const MAX_NOTICE_HISTORY = 4;

/** 通知栏最多占用的行数（多条合计；超出时**整条**让位，不把通知劈成两半） */
export const MAX_NOTICE_LINES = 8;

/** 单条通知渲染出的一行（带 tone，供渲染侧逐行着色） */
export interface NoticeLine {
  text: string;
  tone: "info" | "error";
}

/** 通知队列：`push` 入队并广播整份队列，屏订阅后按队列渲染。 */
export class NoticeChannel {
  private seq = 0;
  private queue: Notice[] = [];
  private readonly listeners = new Set<NoticeListener>();

  /** 当前通知（最近的在最后）；组件可用它做 `useState` 的初值 */
  get notices(): readonly Notice[] {
    return this.queue;
  }

  /** 推入一条通知；空文本直接忽略（调用方常把错误消息直接透传进来） */
  push(text: string, tone: "info" | "error" = "info"): void {
    if (!text) return;
    const notice: Notice = { text, tone, seq: ++this.seq };
    this.queue = [...this.queue, notice].slice(-MAX_NOTICE_HISTORY);
    this.broadcast();
  }

  /** 清空（发送新消息 / `/clear` / 会话重建时调用，避免上一轮的提示一直挂着） */
  clear(): void {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.broadcast();
  }

  subscribe(listener: NoticeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(): void {
    for (const listener of this.listeners) listener(this.queue);
  }
}

/** 单条通知 → 若干行（首行带前缀，续行对齐缩进；条内超出上限以 … 收尾） */
function noticeBlockLines(notice: Notice, width: number): NoticeLine[] {
  const prefix = notice.tone === "error" ? "✖ " : "· ";
  const wrapped = wrapText(notice.text, width);
  const capped = wrapped.slice(0, MAX_NOTICE_LINES);
  if (capped.length > 0 && wrapped.length > capped.length) {
    capped[capped.length - 1] = `${capped[capped.length - 1]}…`;
  }
  return capped.map((line, index) => ({
    text: `  ${index === 0 ? prefix : "  "}${line}`,
    tone: notice.tone,
  }));
}

/**
 * 通知队列 → 栏位文本行（按显示宽度折行）。
 *
 * 总行数超过 {@link MAX_NOTICE_LINES} 时，从**最早**的通知开始整条让位 —— 保持每条
 * 通知的自洽（不会看到半条「已迁移」），也保证栏位高度有确定上限（布局按行数预留空间）。
 */
export function noticeLines(notices: readonly Notice[], columns: number): NoticeLine[] {
  const width = Math.max(4, columns - 4);
  const blocks: NoticeLine[][] = [];
  for (const notice of notices) {
    if (!notice.text) continue;
    blocks.push(noticeBlockLines(notice, width));
  }

  let start = 0;
  let total = blocks.reduce((sum, block) => sum + block.length, 0);
  while (total > MAX_NOTICE_LINES && start < blocks.length - 1) {
    total -= blocks[start]!.length;
    start += 1;
  }
  const kept = blocks.slice(start).flat();
  // 兜底：只剩一条也放不下时（单条已被 noticeBlockLines 封顶，正常走不到），保尾部
  return kept.length > MAX_NOTICE_LINES ? kept.slice(kept.length - MAX_NOTICE_LINES) : kept;
}
