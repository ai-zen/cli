import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameBuffer, STREAM_FRAME_MS, isImmediateEvent } from "./frame-buffer.js";

describe("isImmediateEvent（即时上屏判定）", () => {
  it("user / done / error 立即上屏，不参与合帧", () => {
    expect(isImmediateEvent("user")).toBe(true);
    expect(isImmediateEvent("done")).toBe(true);
    expect(isImmediateEvent("error")).toBe(true);
  });

  it("流式增量与过程事件走合帧", () => {
    for (const type of ["assistant-start", "reasoning", "content", "tool", "notice", "subagent-start"]) {
      expect(isImmediateEvent(type)).toBe(false);
    }
  });
});

describe("FrameBuffer（流式合帧）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("同一帧间隔内的多个事件合并为一次 flush", () => {
    const flushed: number[][] = [];
    const buffer = new FrameBuffer<number>((items) => flushed.push(items));
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(flushed).toHaveLength(0); // 尚未到帧间隔，不上屏
    vi.advanceTimersByTime(STREAM_FRAME_MS);
    expect(flushed).toEqual([[1, 2, 3]]);
  });

  it("跨帧的事件各自独立吐出", () => {
    const flushed: number[][] = [];
    const buffer = new FrameBuffer<number>((items) => flushed.push(items));
    buffer.push(1);
    vi.advanceTimersByTime(STREAM_FRAME_MS);
    buffer.push(2);
    vi.advanceTimersByTime(STREAM_FRAME_MS);
    expect(flushed).toEqual([[1], [2]]);
  });

  it("immediate 立即吐出，并连带已积压项；此后不再有滞留帧", () => {
    const flushed: number[][] = [];
    const buffer = new FrameBuffer<number>((items) => flushed.push(items));
    buffer.push(1);
    buffer.push(2, true);
    expect(flushed).toEqual([[1, 2]]);
    vi.advanceTimersByTime(STREAM_FRAME_MS * 3);
    expect(flushed).toEqual([[1, 2]]);
  });

  it("flushNow 在空队列时不触发回调", () => {
    const onFlush = vi.fn();
    const buffer = new FrameBuffer<number>(onFlush);
    buffer.flushNow();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("dispose 丢弃缓冲并取消定时器", () => {
    const onFlush = vi.fn();
    const buffer = new FrameBuffer<number>(onFlush);
    buffer.push(1);
    buffer.dispose();
    vi.advanceTimersByTime(STREAM_FRAME_MS * 3);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("高帧率输入被显著降频，但事件总量不丢", () => {
    const batches: number[] = [];
    const buffer = new FrameBuffer<number>((items) => batches.push(items.length));
    // 每 2ms 一个 delta，持续 200ms → 共 100 个事件
    for (let elapsed = 0; elapsed < 200; elapsed += 2) {
      buffer.push(1);
      vi.advanceTimersByTime(2);
    }
    // 收尾：让最后一帧也吐出
    vi.advanceTimersByTime(STREAM_FRAME_MS * 2);
    // 200ms / 60ms ≈ 3~5 帧，远小于 100 次上屏
    expect(batches.length).toBeLessThanOrEqual(5);
    // 不丢事件
    expect(batches.reduce((sum, n) => sum + n, 0)).toBe(100);
  });
});
