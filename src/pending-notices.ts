/**
 * 通知槽位的**补看** —— 启动 / 重连之后，把「此刻还挂着、而屏幕上没有的」通知补上屏。
 *
 * ## 为什么需要补看（而不是只靠事件流）
 *
 * 通知不再是一次性广播，而是**有状态的槽位**：登记之后一直躺在服务端，直到有人确认
 * （全局的挂在进程上、会话内的挂在会话上 —— 见 `notice.ts` / `LiveSession`）。于是
 * 「我连上来那一刻之前发生过什么」这件事，事件流答不了：事件只推给**当时在听**的那些
 * 连接，而后连上来的客户端错过就永远错过。所以两条入口各有一个：
 *
 *   · **全局**：`notice.list` —— 它不属于任何会话，没有所属物可依附；
 *   · **会话内**：`session.snapshot` 的 `pendingNotices` —— 它有会话可依附，所以搭快照的车，
 *     不为它单开一条查询方法。
 *
 * ## 两个入口，一份 id，一次确认
 *
 * 两处下来的通知**都带 `id`**（UUID），而且与实时推送的那一条是**同一个**值；`notice.ack
 * { ids }` 又同时认两类 id（服务端先查全局表、再扫各会话的通知表）。所以补看只发**一次**
 * ack：把两处收集到的 id 一起交上去 —— 不必先分辨「这条属于哪一类、该用哪条方法确认」，
 * 也不必为会话内那一半多跑一趟往返。
 *
 * ## 显示过就确认
 *
 * 一份状态，任意客户端确认即消（`notice.ack { ids }`），不做「每个客户端各记一份已读」
 * —— 那是状态爆炸，而且会让「我已经看过了」变成服务端的二次记账。CLI 的用法就是
 * 「**显示即消费**」：通知栏已经念给用户看了，再让它在下次连上来时重播一遍没有意义。
 *
 * 顺序固定「先显示、后确认」：反过来的话确认成功而显示失败，那条通知就谁也没看见地消失了
 * （通知的寿命终点是消费者说的，不是服务端猜的）。
 *
 * ## 本地不留「哪几条已经上过屏」
 *
 * 有了 id 就不需要那份表：显示完就确认，服务端的槽位当场消失，下一次补看（重连 / 重取
 * 快照）自然拿不到它。在客户端另记一份「这条念过没有」只在**通知没有 id** 的年代有必要
 * —— 那张表得活到会话关闭、还得与服务端的槽位保持同步，本质上是把槽位在客户端再实现一遍。
 *
 * ## 为什么渲染不在这里
 *
 * 本文件只做「查 / 显示 / 确认」这三步的顺序，句子由 `session-notice.ts` 的词典给
 * （服务端一句自然语言都不产）。`onNotice` 由调用方接到**既有的**通知栏渲染上，于是
 * 补看这条路径上不会有第二套 UI。
 */

import type {
  ChannelNoticePayload,
  NoticeListResult,
  ServerClient,
  SessionSnapshotResult,
} from "./server-client/index.js";

export interface FlushPendingNoticesInput {
  /** 那条连接（进程级共享的那一条，不是新建的） */
  client: ServerClient;
  /**
   * 这段会话的 id。`undefined` = 还没开会话（启动时连接先就绪、会话后开）：只补全局那一半。
   */
  sessionId?: string;
  /** 把一条通知交给**现有**的通知栏渲染路径（`RemoteChatSession.showNotice` 那一层） */
  onNotice: (payload: ChannelNoticePayload) => void;
}

/**
 * 走一遍两条入口（先全局、再会话内），**最后一次**确认掉全部上过屏的。
 *
 * 全局那一半放在前面不是随意的：它说的是「这部进程现在的状态」（MCP 连不上、存档不可用
 * 之类），而会话内的那些是「这一段对话里发生过的事」—— 用户先要知道「能不能用」。
 *
 * 查询失败**不吞**：抛给调用方，由它决定（开会话那一路会忽略 —— 补看是尽力而为，一条通知
 * 没补上不该让会话开不起来）。这里不 catch 也是为了让「服务端没注册 `notice.*`」这种部署
 * 问题在用例里看得见，而不是静默变成一个永远为空的函数。
 *
 * 但「已经上过屏的那几条」在失败路径上照样要确认（`finally`）：它们已经念给用户看了，
 * 留着只会在下次补看时重播一遍。确认本身失败吞掉 —— 上屏已经发生，剩下的只是「服务端那份
 * 什么时候消失」，不值得为它把会话打断。
 */
export async function flushPendingNotices(input: FlushPendingNoticesInput): Promise<void> {
  /** 已经上过屏、等着被确认的 id：全局与会话内混在一起，确认时不区分（见文件头） */
  const shownIds: string[] = [];
  try {
    const listed = await input.client.call<NoticeListResult>("notice.list");
    for (const slot of listed.notices) {
      input.onNotice({
        id: slot.id,
        level: slot.level,
        code: slot.code,
        ...(slot.params !== undefined ? { params: slot.params } : {}),
      });
      shownIds.push(slot.id);
    }

    if (input.sessionId) {
      const snapshot = await input.client.call<SessionSnapshotResult>("session.snapshot", {
        sessionId: input.sessionId,
      });
      for (const notice of snapshot.pendingNotices) {
        input.onNotice({
          id: notice.id,
          level: notice.level,
          code: notice.code,
          ...(notice.params !== undefined ? { params: notice.params } : {}),
        });
        shownIds.push(notice.id);
      }
    }
  } finally {
    await ackNotices(input.client, shownIds).catch(() => {});
  }
}

/**
 * 确认一批通知（`notice.ack { ids }`）—— **一次往返**，两类 id 都认。
 *
 * 空数组直接返回：什么都不确认的往返没有意义。返回的 `acked` 本层不看（它只说明「哪些真的
 * 被这次调用消掉了」，而补看与实时推送都不需要据此做决定）。
 *
 * 失败原样抛给调用方：补看那条路吞掉（见 {@link flushPendingNotices}），实时推送那条路也
 * 吞掉（上屏已经发生，一次没确认只会在下次补看时再上一次屏）。
 */
export async function ackNotices(client: ServerClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.call("notice.ack", { ids: [...ids] });
}
