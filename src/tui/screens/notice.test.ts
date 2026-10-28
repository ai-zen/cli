import { describe, expect, it, vi } from "vitest";
import {
  MAX_NOTICE_HISTORY,
  MAX_NOTICE_LINES,
  NoticeChannel,
  noticeLines,
  type Notice,
} from "./notice.js";

const notice = (text: string, tone: "info" | "error" = "info", seq = 1): Notice => ({
  text,
  tone,
  seq,
});

const texts = (lines: Array<{ text: string }>): string[] => lines.map((line) => line.text);

describe("NoticeChannel（通知旁路通道）", () => {
  it("push 广播**整份队列**（而非单个增量），seq 递增", () => {
    const channel = new NoticeChannel();
    const seen: Array<readonly Notice[]> = [];
    channel.subscribe((queue) => seen.push(queue));
    channel.push("已保存");
    channel.push("读取出错", "error");

    expect(seen.map((queue) => queue.map((n) => n.text))).toEqual([["已保存"], ["已保存", "读取出错"]]);
    expect(seen.map((queue) => queue.map((n) => n.tone))).toEqual([["info"], ["info", "error"]]);
    const last = seen.at(-1)!;
    expect(last[0]!.seq).toBeLessThan(last[1]!.seq);
  });

  it("队列只保留最近 MAX_NOTICE_HISTORY 条（进度流不会无限堆积）", () => {
    const channel = new NoticeChannel();
    for (let i = 0; i < MAX_NOTICE_HISTORY + 2; i += 1) channel.push(`n${i}`);
    expect(channel.notices.map((n) => n.text)).toEqual(
      Array.from({ length: MAX_NOTICE_HISTORY }, (_, i) => `n${i + 2}`),
    );
  });

  it("空文本不推入（调用方常把错误消息直接透传进来）", () => {
    const channel = new NoticeChannel();
    channel.push("");
    expect(channel.notices).toEqual([]);
  });

  it("clear 清空并广播空队列", () => {
    const channel = new NoticeChannel();
    const spy = vi.fn();
    channel.subscribe(spy);
    channel.push("x");
    channel.clear();
    expect(channel.notices).toEqual([]);
    expect(spy).toHaveBeenLastCalledWith([]);
  });

  it("队列已空时 clear 不广播（不制造无谓重渲染）", () => {
    const channel = new NoticeChannel();
    const spy = vi.fn();
    channel.subscribe(spy);
    channel.clear();
    expect(spy).not.toHaveBeenCalled();
  });

  it("取消订阅后不再收到", () => {
    const channel = new NoticeChannel();
    const spy = vi.fn();
    const off = channel.subscribe(spy);
    channel.push("x");
    off();
    channel.push("y");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("缺省 tone 为 info", () => {
    const channel = new NoticeChannel();
    channel.push("hi");
    expect(channel.notices[0]!.tone).toBe("info");
  });
});

describe("noticeLines（通知栏文本行）", () => {
  it("文本从行首开始，不加 `· ` / `✖ ` 前缀（语气靠 tone 着色）", () => {
    expect(texts(noticeLines([notice("就绪")], 80))).toEqual(["就绪"]);
    expect(texts(noticeLines([notice("失败", "error")], 80))).toEqual(["失败"]);
  });

  it("空文本跳过；空队列返回空数组", () => {
    expect(noticeLines([notice("")], 80)).toEqual([]);
    expect(noticeLines([], 80)).toEqual([]);
  });

  it("单条按列宽折行，条内超出上限以 … 收尾", () => {
    const lines = noticeLines([notice("长".repeat(200))], 20);
    expect(lines.length).toBe(MAX_NOTICE_LINES);
    expect(lines[lines.length - 1]!.text.endsWith("…")).toBe(true);
  });

  it("短文本单行、不折", () => {
    expect(texts(noticeLines([notice("ok")], 80))).toEqual(["ok"]);
  });

  it("多条各自保留自己的 tone（渲染时逐行着色）", () => {
    const lines = noticeLines([notice("a"), notice("b", "error")], 80);
    expect(lines.map((line) => line.tone)).toEqual(["info", "error"]);
    expect(texts(lines)).toEqual(["a", "b"]);
  });

  it("多行通知每行都从行首开始，不加续行缩进", () => {
    // 横向定位全归容器（`NoticeBar` 的 paddingX）管；这里再多一层缩进/前缀，
    // 文案就会比输入行右漂，一屏里几条通知并排时整块向右挤。
    const lines = texts(noticeLines([notice("甲\n乙\n丙")], 80));
    expect(lines).toEqual(["甲", "乙", "丙"]);
  });

  it("合计超出上限时从最早的一条开始整条让位（不劈半条）", () => {
    // 每条自身封顶 8 行，两条合计 16 > 8 → 只剩最新那条，且是完整的 8 行
    const lines = noticeLines([notice("甲".repeat(200)), notice("乙".repeat(200))], 20);
    expect(lines.length).toBe(MAX_NOTICE_LINES);
    expect(lines.every((line) => line.text.includes("乙"))).toBe(true);
  });
});
