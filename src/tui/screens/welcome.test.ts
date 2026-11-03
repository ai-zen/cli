// 欢迎块（空对话时的品牌区）—— 纯函数产出 `RLine[]`，不依赖 Ink，可直接断言
import { describe, expect, it, beforeEach } from "vitest";
import { welcomeLines } from "./welcome.js";
import { setLocale } from "../../i18n/index.js";
import { LOGO_COMPACT, LOGO_WIDE } from "../theme.js";
import { displayWidth } from "../text.js";
import { CLI_VERSION, SDK_VERSION, CORE_VERSION } from "../../version.js";

/** 行首空白列数 */
const leftPad = (text: string) => text.length - text.trimStart().length;

describe("welcomeLines", () => {
  beforeEach(() => setLocale("zh"));

  it("宽终端用 6 行宽版 logo", () => {
    const lines = welcomeLines({ columns: 100 });
    // logo 6 行 + 空行 + 标语 + 版本
    expect(lines).toHaveLength(6 + 1 + 2);
    LOGO_WIDE.forEach((logoLine, i) => {
      expect(lines[i].text.trimEnd().endsWith(logoLine.trim())).toBe(true);
    });
  });

  it("窄终端退化成单行 logo", () => {
    const lines = welcomeLines({ columns: 40 });
    expect(lines[0].text.trim()).toBe(LOGO_COMPACT[0].trim());
    expect(lines).toHaveLength(1 + 1 + 2);
  });

  it("带标语与三处版本号", () => {
    const text = welcomeLines({ columns: 100 })
      .map((line) => line.text)
      .join("\n");
    expect(text).toContain("终端里的 AI 协作台");
    expect(text).toContain(`v${CLI_VERSION}`);
    expect(text).toContain(`sdk ${SDK_VERSION}`);
    expect(text).toContain(`core ${CORE_VERSION}`);
  });

  it("logo 逐字符着色：非空白有色、空白无色", () => {
    const logoLine = welcomeLines({ columns: 100 })[0];
    expect(logoLine.spans).toBeDefined();
    for (const span of logoLine.spans!) {
      if (span.text.trim() === "") expect(span.color).toBeUndefined();
      else expect(span.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(logoLine.spans!.some((span) => span.color)).toBe(true);
  });

  it("每行各自横向居中（左右余量差不超过 1 列）", () => {
    const columns = 100;
    for (const line of welcomeLines({ columns })) {
      if (line.kind === "gap") continue;
      const left = leftPad(line.text);
      const right = columns - displayWidth(line.text.trimEnd());
      expect(Math.abs(right - left)).toBeLessThanOrEqual(1);
    }
  });
});

describe("welcomeLines（英文界面）", () => {
  beforeEach(() => setLocale("en"));

  it("标语跟随界面语言", () => {
    const text = welcomeLines({ columns: 100 })
      .map((line) => line.text)
      .join("\n");
    expect(text).toContain("The AI collaboration desk in your terminal");
    expect(text).not.toContain("终端里的 AI 协作台");
  });
});
