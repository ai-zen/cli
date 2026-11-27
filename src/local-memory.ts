/**
 * 本机记忆文件（`<数据根>/cli/*.json`）的读法：工作区、会话、界面偏好这几份「上次用的什么」。
 *
 * 两种「没有」不是一回事：文件不存在（`ENOENT`）是第一次用，结局 `absent`，用默认值、不报、不写盘；
 * 文件在但读不出来（`EACCES`、`EISDIR`…）、不是合法 JSON、或者是合法 JSON 但不是「键 → 值」的表
 * （`[]` / `"text"` / `42` —— 写回只写得出键值表，等于拿一份 `{}` 覆盖它），结局都是 `broken`：报一句，
 * 磁盘一个字节都不动。只有 `absent` 与 `value` 这两种可以接着写盘。
 *
 * `broken` 之后不许写回：写回的动作是「读出来 → 合并这一次 → 整份写下去」，读不出来时合并的底子是空
 * 的，写下去等于把那份没读到的东西一起抹掉（`last-workspace.json` 里每台宿主各占一格，
 * `last-session.json` 里每个项目各占一格）。
 *
 * 报给调用方递进来的 `LogSink`（`@ai-zen/agents-logger` 的三方法形状）：这几份记的都是缓存，丢了只是
 * 回到出厂，所以失败姿势是报出去加用默认值继续，不是抛。日志实例归根，所以本模块没有全局日志口可读。
 *
 * 缓存只在用户真的做了一件事（切了会话、选了语言）时才写：读到什么就照着再存一遍，那是把默认值冒充他
 * 的旧值。
 */

import { readFile } from "node:fs/promises";
import type { LogSink } from "@ai-zen/agents-logger";

export type MemoryRead =
  | { readonly kind: "absent" }
  | { readonly kind: "broken" }
  | { readonly kind: "value"; readonly entries: Record<string, unknown> };

/**
 * 读一份记忆文件；`broken` 的那一句已经在这里报掉了，调用方只负责别写盘。
 */
export async function readMemoryFile(path: string, logger: LogSink): Promise<MemoryRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return broken(path, error, logger);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return broken(path, error, logger);
  }
  // 合法 JSON，但不是「键 → 值」的表（`[]` / `"text"` / `42`）：不当空表 ——
  // 写回是「读出来 → 合并这一次 → 整份写下去」，把它当空表就等于拿一份 `{}` 覆盖它。
  // 判据与「不是合法 JSON」同一条：读不懂它的意思，就不动它。
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const shape = parsed === null ? "null" : Array.isArray(parsed) ? "数组" : typeof parsed;
    return broken(path, `顶层不是「键 → 值」的表（读到的是 ${shape}）`, logger);
  }
  return { kind: "value", entries: parsed as Record<string, unknown> };
}

/** 入口只有三类：读不出来、不是 JSON、不是「键 → 值」的表 */
function broken(path: string, reason: unknown, logger: LogSink): MemoryRead {
  const text = reason instanceof Error ? reason.message : String(reason);
  logger.warn(`读不了 ${path}：${text}（按没有记录继续，文件原样不动）`);
  return { kind: "broken" };
}
