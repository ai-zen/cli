/**
 * 会话注册表用例：**会话归进程所有，屏幕只是借一段来看**（PRD D4）。
 *
 * ## 为什么这里用真会话 + 假连接
 *
 * 这一层要钉的恰恰是「订阅还在不在」：切走之后旧那一段还能不能收到事件、进程收摊时每一段
 * 有没有被关掉。这些行为都长在 `RemoteChatSession` 的订阅上，用假会话去测等于把被验证的那
 * 一半换成桩。所以这里用**真会话**，只把「宿主说了什么」换成几行可以直接写的话
 * （`test-support/fake-connection.ts`，与 `session.test.ts` 同一套路）。
 *
 * 这一刀改写的部分（口径⑦）：事件名与载荷换成 `HostEvent` 那一套（`agent.status` /
 * `session.changed` 带整行 / `notice` 是扁平的一行），打开会话换成 `session.open` 一次取全。
 * 守行为的断言（谁被叫、次序、文案）一条没删。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import { DEFAULT_LOCALE, setLocale } from "./i18n/index.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";
import { QUIET_LOG } from "./test-support/log.js";
import {
  fakeConnection,
  type FakeConnection,
  type FakeOpen,
} from "./test-support/fake-connection.js";
import { createRemoteChatSession } from "./session.js";
import { SessionRegistry, type LiveSession } from "./sessions-registry.js";
import type {
  ChatSessionLike,
  ChatSessionNotifier,
  HostEvent,
  MirrorSessionRow,
  NoticeTone,
  QuestionView,
  RemovedSession,
} from "./session/types.js";

const WORKSPACE = "ws-1";

/** 一条会话行（宿主 `session.open` 出参里的 `session`） */
function sessionRow(id: string, overrides: Partial<MirrorSessionRow> = {}): MirrorSessionRow {
  return {
    id,
    workspaceId: WORKSPACE,
    name: id === "sess-1" ? "第一段" : id,
    nameSource: "default",
    pinned: false,
    agentId: "default",
    modelId: "test-model",
    thinkingLevel: null,
    autoHandoff: false,
    lineage: null,
    handoffThreshold: null,
    guardThreshold: null,
    // 时间一律 epoch 毫秒（宿主的口径）
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** `session.open` 的一份出参 */
function openView(id: string, overrides: Partial<FakeOpen> = {}): FakeOpen {
  return {
    session: sessionRow(id),
    live: { state: "idle", inputPaused: false, outputPaused: false, handingOff: false },
    messages: [],
    inbox: [],
    ...overrides,
  };
}

/** 宿主问过来的一道题（题干已经是渲染好的人话） */
function question(id: string, message: string, sessionId = "sess-1"): QuestionView {
  return {
    id,
    sessionId,
    message,
    choices: [{ value: "yes", label: "好" }],
    blocking: true,
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
  };
}

/** 让挂起的微任务跑完（宿主推的题是会话那一层异步处理的） */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 一段会话的打开视图与事件（`id` 决定是哪一段；测试里按需改） */
function hostLike(
  options: {
    messages?: Record<string, AgentNS.Message[]>;
    defaultAgentId?: string | null;
    /** 额外的路由（覆盖前面那些缺省回执）；回一个 `Error` 就是宿主拒绝这条调用 */
    reply?: (method: string, params: unknown) => unknown;
  } = {},
) {
  const messages = new Map<string, AgentNS.Message[]>(Object.entries(options.messages ?? {}));
  const states = new Map<string, { status: "working" | "idle"; messages: AgentNS.Message[] }>();
  let defaultAgentId = options.defaultAgentId ?? null;

  /** 每一段当前的打开视图（`session.open` 的回执从这里现拼） */
  const viewOf = (sessionId: string): FakeOpen => {
    const current = states.get(sessionId);
    return current === undefined
      ? openView(sessionId, { messages: messages.get(sessionId) ?? [] })
      : openView(sessionId, {
          live: {
            state: current.status,
            inputPaused: false,
            outputPaused: false,
            handingOff: false,
          },
          messages: current.messages,
        });
  };

  const connection: FakeConnection = fakeConnection({
    open: (sessionId) => viewOf(sessionId),
    reply: (method, params) => {
      if (options.reply) {
        const answered = options.reply(method, params);
        if (answered !== undefined) return answered;
      }
      const input = params as { sessionId?: string; workspaceId?: string; agentId?: string };
      switch (method) {
        case "question.list":
          return [];
        case "notice.list":
          return [];
        case "notice.deleteAll":
          return undefined;
        case "config.get":
          return {
            config: { models: [], defaultAgent: defaultAgentId ?? undefined },
            presets: {},
          };
        case "config.agents.get":
          return { definition: { name: "Test Assistant" } };
        case "workspace.list":
          return [{ id: WORKSPACE, name: "项目一", cwd: "/work/proj", createdAt: 0 }];
        case "runtime.agent.send":
          // 投递那一支：回来的 `sessionId` 就是投到的那一段
          return { sessionId: "sess-new", messageId: "u-new" };
        case "session.create":
          // 建行那一支：回来的那一行决定这一段是哪一段（只建行，不唤醒也不投递）
          return { session: sessionRow("sess-new") };
        default:
          void input;
          return undefined;
      }
    },
  });
  return {
    connection,
    messages,
    states,
    // `/agent` 之后宿主配置里那个默认 AgentDefinition 换了一个人：`/new` 得跟着它
    setDefaultAgentId: (value: string | null) => {
      defaultAgentId = value;
    },
  };
}

const zen = useTempAiZenDir("aiz-registry-");
afterAll(() => zen.cleanup());

beforeEach(() => {
  zen.pin();
  // 这一组断言的是中文文案（`phaseLine` 出来的那一句），显式锁语言
  setLocale("zh");
  // 会话记忆是落盘的（`last-session.json`）：每条用例从「本机没记过」开始
  rmSync(join(zen.dir, "cli"), { recursive: true, force: true });
});

afterEach(() => setLocale(DEFAULT_LOCALE));

/** 一屏的听众（`ChatSessionNotifier` 那三路信号 + 记下收到什么） */
type Sink = ChatSessionNotifier & {
  notices: Array<{ text: string; tone: NoticeTone }>;
  changes: number;
  /** 收到过几次「这一段被别处删掉了」（`session.removed` 那一路） */
  removed: RemovedSession[];
};

function sink(): Sink {
  const notices: Array<{ text: string; tone: NoticeTone }> = [];
  const removed: RemovedSession[] = [];
  return {
    notices,
    removed,
    changes: 0,
    onChange() {
      this.changes += 1;
    },
    onNotice: (text, tone) => notices.push({ text, tone }),
    onRemoved: (gone) => removed.push(gone),
  };
}

/**
 * 带记账的注册表：每一段会话被 `dispose()` 几次都记下来。
 *
 * 「各一次，不多不少」只能这样看 —— 真会话的 `dispose()` 自己是幂等的，关了两次也看不出来。
 */
function registryWithDisposeLog(connection: FakeConnection): {
  registry: SessionRegistry;
  disposed: string[];
} {
  const disposed: string[] = [];
  const registry = new SessionRegistry(connection, QUIET_LOG, async (options, notifier) => {
    const session: ChatSessionLike = await createRemoteChatSession(options, notifier, QUIET_LOG);
    const original = session.dispose.bind(session);
    session.dispose = () => {
      disposed.push(session.sessionId);
      original();
    };
    return session;
  });
  return { registry, disposed };
}

/** 「这一批在动」的事件：一条用户消息写进 messages + 一条 AgentDefinition 消息在写 + 忙闲翻成 working */
function working(sessionId: string): HostEvent[] {
  return [
    {
      type: "message.added",
      sessionId,
      message: {
        id: `u-${sessionId}`,
        createdAt: 1,
        role: AgentNS.Role.User,
        content: "干活",
        source: { kind: "user" },
      },
    },
    {
      type: "message.added",
      sessionId,
      message: {
        id: `a-${sessionId}`,
        createdAt: 2,
        role: AgentNS.Role.Assistant,
        status: AgentNS.MessageStatus.Writing,
        reasoning_content: "想一想",
      },
    },
    { type: "agent.status", sessionId, status: "working" },
  ];
}

const emitWorking = (connection: FakeConnection, sessionId: string) => {
  for (const event of working(sessionId)) connection.emit(event);
};

// ==================================================================
// 借一段 / 再借同一段
// ==================================================================

describe("SessionRegistry：一段会话只开一次", () => {
  it("同一个 sessionId 再借一次：拿回**同一个**会话（不重开、也不丢订阅）", async () => {
    const { connection } = hostLike();
    const registry = new SessionRegistry(connection, QUIET_LOG);
    const first = await registry.enter({ sessionId: "sess-1" }, sink());
    const second = await registry.enter({ sessionId: "sess-1" }, sink());

    expect(second).toBe(first);
    // 只开过一次：`session.open` 一次（第二回直接取现成的）
    expect(connection.opens).toEqual(["sess-1"]);
    registry.disposeAll();
  });

  it("两个屏幕先后借同一段：听众换成后来的那个（旧屏的 `detach` 不会把新屏的听众摘掉）", async () => {
    const { connection } = hostLike();
    const registry = new SessionRegistry(connection, QUIET_LOG);
    const oldSink = sink();
    const newSink = sink();
    await registry.enter({ sessionId: "sess-1" }, oldSink);
    await registry.enter({ sessionId: "sess-1" }, newSink);

    // 重挂载的时序：新屏的 `enter` 先写进 messages，旧屏的 cleanup 后跑
    registry.detach(oldSink);
    connection.emit({ type: "agent.status", sessionId: "sess-1", status: "working" });

    expect(newSink.changes).toBeGreaterThan(0);
    registry.disposeAll();
  });
});

// ==================================================================
// 切会话不打断
// ==================================================================

describe("SessionRegistry：切走的那一段继续跑", () => {
  it("换到另一段之后：旧会话没被 dispose，还在收事件、状态跟着变", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    const firstSink = sink();
    const first = await registry.enter({ sessionId: "sess-1" }, firstSink);

    // 第二段（`/load` 选中别的、或 `/new` 开出来的）
    await registry.enter({ sessionId: "sess-2" }, sink());
    registry.detach(firstSink);

    expect(disposed).toEqual([]);
    // 旧那一段还在动：宿主推一条「忙」与那两条消息，它的读数当场变（订阅还在）
    emitWorking(connection, "sess-1");
    expect(first.status).toBe("working");
    expect(first.messages.map((message) => message.id)).toEqual(["u-sess-1", "a-sess-1"]);
    // 而且注册表看得见它 —— 屏幕上没人看，不代表它不在
    expect(registry.list().map((row) => row.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(registry.list()[0]?.status).toBe("working");
    // 「在忙什么」是读的时候从忙闲 + 消息现推的
    expect(registry.list()[0]?.phaseText).toContain("思考");
    registry.disposeAll();
  });

  it("`/new` 的那一段：用同一段会话的助手与选中的工作区开，旧那一段一个字节都不动", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    const firstSink = sink();
    const first = await registry.enter({ sessionId: "sess-1" }, firstSink);
    // `/ws` 刚选过别的工作区：下一个新会话落在它里面，而这一段会话不动
    first.selectWorkspace("ws-other");
    emitWorking(connection, "sess-1");

    const newId = await registry.newSegment();

    expect(newId).toBe("sess-new");
    // 建行只有 `session.create` 这一条路（仅生成库），项目认 `currentWorkspaceId`
    const created = connection.calls.filter((call) => call.method === "session.create").at(-1);
    expect(created?.params).toEqual({ workspaceId: "ws-other", agentId: "default" });
    // `/new` 之后一个字都没投出去：建行不顺带唤醒，也不顺带发消息
    expect(connection.methods()).not.toContain("runtime.agent.send");
    expect(connection.methods()).not.toContain("runtime.agent.wake");
    // 建出来的那一段当场就开出来了（镜像挂上，`/sessions` 与切回去都有它）
    expect(connection.opens).toContain("sess-new");
    // 新的那一段立刻在注册表里（切过去只是接成它的听众），旧那一段：会话没换、订阅还在、也没被关
    expect(
      registry
        .list()
        .map((row) => row.sessionId)
        .sort(),
    ).toEqual(["sess-1", "sess-new"]);
    expect(first.sessionId).toBe("sess-1");
    expect(first.workspaceId).toBe(WORKSPACE);
    expect(disposed).toEqual([]);
    connection.emit({
      type: "message.changed",
      sessionId: "sess-1",
      message: {
        id: "a-sess-1",
        createdAt: 2,
        role: AgentNS.Role.Assistant,
        status: AgentNS.MessageStatus.Writing,
        content: "写到一半",
        reasoning_content: "想一想",
      },
    });
    expect(registry.list()[0]?.phaseText).toContain("输出");
    registry.disposeAll();
  });
});

// ==================================================================
// 列表
// ==================================================================

describe("SessionRegistry：活跃会话清单", () => {
  it("每一行都是会话的**活值**：忙闲、死活、在忙什么、排队条数、几点开的", async () => {
    const { connection } = hostLike();
    const registry = new SessionRegistry(connection, QUIET_LOG);
    await registry.enter({ sessionId: "sess-1" }, sink());

    expect(registry.list()[0]).toMatchObject<Partial<LiveSession>>({
      sessionId: "sess-1",
      name: "第一段",
      status: "idle",
      alive: true,
      phaseText: null,
      // 派生值：会话那边 `inboxPending` = `inbox.length`
      inboxPending: 0,
      // 这一段的起点：会话行上那一格（宿主的口径是 epoch 毫秒，列表要说 ISO）
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    emitWorking(connection, "sess-1");
    expect(registry.list()[0]).toMatchObject<Partial<LiveSession>>({
      status: "working",
      alive: true,
    });
    expect(registry.list()[0]?.phaseText).toContain("思考");
    registry.disposeAll();
  });
});

// ==================================================================
// 后台通知归位
// ==================================================================

describe("SessionRegistry：后台会话的通知不抢当前屏", () => {
  it("没人看那一段时攒着，切过去（`enter`）一次性交给那一屏", async () => {
    const { connection } = hostLike();
    const registry = new SessionRegistry(connection, QUIET_LOG);
    const background = sink();
    await registry.enter({ sessionId: "sess-1" }, background);
    await registry.enter({ sessionId: "sess-2" }, sink());
    // sess-1 变成后台：屏幕已经走了
    registry.detach(background);

    connection.emit({
      type: "notice",
      notice: {
        id: "n-1",
        level: "warning",
        code: "notice.test",
        // 句子是宿主渲染好的（客户端不翻译）；四档语气收成三档（`session-notice.ts`）
        message: "会话一那边有话要说",
        durationMs: null,
        sessionId: "sess-1",
        createdAt: 0,
      },
    });
    // 后台那一段的句子不往当前屏（sess-2）上冒
    expect(background.notices).toEqual([]);

    const backToFirst = sink();
    await registry.enter({ sessionId: "sess-1" }, backToFirst);
    expect(backToFirst.notices).toEqual([{ text: "会话一那边有话要说", tone: "warn" }]);
    registry.disposeAll();
  });
});

// ==================================================================
// 启动期先把会话开好（组装根的 `open`）
// ==================================================================

describe("SessionRegistry：启动期先开会话（`open`），屏幕随后只接听众", () => {
  it("`open` 之后屏幕 `enter` 同一段：只开一次（不重开、不重订阅）", async () => {
    const { connection } = hostLike();
    const registry = new SessionRegistry(connection, QUIET_LOG);
    const primed = await registry.open({ agentId: "default", workspaceId: WORKSPACE });

    const screen = sink();
    const entered = await registry.enter({ sessionId: primed.sessionId }, screen);

    expect(entered).toBe(primed);
    // 建行一次、`connection.open` 一次：两次开会话就是两条镜像订阅
    expect(connection.calls.filter((call) => call.method === "session.create")).toHaveLength(1);
    expect(connection.opens).toEqual([primed.sessionId]);
    // 听众真的接上了：事件到它那儿
    connection.emit({ type: "agent.status", sessionId: primed.sessionId, status: "working" });
    expect(screen.changes).toBeGreaterThan(0);
    registry.disposeAll();
  });

  // 攒下的通知仍然在**这一段自己的**那一格（`channel`），与作答那一手无关
  it("开好那一刻攒下的通知不丢：屏幕挂上来时一次性交出去", async () => {
    const { connection } = hostLike();
    const registry = new SessionRegistry(connection, QUIET_LOG);
    const primed = await registry.open({ agentId: "default", workspaceId: WORKSPACE });

    connection.emit({
      type: "notice",
      notice: {
        id: "n-1",
        level: "info",
        code: "notice.test",
        message: "开会话的时候宿主说了一句",
        durationMs: null,
        sessionId: primed.sessionId,
        createdAt: 0,
      },
    });

    const screen = sink();
    await registry.enter({ sessionId: primed.sessionId }, screen);
    expect(screen.notices).toEqual([{ text: "开会话的时候宿主说了一句", tone: "info" }]);
    registry.disposeAll();
  });

  it("作答那一手可以晚绑：没屏幕时如实回 null（题干进通知栏），屏幕挂上来之后就用它那个", async () => {
    const host = hostLike();
    const registry = new SessionRegistry(host.connection, QUIET_LOG);
    const primed = await registry.open({ agentId: "default", workspaceId: WORKSPACE });

    // 屏幕的那一手先摆在这儿：它该被写进 `enter` 拿到的那一格（这里是下面 `enter` 交的）
    const answered: string[] = [];

    // 启动期（屏幕还没挂上来）宿主就问了一道题：这一段的格子还是空的，没人能答，题干进通知栏攒着
    host.connection.emit({
      type: "question.asked",
      sessionId: primed.sessionId,
      question: question("q-1", "要交接吗", primed.sessionId),
    });
    await settle();
    // 作答者在 `enter` 之前根本不存在（不是全局挂着、也不是开局那个空手）
    expect(answered).toEqual([]);

    const screen = sink();
    await registry.enter(
      {
        sessionId: primed.sessionId,
        onQuestion: async (asked) => {
          answered.push(asked.id);
          return "later";
        },
      },
      screen,
    );
    expect(screen.notices).toEqual([{ text: "要交接吗", tone: "info" }]);

    // 屏幕挂上来之后的那一道题：交给屏幕作答（它那一格此时已写着屏幕那一手）
    host.connection.emit({
      type: "question.asked",
      sessionId: primed.sessionId,
      question: question("q-2", "换记忆吗", primed.sessionId),
    });
    await settle();
    expect(answered).toEqual(["q-2"]);
    registry.disposeAll();
  });
});

// ==================================================================
// 作答那一手按会话各持一个
// ==================================================================

describe("SessionRegistry：作答那一手按会话各持一个", () => {
  it("后台那段会话推的题不去问当前屏：当前屏的作答者一次都没被调，题干落进它自己那一格", async () => {
    const host = hostLike();
    const registry = new SessionRegistry(host.connection, QUIET_LOG);
    // 甲：屏幕挂上来了，把它自己的那一手写进了这一段的格子
    const screenA = sink();
    const answered: string[] = [];
    await registry.enter(
      {
        sessionId: "sess-1",
        onQuestion: async (asked) => {
          answered.push(asked.id);
          return "yes";
        },
      },
      screenA,
    );
    // 乙：只开着，没有屏幕（启动期先开好、还没切过去的那一种）
    await registry.open({ sessionId: "sess-2" });

    // 乙推题：它那一格是空的 —— 绝不能拿甲那一手来答
    host.connection.emit({
      type: "question.asked",
      sessionId: "sess-2",
      question: question("q-b", "后台要交接吗", "sess-2"),
    });
    await settle();
    expect(answered).toEqual([]);
    // 谁也没答：这一段没有作答者就不作答（不回宿主任意选项）
    const answers = () => host.connection.calls.filter((call) => call.method === "question.answer");
    expect(answers()).toHaveLength(0);
    // 题不进别人那一屏：甲的屏幕一句都没收到
    expect(screenA.notices).toEqual([]);
    // 而是进乙自己那一格的通知栏，切过去才看见
    const screenB = sink();
    await registry.enter({ sessionId: "sess-2" }, screenB);
    expect(screenB.notices).toEqual([{ text: "后台要交接吗", tone: "info" }]);

    // 甲自己那一段推的题：照旧交给甲的作答者，答案回给宿主
    host.connection.emit({
      type: "question.asked",
      sessionId: "sess-1",
      question: question("q-a", "换记忆吗", "sess-1"),
    });
    await settle();
    expect(answered).toEqual(["q-a"]);
    expect(answers()[0]?.params).toEqual({ questionId: "q-a", value: "yes" });
    registry.disposeAll();
  });
});

// ==================================================================
// 收摊
// ==================================================================

describe("SessionRegistry：进程收摊", () => {
  it("每一段各 dispose 一次（收两遍也不会重复关）", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    await registry.enter({ sessionId: "sess-1" }, sink());
    await registry.enter({ sessionId: "sess-2" }, sink());

    registry.disposeAll();
    registry.disposeAll();

    expect(disposed).toEqual(["sess-1", "sess-2"]);
    // 关过之后清单就空了：收摊之后再 `enter` 是新的一段，不会拿到已经关掉的旧对象
    expect(registry.list()).toEqual([]);
  });

  it("关掉之后那一段不再收事件（订阅真的摘干净了）", async () => {
    const { connection } = hostLike();
    const registry = new SessionRegistry(connection, QUIET_LOG);
    const session = await registry.enter({ sessionId: "sess-1" }, sink());

    registry.disposeAll();
    emitWorking(connection, "sess-1");

    expect(session.status).toBe("idle");
    expect(session.messages).toEqual([]);
  });
});

// ==================================================================
// `/new` 用哪个 AgentDefinition
// ==================================================================

describe("/new：下一段用宿主配置里的默认助手", () => {
  it("`/agent` 改过默认助手之后，`/new` 出来的就是新的那个", async () => {
    const host = hostLike();
    const registry = new SessionRegistry(host.connection, QUIET_LOG);
    await registry.enter({ sessionId: "sess-1" }, sink());

    // `/agent` 干的就是这件事：写宿主配置里的 `defaultAgent`
    host.setDefaultAgentId("picked");

    await registry.newSegment();

    const created = host.connection.calls.filter((call) => call.method === "session.create").at(-1);
    expect((created?.params as { agentId?: string }).agentId).toBe("picked");
    registry.disposeAll();
  });

  it("宿主没给默认助手：退回当前这一段用的那个（不让 `/new` 因为一条附加查询开不了）", async () => {
    const host = hostLike();
    const registry = new SessionRegistry(host.connection, QUIET_LOG);
    await registry.enter({ sessionId: "sess-1" }, sink());
    host.setDefaultAgentId(null);

    await registry.newSegment();

    const created = host.connection.calls.filter((call) => call.method === "session.create").at(-1);
    // `sess-1` 的会话行上那一格是 `default`
    expect((created?.params as { agentId?: string }).agentId).toBe("default");
    registry.disposeAll();
  });

  it("默认助手问不到：退回当前这一段用的那个，并说一句", async () => {
    const host = hostLike({
      reply: (method) => (method === "config.get" ? new Error("连接断了") : undefined),
    });
    const registry = new SessionRegistry(host.connection, QUIET_LOG);
    const screen = sink();
    await registry.enter({ sessionId: "sess-1" }, screen);

    await registry.newSegment();

    const created = host.connection.calls.filter((call) => call.method === "session.create").at(-1);
    // `/new` 照旧开得出来（一条附加查询失败不能拦住开新会话）
    expect((created?.params as { agentId?: string }).agentId).toBe("default");
    // 但「换了个 AgentDefinition」不能就这样过去：用户只会发现自己开的不是预期的那一段
    expect(screen.notices).toEqual([
      { text: "默认助手问不到，这一段按当前用的助手开：连接断了", tone: "warn" },
    ]);
    registry.disposeAll();
  });
});

// ==================================================================
// `/delete` 之后：登记里不留那一段
// ==================================================================

/**
 * 删掉一段会话之后的第一件事是**摘登记**：宿主那边已经硬删了，本进程再挂着它，后续「切回去」
 * 就指向一段已经不存在的东西，而它那份订阅也会白白留着推。
 */
describe("SessionRegistry：删掉的会话不再挂在登记里", () => {
  it("摘掉之后登记表里没有它，它的订阅也真的解了（事件推过来一个字节都不变）", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    const first = await registry.enter({ sessionId: "sess-1" }, sink());
    await registry.enter({ sessionId: "sess-2" }, sink());

    registry.drop("sess-1");

    expect(registry.list().map((row) => row.sessionId)).toEqual(["sess-2"]);
    // 订阅真的解了：宿主再推那一段的事件，它的读数一点不动
    emitWorking(connection, "sess-1");
    expect(first.messages).toEqual([]);
    expect(first.status).toBe("idle");
    // 镜像也关了（`dispose()` 里那一手）：没人看的镜像不该留在连接上
    expect(connection.mirrors.has("sess-1")).toBe(false);
    // 解订阅走的是摘掉它自己的那一套：各一次，不多不少
    expect(disposed).toEqual(["sess-1"]);

    registry.disposeAll();
    expect(disposed).toEqual(["sess-1", "sess-2"]);
  });

  it("删的是唯一的一段：登记表清空，不报错，进程收摊不会重复关它", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    await registry.enter({ sessionId: "sess-1" }, sink());

    expect(() => registry.drop("sess-1")).not.toThrow();
    expect(registry.list()).toEqual([]);

    // 已经摘掉了：收摊那一手不会把它再 `dispose()` 一次（也没别的可摘）
    registry.disposeAll();
    expect(disposed).toEqual(["sess-1"]);
  });

  it("那一段本来就不在本进程的登记里（别的客户端删的）：空操作，不报错", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    await registry.enter({ sessionId: "sess-1" }, sink());

    expect(() => registry.drop("sess-other")).not.toThrow();
    expect(registry.list().map((row) => row.sessionId)).toEqual(["sess-1"]);
    expect(disposed).toEqual([]);

    registry.disposeAll();
  });
});

