import { describe, expect, it, vi } from "vitest";
import { NoticeChannel, noticeLines, MAX_NOTICE_LINES, type Notice } from "./notice.js";

describe("NoticeChannel（通知旁路通道）", () => {
  it("push 广播给所有订阅者，seq 递增", () => {
    const channel = new NoticeChannel();
    const a: Notice[] = [];
    const b: Notice[] = [];
    channel.subscribe((n) => a.push(n));
    channel.subscribe((n) => b.push(n));
    channel.push("已保存");
    channel.push("读取出错", "error");
    expect(a.map((n) => n.text)).toEqual(["已保存", "读取出错"]);
    expect(a.map((n) => n.tone)).toEqual(["info", "error"]);
    expect(b).toEqual(a);
    expect(a[0].seq).toBeLessThan(a[1].seq);
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
    const seen: Notice[] = [];
    channel.subscribe((n) => seen.push(n));
    channel.push("hi");
    expect(seen[0].tone).toBe("info");
  });
});

describe("noticeLines（通知栏文本行）", () => {
  it("info 前缀 `· `，error 前缀 `✖ `", () => {
    expect(noticeLines({ text: "就绪", tone: "info", seq: 1 }, 80)[0]).toBe("  · 就绪");
    expect(noticeLines({ text: "失败", tone: "error", seq: 1 }, 80)[0]).toBe("  ✖ 失败");
  });

  it("空文本返回空数组", () => {
    expect(noticeLines({ text: "", tone: "info", seq: 1 }, 80)).toEqual([]);
  });

  it("按列宽折行，超出上限以 … 收尾", () => {
    const text = "长".repeat(200);
    const lines = noticeLines({ text, tone: "info", seq: 1 }, 20);
    expect(lines.length).toBe(MAX_NOTICE_LINES);
    expect(lines[lines.length - 1].endsWith("…")).toBe(true);
  });

  it("短文本单行、不折", () => {
    expect(noticeLines({ text: "ok", tone: "info", seq: 1 }, 80)).toEqual(["  · ok"]);
  });
});
