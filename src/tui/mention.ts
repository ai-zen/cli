/**
 * `@` 文件路径补全 —— 纯逻辑层：识别 token、给候选排序、算出要插入什么。
 *
 * ## 三层分工
 *
 *   · `mention.ts`（本文件）：无 IO、无 React，全是可单测的纯函数；
 *   · `file-index.ts`：扫描项目文件（git 优先 / `fs.glob` 兜底）并缓存；
 *   · `screens/chat.tsx`：只做「按键 → 调上面两者 → 落字」的接线。
 *
 * ## 为什么只插路径文本，不附带文件内容
 *
 * `@` 只把**相对路径**写进草稿，消息本身仍是普通文本，模型用 `read` 工具自己去读。
 * 这样消息契约（core 的 `Message`）一点不动、插入可撤销、超大文件也不会把一条消息
 * 撑成巨型 payload —— 代价是多一轮工具调用，这是刻意的取舍。
 *
 * ## 判据落在字符事实上
 *
 * 「光标是否处在一个 `@token` 里」只看**光标之前的原始字符**：从光标往回扫到空白 /
 * 行首，途中遇到 `@` 且其**前一个字符**是行首、空白或分隔符才算 mention。于是：
 *
 *   · `a@b.com` 不算（`@` 前是 `a`）—— 邮箱不会突然弹出文件列表；
 *   · `@src/tui` 算，query 为 `src/tui`；
 *   · 光标停在 token 中间（`@src|/foo.ts`）也算，且 `end` 会**向后吃掉整个 token**：
 *     补全要替换的是整段，只替换到光标会留下半截残字。
 */
import { graphemes } from "./text.js";

/**
 * `@` token 两侧的分隔符 —— 让 `(@src/x)` / `"@src/x"` / `@src/x,` 也能触发，
 * 并且右端在 `)` 之前就收住（否则补全会把右括号一起替换掉）。
 *
 * 反向的代价是有意接受的：路径里出现这些字符（如 `a,b.txt`）时 token 会在那里截断，
 * 属于极少数情况，且补全仍可手动补完。
 */
const BOUNDARY = new Set([
  "(", ")", "[", "]", "{", "}", "<", ">",
  '"', "'", "`", "“", "”", "‘", "’",
  ",", "，", ":", "：", ";", "；",
  // 中文行文的标点：`@src/x。这里有问题` 里的 `。` 必须收住 token，否则补全会把
  // 后面整句一起替换掉，用户写句子时菜单也会一直弹着不走
  "。", "、", "！", "？", "（", "）", "《", "》",
  "【", "】", "〔", "〕", "「", "」", "『", "』",
  "…", "—", "～",
]);

/** 一次 `@` 补全的上下文 */
export interface Mention {
  /** `@` 之后到**光标**之间的原文（不含 `@`）—— 即用户当前敲的查询串 */
  query: string;
  /** `@` 的字素簇索引 */
  start: number;
  /** token 结束位置（字素簇索引，不含）：补全时替换 `[start, end)` */
  end: number;
}

/** 索引里的一条候选路径 */
export interface PathEntry {
  /** 相对 cwd 的路径（`/` 分隔，不带 `./` 前缀） */
  path: string;
  /** 是否目录 —— 决定补全后是否补一个 `/`，让用户可以继续往里钻 */
  dir: boolean;
}

/** 候选上限：再多也没人翻；同时给每次按键的内存过滤定个上界（10k 候选实测约 9ms） */
export const MENTION_LIMIT = 50;

function isSpace(ch: string): boolean {
  return ch !== "" && /\s/.test(ch);
}

/**
 * 取出光标所在的 `@token`；光标不在 token 里（或不在 mention 语境里）返回 `null`。
 *
 * 纯扫描、无正则回溯：文本长度就是输入框长度，逐字素走一遍即可。
 */
export function extractMention(text: string, cursor: number): Mention | null {
  const chars = graphemes(text);
  const cp = Math.max(0, Math.min(cursor, chars.length));

  // 1) 往回找 `@`：中途遇到空白，说明光标不在任何 token 内
  let i = cp;
  while (i > 0) {
    const ch = chars[i - 1]!;
    if (ch === "@") break;
    if (isSpace(ch) || BOUNDARY.has(ch)) return null;
    i -= 1;
  }
  if (i === 0) return null; // 一路扫到开头也没有 `@`
  const start = i - 1; // `@` 的下标

  // 2) 边界：`@` 前的字符必须是行首 / 空白 / 分隔符，否则当普通字符（邮箱里的 `@`）
  const prev = start > 0 ? chars[start - 1]! : "";
  if (prev && !isSpace(prev) && !BOUNDARY.has(prev)) return null;

  // 3) 右端：向后扫到空白或分隔符。光标停在 token 中间时也要吃掉整段
  let end = cp;
  while (end < chars.length) {
    const ch = chars[end]!;
    if (isSpace(ch) || BOUNDARY.has(ch)) break;
    end += 1;
  }

  return { query: chars.slice(start + 1, cp).join(""), start, end };
}

/** 补全要插入的文本：`@路径`，目录补一个 `/` 以便继续往下钻 */
export function mentionInsertText(path: string, dir: boolean): string {
  return `@${path}${dir ? "/" : ""}`;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 路径深度（`a.ts` = 0，`src/a.ts` = 1） */
function depth(path: string): number {
  let n = 0;
  for (const ch of path) if (ch === "/") n += 1;
  return n;
}

/**
 * 子序列打分（**越小越靠前**）；不匹配返回 `null`。
 *
 * 依据实测（10k 条候选、每次按键）：贪婪子序列 + 三种加权就够用 ——
 * `tuicha` 能直达 `src/tui/screens/chat.tsx`，不必让用户逐段敲路径。
 *
 * 加权：
 *   · 跳跃惩罚：命中间隔越大越差（`t..u..i` 不如 `tui` 连续）；
 *   · 连续命中奖励：连着的字符是同一段词；
 *   · **整体前缀** > **文件名前缀**：`src/tui/` 这种逐段输入要能压过散落命中；
 *   · 同分时浅的、短的优先：根目录文件比深埋的图标库更可能被点名。
 */
export function scorePath(query: string, path: string): number | null {
  // 空 query（刚敲下 `@`）：按「浅 → 短 → 字典序」铺开
  if (!query) return depth(path) * 4 + path.length * 0.05;

  const q = query.toLowerCase();
  const p = path.toLowerCase();
  let pi = 0;
  let score = 0;
  let lastHit = -1;
  for (const ch of q) {
    const hit = p.indexOf(ch, pi);
    if (hit === -1) return null;
    score += hit - pi; // 跳跃惩罚
    if (hit === lastHit + 1) score -= 1; // 连续命中
    lastHit = hit;
    pi = hit + 1;
  }

  if (p.startsWith(q)) score -= 200;
  else if (basename(p).startsWith(q)) score -= 40;

  return score + path.length * 0.05 + depth(path) * 2;
}

/**
 * 过滤 + 排序，取前 `limit` 条。
 *
 * 每次按键都会全量扫一遍（候选只来自内存数组），因此这里不做任何渐进/缓存：
 * 实测 10k 条最长 8.4ms，比一次渲染便宜。
 */
export function rankPaths(
  query: string,
  entries: readonly PathEntry[],
  limit = MENTION_LIMIT,
): PathEntry[] {
  const scored: { entry: PathEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scorePath(query, entry.path);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  return scored.slice(0, Math.max(0, limit)).map((item) => item.entry);
}
