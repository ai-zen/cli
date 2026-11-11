/**
 * 版本信息 —— CLI / SDK / Core。
 *
 * 三个值都在**构建时**由 `rolldown.config.mjs` 注入成字面量（`transform.define`）。
 *
 * 为什么不照旧在运行期读 `package.json`：打包之后本模块被 hoist 进 `dist/chunks/`，
 * `createRequire(import.meta.url)` 之后 `../package.json` 不再指向包根；而
 * `@ai-zen/agents-sdk` / `-core` 是被**内联**进来的，消费者机器上压根没有它们的
 * `package.json` 可读。构建时定死既准确又省掉一次磁盘访问。
 *
 * `typeof` 判断留了一条回退：直接跑 TS（`vitest`、调试）时没有构建期注入，
 * 三个标识符是未声明的全局 —— `typeof` 对未声明标识符安全返回 `"undefined"`，
 * 不会抛 `ReferenceError`。
 */

import { createRequire } from "module";

declare const __CLI_VERSION__: string | undefined;
declare const __SDK_VERSION__: string | undefined;
declare const __CORE_VERSION__: string | undefined;

const require = createRequire(import.meta.url);

/** 直接跑 TS 时的回退：读实际安装的包，失败则 `"unknown"` */
function readPkgVersion(spec: string): string {
  try {
    const pkg = require(spec) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** CLI 自身版本（来自项目根 `package.json`） */
export const CLI_VERSION =
  typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : readPkgVersion("../package.json");

/** `@ai-zen/agents-sdk` 的版本（打包时内联进来的那一份，不是运行期装的） */
export const SDK_VERSION =
  typeof __SDK_VERSION__ === "string"
    ? __SDK_VERSION__
    : readPkgVersion("@ai-zen/agents-sdk/package.json");

/** `@ai-zen/agents-core` 的版本（同上） */
export const CORE_VERSION =
  typeof __CORE_VERSION__ === "string"
    ? __CORE_VERSION__
    : readPkgVersion("@ai-zen/agents-core/package.json");
