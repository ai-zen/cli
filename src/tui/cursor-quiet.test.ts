// 「显示光标」那一个序列在写终端那一层被拦掉：位置照旧逐帧更新（输入法要靠它），
// 只是那个方块不再被画出来。这几条锁的是「拦得准」与「别的字节一个都不动」。
import { describe, expect, it } from "vitest";
import { quietCursor, stripCursorShow } from "./cursor-quiet.js";

const SHOW = "\u001b[?25h";
const HIDE = "\u001b[?25l";
/** 一帧的典型样子：藏 → 上移 → 写行 → 挪回目标列 → 显 */
const FRAME = `${HIDE}\u001b[3A\u001b[5G hello \u001b[2A\u001b[7G${SHOW}`;

/** 一条记账用的假流：写进来的每一段都存下来，回调照调（Node 的 write 第三参） */
function fakeStream() {
  const writes: Array<{ chunk: unknown; rest: unknown[] }> = [];
  return {
    writes,
    columns: 100,
    rows: 40,
    isTTY: true,
    write(chunk: unknown, ...rest: unknown[]): boolean {
      writes.push({ chunk, rest });
      for (const arg of rest) if (typeof arg === "function") (arg as () => void)();
      return true;
    },
  };
}

describe("stripCursorShow", () => {
  it("只去掉「显示光标」，隐藏与定位序列一个字节不动", () => {
    expect(stripCursorShow(FRAME)).toBe(`${HIDE}\u001b[3A\u001b[5G hello \u001b[2A\u001b[7G`);
  });

  it("一帧里出现几次就去几次", () => {
    expect(stripCursorShow(`${SHOW}a${SHOW}${SHOW}`)).toBe("a");
  });

  it("没有这个序列时原样返回", () => {
    const text = `${HIDE}\u001b[2K 正文`;
    expect(stripCursorShow(text)).toBe(text);
  });
});

describe("quietCursor", () => {
  it("写到终端的那一段里不再有「显示光标」，但位置序列还在", () => {
    const stream = fakeStream();
    quietCursor(stream).write(FRAME);

    const out = String(stream.writes[0].chunk);
    expect(out.includes(SHOW)).toBe(false);
    // 输入法的锚点靠的就是这几个：藏、上移、定位
    expect(out.startsWith(HIDE)).toBe(true);
    expect(out.includes("\u001b[3A")).toBe(true);
    expect(out.includes("\u001b[7G")).toBe(true);
  });

  it("不是字符串的块原样透传（不参与过滤）", () => {
    const stream = fakeStream();
    const bytes = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68]);
    quietCursor(stream).write(bytes);

    expect(stream.writes[0].chunk).toBe(bytes);
  });

  it("其余属性与方法原样透传，且方法绑在真流上", () => {
    const stream = fakeStream();
    const quiet = quietCursor(stream);

    expect(quiet.columns).toBe(100);
    expect(quiet.rows).toBe(40);
    expect(quiet.isTTY).toBe(true);
    // 方法经代理调用时 `this` 必须是真流：写一个回调，看它有没有落到真流的记账里
    let called = false;
    quiet.write("x", () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(stream.writes).toHaveLength(1);
  });
});
