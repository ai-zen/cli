import { describe, it, expect } from "vitest";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { CursorInputRow, type CursorPosition } from "./input-row.js";
import { computeInputCursorPosition } from "./input.js";

/**
 * `CursorInputRow` 的职责只有一件事：**让渲染器说出光标在哪一列、哪一行**。
 *
 * 这些断言的价值在于它们**不依赖我们的宽度模型**：期望值取自 Ink 自身的排版结果
 * （`⚡` 算 2 列、`中文` 算 4 列），而不是 `displayWidth`。最后一条用例专门把两者
 * 摆在一起对比 —— 手算会错 1 列，实测不会。
 */

/** 把目标行放在 `filler` 行内容之后，模拟真实帧里的位置 */
function renderRow(input: {
  before: string;
  at: string;
  after: string;
  firstLine?: boolean;
  filler?: number;
  width?: number;
}) {
  const measured: CursorPosition[] = [];
  const frame = render(
    <Box flexDirection="column" width={input.width ?? 40}>
      {Array.from({ length: input.filler ?? 0 }, (_, i) => (
        <Text key={i}>{`L${i}`}</Text>
      ))}
      <Box paddingX={1}>
        <CursorInputRow
          firstLine={input.firstLine ?? true}
          before={input.before}
          at={input.at}
          after={input.after}
          onMeasure={(position) => measured.push(position)}
        />
      </Box>
    </Box>,
  );
  return { measured, frame };
}

describe("CursorInputRow（渲染器实测的光标坐标）", () => {
  it("x = 左侧 padding(1) + 提示符(2) + 光标前文本宽度", async () => {
    const { measured, frame } = renderRow({ before: "abc", at: "d", after: "ef" });
    await new Promise((r) => setTimeout(r, 20));
    expect(measured.at(-1)).toEqual({ x: 6, y: 0 });
    expect(frame.lastFrame()).toContain("❯ abcdef");
    frame.unmount();
  });

  it("宽字符按渲染器的 2 列计（中文 → 4 列）", async () => {
    const { measured, frame } = renderRow({ before: "中文", at: "a", after: "b" });
    await new Promise((r) => setTimeout(r, 20));
    expect(measured.at(-1)).toEqual({ x: 7, y: 0 });
    frame.unmount();
  });

  it("y 跟随所在行的位置（前面 3 行 → y=3）", async () => {
    const { measured, frame } = renderRow({ before: "ab", at: "c", after: "", filler: 3 });
    await new Promise((r) => setTimeout(r, 20));
    expect(measured.at(-1)?.y).toBe(3);
    frame.unmount();
  });

  it("非首行时提示符占位两格，x 仍从 3 起算", async () => {
    const { measured, frame } = renderRow({ before: "", at: "a", after: "b", firstLine: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(measured.at(-1)).toEqual({ x: 3, y: 0 });
    frame.unmount();
  });

  it("超宽内容不会把行顶成两行（溢出让可截断的邻段吸收）", async () => {
    const { measured, frame } = renderRow({ before: "x".repeat(60), at: "c", after: "zzz" });
    await new Promise((r) => setTimeout(r, 20));
    const lines = (frame.lastFrame() ?? "").split("\n");
    expect(lines).toHaveLength(1);
    // 光标被钳在可用区边缘，而不是溢出到屏幕外
    expect(measured.at(-1)?.x).toBeLessThanOrEqual(38);
    expect(measured.at(-1)?.x).toBeGreaterThan(30);
    frame.unmount();
  });

  it("⚡ 这类宽符号：手算与实测必须一致（宽度表与 Ink 的 string-width 已对齐）", async () => {
    // "ab⚡cd"：⚡ 在 Unicode 里是 East Asian Wide，Ink（string-width）按 2 列排
    const { measured, frame } = renderRow({ before: "ab⚡cd", at: "e", after: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect(measured.at(-1)?.x).toBe(9);
    // 手算（displayWidth）现在也是 9 —— 两者一致，说明宽度表不再是“另一把尺子”
    const manual = computeInputCursorPosition({
      transcriptLines: 0,
      hintCount: 0,
      cursorRow: 0,
      cursorCol: 5,
      lineText: "ab⚡cd",
      placeholder: false,
    });
    expect(manual.x).toBe(9);
    frame.unmount();
  });

  it("位置没变化时不会重复上报（避免「测量→重渲染→再测量」打转）", async () => {
    const measured: CursorPosition[] = [];
    const view = (text: string) => (
      <Box flexDirection="column" width={40}>
        <Box paddingX={1}>
          <CursorInputRow
            firstLine
            before={text}
            at="c"
            after=""
            onMeasure={(position) => measured.push(position)}
          />
        </Box>
      </Box>
    );
    const frame = render(view("ab"));
    await new Promise((r) => setTimeout(r, 20));
    const countAfterFirst = measured.length;
    expect(countAfterFirst).toBe(1);
    // 内容不变的重渲染：坐标相同 → 不再上报
    frame.rerender(view("ab"));
    await new Promise((r) => setTimeout(r, 20));
    expect(measured).toHaveLength(1);
    // 内容变化 → 重新上报
    frame.rerender(view("abcd"));
    await new Promise((r) => setTimeout(r, 20));
    expect(measured.length).toBe(2);
    frame.unmount();
  });
});
