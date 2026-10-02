import { describe, it, expect } from "vitest";
import {
  theme,
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
