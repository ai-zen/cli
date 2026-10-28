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

/** 通知语气：info 普通提示 / warn 警告（不影响使用但需看一眼）/ error 错误 */
export type NoticeTone = "info" | "warn" | "error";

export interface Notice {
  text: string;
  tone: NoticeTone;
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
  tone: NoticeTone;
}

/** 通知队列：`push` 入队并广播整份队列，屏订阅后按队列渲染。 */
export class NoticeChannel {
  private seq = 0;
  private queue: Notice[] = [];
  private readonly listeners = new Set<NoticeListener>();

  /** 当前通知（最近的在最后）；组件用它做 `useState` 的初值。
   *
   * 返回**副本**：`readonly` 只在编译期生效，直接交给外部等于把内部队列的引用
   * 泄出去（对方一次 `push` 就能绕开 `MAX_NOTICE_HISTORY`）。
   */
  get notices(): readonly Notice[] {
    return [...this.queue];
  }

  /** 推入一条通知；空文本直接忽略（调用方常把错误消息直接透传进来） */
  push(text: string, tone: NoticeTone = "info"): void {
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

/** 单条通知 → 若干行（按列宽折行；条内超出上限以 … 收尾）
 *
 * **不加任何行首装饰**：既不带缩进，也不带 `· ` / `✖ ` 前缀。横向定位全部交给
 * `NoticeBar` 的 `paddingX`，于是通知文本与分隔线、输入行左对齐；语气差异由
 * {@link NoticeLine.tone} 的着色表达（info 暗、error 红），不需要符号占位。
 * 多行通知（如迁移完成 + 文档路径）每行都从行首开始，不另加续行缩进。
 */
function noticeBlockLines(notice: Notice, width: number): NoticeLine[] {
  const wrapped = wrapText(notice.text, width);
  const capped = wrapped.slice(0, MAX_NOTICE_LINES);
  if (capped.length > 0 && wrapped.length > capped.length) {
    capped[capped.length - 1] = `${capped[capped.length - 1]}…`;
  }
  return capped.map((text) => ({ text, tone: notice.tone }));
}

/**
 * 通知队列 → 栏位文本行（按显示宽度折行）。
 *
 * 总行数超过 {@link MAX_NOTICE_LINES} 时，从**最早**的通知开始整条让位 —— 保持每条
 * 通知的自洽（不会看到半条「已迁移」），也保证栏位高度有确定上限（布局按行数预留空间）。
 */
export function noticeLines(notices: readonly Notice[], columns: number): NoticeLine[] {
  // 行宽留给容器 paddingX（左右各 1）+ 1 列余量，避免贴边被 Ink 再折一行
  const width = Math.max(4, columns - 3);
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
  // 单条已被 `noticeBlockLines` 封顶到 MAX_NOTICE_LINES，而上面的循环保证至少留下最后一条，
  // 所以合计行数必然 ≤ 上限——不需要再截一次
  return blocks.slice(start).flat();
}
