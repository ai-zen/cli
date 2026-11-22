/**
 * 通知补看用例：`flushPendingNotices` 只做「查 / 显示 / 清」这三步的顺序与粒度。
 *
 * 四件要钉住的事：
 *   1. **先显示、后清**：反过来的话清成功而显示失败，那条通知就谁也没看见地消失了；
 *   2. **逐条清**（`notice.clearOne({ id })`）：上屏了哪几条就按那几条的 id 清 —— 从前按会话清
 *      一片，代价是同一段里**还没上屏**的几条跟着一起没（`pending-notices.ts` 的文件头）；
 *   3. **只清真的上屏了的那几条**：显示那一侧回 `false`（屏已卸载 / 栏位不再收）的留着，
 *      谁也没看见的东西不能被清掉；
 *   4. **全局通知（`sessionId === null`）照旧留着**：它不属于这一段，按 id 清掉就等于替别的
 *      客户端做了「清一条」的决定，所以只上屏、不清。
 *
 * 另加「手动全部清空」的那一条（`clearSessionNotices`）：它走 `notice.clear` 的**按会话**口径，
 * 不带 `sessionId` 的那一档会抹掉别的会话还没上屏的通知。
 */

import { describe, expect, it } from "vitest";
import { clearSessionNotices, flushPendingNotices } from "./pending-notices.js";
import type { HostConnection, NoticeView } from "./session/types.js";

/** 一条通知（宿主 `notice.list` 的一行） */
function notice(
  id: string,
  sessionId: string | null,
  message = `通知 ${id}`,
  level: NoticeView["level"] = "info",
): NoticeView {
  return {
    id,
    level,
    code: "notice.test",
    message,
    durationMs: null,
    sessionId,
    // 时间一律 epoch 毫秒（宿主的口径）
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
  };
}

/**
 * 假的连接：认 `notice.list` / `notice.clearOne` / `notice.clear` 三条。
 *
 * `clearOne` 顺手把那条从表里删掉（生产里「清掉即消」，所以「清过的不再重播」才测得出来）；
 * 那条本来就没有时回 `{ changed: false }` —— 与宿主同一个口径（没改动，不抛错）。
 * `notice.clear` 筛的照宿主：给了 `sessionId` 就是「这一段 + 全局」。
 */
function fakeConnection(
  options: {
    notices?: NoticeView[];
    /** `notice.list` 额外给的那些（库里没有）：模拟「别人刚清掉」的那一刻 */
    listed?: NoticeView[];
    failList?: Error;
    clearOneThrows?: Error;
  } = {},
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let notices = [...(options.notices ?? [])];
  const api = {
    notice: {
      list: {
        query: async (params: { sessionId?: string } = {}) => {
          calls.push({ method: "notice.list", params });
          if (options.failList) throw options.failList;
          const listed = [...notices, ...(options.listed ?? [])];
          const scope = params.sessionId;
          return scope === undefined
            ? listed
            : listed.filter((item) => item.sessionId === null || item.sessionId === scope);
        },
      },
      clearOne: {
        mutate: async (params: { id: string }) => {
          calls.push({ method: "notice.clearOne", params });
          if (options.clearOneThrows) throw options.clearOneThrows;
          const before = notices.length;
          notices = notices.filter((item) => item.id !== params.id);
          return { changed: notices.length !== before };
        },
      },
      clear: {
        mutate: async (params: { sessionId?: string } = {}) => {
          calls.push({ method: "notice.clear", params });
          const scope = params.sessionId;
          notices =
            scope === undefined
              ? []
              : notices.filter((item) => item.sessionId !== null && item.sessionId !== scope);
        },
      },
    },
  };
  return {
    connection: { api } as unknown as HostConnection,
    calls,
    /** 宿主那边现在还剩哪几条（按 id，顺序即原顺序） */
    store: () => notices.map((item) => item.id),
  };
}

/** 记录上屏顺序的渲染口（生产就是 `RemoteChatSession.showNotice`） */
function recorder() {
  const shown: string[] = [];
  return {
    shown,
    onNotice: (item: NoticeView) => {
      shown.push(item.id);
    },
  };
}

