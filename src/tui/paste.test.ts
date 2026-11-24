import { describe, expect, it } from "vitest";

import { normalizePastedText, PasteAssembler } from "./paste.js";

/**
 * 粘贴这条路的两件事：**归一**（`\r\n` 与控制字符）与**拼装**（一段粘贴可能被拆成几块）。
 *
 * 为什么它值得一组用例：这两件事都在「输入」这条路上，出错时不是崩溃，而是「粘进来的东西
 * 看起来不对」—— 多行粘贴被当成回车发出去、Windows 剪贴板的 `\r` 留在行尾把回显挤歪、
 * 一段长文本被拆包后只插进去前半截。这三种都不报错。
 */

describe("normalizePastedText", () => {
  it("CRLF 与单独的 CR 都收成 `\\n`（草稿只认 `\\n` 折行）", () => {
    expect(normalizePastedText("一\r\n二\r三")).toBe("一\n二\n三");
  });

  it("去掉其余控制字符，但留着 `\\n` 与 `\\t`", () => {
    expect(normalizePastedText("a\u0000b\u0007c\u001bd")).toBe("abcd");
    expect(normalizePastedText("行一\n\t缩进")).toBe("行一\n\t缩进");
  });

  it("末尾的换行整段去掉（粘贴几乎总带一个）", () => {
    expect(normalizePastedText("你好\n")).toBe("你好");
    expect(normalizePastedText("你好\r\n\r\n")).toBe("你好");
    // 中间的空行留着：那是用户要的排版
    expect(normalizePastedText("甲\n\n乙\n")).toBe("甲\n\n乙");
  });

  it("普通单行文本原样返回", () => {
    expect(normalizePastedText("帮我看看这个文件")).toBe("帮我看看这个文件");
  });
});

describe("PasteAssembler（括号粘贴的拼装）", () => {
  it("整段一次到齐：交出归一后的整段", () => {
    const assembler = new PasteAssembler();
    expect(assembler.feed("\u001b[200~第一行\r\n第二行\u001b[201~")).toEqual({
      kind: "text",
      text: "第一行\n第二行",
    });
    expect(assembler.collecting).toBe(false);
  });

  it("Ink 吃掉 ESC 的形状也认（`[200~…[201~`）", () => {
    const assembler = new PasteAssembler();
    expect(assembler.feed("[200~甲\r乙[201~")).toEqual({ kind: "text", text: "甲\n乙" });
  });

  it("被拆成几块：先 pending，收齐了才一次交出", () => {
    const assembler = new PasteAssembler();
    expect(assembler.feed("\u001b[200~第一段")).toEqual({ kind: "pending" });
    expect(assembler.collecting).toBe(true);
    expect(assembler.feed("，第二段")).toEqual({ kind: "pending" });
    expect(assembler.feed("\u001b[201~")).toEqual({
      kind: "text",
      text: "第一段，第二段",
    });
  });

  it("标记也可能被拆在两块里（`[20` + `0~…`）", () => {
    const assembler = new PasteAssembler();
    // 半截标记不是标记：照常当打字
    expect(assembler.feed("[20")).toEqual({ kind: "none" });
  });

  it("不是粘贴的输入一律 `none`（手工敲的字不受影响）", () => {
    const assembler = new PasteAssembler();
    expect(assembler.feed("a")).toEqual({ kind: "none" });
    expect(assembler.feed("\r")).toEqual({ kind: "none" });
    expect(assembler.collecting).toBe(false);
  });

  it("粘了个空的：交出空串（调用方据此不插入任何东西）", () => {
    const assembler = new PasteAssembler();
    expect(assembler.feed("\u001b[200~\u001b[201~")).toEqual({ kind: "text", text: "" });
  });

  it("结束标记之后还跟着打字：忽略，不混进这一段", () => {
    const assembler = new PasteAssembler();
    expect(assembler.feed("\u001b[200~甲\u001b[201~junk")).toEqual({ kind: "text", text: "甲" });
    // 那一段「junk」由后面的帧照常当打字处理（这里不替它做主）
    expect(assembler.collecting).toBe(false);
  });
});
