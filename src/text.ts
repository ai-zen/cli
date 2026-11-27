/**
 * 纯文本度量，零 UI 依赖（不 import React / Ink），会话层与命令层都能用。
 *
 * 它必须住在 `tui/` 外面：`tui/screens/render.tsx` 第一行就是 `import { Text } from "ink"`，命令层
 * 为了一个几行的纯函数（`/load` 的预览、`/back` 的标签）就会把 ink 拖进自己的依赖图 —— 实测那条链
 * 的 import 图里，`ink` 与 `react/jsx-runtime` 只有这一条来源。判据不能是路径 grep：只要调用点写的是
 * `from "./render.js"`，把文件挪个地方 grep 就绿了，ink 仍在图里。真正的门禁是产物 import 图
 * （`scripts/check-imports.mjs`）。
 *
 * `graphemes` / `clusterWidth` 跟着搬，是因为 `truncate` 必须按字素簇切，而字素簇切分就是这三个函数
 * 构成的最小簇，拆不开：`truncate` → `graphemes`（+ `clusterWidth`）→ `string-width`。留下的
 * `wrapText` / `layoutInput` 是排版（输入区折行、光标定位），仍归 `tui/`。
 *
 * `tui/text.ts` 把这几个名字原样转出，所以既有调用点一行不用改。
 */

import stringWidth from "string-width";

// 宽度计算直接交给 `string-width`：Ink 排版时用的就是它（`ink/build/output.js` 第一行
// `import stringWidth from 'string-width'`）。必须与 Ink 同一把尺子，否则一切依赖宽度的东西
// （折行、状态栏装行、光标列号）都差一截：East Asian Wide 符号（`⚡` `✅`）、ZWJ 序列
// （`👨‍👩‍👧`）、VS16 序列（`✌️`）与国旗对（`🇨🇳`）在两种算法下的差别能从 1 列到好几列。
//
// 仍然需要 `graphemes()`：`string-width` 只管宽度，不管光标该以什么为单位移动。

/**
 * 单簇宽度缓存：`string-width` 内部要跑 emoji 与 EAW 正则，而折行是每帧热路径；字素簇的种类远少于
 * 出现次数，缓存后几乎零成本。
 */
const clusterWidthCache = new Map<string, number>();
const CLUSTER_CACHE_LIMIT = 4096;

export function displayWidth(text: string): number {
  if (text === "") return 0;
  return stringWidth(text);
}

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
 * 把一个字符串切成字素簇（用户感知的「一个字符」）。
 *
 * 不能按 code point 切：`✌️` 是 `U+270C U+FE0F` 两个 code point、`👨‍👩‍👧` 是五个、`🇨🇳` 是两个
 * 区域指示符，它们都是一个字素簇。按 code point 切会让光标停在簇中间（例如停在 `✌` 与 `U+FE0F`
 * 之间），后果是反显光标变成在反显一个变体选择符（屏幕上什么都不显示，实测 Ink 的输出里整个反显段
 * 直接消失）、退格只删掉半个 emoji 留下一个孤立的 `U+FE0F`、光标列号也因为半个簇的宽度算错。
 *
 * 用 `Intl.Segmenter`（Node 内置，无需依赖）；环境不支持时退回 code point 切分。
 */
const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh", { granularity: "grapheme" })
    : null;

/**
 * 「可能出现多个 code point 合为一簇」的码位集合，命中才需要 `Intl.Segmenter`。
 *
 * 折行是每帧热路径，而 `Segmenter.segment()` 比直接遍历慢一个数量级；但绝大多数文本（ASCII / CJK /
 * 代码）每一簇就是一个 code point，根本不需要分词器。实测一帧 60 行中文：663 µs → 52 µs。
 *
 * 命中条件宁可误报不可漏报（误报只是走慢路径，漏报会切错字）：`\u{10000}-\u{10FFFF}` 是 astral
 * 平面（emoji、区域指示符、肤色修饰符、tag 序列、扩展汉字），注意不能写 `\uD800-\uDFFF` —— `u`
 * 模式下那是孤立代理项，合法的 astral 字符反而匹配不到；`\u000D`（CRLF 是一个字素簇）、
 * `\u200C` `\u200D`（ZWNJ / ZWJ）、`\u1100-\u11FF`（韩文组合字母）、`\p{M}`（所有组合附加符：
 * 拉丁、天城文、阿拉伯文、键帽 U+20E3、变体选择符 U+FE00-FE0F…）。最后一条覆盖不了枚举，必须用
 * Unicode 属性。
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
 * 单行化文本（表格 / 列表项用）：折叠空白并按字素簇截断。
 *
 * 用于列表项等「必须恰好占一行」的场景，让 Ink 不会二次折行，自底部向上布局时才能精确算出顶部留白。
 */
export function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  // 按簇而不是按 UTF-16 code unit 切：`slice` 会把 emoji / ZWJ 序列劈成两半，
  // 屏幕上显示为一个孤立代理项（一个方框）。`/back` 的标签与 `/load` 的预览都走这里。
  const chars = graphemes(single);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : single;
}

/**
 * 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示：那是喂给模型的上下文，不该显示给用户。
 *
 * 它属于会话层而不属于渲染：`/back` 要把被删消息的原文预填进输入框，`rollbackTo()` 要把服务端给的
 * 原文还回来，两处都在剥同一段东西。
 */
export function stripCwdNote(text: string): string {
  // 两代格式都要认：新（英文 + system-injected 标记）与旧存档里的中文格式。
  // 旧格式不认会把磁盘上已有会话的 cwd 笔记渲染出来。
  return text
    .replace(/\n+\[system-injected: [^\]\n]*\]\nCurrent working directory: [^\n]*$/, "")
    .replace(/\n+(?:\[工作目录变更\]\n)?当前工作目录: [^\n]*$/, "");
}
