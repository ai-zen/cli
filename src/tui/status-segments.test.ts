import { describe, it, expect } from "vitest";
import { packSegments, segmentsWidth, wrapSegments, type StatusSegment } from "./status-segments.js";
import { displayWidth } from "./text.js";

/** 把折行结果还原成纯文本，便于断言 */
const plain = (rows: StatusSegment[][]): string[] =>
  rows.map((row) => row.map((segment) => segment.text).join(""));

describe("wrapSegments（状态栏的流动折行）", () => {
  it("装得下就一行不折", () => {
    expect(plain(wrapSegments([{ text: "◆ m1 · agent a1" }], 40))).toEqual(["◆ m1 · agent a1"]);
  });

  it("超出宽度时把后段顺延到下一行（左侧内容优先完整保留）", () => {
    const rows = wrapSegments(
      [
        { text: "◆ deepseek-v4-flash", color: "cyan" },
        { text: " · agent default", color: "gray" },
        { text: "  Enter 发送 · Ctrl+J 换行 · / 命令 · PgUp 看历史", color: "white" },
      ],
      40,
    );
    const lines = plain(rows);
    expect(lines.length).toBeGreaterThan(1);
    // 第一行必须完整包含身份信息
    expect(lines[0]).toContain("◆ deepseek-v4-flash");
    expect(lines[0]).toContain("agent default");
    // 所有内容不得丢失（只是换行重排）
    expect(lines.join(" ").replace(/\s+/g, "")).toContain("PgUp看历史");
  });

  it("优先在空格处断行，不把英文单词劈开", () => {
    // 宽度 9：「aaaa bbbb」恰好占满，空格丢弃后换行
    expect(plain(wrapSegments([{ text: "aaaa bbbb cccc" }], 9))).toEqual(["aaaa bbbb", "cccc"]);
    // 宽度 8：贪心填满后依次断词
    expect(plain(wrapSegments([{ text: "aaaa bbbb cccc" }], 8))).toEqual(["aaaa", "bbbb", "cccc"]);
  });

  it("没有空格可断时按字符硬断（CJK 本来就能任意断行）", () => {
    const rows = plain(wrapSegments([{ text: "中文中文中文中文" }], 4));
    expect(rows).toEqual(["中文", "中文", "中文", "中文"]);
  });

  it("宽字符按 2 列计算（不出现半宽溢出）", () => {
    const rows = plain(wrapSegments([{ text: "中a中a中" }], 4));
    expect(rows).toEqual(["中a", "中a", "中"]);
  });

  it("折行后的行首空格被吃掉（不产生莫名缩进）", () => {
    const rows = plain(wrapSegments([{ text: "aaaa bbbb" }], 5));
    expect(rows[0]).toBe("aaaa");
    expect(rows[1]).toBe("bbbb");
  });

  it("行尾空格被裁掉（不留视觉空档）", () => {
    const rows = plain(wrapSegments([{ text: "ab  " }], 10));
    expect(rows).toEqual(["ab"]);
  });

  it("保留各段样式：连续同色合并，不同色不合并", () => {
    const rows = wrapSegments(
      [
        { text: "◆ ", color: "cyan" },
        { text: "m1", color: "cyan" },
        { text: " · ", color: "gray" },
        { text: "a1", color: "white" },
      ],
      40,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      { text: "◆ m1", color: "cyan", bold: undefined },
      { text: " · ", color: "gray", bold: undefined },
      { text: "a1", color: "white", bold: undefined },
    ]);
  });

  it("行首的孤儿分隔符被丢弃（不出现「· ⚡ 47 tok/s」这种行首）", () => {
    const rows = plain(wrapSegments([{ text: "aaaa · bbbb" }], 5));
    expect(rows).toEqual(["aaaa", "bbbb"]);
  });

  it("空内容返回一个空行（保持行数语义）", () => {
    expect(wrapSegments([], 40)).toEqual([[]]);
  });
});

describe("packSegments（按块装行）", () => {
  const block = (text: string): StatusSegment[] => [{ text }];

  it("segmentsWidth 按显示宽度累计（宽字符算 2）", () => {
    expect(segmentsWidth([{ text: "ab" }, { text: "中" }])).toBe(4);
    expect(segmentsWidth([])).toBe(0);
  });

  it("三块都放得下就并成一行，用分隔符连起来", () => {
    const rows = plain(packSegments([block("A"), block("B"), block("C")], 40));
    expect(rows).toEqual(["A · B · C"]);
  });

  it("放不下的块整块挪到下一行（不被劈开）", () => {
    // 宽度 10：「AAAAAAAA」+「 · 」+「BBBB」=13 > 10 → B 整块下一行
    const rows = plain(packSegments([block("AAAAAAAA"), block("BBBB")], 10));
    expect(rows).toEqual(["AAAAAAAA", "BBBB"]);
  });

  it("换行后不留行首 / 行尾的分隔符", () => {
    const rows = plain(packSegments([block("AAAA"), block("BBBB"), block("CCCC")], 11));
    expect(rows).toEqual(["AAAA · BBBB", "CCCC"]);
    for (const row of rows) {
      expect(row.startsWith("·")).toBe(false);
      expect(row.endsWith("·")).toBe(false);
      expect(row).toBe(row.trim());
    }
  });

  it("单块超一整行时才块内折行，尾巴接着接下一块", () => {
    const rows = plain(packSegments([block("aaaa bbbb cccc"), block("dd")], 10));
    expect(rows).toEqual(["aaaa bbbb", "cccc · dd"]);
  });

  it("空块直接跳过：既不占行也不留多余分隔符", () => {
    const rows = plain(packSegments([block("A"), [], block("B")], 40));
    expect(rows).toEqual(["A · B"]);
    expect(plain(packSegments([], 40))).toEqual([""]);
  });

  it("保留各块的样式，分隔符与块互不影响", () => {
    const rows = packSegments([[{ text: "A", color: "red" }], [{ text: "B", color: "blue" }]], 40, [
      { text: " | ", color: "gray" },
    ]);
    expect(rows).toEqual([
      [
        { text: "A", color: "red" },
        { text: " | ", color: "gray" },
        { text: "B", color: "blue" },
      ],
    ]);
  });
});

describe("折行宽度按字素簇计（与 Ink 排版同一把尺子）", () => {
  const plainRows = (rows: StatusSegment[][]): string[] =>
    rows.map((row) => row.map((segment) => segment.text).join(""));

  it("VS16 序列占 2 列，行不超宽", () => {
    // 按 code point 会算成 1 列，20 个本该折成 2 行却挤成 1 行（宽 20 却占 40 列）
    const rows = plainRows(wrapSegments([{ text: "❤️".repeat(20) }], 20));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(20);
  });

  it("ZWJ 家族占 2 列，不被算成 6 列", () => {
    // 10 簇 × 2 列 = 20，恰好一行；按 code point 会算成 60 列而折成多行
    const rows = plainRows(wrapSegments([{ text: "👨‍👩‍👧".repeat(10) }], 20));
    expect(rows).toHaveLength(1);
  });

  it("segmentsWidth 与逐行折行的宽度口径一致", () => {
    const segments: StatusSegment[] = [{ text: "❤️".repeat(5) }];
    expect(segmentsWidth(segments)).toBe(10);
    expect(displayWidth(segments.map((segment) => segment.text).join(""))).toBe(10);
  });
});
