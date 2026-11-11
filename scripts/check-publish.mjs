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
 * ## 例外：`devDependencies` 一律放行
 *
 * 消费者的安装图里**不包含别人的 `devDependencies`** —— 它们不进包、不会被安装，也
 * 就不可能把「发布出去的包装不上」这件事引进来。所以这一档不查本地路径。
 *
 * 本仓的 `@ai-zen/agents-{client,core,sdk,server}` 都靠这一档：它们是被**打包内联**
 * 进产物的构建期依赖，运行期不装（`dist/` 里没有对它们的 import，由 `check:imports`
 * 盯着）。三个运行期字段的口径一点没松。
 */

import { readFileSync } from "node:fs";

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
const offenders = [];
const allowedDevLinks = [];

for (const field of FIELDS) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    if (typeof spec === "string" && LOCAL_PATH_SPEC.test(spec)) {
      // devDependencies 不进消费者的安装图（理由见文件头）
      if (field === "devDependencies") {
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
  console.log(`  ℹ️  ${field}.${name} = ${JSON.stringify(spec)} —— devDependencies，不随包发出去`);
}

if (failed) process.exit(1);