// ==================================================================
// `session.removed`：别处删掉的那一段，本进程当场就知道
// ==================================================================

/**
 * 宿主在删成功之后推 `session.removed`（删项目连带删掉的那几段也各推一条）。
 *
 * 注册表要做的只有两半：**摘登记**（连带解订阅）与**只对「这一屏正看着的那一段」出声一次**。
 * 往哪换、说什么话不在这一层（那是屏幕 + `moveAfterGone` 的事），所以这里钉的就是这两半。
 */
describe("SessionRegistry：别处删掉的那一段", () => {
  /** 一段会话没了（宿主推的那一条） */
  const removedEvent = (sessionId: string): HostEvent => ({ type: "session.removed", sessionId });

  it("删的是**别的**那一段：只摘登记，不打扰这一屏（不通知、不换屏）", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    const background = sink();
    const screen = sink();
    // 先开 sess-2 再开 sess-1：`current` 是最后进来那一段（sess-1）
    await registry.enter({ sessionId: "sess-2" }, background);
    await registry.enter({ sessionId: "sess-1" }, screen);
    // 屏幕换了那一段：旧听众摘掉（这就是「后台那一段」的样子）
    registry.detach(background);

    connection.emit(removedEvent("sess-2"));

    // 登记里没有它了，订阅也真的解了（各一次，不多不少）
    expect(registry.list().map((row) => row.sessionId)).toEqual(["sess-1"]);
    expect(disposed).toEqual(["sess-2"]);
    expect(connection.mirrors.has("sess-2")).toBe(false);
    // 这一屏什么都不该知道：没有通知、没有「去换一段」那一下
    expect(screen.removed).toEqual([]);
    expect(screen.notices).toEqual([]);
    expect(background.removed).toEqual([]);

    registry.disposeAll();
  });

  it("删的是这一屏正看着的那一段：摘登记，并把这一下交给那一屏（带上项目）", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    const screen = sink();
    await registry.enter({ sessionId: "sess-1" }, screen);

    connection.emit(removedEvent("sess-1"));

    expect(registry.list()).toEqual([]);
    expect(disposed).toEqual(["sess-1"]);
    // 交出去的两格：哪一段没了、它属于哪个项目（找下一段要用）
    expect(screen.removed).toEqual([{ sessionId: "sess-1", workspaceId: WORKSPACE }]);

    registry.disposeAll();
    // 已经摘过的不会再被关一次
    expect(disposed).toEqual(["sess-1"]);
  });

  it("一次连来三条（删项目那种）：每一条都摘登记，只有当前那一段那一下出声", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    const screen = sink();
    await registry.enter({ sessionId: "sess-1" }, screen);
    await registry.enter({ sessionId: "sess-2" }, sink());
    await registry.enter({ sessionId: "sess-3" }, sink());
    // 这一屏看的还是 sess-1（后两段是后台开着的那几段）
    const watching = sink();
    await registry.enter({ sessionId: "sess-1" }, watching);

    for (const id of ["sess-1", "sess-2", "sess-3"]) connection.emit(removedEvent(id));

    // 三段都摘干净了
    expect(registry.list()).toEqual([]);
    expect(disposed.sort()).toEqual(["sess-1", "sess-2", "sess-3"]);
    // 只有「正看着的那一段」那一下交给了屏幕：不许连刷几条通知
    expect(watching.removed).toEqual([{ sessionId: "sess-1", workspaceId: WORKSPACE }]);
    expect(watching.notices).toEqual([]);
    expect(screen.removed).toEqual([]);

    registry.disposeAll();
  });

  it("本进程自己叫的那一次删除（`expectOwnRemoval` 期间）：只摘登记，不出声", async () => {
    const { connection } = hostLike();
    const { registry } = registryWithDisposeLog(connection);
    const screen = sink();
    await registry.enter({ sessionId: "sess-1" }, screen);

    const doneOwnRemoval = registry.expectOwnRemoval();
    // 宿主在 mutation 里就把这条推回来了：它到得比回执早（所以报名在删之前）
    connection.emit(removedEvent("sess-1"));

    expect(registry.list()).toEqual([]);
    // 收尾在发起删除的那条命令手里：这一屏不该被惊动一次再被收尾一次
    expect(screen.removed).toEqual([]);

    // 结账之后一切照旧：别处删掉的那一段照样交出来
    await registry.enter({ sessionId: "sess-2" }, screen);
    doneOwnRemoval();
    connection.emit(removedEvent("sess-2"));
    expect(screen.removed).toEqual([{ sessionId: "sess-2", workspaceId: WORKSPACE }]);

    registry.disposeAll();
  });

  it("本进程没开过的那一段（别的客户端的）：什么都不做", async () => {
    const { connection } = hostLike();
    const { registry, disposed } = registryWithDisposeLog(connection);
    const screen = sink();
    await registry.enter({ sessionId: "sess-1" }, screen);

    expect(() => connection.emit(removedEvent("sess-other"))).not.toThrow();

    expect(registry.list().map((row) => row.sessionId)).toEqual(["sess-1"]);
    expect(disposed).toEqual([]);
    expect(screen.removed).toEqual([]);

    registry.disposeAll();
  });
});
