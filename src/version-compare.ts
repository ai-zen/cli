/**
 * 版本号比较 —— 只回答「谁更新」这一个问题。
 *
 * 语义照 semver 2.0 的比较规则（`X.Y.Z[-pre][+build]`）：
 *   - 核心段按数字比，缺省补 0；
 *   - **有预发布标识的更小**（`1.0.0-alpha.23 < 1.0.0`）；
 *   - 预发布标识逐个比：纯数字比数值、数字**小于**非数字、非数字按 ASCII 比；
 *     前缀全相同则标识少的更小（`1.0.0-alpha < 1.0.0-alpha.1`）；
 *   - 构建元数据（`+xxx`）不参与比较。
 *
 * 为什么不引 `semver` 包：CLI 只在这一处比版本号（`/update` 从 registry 的多个
 * dist-tag 里挑最新的那个），为它多挂一份依赖不划算；而这段规则稳定、可穷举测试。
 *
 * 无法解析的版本号一律返回 `null`（调用方跳过），绝不抛错——版本号来自网络，
 * 不该因为 registry 上有个畸形 tag 就让命令崩掉。
 */

export interface ParsedVersion {
  /** 核心段（数字数组，通常是 3 段） */
  core: number[];
  /** 预发布标识（`alpha.23` → `["alpha", "23"]`）；无预发布为空数组 */
  pre: string[];
}

const NUMERIC = /^\d+$/;

/** 解析版本号；畸形返回 `null` */
export function parseVersion(version: string): ParsedVersion | null {
  if (typeof version !== "string") return null;
  // 容忍 `v1.2.3` 写法与首尾空白
  const trimmed = version.trim().replace(/^v/i, "");
  if (!trimmed) return null;
  // 构建元数据不参与比较
  const plus = trimmed.indexOf("+");
  const noBuild = plus >= 0 ? trimmed.slice(0, plus) : trimmed;
  // 预发布段从**第一个** `-` 开始（`1.0.0-alpha-beta` 的预发布标识是 `alpha-beta`）
  const dash = noBuild.indexOf("-");
  const coreText = dash >= 0 ? noBuild.slice(0, dash) : noBuild;
  const preText = dash >= 0 ? noBuild.slice(dash + 1) : "";

  const parts = coreText.split(".");
  if (!parts.every((part) => NUMERIC.test(part))) return null;
  return { core: parts.map(Number), pre: preText ? preText.split(".") : [] };
}

/** 单个预发布标识比较：数字按数值，数字 < 非数字，非数字按 ASCII */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 比较两个版本号：`a` 更新返回正数、`b` 更新返回负数、相同返回 0。
 * 任一方无法解析时返回 `null`。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;

  const coreLength = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < coreLength; i += 1) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  // 核心段相同：有预发布标识的更小（1.0.0-alpha < 1.0.0）
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const preLength = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < preLength; i += 1) {
    const left = pa.pre[i];
    const right = pb.pre[i];
    // 前缀相同 → 标识少的更小（1.0.0-alpha < 1.0.0-alpha.1）
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const diff = compareIdentifier(left, right);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 从一组版本号里挑最新的（忽略无法解析的条目）；全都不合法时返回 `undefined`。
 *
 * `/update` 用它把 registry 上**所有** dist-tag 折叠成一个目标版本：只认 `latest`
 * 会漏掉「alpha 比正式版更新」的实际发布状态，只认 `alpha` 又会在正式版追上后装旧版。
 */
export function pickNewest(versions: Iterable<string>): string | undefined {
  let newest: string | undefined;
  for (const version of versions) {
    if (!parseVersion(version)) continue;
    if (newest === undefined || (compareVersions(version, newest) ?? 0) > 0) newest = version;
  }
  return newest;
}
