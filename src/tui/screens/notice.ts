/**
 * 通知通道 —— 系统级提示（notice / error）的旁路，与对话转录严格分离。
 *
 * 为什么不能塞进 `agent.messages`：那份数组会被 `formatHistory()` **原样发给模型**，
 * 把「配置已更新 / 已中止 / 保存失败」这类 UI 提示写进去，等于往上下文里灌噪声，
 * 甚至带偏模型行为。所以 notice / error 走这条独立通道，由对话屏订阅后渲染到
 * 输入框上方的独立栏位，**绝不进入 messages**。
 *
 * 纯逻辑、不依赖 React，可独立单测。
 */

import { wrapText } from "../text.js";

export interface Notice {
  text: string;
  tone: "info" | "error";
  /** 递增序号：同一文本重复推送也能被 React 依赖感知为「新通知」 */
  seq: number;
}

export type NoticeListener = (notice: Notice) => void;

/** 通知通道：`push` 广播，屏订阅。 */
export class NoticeChannel {
  private seq = 0;
  private readonly listeners = new Set<NoticeListener>();

  push(text: string, tone: "info" | "error" = "info"): void {
    const notice: Notice = { text, tone, seq: ++this.seq };
    for (const listener of this.listeners) listener(notice);
  }

  subscribe(listener: NoticeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** 通知栏最多占用的行数（超出以 … 收尾），避免长输出把对话区挤没 */
export const MAX_NOTICE_LINES = 8;

/**
 * 通知 → 栏位文本行（按显示宽度折行、封顶）。
 * 首行带前缀（info `· ` / error `✖ `），其余行对齐缩进。
 */
export function noticeLines(notice: Notice, columns: number): string[] {
  if (!notice.text) return [];
  const width = Math.max(4, columns - 4);
  const prefix = notice.tone === "error" ? "✖ " : "· ";
  const wrapped = wrapText(notice.text, width);
  const capped = wrapped.slice(0, MAX_NOTICE_LINES);
  if (wrapped.length > MAX_NOTICE_LINES && capped.length > 0) {
    capped[capped.length - 1] = `${capped[capped.length - 1]}…`;
  }
  return capped.map((line, i) => `  ${i === 0 ? prefix : "  "}${line}`);
}
