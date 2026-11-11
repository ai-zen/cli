import { describe, expect, it } from "vitest";
import { flushPendingNotices } from "./pending-notices.js";
import type { ChannelNoticePayload, ServerClient } from "./server-client/index.js";

/** 一个通知槽位（全局表与会话内的通知表用同一个形状，差别只在挂在哪） */
interface FakeSlot {
  id: string;
  level: "info" | "warn" | "error";
  code: string;
  params?: any;
}

/**
 * 假的连接：只认 `notice.list` / `notice.ack` / `session.snapshot` 三条。
 *
 * 两件事是这组用例的断言对象：
 *   · `calls` —— 调用顺序，「先显示、后确认」与「一次 ack」靠它钉住；
 *   · `acked` —— 每次 ack 收到的 id 列表。
 *
 * `notice.ack` 顺手把 id 从两张表里删掉：生产里「确认即消」就是这个语义（`ServerApp.ackNotices`
 * 先查全局表、再扫各会话的通知表），所以「确认过的不再重播」才测得出来。
 */
function fakeClient(replies: {
  global?: FakeSlot[];
  pending?: FakeSlot[];
  failList?: Error;
  failSnapshot?: Error;
}) {
  const calls: string[] = [];
  const acked: string[][] = [];
  let global = [...(replies.global ?? [])];
  let pending = [...(replies.pending ?? [])];
  const client = {
    call: async (method: string, params?: any) => {
      calls.push(method);
      if (method === "notice.list") {
        if (replies.failList) throw replies.failList;
        // 全局槽位比会话内的通知多一个 `createdAt`（登记时刻）
        return {
          notices: global.map((slot) => ({ ...slot, createdAt: "2026-01-01T00:00:00.000Z" })),
        };
      }
      if (method === "notice.ack") {
        acked.push(params.ids);
        const ids: string[] = params.ids;
        global = global.filter((slot) => !ids.includes(slot.id));
        pending = pending.filter((notice) => !ids.includes(notice.id));
        return { acked: ids };
      }
      if (method === "session.snapshot") {
        if (replies.failSnapshot) throw replies.failSnapshot;
        return {
          sessionId: params.sessionId,
          pendingNotices: pending.map((notice) => ({
            event: "session-notice",
            sessionId: params.sessionId,
            ...notice,
          })),
        };
      }
      throw new Error(`unexpected call ${method}`);
    },
  } as unknown as ServerClient;
  return { client, calls, acked };
}

/** 记录上屏顺序的渲染口（生产就是 `RemoteChatSession.showNotice`） */
function recorder() {
  const shown: ChannelNoticePayload[] = [];
  return { shown, onNotice: (payload: ChannelNoticePayload) => shown.push(payload) };
}

describe("flushPendingNotices：全局通知", () => {
  it("查到的每一条都上屏（带 id），然后按 id 一次性确认", async () => {
    const { client, calls, acked } = fakeClient({
      global: [
        { id: "n-1", level: "error", code: "mcpUnavailable", params: { server: "fs" } },
        { id: "n-2", level: "info", code: "storeUnavailable" },
      ],
    });
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ client, onNotice });

    // 载荷带上槽位的 id（确认的凭据）后原样交给渲染层（服务端不产句子，也不在这一层翻译）
    expect(shown).toEqual([
      { id: "n-1", level: "error", code: "mcpUnavailable", params: { server: "fs" } },
      { id: "n-2", level: "info", code: "storeUnavailable" },
    ]);
    // **一次** ack：两个 id 一起交上去（不是每条一次往返）
    expect(acked).toEqual([["n-1", "n-2"]]);
    // 「先显示、后确认」：反过来的话确认成功而显示失败，那条通知就谁也没看见地消失了
    expect(calls).toEqual(["notice.list", "notice.ack"]);
  });

  it("一条都没有时不上屏，也不发确认（空 ack 是一次没必要的往返）", async () => {
    const { client, calls } = fakeClient({});
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ client, onNotice });

    expect(shown).toEqual([]);
    expect(calls).toEqual(["notice.list"]);
  });
});

describe("flushPendingNotices：会话内通知", () => {
  it("没开会话（没给 sessionId）时不查快照，只补全局那一半", async () => {
    const { client, calls } = fakeClient({});
    const { onNotice } = recorder();

    await flushPendingNotices({ client, onNotice });

    expect(calls).toEqual(["notice.list"]);
  });

  it("会话内通知也上屏，并与全局的一起在**一次** ack 里确认掉", async () => {
    const { client, calls, acked } = fakeClient({
      global: [{ id: "n-1", level: "info", code: "storeUnavailable" }],
      pending: [
        { id: "s-1", level: "error", code: "persistFailed", params: { error: "disk full" } },
        { id: "s-2", level: "info", code: "handoffMigrated", params: { n: 1 } },
      ],
    });
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ client, sessionId: "chat_1", onNotice });

    expect(shown.map((payload) => payload.id)).toEqual(["n-1", "s-1", "s-2"]);
    // 两类 id 混在同一个 `ids` 里：`notice.ack` 两类都认，客户端不必先分类
    expect(acked).toEqual([["n-1", "s-1", "s-2"]]);
    expect(calls).toEqual(["notice.list", "session.snapshot", "notice.ack"]);
  });

  it("确认过的槽位在服务端就没了：重连后再补看不重播（本地不记「哪几条上过屏」）", async () => {
    const { client, acked } = fakeClient({
      pending: [{ id: "s-1", level: "info", code: "turnAborted" }],
    });
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ client, sessionId: "chat_1", onNotice });
    expect(shown).toHaveLength(1);

    // 重连之后同一个槽位已经不在服务端（上一次补看确认过它）：什么都不用显示、也不用再确认
    await flushPendingNotices({ client, sessionId: "chat_1", onNotice });
    expect(shown).toHaveLength(1);
    expect(acked).toEqual([["s-1"]]);
  });

  it("换了一段会话（`/new` 之后 id 不同）：那一段自己的通知照样上屏并确认", async () => {
    const { client, acked } = fakeClient({
      pending: [{ id: "s-1", level: "info", code: "turnAborted" }],
    });
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ client, sessionId: "chat_1", onNotice });
    await flushPendingNotices({ client, sessionId: "chat_2", onNotice });

    // 第一次已经确认掉了 s-1，所以第二次没有新东西可播 —— 「一份状态，确认即消」的直接后果
    expect(shown).toHaveLength(1);
    expect(acked).toEqual([["s-1"]]);
  });
});

describe("flushPendingNotices：失败不吞", () => {
  it("查询失败原样抛给调用方（补看是尽力而为，但「服务端没注册 notice.*」不该静默）", async () => {
    const { client } = fakeClient({
      failList: Object.assign(new Error("unknown method"), { code: "unknown-method" }),
    });
    const { onNotice } = recorder();

    await expect(flushPendingNotices({ client, onNotice })).rejects.toThrow("unknown method");
  });

  it("全局那一半已经上屏、会话那一半失败：错误照抛，但上过屏的仍然确认掉（否则下次会重播）", async () => {
    const { client, acked } = fakeClient({
      global: [{ id: "n-1", level: "error", code: "mcpUnavailable" }],
      failSnapshot: new Error("session gone"),
    });
    const { shown, onNotice } = recorder();

    await expect(flushPendingNotices({ client, sessionId: "chat_1", onNotice })).rejects.toThrow(
      "session gone",
    );

    expect(shown.map((payload) => payload.id)).toEqual(["n-1"]);
    expect(acked).toEqual([["n-1"]]);
  });
});
