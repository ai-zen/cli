/**
 * 流式事件合帧缓冲 —— 把高频的流式 delta 合并为低频「帧」再交给 React 上屏。
 *
 * 背景：AI 流式响应每秒可产生数十到上百个 delta。若每个 delta 都触发一次 React
 * 更新，等价于每个 delta 一次「全量布局重算（含语法高亮 / 折行）+ 整屏重绘」。
 * Ink 每帧输出的是**整屏**（先擦除旧帧再写新帧，见 `ink/build/ink.js`），并不做
 * 行级差分；在 SSH 弱网（低带宽 / 高延迟）下，这会迅速填满 pty 缓冲、阻塞
 * stdout（Linux 上 TTY 写是同步阻塞的），表现为界面卡死，甚至把连接拖断。
 *
 * 本模块把 delta 先攒进缓冲，按固定间隔（默认 {@link STREAM_FRAME_MS} 毫秒，
 * 约 16fps）批量吐出；`user` / `done` / `error` 这类需要即时反馈或收尾的事件则
 * 立即上屏（flush），避免「按下回车半天不显示」或「回答完了还在转圈」。
 *
 * 纯逻辑、不依赖 React，可独立单测。
 */

/**
 * 合帧间隔（毫秒）：约 16fps。
 *
 * 刻意**低于** Ink 默认的 30fps 输出节流，让「主动合帧」成为上屏频率的主控，
 * 而不是叠加在 Ink 节流之上。
 */
export const STREAM_FRAME_MS = 60;

/**
 * 需要立即上屏（不等下一帧）的事件类型：
 * - `user`：回车即回显，交互反馈不能延迟；
 * - `done` / `error`：本轮收尾 / 报错，立刻落定，避免「结束还挂着 spinner」。
 */
export function isImmediateEvent(type: string): boolean {
  return type === "user" || type === "done" || type === "error";
}

/**
 * 通用合帧缓冲：`push` 入队，按 `delayMs` 节流批量交给 `onFlush`。
 *
 * `immediate=true` 时立即吐出（连同已积压项），用于需要即时反馈的事件。
 */
export class FrameBuffer<T> {
  private pending: T[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onFlush: (items: T[]) => void,
    private readonly delayMs: number = STREAM_FRAME_MS,
  ) {}

  /** 入队一个事件；`immediate` 为真时立刻吐出（连同已积压的） */
  push(item: T, immediate = false): void {
    this.pending.push(item);
    if (immediate) {
      this.flushNow();
      return;
    }
    if (this.timer == null) {
      this.timer = setTimeout(() => this.flushNow(), this.delayMs);
      // 不因合帧定时器拖住进程退出（测试环境的假定时器可能没有 unref，故可选调用）
      this.timer.unref?.();
    }
  }

  /** 立即吐出缓冲（清定时器 + 排空队列）；空队列时不做任何事 */
  flushNow(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const items = this.pending.splice(0, this.pending.length);
    this.onFlush(items);
  }

  /** 丢弃缓冲并清定时器（组件卸载 / 会话重建时调用） */
  dispose(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.length = 0;
  }
}
