import { describe, it, expect } from "vitest";
import { clusterWidth, displayWidth, graphemes, layoutInput, wrapText, clipWidth } from "./text.js";

/**
 * 字素簇（grapheme cluster）与显示宽度。
 *
 * 这套东西存在的原因：`✌️` 是 `U+270C U+FE0F` **两个 code point 组成的一个字素簇**。
 * 如果按 code point 当「一个字符」处理，光标就能停在簇中间（`✌` 与 `U+FE0F` 之间），
 * 后果是：反显光标变成在反显一个变体选择符 —— 屏幕上什么都不显示（Ink 的输出里
 * 反显段直接消失，实测）；退格只删掉半个 emoji；列号也因「半个簇」而算错。
 *
 * 宽度必须与 Ink 排版用的 `string-width` 一致，否则折行、状态栏、光标列号各错一截。
 * 下面这些期望值直接取自 `string-width`（已逐条比对过）。
 */

describe("graphemes：按用户感知的「一个字符」切分", () => {
  it("VS16 序列是一个簇（✌️ / ❤️ / ⚠️）", () => {
    expect(graphemes("✌️")).toEqual(["✌️"]);
    expect(graphemes("❤️")).toEqual(["❤️"]);
    expect(graphemes("⚠️")).toEqual(["⚠️"]);
  });

  it("ZWJ 序列是一个簇（👨‍👩‍👧 / 🏳️‍🌈）", () => {
    expect(graphemes("👨‍👩‍👧")).toHaveLength(1);
    expect(graphemes("🏳️‍🌈")).toHaveLength(1);
  });

  it("国旗（一对区域指示符）是一个簇", () => {
    expect(graphemes("🇨🇳")).toEqual(["🇨🇳"]);
  });

  it("字符 + 肤色修饰符 / keycap 是一个簇", () => {
    expect(graphemes("👍🏽")).toHaveLength(1);
    expect(graphemes("1️⃣")).toHaveLength(1);
  });

  it("普通文本逐字切分，CJK / ASCII 都对", () => {
    expect(graphemes("中文ab")).toEqual(["中", "文", "a", "b"]);
    expect(graphemes("")).toEqual([]);
  });

  it("换行符自成一簇（layoutInput 靠它判断行边界）", () => {
    expect(graphemes("a\nb")).toEqual(["a", "\n", "b"]);
  });

  // 下面这组是「快速路径」（见 text.ts::NEEDS_SEGMENTER）的护栏。
  // `graphemes()` 对普通文本跳过 `Intl.Segmenter` 直接按 code point 切，快一个数量级；
  // 但一旦判定该走分词器的码位集漏了、就会静默切错 —— 所以把各类「多 code point 一簇」
  // 的形态都钉在这里。漏一个就让这些用例红。
  it("CRLF 是一个簇（不是两个）", () => {
    expect(graphemes("a\r\nb")).toEqual(["a", "\r\n", "b"]);
  });

  it("组合附加符跟着基字走（拉丁 / 天城文 / 阿拉伯文）", () => {
    expect(graphemes("a\u0301")).toEqual(["a\u0301"]);
    expect(graphemes("नमस्ते")).toEqual(["न", "म", "स्ते"]);
    expect(graphemes("مَرْحَبًا")).toEqual(["مَ", "رْ", "حَ", "بً", "ا"]);
  });

  it("韩文组合字母合成一簇", () => {
    expect(graphemes("\u1100\u1161\u11A8")).toHaveLength(1);
  });

  it("ZWNJ / ZWJ 不断开字素簇", () => {
    expect(graphemes("a\u200Cb")).toEqual(["a\u200C", "b"]);
    expect(graphemes("क्‍ष")).toEqual(["क्‍ष"]);
  });

  it("tag 序列（旗帜细分）不按码位切散", () => {
    expect(graphemes("🏴󠁧󠁢󠁥󠁮󠁧󠁿‌")).toHaveLength(1);
  });

  it("astral 平面汉字（扩展 B）是一个簇", () => {
    expect(graphemes("𠮷𪚥")).toEqual(["𠮷", "𪚥"]);
  });
});

