/**
 * 一条一条按 id 清（`notice.delete`）。
 *
 * 清一条失败不影响后面几条：它们各自是独立的一条通知，卡在第一条上会让剩下的永远清不掉。
 */

import type { NoticeView } from "./session/types.js";
import type { HostConnection } from "./session/types.js";

export interface FlushPendingNoticesInput {
  /** 那条连接（进程级共享的那一条，不是新建的） */
  connection: HostConnection;
  /** 这段会话的 id。给 `undefined` = 还没开会话：只补全局那一半 */
  sessionId?: string;
  /**
   * 把一条通知交给现有的通知栏渲染路径。
   *
   * 返回 `false` = 这一条没上屏（屏已经卸载 / 栏位不再收了）：那它就不能被清掉 ——
   * 谁也没看见的东西清掉，等于它从来没存在过。留着给下一次补看。
   */
  onNotice: (notice: NoticeView) => boolean | void;
}

/**
 * 走一遍「查 → 显示 → 清」。
 *
 * 查询失败不吞：抛给调用方，由它决定（开会话那一路会忽略 —— 补看是尽力而为）。
 */
export async function flushPendingNotices(input: FlushPendingNoticesInput): Promise<void> {
  const notices = await input.connection.api.notice.list.query(
    input.sessionId === undefined ? {} : { sessionId: input.sessionId },
  );
  if (notices.length === 0) return;

  // 显示在前、清账在后：反过来的话清成功而显示失败，那条通知就谁也没看见地消失了
  const shown: string[] = [];
  for (const notice of notices) {
    if (input.onNotice(notice) === false) continue;
    // 全局通知不在这里清（见文件头）：它不属于这一段，清掉就是把别人的那条也抹了
    if (notice.sessionId !== null) shown.push(notice.id);
  }
  await deleteOneByOne(input.connection, shown);
}

/**
 * 一条一条按 id 清（`notice.delete`）。
 *
 * 清一条失败不影响后面几条：它们各自是独立的一条通知，卡在第一条上会让剩下的永远清不掉。
 * 回执 `changed: false`（那条已经不在了）走的是同一条路 —— 不重试、不报错。
 */
async function deleteOneByOne(connection: HostConnection, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await connection.api.notice.delete.mutate({ id });
    } catch {
      // 上屏已经发生，清不掉只影响「宿主那份什么时候消失」（下次补看再上屏一次）
    }
  }
}

/**
 * 清掉这一段会话在宿主那边的通知（`notice.deleteAll` 的「按会话」口径）。
 *
 * 这是通知栏「全部清空」（Ctrl+X）那一条，清的是这一段会话，不是整个库。契约的入参是
 * `{ sessionId? }`：给就只删这一段会话的，不给就清整个库，把宿主库里所有通知一次删光（含别的会话还
 * 没上屏的那些）。栏位念的是这一段会话，不给就会顺带抹掉别人换回去时还该看到的那几条。
 *
 * 失败原样抛给调用方，上屏那句话由屏幕层说。
 */
export async function clearSessionNotices(
  connection: HostConnection,
  sessionId: string | undefined,
): Promise<void> {
  await connection.api.notice.deleteAll.mutate(sessionId === undefined ? {} : { sessionId });
}
