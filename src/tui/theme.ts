/**
 * TUI 主题与视觉元素 —— 颜色、渐变色与 ASCII Logo
 *
 * 设计原则：
 *   - 渐变只产出**每字符的 hex 颜色**，交由 Ink 的 `<Text color>` 渲染（不使用 chalk）；
 *   - 颜色是否生效由 Ink 依终端能力决定（无色终端自动退化为纯文本）；
 *   - Logo 提供「宽 / 窄」两套，按终端宽度选择，避免折行破坏构图。
 */

/** 品牌色板（tailwind 近似色） */
export const theme = {
  brand: ["#22d3ee", "#818cf8", "#f472b6"] as const,
  accent: "#a78bfa",
  user: "#22d3ee",
  assistant: "#e2e8f0",
  reasoning: "#8b9cb3",
  tool: "#fbbf24",
  error: "#f87171",
  ok: "#34d399",
  warn: "#fbbf24",
  dim: "#64748b",
  faint: "#475569",
  border: "#334155",
  highlight: "#c4b5fd",
};

/** 语法高亮：一段文本的样式覆盖（缺省字段沿用所在行的基础色） */
export interface TextStyle {
  color?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
}

/**
 * 语法高亮色板 —— 键为 highlight.js 的 scope（`highlight.ts` 已去掉 `hljs-` 前缀），
 * 供工具调用参数（JSON）与围栏代码块共用。暗色主题友好（tailwind 近似色）。
 */
export const syntax: Record<string, TextStyle> = {
  keyword: { color: "#c4b5fd", bold: true },
  built_in: { color: "#67e8f9" },
  type: { color: "#5eead4" },
  literal: { color: "#c4b5fd" },
  number: { color: "#fca5a5" },
  string: { color: "#86efac" },
  comment: { color: "#64748b", italic: true, dim: true },
  attr: { color: "#7dd3fc" },
  attribute: { color: "#7dd3fc" },
  property: { color: "#7dd3fc" },
  variable: { color: "#cbd5e1" },
  params: { color: "#cbd5e1" },
  title: { color: "#fbbf24" },
  function: { color: "#fbbf24" },
  selector: { color: "#fbbf24" },
  tag: { color: "#f472b6" },
  name: { color: "#f472b6" },
  punctuation: { color: "#64748b" },
  operator: { color: "#94a3b8" },
  meta: { color: "#94a3b8" },
  addition: { color: "#86efac" },
  deletion: { color: "#f87171" },
};

/** 把 highlight.js 的 scope 映射为具体样式；未知 scope 返回空（沿用基础色） */
export function syntaxStyle(scope: string): TextStyle {
  return scope ? (syntax[scope] ?? {}) : {};
}

// ==================== 颜色工具 ====================

type RGB = [number, number, number];

export function parseHex(hex: string): RGB {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

export function toHex([r, g, b]: RGB): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** 在两色之间线性插值 */
export function mixColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  return toHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

/** 给定一组颜色停靠点，取 `t`(0..1) 处的颜色（超出范围按循环处理） */
export function gradientAt(stops: readonly string[], t: number): string {
  const n = stops.length;
  if (n === 1) return stops[0];
  const wrapped = ((t % 1) + 1) % 1;
  const scaled = wrapped * (n - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  return mixColor(stops[i], stops[(i + 1) % n], f);
}

// ==================== ASCII Logo ====================

/** 宽版 Logo（约 42 列） */
export const LOGO_WIDE: string[] = [
  " █████╗ ██╗    ███████╗███████╗███╗   ██╗",
  "██╔══██╗██║    ╚══███╔╝██╔════╝████╗  ██║",
  "███████║██║      ███╔╝ █████╗  ██╔██╗ ██║",
  "██╔══██║██║     ███╔╝  ██╔══╝  ██║╚██╗██║",
  "██║  ██║██║    ███████╗███████╗██║ ╚████║",
  "╚═╝  ╚═╝╚═╝    ╚══════╝╚══════╝╚═╝  ╚═══╝",
];

/** 宽版 Logo 的显示宽度 */
export const LOGO_WIDE_WIDTH = Math.max(...LOGO_WIDE.map((l) => l.length));

/** 窄版 Logo（单行，用于窄终端） */
export const LOGO_COMPACT: string[] = ["◢ AI · ZEN ◣"];

/** 选择与终端宽度相匹配的 Logo 行 */
export function pickLogo(columns: number): string[] {
  return columns >= LOGO_WIDE_WIDTH + 6 ? LOGO_WIDE : LOGO_COMPACT;
}

/**
 * 计算 Logo 每个字符的渐变色（hex），供 Ink `<Text color>` 渲染。
 * 空格返回 `undefined`（不着色）；其余为「对角渐变 + 扫光」色。
 * @param lines Logo 文本行
 * @param phase 扫光相位（0..1，随时间推进产生流动感）
 */
export function logoGradientColors(lines: string[], phase = 0): (string | undefined)[][] {
  const height = lines.length;
  const width = Math.max(...lines.map((l) => l.length), 1);
  return lines.map((line, y) =>
    [...line].map((ch, x) => {
      if (ch === " ") return undefined;
      const t = (x / width) * 0.7 + (y / Math.max(height - 1, 1)) * 0.3 + phase;
      return gradientAt(theme.brand, t);
    }),
  );
}
