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
 * ## 动态 import 是**边界**：记下来，不跟进去
 *
 * `import("…")` 与静态 `import … from "…"` 在运行期是两件事：前者只在那行代码真的被执行时
 * 才求值，后者在模块求值时就求值。本仓把「React 必须在 `NODE_ENV ||= "production"` 之后
 * 求值」这条纪律表达成**一个动态 import**（`app.ts` 里那句 `await import("./tui/index.js")`），
 * 所以这里必须区分两种边：
 *
 *   · **静态边**：跟进去，并参与 `--forbid` 判定 —— 它决定「入口求值时依赖图上有什么」；
 *   · **动态边**：只记一条「这里有边界」，**不跟进去**。跟进去了就等于说「TUI 的 React 也
 *     算在 `dist/index.js` 的求值依赖里」，那条纪律立刻自相矛盾。
 *
 * 判据因此是：`dist/index.js` 的**静态**图上不许有 `react` / `ink` —— 也就是说，
 * 谁把那条 `await import` 改成静态 import，这一关就会红（因为 tui 那个 chunk 顶上就是
 * `import { Text } from "ink"`），而不是像从前那样只能靠读注释发现。
 *
 * ## 为什么说明符是全文扫，不是按行首锚
 *
 * 上一版只认「行首是 import/export/`{`」的行，于是 `const { runTui } = await import("./chunks/tui-x.js")`
 * （行内动态 import，正是 rolldown 对 `app.ts` 那句的输出形状）**一条都扫不到**，
 * 多行 import 的 `} from "./x.js"` 收尾也扫不到。今天三个入口没出事，靠的是 rolldown 恰好
 * 输出单行静态 import —— 那不是判据。现在改成全文扫 `from "…"` / `import "…"` /
 * `import("…")`，跳过纯注释行（注释里写着示例 import 是最常见的假阳性来源）。
 *
 * ## 用法
 *
 *   node scripts/check-imports.mjs dist/stdio.js --forbid tui/
 *   node scripts/check-imports.mjs dist/index.js --forbid react
 *
 * 可给多个入口文件，`--forbid` 也可重复；命中的**子串**同时比对「写下的相对说明符」
 * 与「解析后的文件路径」，两种写法都能拦住（动态边上同样比对）。
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

/** 产物里出现的全部说明符，**连同它是静态边还是动态边** */
function specifiersOf(file) {
  const out = [];
  for (const rawLine of readFileSync(file, "utf-8").split("\n")) {
    const line = rawLine.trim();
    // 纯注释行整行丢掉：注释里的示例 import 是这类检查最常见的假阳性
    if (line === "" || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) {
      continue;
    }
    // 一条行内可能同时有 `from "…"` 与 `import("…")`（`import("./x"), import("./y")`），全取
    for (const match of line.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"/g)) {
      out.push({ spec: match[1] ?? match[2], dynamic: false });
    }
    for (const match of line.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/g)) {
      out.push({ spec: match[1], dynamic: true });
    }
  }
  return out;
}

const seen = new Set();
/** 命中链：子串 → 从入口到它的路径（用来让人一眼看出「谁把 ink 拖进来的」） */
const violations = [];
const allSpecifiers = new Set();
/** 动态 import 的边界（记下来只为汇报：它们**没有**被跟进） */
const boundaries = new Set();

function walk(file, chain) {
  const key = resolve(file);
  if (seen.has(key)) return;
  seen.add(key);
  for (const { spec, dynamic } of specifiersOf(file)) {
    allSpecifiers.add(spec);
    const resolved = spec.startsWith(".") ? resolve(dirname(file), spec) : null;
    const hit = forbidden.find(
      (needle) =>
        spec.includes(needle) ||
        (resolved !== null && relative(process.cwd(), resolved).includes(needle)),
    );
    if (hit !== undefined) {
      violations.push({ needle: hit, spec, dynamic, chain: [...chain, spec] });
      continue;
    }
    if (resolved === null) continue;
    // 动态边是**边界**：记一笔，不跟进去（理由见文件头）
    if (dynamic) {
      boundaries.add(relative(process.cwd(), resolved));
      continue;
    }
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
    const kind = v.dynamic ? "动态" : "静态";
    console.error(`禁止的依赖 "${v.needle}"（${kind}边）：${v.spec}`);
    console.error(`  链路: ${v.chain.join(" → ")}`);
  }
  console.error(`\n✖ ${violations.length} 处命中（入口 ${entries.join(", ")}）`);
  process.exit(1);
}

console.log(
  `✔ ${entries.join(", ")}：静态图上 ${seen.size} 个文件` +
    (boundaries.size > 0 ? `，${boundaries.size} 条动态边界未跟进` : "") +
    `，未命中 ${forbidden.join(" / ") || "(无 --forbid)"}`,
);
if (process.env.CHECK_IMPORTS_VERBOSE) {
  console.log(["--- 说明符 ---", ...[...allSpecifiers].sort()].join("\n"));
  if (boundaries.size > 0) {
    console.log(["--- 动态边界（未跟进）---", ...[...boundaries].sort()].join("\n"));
  }
}
