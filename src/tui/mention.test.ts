import { describe, expect, it } from "vitest";
import {
  extractMention,
  mentionInsertText,
  rankPaths,
  scorePath,
  MENTION_LIMIT,
  type PathEntry,
} from "./mention.js";

/** 光标停在文本末尾的常用简写 */
const at = (text: string) => ({ text, cursor: text.length });

describe("extractMention：光标在不在 @token 里", () => {
  it("刚敲下 @（行首、无查询串）也触发", () => {
    const { text, cursor } = at("@");
    expect(extractMention(text, cursor)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("空白之后的 @ 触发，query 是 @ 到光标之间的原文", () => {
    const { text, cursor } = at("看看 @src/tu");
    expect(extractMention(text, cursor)).toEqual({ query: "src/tu", start: 3, end: 10 });
  });

  it("邮箱里的 @ 不算 mention（前一个是单词字符）", () => {
    const { text, cursor } = at("mail a@b.com");
    expect(extractMention(text, cursor)).toBeNull();
  });

  it("光标停在 token 中间：query 截止于光标，end 吃掉整段（补全才替换得干净）", () => {
    const text = "@src/foo.ts";
    expect(extractMention(text, 5)).toEqual({ query: "src/", start: 0, end: 11 });
  });

  it("光标已离开 token（后面有空白）时返回 null", () => {
    const { text, cursor } = at("@foo bar");
    expect(extractMention(text, cursor)).toBeNull();
  });

  it("不跨行：上一行的 @token 在换行后失效", () => {
    expect(extractMention("@foo\nbar", 8)).toBeNull();
  });

  it("括号 / 引号分隔的 @ 可触发，且右端在分隔符前收住", () => {
    expect(extractMention("(@src/x)", 7)).toEqual({ query: "src/x", start: 1, end: 7 });
    expect(extractMention('"@src/x"', 7)).toEqual({ query: "src/x", start: 1, end: 7 });
  });

  it("光标在 0 位 / 文本为空时安全返回 null", () => {
    expect(extractMention("", 0)).toBeNull();
    expect(extractMention("@foo", 0)).toBeNull();
  });

  it("emoji 等字素簇按簇计数（index 不是 code point）", () => {
    // `👨‍👩‍👧` 是 5 个 code point 但 1 个字素簇
    const { text, cursor } = at("👨‍👩‍👧 @src");
    const mention = extractMention(text, cursor);
    expect(mention).toEqual({ query: "src", start: 2, end: 6 });
  });
});

describe("mentionInsertText", () => {
  it("文件插 `@路径`，目录补尾斜杠（以便继续往下钻）", () => {
    expect(mentionInsertText("src/tui/chat.tsx", false)).toBe("@src/tui/chat.tsx");
    expect(mentionInsertText("src/tui", true)).toBe("@src/tui/");
  });
});

describe("scorePath / rankPaths：排序判据", () => {
  const entries: PathEntry[] = [
    { path: "src/tui/screens/chat.tsx", dir: false },
    { path: "src/tui/screens/chat-commands.ts", dir: false },
    { path: "src/tui", dir: true },
    { path: "docs/zh/configuration.md", dir: false },
    { path: "README.md", dir: false },
  ];

  it("整体前缀压过其他匹配（逐段敲路径时目录排最前）", () => {
    const ranked = rankPaths("src/tui", entries);
    expect(ranked[0]).toEqual({ path: "src/tui", dir: true });
  });

  it("文件名前缀优先于路径深处的散落命中", () => {
    const ranked = rankPaths("readme", entries);
    expect(ranked[0]?.path).toBe("README.md");
  });

  it("子序列（非连续）也能命中：tuicha → chat.tsx", () => {
    const ranked = rankPaths("tuicha", entries);
    expect(ranked[0]?.path).toBe("src/tui/screens/chat.tsx");
  });

  it("不匹配的候选被过滤掉", () => {
    expect(rankPaths("zzz", entries)).toEqual([]);
  });

  it("空 query 按「浅 → 短」铺开", () => {
    const ranked = rankPaths("", entries);
    expect(ranked.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/tui",
      "docs/zh/configuration.md",
      "src/tui/screens/chat.tsx",
      "src/tui/screens/chat-commands.ts",
    ]);
  });

  it("大小写不敏感", () => {
    expect(scorePath("README", "readme.md")).toBe(scorePath("readme", "readme.md"));
  });

  it("limit 生效（默认 MENTION_LIMIT）", () => {
    const many: PathEntry[] = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.ts`, dir: false }));
    expect(rankPaths("f", many)).toHaveLength(MENTION_LIMIT);
    expect(rankPaths("f", many, 3)).toHaveLength(3);
    expect(rankPaths("f", many, 0)).toEqual([]);
  });
});
