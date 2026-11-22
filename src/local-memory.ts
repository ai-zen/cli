/**
 * 本机记忆文件（`<数据根>/cli/*.json`）的**读法** —— 工作区、会话、界面偏好这几份
 * 「上次用的什么」。
 *
 * ## 两种「没有」不是一回事（判据照 `host-version.ts` 那张表）
 *
 * | 盘上状态 | 含义 | 结局 |
 * |---|---|---|
 * | 文件不存在（`ENOENT`） | 第一次用 | `absent`：用默认值，**不吵**、不写盘 |
 * | 在，但读不出来（`EACCES`、`EISDIR`…） | 我们不知道里面是什么 | `broken`：**报一句**，磁盘一个字节都不动 |
 * | 在，但不是合法 JSON | 里面没有可用的记忆 | `broken`：同上（写回去等于覆盖，不许） |
 * | 在，是合法 JSON 但不是「键 → 值」的表（`[]` / `"text"` / `42`） | 读得出，可它不是这张表 —— 而写回只写得出「键 → 值」，等于拿一份 `{}` 覆盖它 | `broken`：同上 |
 * | 读到了，确实是「键 → 值」的表 | 正常 | `value`：那张表原样交出去 |
 *
 * 只有第一行和最后一行可以接着写盘。`broken` 之后**绝不许写回**：写回的动作是「读出来 → 合并这一次
 * → 整份写下去」，读不出来时合并的底子是空的，写下去等于把那份**我们没读到的东西**一起抹掉
 * （`last-workspace.json` 里每台宿主各占一格，`last-session.json` 里每个项目各占一格）。
 *
 * ## 报给谁
 *
 * 调用方递进来的 `LogSink`（`@ai-zen/agents-logger` 的三方法形状）：这几份记的都是**缓存**
 * （丢了只是回到出厂），所以失败姿势是「报出去 + 用默认值继续」，不是抛。日志实例归根
 * （`tui/index.tsx` / `stdio.ts` 从 `CliApp` 手里收），所以本模块**没有**全局日志口可读，
 * 也就不可能把一句话写到一个自己看不见的地方。
 *
 * 缓存只在**用户真的做了一件事**（切了会话 / 选了语言）时才写 —— 读到什么就照着再存一遍，
 * 那是把默认值冒充他的旧值。
 */

import { readFile } from "node:fs/promises";
import type { LogSink } from "@ai-zen/agents-logger";

/** 一次读记忆文件的结局：三种，对「能不能接着写盘」的答案不同（见文件头那张表） */
export type MemoryRead =
  | { readonly kind: "absent" }
  | { readonly kind: "broken" }
  | { readonly kind: "value"; readonly entries: Record<string, unknown> };

/**
 * 读一份记忆文件；`broken` 的那一句已经在这里报掉了（调用方只负责「别写盘」）。
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
  // 合法 JSON，但不是「键 → 值」的表（`[]` / `"text"` / `42`）：**不**当空表 ——
  // 写回是「读出来 → 合并这一次 → 整份写下去」，把它当空表就等于拿一份 `{}` 覆盖它。
  // 判据与「不是合法 JSON」同一条：我们读不懂它的意思，就不许动它。
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const shape = parsed === null ? "null" : Array.isArray(parsed) ? "数组" : typeof parsed;
    return broken(path, `顶层不是「键 → 值」的表（读到的是 ${shape}）`, logger);
  }
  return { kind: "value", entries: parsed as Record<string, unknown> };
}

/** 报一句，并把结局定成 `broken`（入口只有三类：读不出来、不是 JSON、不是「键 → 值」的表） */
function broken(path: string, reason: unknown, logger: LogSink): MemoryRead {
  const text = reason instanceof Error ? reason.message : String(reason);
  logger.warn(`读不了 ${path}：${text}（按没有记录继续，文件原样不动）`);
  return { kind: "broken" };
}
