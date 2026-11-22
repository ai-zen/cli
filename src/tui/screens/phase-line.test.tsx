// 阶段行（分隔线之上那一行）的布局护栏。
//
// 为什么单拎出来测：`computeChatLayout`（占高）、`computeInputCursorPosition`（IME 光标 y）、
// `PhaseLine`（实际渲染行数）三处必须一致 —— 差一行，输入框整体位移、输入法候选框跟着偏。
// 这在本仓是有前科的（通知栏就漏算过），附件行因此也有同一套用例。
import { describe, expect, it } from "vitest";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { setLocale } from "../../i18n/index.js";
import { PhaseLine } from "../components.js";
import { computeChatLayout } from "./layout.js";
import { computeInputCursorPosition } from "./input.js";

const lines = (frame: string) => frame.split("\n").filter((line) => line.trim().length > 0);

describe("PhaseLine", () => {
  it("恒为一行：超宽文案由 truncate 兜底，绝不折成两行把输入框顶出屏幕", () => {
    setLocale("zh");
    // 窄框 + 长文案：折行的话这里会是两行以上
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={30}>
        <PhaseLine label={`调用工具 ${"read_file、".repeat(20)}`} />
      </Box>,
    );
    expect(lines(lastFrame() ?? "")).toHaveLength(1);
    unmount();
  });

  it("画出阶段文案（文案本身来自 `busySpinnerLabel`，这里只钉「说得出来」）", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={60}>
        <PhaseLine label="思考中…" />
      </Box>,
    );
    expect(lastFrame() ?? "").toContain("思考中…");
    unmount();
  });
});

describe("阶段行参与布局与硬件光标", () => {
  const base = {
    columns: 80,
    rows: 24,
    transcript: [],
    input: "",
    hintCount: 0,
    overlay: "none" as const,
    pickerItems: 0,
  };

  it("computeChatLayout：有阶段行时底部多占 1 行（输入区不被压缩）", () => {
    const without = computeChatLayout({ ...base });
    const withPhase = computeChatLayout({ ...base, phaseLines: 1 });
    expect(withPhase.bottomLines).toBe(without.bottomLines + 1);
    // 输入区照旧按草稿行数算：生成中不再把它压成 1 行（那正是旧实现的做法）
    expect(computeChatLayout({ ...base, input: "a\nb", phaseLines: 1 }).bottomLines).toBe(
      without.bottomLines + 1 + 1,
    );
  });

  it("computeInputCursorPosition：阶段行计入 y（否则 IME 候选框会偏高一行）", () => {
    const position = (phaseCount?: number) =>
      computeInputCursorPosition({
        transcriptLines: 5,
        hintCount: 0,
        cursorRow: 0,
        cursorCol: 0,
        lineText: "",
        placeholder: false,
        phaseCount,
      });
    expect(position(1).y).toBe(position(0).y + 1);
    expect(position(1).x).toBe(position(0).x);
  });
});
