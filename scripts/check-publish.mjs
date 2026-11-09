#!/usr/bin/env node

/**
 * 发布前置检查 —— 在 `prepublishOnly` 里跑，失败即中止发布。
 *
 * 两件事，都是「发出去才发现」那一类问题：
 *
 * 1. **发布工具必须是 pnpm**。依赖里用了 `workspace:*` 协议，`npm publish` 不会替换它，
 *    用户装上去直接找不到依赖。
 * 2. **依赖不许带本地路径**（`link:` / `file:` / `./` / `../`）。`pnpm publish` 会替换
 *    `workspace:*`，但**不会**替换 `link:` —— 它会把 `"x": "link:../agents/packages/server"`
 *    原样写进发布出去的 package.json，用户的机器上根本没有那个相对路径。
 *
 * 第 2 条现在就该看得见：本地开发期人肉 link 是合理的（新包还没发布），但「发布前
 * 记得改回版本号」靠记性一定会漏，所以让它在这里红灯。
 *
 * ## 一个例外：`devDependencies` 指向**本仓私有测试件**
 *
 * `@ai-zen/agents-testing` 是 `private: true` 的测试件（假 LLM 端点），永远不会发布 ——
 * 于是「改成发布出去的精确版本号」对它根本不成立，而消费者也不会安装别人的
 * `devDependencies`。所以只对这一种情况放行：**字段是 devDependencies 且目标包自身
 * `private: true`**。运行期三个字段的口径一点没松。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

let failed = false;

// ==================== 1. 发布工具 ====================

const execPath = process.env.npm_execpath || "";
const userAgent = process.env.npm_config_user_agent || "";
const isPnpm = execPath.includes("pnpm") || userAgent.includes("pnpm");

if (!isPnpm) {
  console.error("");
  console.error("  ❌ 发布失败：检测到使用 npm 发布！");
  console.error("");
  console.error("     本项目的依赖使用了 pnpm workspace 协议 (workspace:*)");
  console.error("     使用 npm publish 会导致 workspace:* 无法被正确替换为实际版本号");
  console.error("     从而导致用户安装时找不到依赖包而失败。");
  console.error("");
  console.error("  ✅ 请使用以下命令发布：");
  console.error("     pnpm publish");
  console.error("");
  failed = true;
} else {
  console.log("  ✅ 发布工具检测通过 (pnpm)");
}

// ==================== 2. 依赖里的本地路径 ====================

const LOCAL_PATH_SPEC = /^(link:|file:|\.{1,2}\/)/;
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const ROOT = dirname(new URL("../package.json", import.meta.url).pathname);
const offenders = [];
const allowedDevLinks = [];

/**
 * 本地依赖指向的那个包自己是不是 `private`（= 永远不会发布）。
 *
 * 读不到就当「不是」，宁可红灯：一道闸门猜错方向的代价不对称。
 */
function isPrivateTarget(spec) {
  try {
    const relative = spec.replace(/^(link:|file:)/, "");
    const target = JSON.parse(readFileSync(resolve(ROOT, relative, "package.json"), "utf-8"));
    return target.private === true;
  } catch {
    return false;
  }
}

for (const field of FIELDS) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    if (typeof spec === "string" && LOCAL_PATH_SPEC.test(spec)) {
      // 只有 devDependencies 能放行，且必须是私有包（理由见文件头）
      if (field === "devDependencies" && isPrivateTarget(spec)) {
        allowedDevLinks.push({ field, name, spec });
        continue;
      }
      offenders.push({ field, name, spec });
    }
  }
}

if (offenders.length > 0) {
  console.error("  ❌ 发布失败：依赖里有本地路径，发布出去的包会装不上");
  console.error("");
  for (const { field, name, spec } of offenders) {
    console.error(`     ${field}.${name} = ${JSON.stringify(spec)}`);
  }
  console.error("");
  console.error("     `pnpm publish` 只替换 workspace:*，不会替换 link:/file:/相对路径。");
  console.error("     请先把它们改成要发布出去的精确版本号，例如：");
  for (const { name } of offenders) {
    console.error(`       "${name}": "<published-version>"`);
  }
  console.error("");
  failed = true;
} else {
  console.log("  ✅ 依赖路径检测通过（无 link:/file:/相对路径）");
}

for (const { field, name, spec } of allowedDevLinks) {
  console.log(`  ℹ️  ${field}.${name} = ${JSON.stringify(spec)} —— 目标包 private，不随发布出去`);
}

if (failed) process.exit(1);
