/**
 * 版本信息 —— CLI / SDK / Core，外加本机拉起宿主时交给 npx 的**版本范围**。
 *
 * 四个值都在**构建时**由 `rolldown.config.mjs` 注入成字面量（`transform.define`）。
 *
 * 为什么不照旧在运行期读 `package.json`：打包之后本模块被 hoist 进 `dist/chunks/`，
 * `createRequire(import.meta.url)` 之后 `../package.json` 不再指向包根；而
 * `@ai-zen/agents-sdk` / `-core` 是被**内联**进来的，消费者机器上压根没有它们的
 * `package.json` 可读。构建时定死既准确又省掉一次磁盘访问。
 *
 * `typeof` 判断留了一条回退：直接跑 TS（`vitest`、调试）时没有构建期注入，
 * 四个标识符是未声明的全局 —— `typeof` 对未声明标识符安全返回 `"undefined"`，
 * 不会抛 `ReferenceError`。
 */

import { createRequire } from "module";

declare const __CLI_VERSION__: string | undefined;
declare const __SDK_VERSION__: string | undefined;
declare const __CORE_VERSION__: string | undefined;
declare const __AGENTS_HOST_RANGE__: string | undefined;

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

/**
 * 直接跑 TS 时的回退：读本包 `package.json` 的 devDependencies，并把路径式的依赖归一成
 * 「那个包自己的版本」加上限（与 `rolldown.config.mjs` 的 `hostRangeOf` 同一口径）。
 *
 * 为什么要归一：开发时那一条是 `link:../agents/packages/host`（类型与实现取自本地宿主仓），
 * 而 `npx` 只认 semver range。**「照哪一份源码编译」与「线上该拉哪一版」是两件事**，
 * 前者是依赖声明，后者是发布事实。
 *
 * 读不到就是空串 —— 拉起时会明确报「不知道该拉哪一版」，而不是静默去拉一个通配范围。
 */
function readDevDependency(name: string): string {
  let spec = "";
  try {
    const pkg = require("../package.json") as { devDependencies?: Record<string, string> };
    spec = pkg.devDependencies?.[name] ?? "";
  } catch {
    return "";
  }
  if (spec === "" || /^[\^~]?\d/.test(spec)) return spec;
  const version = readPkgVersion(`${name}/package.json`);
  return version === "unknown" ? "" : `^${version}`;
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

/**
 * `@ai-zen/agents-host` 的**版本范围** —— 本机拉起宿主时交给 `npx` 的那一段（PRD L14）。
 *
 * 它只住在 `devDependencies`（运行期不装宿主），所以不是 `version` 而是**范围**：npx 按它拉
 * 「满足范围的最新版」，宿主发了新版、CLI 不用重装就能用上（F-E3）。
 */
export const AGENTS_HOST_RANGE =
  typeof __AGENTS_HOST_RANGE__ === "string"
    ? __AGENTS_HOST_RANGE__
    : readDevDependency("@ai-zen/agents-host");
