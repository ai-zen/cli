/**
 * 「下次拉宿主用哪一版」—— 本机的一小块记忆（拉起宿主时读）。
 *
 * ## 今天谁在用它
 *
 * | 谁 | 干什么 |
 * |---|---|
 * | `connection.ts` 的 `connectHost` | 读：没记过就用构建时的 `AGENTS_HOST_RANGE` |
 * | `connection.test.ts` | 写（只当夹具）：验「记着的那个压过构建时的范围」 |
 *
 * ## 写方已经退场（pin 归宿主）
 *
 * 从前是 `/upgrade` 写它：先把目标版本拉进 npx 缓存、再记下这一版、再 `host.shutdown`。那是
 * 客户端在替宿主做升级的第 ② 段，与 `trd/host-infrastructure.md` 的三段分工冲突（也把 pin 与
 * 退出信号分在了两处）。现在升级走 `host.upgrade`：**pin 由宿主写**
 * （`<数据根>/run/next-version.json`），读 pin 是启动方式的事 —— 连接层下一波才改成读它。
 *
 * 那一刻这个文件就应该连文件带导出一起退场：它服务的那条口（`EnsureHostOptions.versionRange`）
 * 到那时换一个人给值。留在今天是因为还有上面那一格读者，删掉的话本机拉起的版本范围就没了。
 *
 * ## 为什么需要它（写方还在的时候）
 *
 * 宿主由客户端用 `npx -y @ai-zen/agents-host@<版本> serve` 现拉现起，而版本号来自 CLI **构建时**
 * 注入的 `AGENTS_HOST_RANGE`（`version.ts`）—— 那是常量，运行期改不了。所以「重启到刚下载好
 * 的那一版」这件事必须在盘上留一笔：写下确切版本，下次拉起宿主时把它当作
 * `EnsureHostOptions.versionRange` 递给 npx（`connection.ts` 的 `connectHost`）。
 *
 * 落点 `<数据根>/cli/host-version.json` 与 `connection.json` / `last-session.json` 同级：这是
 * **客户端自己的事**（记住上次怎么连的那一类，PRD 4.12），宿主既不知道也不需要知道。
 *
 * ## 两种「没有版本」不是一回事
 *
 * | 盘上状态 | 含义 | 处理 |
 * |---|---|---|
 * | 文件不存在 | 没记过 | **正常路径**：用构建时的范围 |
 * | 文件在但读不懂 | 有人手改坏了 / 写坏了 | 报错。不吞、不猜、不退回范围 |
 *
 * 第二行是刻意的：一份坏掉的记忆若被静默当成「没记过」，症状是「升过的版本自己退回去了」，
 * 而那句原因永远出不来。让它报错，至少报错的那句话里有文件路径。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** `<数据根>/cli/host-version.json` */
export function hostVersionFile(dataRoot: string): string {
  return join(dataRoot, "cli", "host-version.json");
}

/**
 * 记着的那一版；文件不存在返回 `undefined`（= 没升级过）。
 *
 * 只在「文件不存在」这一种情况下返回 `undefined`：其它读失败（EACCES、目录被占）与内容不合法
 * 一律抛出 —— 见文件头那张表。
 */
export async function readHostVersion(dataRoot: string): Promise<string | undefined> {
  const file = hostVersionFile(dataRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`${file} 里没有可用的 version 字段：${raw.trim()}`);
  }
  return version.trim();
}

/** 记下「下次拉这一版」（生产码已经没有写方：pin 归宿主，只剩用例在用它铺夹具） */
export async function rememberHostVersion(dataRoot: string, version: string): Promise<void> {
  const file = hostVersionFile(dataRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version })}\n`, "utf-8");
}