describe("flushPendingNotices：查 / 显示 / 清", () => {
  it("查到的都上屏，然后**按 id 逐条**清（先显示、后清）", async () => {
    const { connection, calls, store } = fakeConnection({
      notices: [notice("n-1", "conv-1"), notice("n-2", "conv-1")],
    });
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ connection, sessionId: "conv-1", onNotice });

    expect(shown).toEqual(["n-1", "n-2"]);
    expect(calls).toEqual([
      { method: "notice.list", params: { sessionId: "conv-1" } },
      { method: "notice.clearOne", params: { id: "n-1" } },
      { method: "notice.clearOne", params: { id: "n-2" } },
    ]);
    // 一次按会话清都不发：那一片里可能有还没上屏的（这一刀改的就是这个）
    expect(calls.filter((call) => call.method === "notice.clear")).toEqual([]);
    expect(store()).toEqual([]);
  });

  it("三条里只上屏一条：只清那一条，另外两条还在（谁也没看见的不能被清掉）", async () => {
    const { connection, calls, store } = fakeConnection({
      notices: [notice("n-1", "conv-1"), notice("n-2", "conv-1"), notice("n-3", "conv-1")],
    });
    // 屏在念第一条的时候就卸载了：后两条没上屏（`showNotice` 回 false）
    const onNotice = (() => {
      let first = true;
      return () => {
        if (!first) return false;
        first = false;
        return true;
      };
    })();

    await flushPendingNotices({ connection, sessionId: "conv-1", onNotice });

    expect(calls.filter((call) => call.method === "notice.clearOne")).toEqual([
      { method: "notice.clearOne", params: { id: "n-1" } },
    ]);
    // 另外两条还在宿主那边：下一次补看还能上屏
    expect(store()).toEqual(["n-2", "n-3"]);
  });

  it("清一条已经不存在的（回执 changed: false）不算失败（别人先清掉了）", async () => {
    const { connection, store } = fakeConnection({
      // 库里没有这一条，`clearOne` 会回 `{ changed: false }`
      listed: [notice("gone", "conv-1")],
    });

    await expect(
      flushPendingNotices({ connection, sessionId: "conv-1", onNotice: () => true }),
    ).resolves.toBeUndefined();
    expect(store()).toEqual([]);
  });

  it("一条都没有时不上屏，也不发清理（空往返没有意义）", async () => {
    const { connection, calls } = fakeConnection({});
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ connection, sessionId: "conv-1", onNotice });

    expect(shown).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["notice.list"]);
  });

  it("还没开会话（没给 sessionId）：不带 sessionId 查一遍（宿主会给全部），全局那几条留库里", async () => {
    const { connection, calls, store } = fakeConnection({
      notices: [notice("n-1", null), notice("s-1", "conv-1")],
    });
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ connection, onNotice });

    expect(shown).toEqual(["n-1", "s-1"]);
    expect(calls[0]).toEqual({ method: "notice.list", params: {} });
    // 会话那一条按 id 清掉；全局的照旧留着（不属于任何一段，清掉别人就再也看不见了）
    expect(calls.slice(1)).toEqual([{ method: "notice.clearOne", params: { id: "s-1" } }]);
    expect(store()).toEqual(["n-1"]);
  });

  it("清过的槽位在宿主那边就没了：再补看不重播（本地不记「哪几条上过屏」）", async () => {
    const { connection } = fakeConnection({ notices: [notice("s-1", "conv-1")] });
    const { shown, onNotice } = recorder();

    await flushPendingNotices({ connection, sessionId: "conv-1", onNotice });
    await flushPendingNotices({ connection, sessionId: "conv-1", onNotice });

    expect(shown).toEqual(["s-1"]);
  });
});

describe("flushPendingNotices：失败不吞", () => {
  it("查询失败原样抛给调用方（「宿主没接 notice.*」不该静默成一个永远为空的函数）", async () => {
    const { connection } = fakeConnection({ failList: new Error("unknown method") });
    const { onNotice } = recorder();

    await expect(flushPendingNotices({ connection, onNotice })).rejects.toThrow("unknown method");
  });

  it("清理失败不抛（上屏已经发生，剩下的只是宿主那份什么时候消失）", async () => {
    const { connection } = fakeConnection({
      notices: [notice("n-1", "conv-1")],
      clearOneThrows: new Error("clear 失败"),
    });
    const { shown, onNotice } = recorder();

    await expect(flushPendingNotices({ connection, onNotice })).resolves.toBeUndefined();
    expect(shown).toEqual(["n-1"]);
  });
});

describe("clearSessionNotices：手动全部清空只清这一段会话", () => {
  /** 只认 `notice.clear` 的连接（把入参原样记下来） */
  function clearConnection() {
    const calls: Array<{ method: string; params: unknown }> = [];
    const connection = {
      api: {
        notice: {
          clear: {
            mutate: async (params: unknown) => {
              calls.push({ method: "notice.clear", params });
            },
          },
        },
      },
    };
    return { connection: connection as unknown as HostConnection, calls };
  }

  it("带 sessionId 调 notice.clear（不带 = 清整个库，会连别的会话一起清）", async () => {
    const { connection, calls } = clearConnection();

    await expect(clearSessionNotices(connection, "conv-1")).resolves.toBeUndefined();

    expect(calls).toEqual([{ method: "notice.clear", params: { sessionId: "conv-1" } }]);
  });

  it("失败原样抛给调用方（上屏那句话由屏幕层说）", async () => {
    const connection = {
      api: {
        notice: {
          clear: {
            mutate: async () => {
              throw new Error("宿主不认这个方法");
            },
          },
        },
      },
    } as unknown as HostConnection;

    await expect(clearSessionNotices(connection, "conv-1")).rejects.toThrow("宿主不认这个方法");
  });
});
