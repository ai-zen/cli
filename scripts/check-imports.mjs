#!/usr/bin/env node
/**
 * 产物 import 图检查 —— 「这个入口的运行期依赖图里有没有某样东西」。
 *
 * ## 为什么必须是产物图，不能是路径 grep
 *
 * 只要有人写着 `import { truncate } from "./render.js"`，把实现挪个地方 grep 就绿了，
 * 而 `render.js` 头顶那句 `import { Text } from "ink"` 照样把 ink 拖进依赖图。
 * 判据必须落在**编译产物**上：从 `dist/x.js` 出发，递归读它 import 了谁。
 *
 * ## 用法
 *
 *   node scripts/check-imports.mjs dist/stdio.js --forbid tui/
 *   node scripts/check-imports.mjs dist/stdio.js --forbid ink --forbid react
 *
 * 可给多个入口文件，`--forbid` 也可重复；命中的**子串**同时比对「写下的相对说明符」
 * 与「解析后的文件路径」，两种写法都能拦住。
 *
 * 只跟**相对路径**（`./x.js` / `../x.js`）：`ink` 这类裸包名不是文件，无法继续递归，
 * 但它们的名字会出现在「写下的说明符」里 —— `--forbid ink` 正是靠这一步命中的。
 *
 * 退出码：命中 → 1（并打印完整链路），未命中 → 0。
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const entries = [];
const forbidden = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--forbid") forbidden.push(argv[++i]);
  else entries.push(argv[i]);
}

if (entries.length === 0) {
  console.error("用法: node scripts/check-imports.mjs <dist/entry.js>... [--forbid <子串>]...");
  process.exit(2);
}

/** `from "x"` / `import("x")` / `export * from "x"` 里的说明符（锚行首，别被注释里的示例骗到） */
function specifiersOf(file) {
  const source = readFileSync(file, "utf-8");
  const out = [];
  for (const line of source.split("\n")) {
    if (!/^\s*(import|export)\b/.test(line) && !/^\s*\{/.test(line)) continue;
    for (const match of line.matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g)) {
      out.push(match[1] ?? match[2]);
    }
  }
  return out;
}

const seen = new Set();
/** 命中链：子串 → 从入口到它的路径（用来让人一眼看出「谁把 ink 拖进来的」） */
const violations = [];
const allSpecifiers = new Set();

function walk(file, chain) {
  const key = resolve(file);
  if (seen.has(key)) return;
  seen.add(key);
  for (const spec of specifiersOf(file)) {
    allSpecifiers.add(spec);
    const resolved = spec.startsWith(".") ? resolve(dirname(file), spec) : null;
    const hit = forbidden.find(
      (needle) =>
        spec.includes(needle) ||
        (resolved !== null && relative(process.cwd(), resolved).includes(needle)),
    );
    if (hit !== undefined) {
      violations.push({ needle: hit, spec, chain: [...chain, spec] });
      continue;
    }
    if (resolved === null) continue;
    if (!existsSync(resolved)) continue;
    if (!statSync(resolved).isFile()) continue;
    walk(resolved, [...chain, spec]);
  }
}

for (const entry of entries) {
  if (!existsSync(entry)) {
    console.error(`入口不存在: ${entry}（先 npm run build）`);
    process.exit(2);
  }
  walk(entry, [entry]);
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`禁止的依赖 "${v.needle}"：${v.spec}`);
    console.error(`  链路: ${v.chain.join(" → ")}`);
  }
  console.error(`\n✖ ${violations.length} 处命中（入口 ${entries.join(", ")}）`);
  process.exit(1);
}

console.log(
  `✔ ${entries.join(", ")}：图中 ${seen.size} 个文件，未命中 ${forbidden.join(" / ") || "(无 --forbid)"}`,
);
if (process.env.CHECK_IMPORTS_VERBOSE) {
  console.log([...allSpecifiers].sort().join("\n"));
}
