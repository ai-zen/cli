/**
 * 纯文本度量 —— **零 UI 依赖**（不 import React / Ink），会话层与命令层都能用。
 *
 * ## 为什么它必须住在 `tui/` 外面
 *
 * `truncate` 曾经住在 `tui/screens/render.tsx`，而那个文件第一行是
 * `import { Text } from "ink"`。于是命令层为了一个 6 行的纯函数（`/load` 的预览、
 * `/back` 的标签）把 ink 拖进了自己的依赖图 —— 实测 `dist/tui/screens/chat-commands.js`
 * 的 24 文件 import 图里，`ink` 与 `react/jsx-runtime` **只有这一条**来源。
 *
 * 判据不能是「路径 grep」：只要调用点写的是 `from "./render.js"`，把文件挪个地方 grep
 * 就绿了，ink 仍在图里。真正的门禁是**产物 import 图**（`scripts/check-imports.mjs`）。
 *
 * ## 为什么 `graphemes` / `clusterWidth` 也跟着搬
 *
 * `truncate` 必须按**字素簇**切（`slice` 会把 emoji / ZWJ 家族劈成两半，屏幕上显示成
 * 一个孤立代理项）。而字素簇切分就是这三个函数构成的一个最小簇，拆不开：
 * `truncate` → `graphemes`（+ `clusterWidth`）→ `string-width`。
 * 留下的 `wrapText` / `layoutInput` 是**排版**（输入区折行、光标定位），仍归 `tui/`。
 *
 * `tui/text.ts` 把这几个名字原样转出，所以既有调用点一行不用改。
 */

import stringWidth from "string-width";

// ==================== 显示宽度 ====================
//
// 宽度计算直接交给 `string-width` —— **Ink 排版时用的就是它**
//（`ink/build/output.js` 第一行 `import stringWidth from 'string-width'`）。
//
// 曾经这里手写了一张 `isWide` 区间表，逐 code point 累加。结果是两把尺子：
//   - `⚡` `✅` `✨` `⭐` 这类 East Asian Wide 符号我们算 1 列、Ink 算 2 列；
//   - `👨‍👩‍👧` 逐 code point 累加得 8 列，实际只占 2 列；
//   - `✌️`（VS16 序列）与 `🇨🇳`（国旗对）同样对不上。
// 于是一切依赖宽度的东西（折行、状态栏装行、光标列号）都差一截，还靠
// 「预留 1 列余量」硬顶。现在两边用同一把尺子，这类偏差从根上没了。
//
// 仍然需要 `graphemes()`：`string-width` 只管宽度，不管「光标该以什么为单位移动」。

/**
 * 单簇宽度缓存 —— `string-width` 内部要跑 emoji / EAW 正则，而折行是每帧热路径；
 * 字素簇的种类远少于出现次数，缓存后几乎零成本。
 */
const clusterWidthCache = new Map<string, number>();
const CLUSTER_CACHE_LIMIT = 4096;

/** 终端显示宽度（按字素簇，与 Ink 的排版完全一致） */
export function displayWidth(text: string): number {
  if (text === "") return 0;
  return stringWidth(text);
}

/** 单个字素簇的显示宽度（结果带缓存） */
export function clusterWidth(cluster: string): number {
  if (cluster === "") return 0;
  const cached = clusterWidthCache.get(cluster);
  if (cached !== undefined) return cached;
  const width = stringWidth(cluster);
  if (clusterWidthCache.size >= CLUSTER_CACHE_LIMIT) clusterWidthCache.clear();
  clusterWidthCache.set(cluster, width);
  return width;
}

