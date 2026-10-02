import { describe, it, expect } from "vitest";
import { mergePrompt, extractText } from "./stdio-runner.js";

describe("mergePrompt", () => {
  it("仅有指令", () => {
    expect(mergePrompt("你好", "")).toBe("你好");
  });

  it("仅有 stdin 内容", () => {
    expect(mergePrompt("", "一段文本\n")).toBe("一段文本");
  });

  it("指令 + 内容 → 指令在前、空行分隔", () => {
    expect(mergePrompt("总结要点", "第一行\n第二行\n")).toBe(
      "总结要点\n\n第一行\n第二行",
    );
  });

  it("仅空白 stdin 视为无内容", () => {
    expect(mergePrompt("你好", "\n\n")).toBe("你好");
  });

  it("两者皆空 → 空串", () => {
    expect(mergePrompt("", "")).toBe("");
    expect(mergePrompt("   ", "\n")).toBe("");
  });
});

describe("extractText", () => {
  it("字符串内容原样返回", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("undefined / null → 空串", () => {
    expect(extractText(undefined)).toBe("");
  });

  it("多文本块拼接", () => {
    expect(
      extractText([
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
  });

  it("非文本块降级为占位文本（仍为纯文本）", () => {
    const text = extractText([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
    ]);
    expect(text).toContain("看图");
    expect(text).toContain("https://x/y.png");
    expect(text).not.toMatch(/\x1b/);
  });
});
