/**
 * 流式事件合帧缓冲：把高频的流式 delta 合并为低频的「帧」再交给 React 渲染。
 *
 * AI 流式响应每秒可产生数十到上百个 delta。每个 delta 都触发一次 React 更新，等于每个
 * delta 一次全量布局重算（含语法高亮 / 折行）加一帧输出的重建与差分。本项目开了
 * `incrementalRendering`（只重绘变化的行），它省的是写出去的字节数，省不掉每帧那次布局
 * 重算与整屏字符串的重建；在 SSH 弱网（低带宽 / 高延迟）下，这会迅速填满 pty 缓冲并阻塞
 * stdout（Linux 上 TTY 写是同步阻塞的），界面表现为停止响应，连接也可能被拖断。
 *
 * delta 先收进缓冲，按固定间隔（默认 `STREAM_FRAME_MS`，约 16fps）批量输出；`user` /
 * `done` / `error` 这类需要即时反馈或收尾的事件立即输出，避免按下回车后长时间没有显示，
 * 或回答结束后仍在转圈。
 *
 * 走哪条路由 `session.ts` 的 `onEvent` 决定：内容变化（`message.added` /
 * `message.changed`）走 `push(…, false)`，其余走 `push(…, true)`。这一处曾经无条件走
 * `true`，于是每个 delta 一次重渲染，本模块因此不起作用；改回来时同步在 `session.test.ts`
 * 里钉住了两边。
 *
 * 纯逻辑、不依赖 React，可独立单测。
 */

/**
 * 合帧间隔（毫秒）：约 16fps。
 *
 * 刻意低于 Ink 默认的 30fps 输出节流，让主动合帧成为上屏频率的主控，
 * 而不是叠加在 Ink 节流之上。
 */
export const STREAM_FRAME_MS = 60;

/**
 * 通用合帧缓冲：`push` 入队，按 `delayMs` 节流批量交给 `onFlush`。
 */
export class FrameBuffer<T> {
  private pending: T[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onFlush: (items: T[]) => void,
    private readonly delayMs: number = STREAM_FRAME_MS,
  ) {}

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

  flushNow(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const items = this.pending.splice(0, this.pending.length);
    this.onFlush(items);
  }

  dispose(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.length = 0;
  }
}