/**
 * 把一个字符串切成**字素簇**（用户感知的「一个字符」）。
 *
 * 为什么不能按 code point 切：`✌️` 是 `U+270C U+FE0F` 两个 code point、`👨‍👩‍👧` 是
 * 五个、`🇨🇳` 是两个区域指示符——它们都是**一个**字素簇。按 code point 切会让光标
 * 停在簇中间（例如停在 `✌` 与 `U+FE0F` 之间），后果是：
 *   - 反显光标变成在反显一个变体选择符 —— 屏幕上什么都不显示（实测：Ink 的输出里
 *     整个反显段直接消失）；
 *   - 退格只删掉半个 emoji，留下一个孤立的 `U+FE0F`；
 *   - 光标列号也会因为「半个簇」的宽度而算错。
 *
 * 用 `Intl.Segmenter`（Node 内置，无需依赖）；环境不支持时退回 code point 切分。
 */
const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh", { granularity: "grapheme" })
    : null;

/**
 * 「可能出现多个 code point 合为一簇」的码位集合。命中才需要 `Intl.Segmenter`。
 *
 * 折行是每帧热路径，而 `Segmenter.segment()` 比直接遍历慢一个数量级；但绝大多数
 * 文本（ASCII / CJK / 代码）每一簇就是一个 code point，根本不需要分词器。
 * 实测一帧 60 行中文：663 µs → 52 µs。
 *
 * 命中条件必须**宁可误报不可漏报**（误报只是走慢路径，漏报会切错字）：
 *   - `\u{10000}-\u{10FFFF}`：astral 平面（emoji、区域指示符、肤色修饰符、
 *     tag 序列、扩展汉字）。注意**不能**写 `\uD800-\uDFFF`：`u` 模式下那是
 *     「孤立代理项」，合法的 astral 字符（已合成为一个码位）反而匹配不到；
 *   - `\u000D`：CRLF 是一个字素簇（`\r\n` 两个 code point）；
 *   - `\u200C` `\u200D`：ZWNJ / ZWJ（连字与 emoji 家族连接）；
 *   - `\u1100-\u11FF`：韩文组合字母（`\u1100\u1161\u11A8` 三簇合一）；
 *   - `\p{M}`：所有组合附加符（拉丁、天城文、阿拉伯文、键帽 U+20E3、
 *     变体选择符 U+FE00-FE0F …）。这一条覆盖不了用枚举列全，必须用 Unicode 属性。
 */
const NEEDS_SEGMENTER = /[\u{10000}-\u{10FFFF}\u000D\u200C\u200D\u1100-\u11FF\p{M}]/u;

export function graphemes(text: string): string[] {
  if (text === "") return [];
  // 每簇就是一个 code point 的普通文本：直接切，省掉整个分词器
  if (!segmenter || !NEEDS_SEGMENTER.test(text)) return Array.from(text);
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/**
 * 单行化文本（表格 / 列表项用）：折叠空白并按**字素簇**截断。
 *
 * 用于列表项等「必须恰好占一行」的场景 —— 让 Ink 不会二次折行，
 * 自底部向上布局时才能精确算出顶部留白。
 */
export function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  // 按簇而不是按 UTF-16 code unit 切：`slice` 会把 emoji / ZWJ 序列劈成两半，
  // 屏幕上显示为一个孤立代理项（一个方框）。`/back` 的标签与 `/load` 的预览都走这里。
  const chars = graphemes(single);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : single;
}

/**
 * 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示。
 * 该提示是喂给模型的上下文，不该显示给用户。
 *
 * 它属于**会话层**而不属于渲染：`/back` 要把被删消息的原文预填进输入框，
 * `rollbackTo()` 要把服务端给的原文还回来 —— 两处都在剥同一段东西。
 */
export function stripCwdNote(text: string): string {
  // 两代格式都要认：新（英文 + system-injected 标记）与旧存档里的中文格式。
  // 旧格式不认会把磁盘上已有会话的 cwd 笔记渲染出来。
  return text
    .replace(/\n+\[system-injected: [^\]\n]*\]\nCurrent working directory: [^\n]*$/, "")
    .replace(/\n+(?:\[工作目录变更\]\n)?当前工作目录: [^\n]*$/, "");
}
