// 输入编辑 hook 的单元测试 —— 编辑器语义第一次有了直接断言
//
// 探针把每个编辑动作绑到一个字母键上，从真 stdin 驱动，再读回 `[草稿]@光标`。
// 这样测的是用户能感觉到的行为（删掉哪几个字素簇、光标停在哪），而不是把实现抄一遍。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text, useInput } from "ink";
import { setLocale } from "../../i18n/index.js";
import { useInputEditing } from "./use-input-editing.js";
import type { HistoryEntry } from "../chat-history.js";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 4));
};

function Probe({
  initialText,
  log,
  entries,
  restored,
}: {
  initialText?: string;
  log: string[];
  /** 历史数据源（模拟 `session.messages` 派生出来的草稿） */
  entries: HistoryEntry[];
  /** `↑` 把历史里的附件放回输入区时记在这里 */
  restored: string[];
}) {
  const e = useInputEditing({
    initialText,
    notify: (text, tone) => log.push(`${tone ?? "info"}:${text}`),
    historySource: () => entries,
    restoreImages: (images) => {
      for (const image of images) restored.push(image.base64);
    },
  });
  useInput((char) => {
    switch (char) {
      case "i":
        return e.insertAtCursor("!");
      case "e":
        return e.insertAtCursor("❤️"); // 2 个 code point 的单个字素簇
      case "b":
        return e.deleteBeforeCursor();
      case "d":
        return e.deleteAfterCursor();
      case "w":
        return e.deleteWordBeforeCursor();
      case "W":
        return e.deletePrevWhitespace();
      case "k":
        return e.deleteToEndOfLine();
      case "K":
        return e.deleteToStartOfLine();
      case "y":
        return e.yank(false);
      case "Y":
        return e.yank(true);
      case "u":
        return e.undoEdit();
      case "s":
        return e.toggleStash();
      case "h":
        return e.moveCursorToLineStart();
      case "l":
        return e.moveCursorToLineEnd();
      case "<":
        return e.moveCursor(-1);
      case ">":
        return e.moveCursor(1);
      case ",":
        return e.moveCursorByWord(-1);
      case ".":
        return e.moveCursorByWord(1);
      case "p":
        return e.historyPrev();
      case "n":
        return e.historyNext();
      case "r":
        return e.setInputText("reset");
      // `@` 补全的落字方式：整段区间替换
      case "R":
        return e.replaceRange(0, 5, "@xy");
      case "Z":
        return e.replaceRange(0, 999, "z"); // 右端越界要能钳制
      case "a":
        return e.setInputText("aaa");
      case "z":
        return e.setInputText("zzz");
      // 提交：消息进入 `messages`（历史数据源）+ 清草稿（与 Chat 的 runSubmit 一致）
      case "m": {
        entries.push({ text: e.input, images: [] });
        e.clearDraft();
        return;
      }
      case "c":
        return e.clearDraft();
    }
  });
  return <Text>{`[${e.input.replace(/\n/g, "⏎")}]@${e.cursor}`}</Text>;
}

async function probe(initialText?: string) {
  const log: string[] = [];
  const entries: HistoryEntry[] = [];
  const restored: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    <Probe initialText={initialText} log={log} entries={entries} restored={restored} />,
  );
  await flush();
  const press = async (char: string) => {
    stdin.write(char);
    await flush();
  };
  const type = async (text: string) => {
    for (const ch of text) await press(ch);
  };
  return { log, entries, restored, press, type, frame: () => (lastFrame() ?? "").trim(), unmount };
}

