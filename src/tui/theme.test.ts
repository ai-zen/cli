import { describe, it, expect } from "vitest";
import {
  theme,
  syntax,
  parseHex,
  toHex,
  mixColor,
  gradientAt,
  pickLogo,
  logoGradientColors,
  LOGO_WIDE,
  LOGO_WIDE_WIDTH,
  LOGO_COMPACT,
} from "./theme.js";

describe("颜色工具", () => {
  it("parseHex / toHex 往返一致", () => {
    expect(toHex(parseHex("#22d3ee"))).toBe("#22d3ee");
    expect(toHex(parseHex("#000000"))).toBe("#000000");
  });

  it("mixColor 端点与中值", () => {
    expect(mixColor("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixColor("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixColor("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("gradientAt 单点与多点取值", () => {
    expect(gradientAt(["#000000"], 0.42)).toBe("#000000");
    const mid = gradientAt(["#000000", "#ffffff"], 0.5);
    expect(mid).toBe("#808080");
  });
});

describe("Logo", () => {
  it("pickLogo 按宽度选择宽/窄版", () => {
    expect(pickLogo(LOGO_WIDE_WIDTH + 10)).toBe(LOGO_WIDE);
    expect(pickLogo(20)).toBe(LOGO_COMPACT);
  });

  it("logoGradientColors 与 Logo 同形：空白不着色、非空白为合法 hex", () => {
    const colors = logoGradientColors(LOGO_WIDE, 0.3);
    expect(colors.length).toBe(LOGO_WIDE.length);
    colors.forEach((row, y) => {
      const chars = [...LOGO_WIDE[y]];
      expect(row.length).toBe(chars.length);
      row.forEach((color, x) => {
        if (chars[x] === " ") expect(color).toBeUndefined();
        else expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      });
    });
  });
});

describe("色板", () => {
  it("品牌色为合法 hex", () => {
    for (const color of theme.brand) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("syntax 色板（默认不写死近白 / 近黑）", () => {
  it("markdown 相关 scope 已映射；strong / emphasis / quote 用终端相对属性、不指定颜色", () => {
    expect(syntax.section?.bold).toBe(true);
    expect(syntax.strong?.bold).toBe(true);
    expect(syntax.strong?.color).toBeUndefined(); // 加粗 + 终端默认前景色
    expect(syntax.emphasis?.italic).toBe(true);
    expect(syntax.emphasis?.color).toBeUndefined();
    expect(syntax.quote?.dim).toBe(true);
    expect(syntax.bullet?.color).toBeDefined();
  });

  it("不留近白 token 色（亮色主题终端下会看不见）", () => {
    for (const [scope, style] of Object.entries(syntax)) {
      expect(style.color, scope).not.toBe("#e2e8f0");
      expect(style.color, scope).not.toBe("#cbd5e1");
      expect(style.color, scope).not.toBe("#ffffff");
      expect(style.color, scope).not.toBe("#000000");
    }
  });
});
