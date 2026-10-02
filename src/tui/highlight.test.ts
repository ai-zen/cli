import { describe, it, expect } from "vitest";
import { highlightJson, highlightCode, splitFences, supportedLanguages } from "./highlight.js";

describe("highlight 数据层（lowlight → highlight.js）", () => {
  it("JSON：键 / 数字 / 标点各自带 scope", () => {
    const tokens = highlightJson('{"a":1,"b":true}');
    const scopeOf = (text: string) => tokens.find((t) => t.text === text)?.scope;
    expect(scopeOf('"a"')).toBe("attr"); // 键
    expect(scopeOf("1")).toBe("number");
    expect(scopeOf(",")).toBe("punctuation");
    expect(scopeOf("true")).toBe("keyword"); // literal > keyword，取最内层
  });

  it("代码：关键字 / 注释 / 数字带 scope", () => {
    const tokens = highlightCode("const x = 1; // hi", "typescript");
    const scopeOf = (text: string) => tokens.find((t) => t.text === text)?.scope;
    expect(scopeOf("const")).toBe("keyword");
    expect(scopeOf("// hi")).toBe("comment");
    expect(scopeOf("1")).toBe("number");
  });

  it("语言别名可用（ts → typescript）", () => {
    const tokens = highlightCode("const a = 1", "ts");
    expect(tokens.find((t) => t.text === "const")?.scope).toBe("keyword");
  });

  it("未注册语言 / 缺省语言：原样返回、不着色", () => {
    expect(highlightCode("x", "definitely-not-a-lang")).toEqual([{ text: "x", scope: "" }]);
    expect(highlightCode("x")).toEqual([{ text: "x", scope: "" }]);
  });

  it("空串返回空数组", () => {
    expect(highlightJson("")).toEqual([]);
    expect(highlightCode("", "json")).toEqual([]);
  });

  it("注册了常用语言", () => {
    const langs = supportedLanguages();
    for (const l of ["json", "typescript", "python", "go", "rust", "bash", "sql", "yaml"]) {
      expect(langs).toContain(l);
    }
  });
});

describe("splitFences（围栏切分）", () => {
  it("切出文本与代码块，丢弃围栏行并识别语言", () => {
    expect(splitFences("前言\n```ts\nconst a = 1;\n```\n后记")).toEqual([
      { type: "text", text: "前言" },
      { type: "code", lang: "ts", text: "const a = 1;" },
      { type: "text", text: "后记" },
    ]);
  });

  it("无围栏时整段为文本", () => {
    expect(splitFences("纯文本\n第二行")).toEqual([{ type: "text", text: "纯文本\n第二行" }]);
  });

  it("无语言标注的代码块 lang 为 undefined", () => {
    expect(splitFences("```\ncode\n```")).toEqual([{ type: "code", lang: undefined, text: "code" }]);
  });
});
