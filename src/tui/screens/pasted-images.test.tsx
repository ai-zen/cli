// 附件行的布局护栏。
//
// 为什么单拎出来测：`computeChatLayout`（占高）、`computeInputCursorPosition`（IME 光标 y）、
// `PastedImagesBar`（实际渲染行数）三处必须一致 —— 差一行，输入框整体位移、候选框跟着偏。
// 这在本仓是有前科的（通知栏就漏算过）。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PastedImagesBar } from "../components.js";
import { setLocale } from "../../i18n/index.js";
import { computeChatLayout } from "./layout.js";
import { computeInputCursorPosition } from "./input.js";

const lines = (frame: string) => frame.split("\n").filter((line) => line.trim().length > 0);

describe("PastedImagesBar", () => {
  it("恒为一行（超宽由 truncate 兜底，不许折行把输入框顶出屏幕）", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(<PastedImagesBar count={2} />);
    const frame = lastFrame() ?? "";
    expect(lines(frame)).toHaveLength(1);
    expect(frame).toContain("已附加 2 张图片");
    unmount();
  });
});

describe("附件行参与布局与硬件光标", () => {
  const base = {
    columns: 80,
    rows: 24,
    transcript: [],
    input: "",
    busy: false,
    hintCount: 0,
    overlay: "none" as const,
    pickerItems: 0,
  };

  it("computeChatLayout：有附件时底部多占 1 行", () => {
    const without = computeChatLayout({ ...base });
    const withAttachment = computeChatLayout({ ...base, attachmentLines: 1 });
    expect(withAttachment.bottomLines).toBe(without.bottomLines + 1);
  });

  it("computeInputCursorPosition：附件行数计入 y（否则 IME 候选框会偏高一行）", () => {
    const position = (attachmentCount?: number) =>
      computeInputCursorPosition({
        transcriptLines: 5,
        hintCount: 0,
        cursorRow: 0,
        cursorCol: 0,
        lineText: "",
        placeholder: false,
        attachmentCount,
      });
    expect(position(1).y).toBe(position(0).y + 1);
    expect(position(1).x).toBe(position(0).x);
  });
});
