/**
 * 通知的**补看** —— 启动 / 重连之后，把「还挂着、而屏幕上没有的」通知补上屏。
 *
 * ## 为什么需要补看（而不是只靠事件流）
 *
 * 通知是**有状态的**：登记之后一直躺在宿主里，直到有人清掉。而事件只推给**当时在听**的那条
 * 连接 —— 后连上来的客户端错过就永远错过。所以每一次「连接就绪 / 重连成功 / 会话开好」都要问
 * 一次 `notice.list`。
 *
 * ## 一次查询，**逐条**清账
 *
 * 清的是**上屏了的那几条**，一条一条按 id 清（`notice.delete({ id })`）：宿主这一版把「清」
 * 分成三档粒度（清一条 / 清一段会话的 / 清全部，`prd/08-client.md` 的通知那一节），补看只该动
 * 第一种 —— 它念过哪几条，就只让那几条消失。
 *
 * 按会话清（`notice.deleteAll({ sessionId })`）曾经是这里的做法，代价写在提交信息里：那一片里
 * **还没上屏**的几条会跟着一起没，它们连「下次再补看」的机会都没有了。宿主补上按 id 清之后，
 * 这个代价没有了 —— 念一条、清一条。
 *
 * 清的时候那条已经不在了（回执 `changed: false`）**不是错误**：别人先清掉了，同一件事做了
 * 两遍而已。清本身失败也吞掉：上屏已经发生，剩下的只是「宿主那份什么时候消失」。
 *
 * ## 全局通知（`sessionId === null`）只上屏、不在这里清
 *
 * 它们不属于任何一段会话，按 id 清掉等于替**别人**做了「清一条」的决定 —— 别的客户端、别的
 * 会话还没见过它。所以全局通知补看时照旧上屏、照旧留在库里（下次补看再上屏一次），要清它们
 * 得由用户开口（清全部要明说，同一节）。
 *
 * ## 「手动全部清空」是另一条路
 *
 * 通知栏上那个「全部清空」（Ctrl+X）清的是**这一段会话**，走 {@link clearSessionNotices}
 * （`notice.deleteAll({ sessionId })`）—— 那是三档里的第二种，与补看的逐条清不是一件事。
 */

import type { NoticeView } from "./session/types.js";
import type { HostConnection } from "./session/types.js";

export interface FlushPendingNoticesInput {
  /** 那条连接（进程级共享的那一条，不是新建的） */
  connection: HostConnection;
  /** 这段会话的 id。给 `undefined` = 还没开会话：只补全局那一半 */
  sessionId?: string;
  /**
   * 把一条通知交给**现有**的通知栏渲染路径。
   *
   * 返回 `false` = 这一条没上屏（屏已经卸载 / 栏位不再收了）：那它就不能被清掉 ——
   * 谁也没看见的东西清掉，等于它从来没存在过。留着给下一次补看。
   */
  onNotice: (notice: NoticeView) => boolean | void;
}

/**
 * 走一遍「查 → 显示 → 清」。
 *
 * 查询失败**不吞**：抛给调用方，由它决定（开会话那一路会忽略 —— 补看是尽力而为）。
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
 * 清掉**这一段会话**在宿主那边的通知（`notice.deleteAll` 的「按会话」口径）。
 *
 * 这是通知栏「全部清空」（Ctrl+X）那一条：它清的是**这一段**，不是整个库。
 *
 * ## 为什么必须带 `sessionId`
 *
 * 契约的入参是 `{ sessionId? }`：给 = 只删这一段会话的，不给 = 清整个库，把宿主库里所有通知
 * 一次删光（含**别的会话还没上屏**的那些）。通知栏上的「全部清空」说的是「把这个栏位清掉」，
 * 而栏位念的是这一段会话 —— 不给就会顺带抹掉别人换回去时还该看到的那几条。清全部要明说
 * （`prd/08-client.md` 的通知那一节），这一条不是那个入口。
 *
 * 失败原样抛给调用方（上屏那句话由屏幕层说）。
 */
export async function clearSessionNotices(
  connection: HostConnection,
  sessionId: string | undefined,
): Promise<void> {
  await connection.api.notice.deleteAll.mutate(sessionId === undefined ? {} : { sessionId });
}
