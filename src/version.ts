/**
 * 版本信息 — CLI / SDK / Core
 *
 * 从实际安装的包中读取版本号（而非 package.json 依赖声明中的版本范围），
 * 确保展示的是运行时的真实版本。读取失败时回退为 "unknown"。
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

interface PkgJson {
  version?: string;
}

/** 读取指定包的实际安装版本，失败时返回 "unknown" */
function readPkgVersion(spec: string): string {
  try {
    const pkg = require(spec) as PkgJson;
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** CLI 自身版本（来自项目根 package.json） */
export const CLI_VERSION = readPkgVersion("../package.json");

/** @ai-zen/agents-sdk 实际安装版本 */
export const SDK_VERSION = readPkgVersion("@ai-zen/agents-sdk/package.json");

/** @ai-zen/agents-core 实际安装版本 */
export const CORE_VERSION = readPkgVersion("@ai-zen/agents-core/package.json");

export interface Versions {
  cli: string;
  sdk: string;
  core: string;
}

export function getVersions(): Versions {
  return { cli: CLI_VERSION, sdk: SDK_VERSION, core: CORE_VERSION };
}