describe("displayWidth / clusterWidth：直接使用 Ink 同款 string-width", () => {
  it("整串宽度 == 逐簇宽度之和（两条路径不能脆裂）", () => {
    const samples = ["⚡", "✅", "✨", "⭐", "✌️", "👨‍👩‍👧", "🇨🇳", "1️⃣", "中文ab", "→…─①", "👍🏽", "🏳️‍🌈"];
    for (const sample of samples) {
      const sum = graphemes(sample).reduce((acc, cluster) => acc + clusterWidth(cluster), 0);
      expect(displayWidth(sample)).toBe(sum);
    }
  });

  it("emoji 序列整体 2 列（不是成员累加）", () => {
    // 成员累加会得到 8：🍎 每个 emoji 2 列 × 4 个成员
    expect(clusterWidth("👨‍👩‍👧")).toBe(2);
    expect(displayWidth("👨‍👩‍👧")).toBe(2);
    expect(displayWidth("🏳️‍🌈")).toBe(2);
    expect(displayWidth("🇨🇳")).toBe(2);
    expect(displayWidth("1️⃣")).toBe(2);
    expect(displayWidth("✌️")).toBe(2);
  });

  it("不带 VS16 的同一个字符按窄字符算（✌ ≠ ✌️）", () => {
    expect(displayWidth("✌")).toBe(1);
    expect(displayWidth("⚠")).toBe(1);
  });

  it("East Asian Wide 符号按 2 列（⚡ ✅ ✨ ⭐ 🀄）", () => {
    expect(displayWidth("⚡")).toBe(2);
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("✨")).toBe(2);
    expect(displayWidth("⭐")).toBe(2);
    expect(displayWidth("🀄")).toBe(2);
  });

  it("窄符号仍按 1 列（→ … ─ ① ⚠）", () => {
    expect(displayWidth("→")).toBe(1);
    expect(displayWidth("…")).toBe(1);
    expect(displayWidth("─")).toBe(1);
    expect(displayWidth("①")).toBe(1);
  });

  it("组合附加符号不占列", () => {
    expect(displayWidth("a\u0301")).toBe(1); // á 的分解形式
  });
});

describe("layoutInput：光标按字素簇定位", () => {
  it("✌️✌️ 只有 3 个光标位置，不会停在簇中间", () => {
    const text = "✌️✌️";
    expect(graphemes(text)).toHaveLength(2);
    for (let cursor = 0; cursor <= 2; cursor += 1) {
      const layout = layoutInput(text, cursor, 38);
      const rowChars = graphemes(layout.lines[layout.cursorRow] ?? "");
      const at = rowChars[layout.cursorCol];
      // 光标处的字素要么是完整的 ✌️，要么在行尾（undefined）
      expect(at === undefined || at === "✌️").toBe(true);
    }
  });

  it("折行按簇宽度：一行正好放下两个 ✌️（各 2 列）", () => {
    expect(layoutInput("✌️✌️", 0, 4).lines).toEqual(["✌️✌️"]);
    // 宽度 3 时第二个装不下 → 换行
    expect(layoutInput("✌️✌️", 0, 3).lines).toEqual(["✌️", "✌️"]);
  });

  it("CJK 仍按 2 列折行", () => {
    expect(layoutInput("中文中文", 0, 4).lines).toEqual(["中文", "中文"]);
  });

  it("光标跨行映射", () => {
    const layout = layoutInput("✌️✌️", 2, 3);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(1);
  });
});

describe("wrapText / clipWidth：也不会把 emoji 劈成两半", () => {
  it("wrapText 按簇断行", () => {
    expect(wrapText("✌️✌️", 3)).toEqual(["✌️", "✌️"]);
    expect(wrapText("👨‍👩‍👧👨‍👩‍👧", 2)).toEqual(["👨‍👩‍👧", "👨‍👩‍👧"]);
  });

  it("clipWidth 截断时保留完整簇", () => {
    const clipped = clipWidth("✌️✌️✌️", 5);
    expect(clipped.endsWith("…")).toBe(true);
    // 截断后不能出现孤立的 VS16
    expect(clipped).not.toMatch(/\uFE0F(?![\uFE0E\uFE0F])$/);
    expect(displayWidth(clipped)).toBeLessThanOrEqual(5);
  });
});
