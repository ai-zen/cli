// 折行宽度必须按**字素簇**算 —— 与 Ink 排版用的是同一把尺子（见 lines.ts::toCells）
//
// 回归背景：`toCells` / `clipSpans` 曾按 code point 遍历文本，导致
//   - VS16 序列（✌️ = U+270C U+FE0F）被算成 1 列而实际占 2 列 → 行超宽 → Ink 在渲染期
//     二次折行 → 实际帧高比 `computeChatLayout` 预算多一行 → 输入框被顶出屏幕；
//   - ZWJ 家族（👨‍👩‍👧）被算成 6 列而实际占 2 列 → 每 2 个簇就折一次，行短一截。
// 这些用例就是那两个方向上的护栏。
import { describe, it, expect } from "vitest";
import { clipSpans, contentLines, spanLine } from "./lines.js";
import { displayWidth, graphemes } from "../text.js";

/** 正文区折行宽度（`contentLines` 的调用方传的是 `innerWidth(columns)` = columns − 4） */
const WIDTH = 40;
/** `contentLines` 每行自带 2 列缩进，故单行显示宽度的硬上限是折行宽度 + 2 */
const HARD_LIMIT = WIDTH + 2;

/** 去掉每行开头的 2 列缩进，还原成内容 */
const stripIndent = (line: string): string => graphemes(line).slice(2).join("");

const lineWidths = (text: string): number[] =>
  contentLines("content", "k", text, WIDTH).map((line) => displayWidth(line.text));

describe("contentLines 折行宽度（字素簇）", () => {
  const samples: Array<[string, string]> = [
    ["VS16 序列 ✌️", "✌️"],
    ["VS16 序列 ❤️", "❤️"],
    ["ZWJ 家族 👨‍👩‍👧", "👨‍👩‍👧"],
    ["区域指示符 🇨🇳", "🇨🇳"],
    ["单码位宽字符 😀", "😀"],
    ["CJK 汉字", "中"],
    ["ASCII 字母", "a"],
  ];

  for (const [label, unit] of samples) {
    it(`${label} 重复 40 次后，没有一行超过硬上限`, () => {
      const widths = lineWidths(unit.repeat(40));
      expect(widths.length).toBeGreaterThan(0);
      for (const width of widths) expect(width).toBeLessThanOrEqual(HARD_LIMIT);
    });
  }

  it("ZWJ 家族按 2 列算，不再被算成 6 列（不提前折行）", () => {
    // 每行 20 簇 × 2 列 = 40 列恰好装满 → 40 簇应折成 2 行（按 code point 算会折成 6 行）
    expect(contentLines("content", "k", "👨‍👩‍👧".repeat(40), WIDTH)).toHaveLength(2);
  });

  it("VS16 序列按 2 列算，20 个恰好装满一行", () => {
    const rows = contentLines("content", "k", "❤️".repeat(20), WIDTH);
    expect(rows).toHaveLength(1);
    expect(displayWidth(rows[0]!.text)).toBe(HARD_LIMIT);
  });

  it("折行不丢内容（按字素簇还原后与原文一致）", () => {
    const text = "❤️".repeat(30);
    const restored = contentLines("content", "k", text, WIDTH)
      .map((line) => stripIndent(line.text))
      .join("");
    expect(restored).toBe(text);
  });

  it("代码块（不优先按空格断）同样按字素簇计宽", () => {
    const rows = contentLines("content", "k", "```\n" + "❤️".repeat(40) + "\n```", WIDTH);
    for (const row of rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(HARD_LIMIT);
  });
});

describe("clipSpans 裁剪（字素簇）", () => {
  it("截断时不切出孤立的变体选择符，且不超宽", () => {
    const spans = spanLine("k", "tool", [{ text: "❤️".repeat(20) }]).spans!;
    const text = clipSpans(spans, 10)
      .map((span) => span.text)
      .join("");

    // 按 code point 切会留下孤立的 "❤"（U+2764）或 "U+FE0F"
    const clusters = graphemes(text);
    expect(clusters.some((cluster) => cluster === "\u2764" || cluster === "\uFE0F")).toBe(false);
    expect(displayWidth(text)).toBeLessThanOrEqual(10);
    expect(text.endsWith("…")).toBe(true);
  });
});
