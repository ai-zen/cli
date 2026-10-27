import { describe, it, expect } from "vitest";
import {
  deleteToPrevWhitespace,
  killedText,
  killAt,
  KILL_RING_SIZE,
  popUndo,
  pushKill,
  pushUndo,
  UNDO_LIMIT,
  type EditState,
} from "./input-editing.js";

describe("Ctrl+W：删到前一空白（标点不切分）", () => {
  it("整条路径一次删掉（与按词删除的关键区别）", () => {
    expect(deleteToPrevWhitespace("see src/utils/foo.ts", 20)).toEqual({ text: "see ", cursor: 4 });
  });
  it("先吃掉光标前的空白", () => {
    expect(deleteToPrevWhitespace("foo bar   ", 10)).toEqual({ text: "foo ", cursor: 4 });
  });
  it("行首 / 空输入为空操作", () => {
    expect(deleteToPrevWhitespace("foo", 0)).toEqual({ text: "foo", cursor: 0 });
    expect(deleteToPrevWhitespace("", 0)).toEqual({ text: "", cursor: 0 });
  });
  it("CJK 无空格时整段删除", () => {
    expect(deleteToPrevWhitespace("你好，世界", 5)).toEqual({ text: "", cursor: 0 });
  });
  it("跨行只删当前行内容", () => {
    expect(deleteToPrevWhitespace("foo\nbar baz", 11)).toEqual({ text: "foo\nbar ", cursor: 8 });
  });
});

describe("killedText：求被删掉的那一段", () => {
  it("向前删除 / 向后删除 / 中间删除都能还原", () => {
    expect(killedText("hello world", "hello ")).toBe("world");
    expect(killedText("hello world", " world")).toBe("hello");
    expect(killedText("abcdef", "abef")).toBe("cd");
  });
  it("无变化时返回空串", () => {
    expect(killedText("same", "same")).toBe("");
  });
});

describe("kill ring（Ctrl+Y / Alt+Y）", () => {
  it("最新的排在最前，空串不入环", () => {
    let ring: string[] = [];
    ring = pushKill(ring, "a");
    ring = pushKill(ring, "");
    ring = pushKill(ring, "b");
    expect(ring).toEqual(["b", "a"]);
    expect(killAt(ring, 0)).toBe("b");
    expect(killAt(ring, 1)).toBe("a");
    expect(killAt(ring, 2)).toBeUndefined();
  });
  it("连续相同的删除不重复入环", () => {
    let ring: string[] = [];
    ring = pushKill(ring, "word");
    ring = pushKill(ring, "word");
    expect(ring).toEqual(["word"]);
  });
  it("超出上限时丢弃最旧的", () => {
    let ring: string[] = [];
    for (const s of ["a", "b", "c", "d", "e", "f"]) ring = pushKill(ring, s);
    expect(ring).toHaveLength(KILL_RING_SIZE);
    expect(ring[0]).toBe("f");
  });
});

describe("撤销栈（Ctrl+_）", () => {
  const s = (text: string, cursor: number): EditState => ({ text, cursor });

  it("后进先出，且相同状态不重复入栈", () => {
    let stack: EditState[] = [];
    stack = pushUndo(stack, s("a", 1));
    stack = pushUndo(stack, s("a", 1));
    stack = pushUndo(stack, s("ab", 2));
    expect(stack).toHaveLength(2);

    const first = popUndo(stack)!;
    expect(first.state).toEqual(s("ab", 2));
    const second = popUndo(first.rest)!;
    expect(second.state).toEqual(s("a", 1));
    expect(popUndo(second.rest)).toBeNull();
  });

  it("超出上限时丢弃最旧的", () => {
    let stack: EditState[] = [];
    for (let i = 0; i < UNDO_LIMIT + 10; i += 1) stack = pushUndo(stack, s(`t${i}`, 0));
    expect(stack).toHaveLength(UNDO_LIMIT);
    expect(stack[stack.length - 1].text).toBe(`t${UNDO_LIMIT + 9}`);
  });
});

describe("emoji / 字素簇：编辑不拆半个字符", () => {
  /**
   * `✌️` 是 `U+270C U+FE0F` 两个 code point、一个簇。按 code point 删会留下孤立的
   * `U+FE0F`（屏幕上什么都看不到，但下次退格会先吃掉它，表现为「退格没反应」）。
   */
  it("Ctrl+W 整簇删除，不留孤立变体选择符", () => {
    expect(deleteToPrevWhitespace("a ✌️", 3)).toEqual({ text: "a ", cursor: 2 });
    expect(deleteToPrevWhitespace("✌️", 1)).toEqual({ text: "", cursor: 0 });
  });

  it("ZWJ 组合 emoji 也整簇删除", () => {
    expect(deleteToPrevWhitespace("👨‍👩‍👧", 1)).toEqual({ text: "", cursor: 0 });
  });

  it("killedText 取被删段落时按簇比对（不会切出半个 emoji）", () => {
    expect(killedText("a ✌️", "a ")).toBe("✌️");
    expect(killedText("✌️✌️", "✌️")).toBe("✌️");
  });
});
