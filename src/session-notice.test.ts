/**
 * 通知上屏那一层：**没有翻译表**（宿主按连接语言渲染好的句子直接用），只剩语气收成三档。
 *
 * 这一条是硬的：客户端再维护一份 code → 词条的表，两处就会漂（新增一条码而客户端忘了加一行，
 * 界面上出现的就是裸 key）。所以用例只断言「原样透传」与「四档 → 三档的映射」。
 */

import { describe, expect, it } from "vitest";
import { noticeText, noticeTone } from "./session-notice.js";
import type { NoticeView } from "./session/types.js";

function notice(overrides: Partial<NoticeView> = {}): NoticeView {
  return {
    id: "n-1",
    level: "info",
    code: "handoff.path",
    // 宿主渲染好的成品句就在这一格（这一版没有 `LocalizedText` 那一层了）
    message: "📄 交接文档：/x.md",
    durationMs: null,
    sessionId: null,
    // 时间一律 epoch 毫秒（宿主的口径）
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("noticeText", () => {
  it("宿主渲染好的那句原样上屏（客户端一个字的翻译都不做）", () => {
    expect(noticeText(notice())).toBe("📄 交接文档：/x.md");
  });

  it("换个语言连回来：同上一条事实、宿主给另一种说法，这里照样原样透传", () => {
    const english = notice({ message: "Handoff: /x.md" });
    expect(noticeText(english)).toBe("Handoff: /x.md");
  });

  it("`message` 为空时不编一句话（宿主没给就是没给）", () => {
    expect(noticeText(notice({ message: "" }))).toBe("");
  });
});

describe("noticeTone", () => {
  it("四档语气收成通知栏的三档（成功归普通，警告与错误各自一档）", () => {
    expect(noticeTone("info")).toBe("info");
    // 「已保存」那种一秒提示不该标红：一片红字里分不出哪条真出事
    expect(noticeTone("success")).toBe("info");
    // 警告与错误分开：一个是「看一眼」，一个是「出错了」（PRD 4.9 四档不能压成两级）
    expect(noticeTone("warning")).toBe("warn");
    expect(noticeTone("error")).toBe("error");
  });
});