describe("useInputEditing", () => {
  it("初始草稿来自 initialText，光标在末尾", async () => {
    setLocale("zh");
    const p = await probe("hello");
    expect(p.frame()).toBe("[hello]@5");
    p.unmount();
  });

  it("在光标处插入，光标随之前移", async () => {
    const p = await probe("hello");
    await p.type("<<i"); // 光标退两格 → hello| 位置 3 → 插入 "!"
    expect(p.frame()).toBe("[hel!lo]@4");
    p.unmount();
  });

  it("退格与删除按字素簇处理（emoji 不会被切半）", async () => {
    const p = await probe("a❤️b");
    await p.press("<"); // 光标在 b 前（位置 3）
    await p.press("b"); // 删掉 ❤️ 整个字素簇
    expect(p.frame()).toBe("[ab]@1");
    await p.press("d"); // 删掉后面的 b
    expect(p.frame()).toBe("[a]@1");
    p.unmount();
  });

  it("边界上退格 / 删除都不动（不产生空编辑）", async () => {
    const p = await probe("ab");
    await p.press("d"); // 已在末尾
    expect(p.frame()).toBe("[ab]@2");
    await p.press("h");
    await p.press("b"); // 已在行首
    expect(p.frame()).toBe("[ab]@0");
    p.unmount();
  });

  it("删词把文本放进 kill ring，Ctrl+Y 可取回", async () => {
    const p = await probe("foo bar");
    await p.press("w"); // 删掉 "bar"
    expect(p.frame()).toBe("[foo ]@4");
    await p.press("y");
    expect(p.frame()).toBe("[foo bar]@7");
    p.unmount();
  });

  it("Alt+Y 在 kill ring 里往前循环", async () => {
    const p = await probe("one two three");
    await p.press("w"); // 删掉 "three"，环里 [three]
    await p.press("K"); // 删到行首 → 环里 ["one two ", three]，草稿空
    expect(p.frame()).toBe("[]@0");
    await p.press("y"); // 取最近一段
    expect(p.frame()).toBe("[one two ]@8");
    await p.press("Y"); // 往前循环到上一段
    expect(p.frame()).toBe("[one two three]@13");
    p.unmount();
  });

  it("撤销回到上一次编辑之前", async () => {
    const p = await probe("foo bar");
    await p.press("w");
    expect(p.frame()).toBe("[foo ]@4");
    await p.press("u");
    expect(p.frame()).toBe("[foo bar]@7");
    p.unmount();
  });

  it("暂存草稿后取回，并各推一条通知", async () => {
    setLocale("zh");
    const p = await probe("draft");
    await p.press("s");
    expect(p.frame()).toBe("[]@0");
    expect(p.log).toEqual(["info:已暂存输入（Ctrl+S 恢复）"]);
    await p.press("s");
    expect(p.frame()).toBe("[draft]@5");
    expect(p.log[1]).toBe("info:已恢复暂存的输入");
    p.unmount();
  });

  it("行首 / 行尾只在当前行内跳（多行草稿）", async () => {
    const p = await probe("ab\ncd");
    await p.press("h");
    expect(p.frame()).toBe("[ab⏎cd]@3");
    await p.press("l");
    expect(p.frame()).toBe("[ab⏎cd]@5");
    p.unmount();
  });

  it("按词移动光标", async () => {
    const p = await probe("foo bar");
    await p.press(",");
    expect(p.frame()).toBe("[foo bar]@4");
    await p.press(",");
    expect(p.frame()).toBe("[foo bar]@0");
    await p.press(".");
    expect(p.frame()).toBe("[foo bar]@3");
    p.unmount();
  });

  it("历史：上翻逐条回溯，下翻到底回到空草稿", async () => {
    const p = await probe("");
    await p.press("a");
    await p.press("m"); // 提交 "aaa"
    await p.press("z");
    await p.press("m"); // 提交 "zzz"
    await p.press("p");
    expect(p.frame()).toBe("[zzz]@3");
    await p.press("p");
    expect(p.frame()).toBe("[aaa]@3");
    await p.press("n");
    expect(p.frame()).toBe("[zzz]@3");
    await p.press("n");
    expect(p.frame()).toBe("[]@0");
    p.unmount();
  });

  it("没有历史时上翻是空转（不会把光标弄乱）", async () => {
    const p = await probe("abc");
    await p.press("p");
    expect(p.frame()).toBe("[abc]@3");
    p.unmount();
  });

  it("翻到带图片的历史：文本回来，附件也一并放回输入区", async () => {
    const p = await probe("");
    // 模拟「上一条发的是带图消息」：历史数据源里直接放一条带附件的草稿
    p.entries.push({ text: "看图", images: [{ base64: "QUJD", mime: "image/png" }] });

    await p.press("p");

    expect(p.frame()).toBe("[看图]@2");
    expect(p.restored).toEqual(["QUJD"]); // 旧实现只恢复文本，图片静默丢失
    p.unmount();
  });

  it("clearDraft 退出历史浏览：之后上翻从最新一条重新开始", async () => {
    const p = await probe("");
    await p.press("a");
    await p.press("m"); // 历史：aaa
    await p.press("z");
    await p.press("m"); // 历史：aaa, zzz
    await p.press("p");
    await p.press("p"); // 游标现在停在最早的一条（aaa）
    expect(p.frame()).toBe("[aaa]@3");
    await p.press("c"); // clearDraft：草稿清空、退出历史浏览
    expect(p.frame()).toBe("[]@0");
    await p.press("p"); // 应重新从最新一条（zzz）开始，而不是继续往回退
    expect(p.frame()).toBe("[zzz]@3");
    p.unmount();
  });
});

describe("replaceRange（`@` 补全的落字方式）", () => {
  it("替换 [start, end) 区间，光标落到插入文本末尾", async () => {
    setLocale("zh");
    const p = await probe("hello world");
    await p.press("R"); // replaceRange(0, 5, "@xy")
    expect(p.frame()).toBe("[@xy world]@3");
    p.unmount();
  });

  it("替换进撤销栈：Ctrl+_ 能退回补全前（含光标位置）", async () => {
    const p = await probe("hello world");
    await p.press("R");
    expect(p.frame()).toBe("[@xy world]@3");
    await p.press("u");
    expect(p.frame()).toBe("[hello world]@11");
    p.unmount();
  });

  it("右端越界被钳制（不产生空洞或异常）", async () => {
    const p = await probe("hello");
    await p.press("Z"); // replaceRange(0, 999, "z")
    expect(p.frame()).toBe("[z]@1");
    p.unmount();
  });
});
