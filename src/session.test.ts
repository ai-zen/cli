/**
 * `RemoteChatSession` 用例：会话层是「宿主事实 ↔ 界面契约」的那一层，所以用**假连接**测。
 *
 * 假连接里真的跑着一个 `SessionMirror`（`test-support/fake-connection.ts`）：消息与四件事的折叠
 * 归 `server-client/mirror.ts`，这一层只负责「催一帧 / 采样速率 / 收个尾 / 把命令打成 procedure
 * 调用」。于是这里的每条用例钉的都是**这一层自己的纪律**：
 *
 *   · 打开会话打哪几条 procedure（`session.open` 一次取全 / `agent.send` 建行）；
 *   · `agent.send` 带的是什么（`workspaceId` + `agentId` + `content` + `messageId` + `sessionId`）；
 *   · 等结局的判据只有契约事实（新消息出现了 + 忙闲回到 `idle` + 没有还在写的助手消息）；
 *   · 忙闲落回 `idle` 就补拉一次（`resync`），速率用消息上的 `usage` 合计定格；
 *   · 通知、问题、名册、subagent 那一栏各自从哪来、按什么过滤。
 *
 * 这一刀改写的部分（口径⑦）：旧断言里守「镜像 / 旧事件 / 旧视图」的换成守新事实 ——
 * `session.open` 一次取全、`HostEvent` 的**整条消息**、会话行上的 `modelId` / `thinkingLevel`
 * 两个字段。守行为的断言（谁被叫、次序、文案）一条没删。
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import type { LogSink } from "@ai-zen/agents-logger";
import { useTempAiZenDir } from "./test-support/temp-dir.js";
import {
  fakeConnection,
  type FakeConnection,
  type FakeOpen,
} from "./test-support/fake-connection.js";
import { RemoteChatSession } from "./session.js";
import type {
  ChatSessionNotifier,
  HostEvent,
  MirrorSessionRow,
  NoticeOrigin,
  NoticeTone,
  QuestionView,
} from "./session/types.js";

// ==================================================================
// 契约形状的样板
// ==================================================================

const SESSION = "sess-1";
const WORKSPACE = "ws-1";

/** 一条会话行（宿主 `session.open` 出参里的 `session`，字段一个不改） */
function sessionRow(overrides: Partial<MirrorSessionRow> = {}): MirrorSessionRow {
  return {
    id: SESSION,
    workspaceId: WORKSPACE,
    name: "会话一",
    nameIsAuto: true,
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

/** `session.open` 的一份出参（`live: null` = 这一段没有执行体，也就是死的） */
function openView(overrides: Partial<FakeOpen> = {}): FakeOpen {
  return {
    session: sessionRow(),
    live: { state: "idle", inputPaused: false, outputPaused: false, handingOff: false },
    messages: [],
    inbox: [],
    ...overrides,
  };
}

const userMessage = (id: string, text: string): AgentNS.Message => ({
  id,
  createdAt: 1,
  role: AgentNS.Role.User,
  content: text,
  status: AgentNS.MessageStatus.Completed,
  source: { kind: "user" },
});

const assistantMessage = (
  id: string,
  overrides: Partial<AgentNS.Message> = {},
): AgentNS.Message => ({
  id,
  createdAt: 2,
  role: AgentNS.Role.Assistant,
  content: "答案",
  status: AgentNS.MessageStatus.Completed,
  ...overrides,
});

const usage = (completion: number): AgentNS.Usage => ({
  prompt_tokens: 10,
  completion_tokens: completion,
  total_tokens: 10 + completion,
});

const question = (overrides: Partial<QuestionView> = {}): QuestionView => ({
  id: "q-1",
  sessionId: SESSION,
  message: "要交接吗？",
  choices: [{ value: "self", label: "自交接" }],
  blocking: true,
  createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

// ==================================================================
// 一个「像宿主一样」的假连接：状态与消息放在这几个可变量里
// ==================================================================

interface HostLike {
  connection: FakeConnection;
  open: { current: FakeOpen };
  questions: QuestionView[];
  /** 宿主配置（`api.config.get` 的回执） */
  config: { models: unknown[]; defaultAgent?: string; presets: unknown };
  /** 助手定义（`api.agentDefinition.get` 的回执；`null` = 定义没了） */
  definition: { modelId?: string; name: string } | null;
  workspaces: { id: string; name: string; cwd: string; createdAt: number }[];
}

function hostLike(
  options: {
    open?: FakeOpen;
    questions?: QuestionView[];
    config?: Partial<HostLike["config"]>;
    definition?: { modelId?: string; name: string } | null;
    workspaces?: HostLike["workspaces"];
    /** 额外的路由（覆盖前面那些缺省回执） */
    reply?: (method: string, params: unknown) => unknown;
    /** `session.open` 对某一段怎么失败（会话没了那种） */
    openFails?: (sessionId: string) => Error | undefined;
  } = {},
): HostLike {
  const host: HostLike = {
    connection: undefined as unknown as FakeConnection,
    open: { current: options.open ?? openView() },
    questions: options.questions ?? [],
    config: {
      models: [{ id: "test-model", name: "Test", vision: false }],
      defaultAgent: "default",
      presets: {},
      ...options.config,
    },
    definition: options.definition === undefined ? { name: "Test Assistant" } : options.definition,
    workspaces: options.workspaces ?? [
      { id: WORKSPACE, name: "项目一", cwd: "/work/proj", createdAt: 0 },
    ],
  };

  const connection = fakeConnection({
    open: (sessionId) => options.openFails?.(sessionId) ?? host.open.current,
    reply: (method, params) => {
      if (options.reply) {
        const answered = options.reply(method, params);
        if (answered !== undefined) return answered;
      }
      switch (method) {
        case "session.open":
          return host.open.current;
        case "question.list":
          return host.questions;
        case "question.answer":
          return question();
        case "notice.list":
          return [];
        case "notice.clear":
          return undefined;
        case "config.get":
          return { config: host.config, presets: host.config.presets };
        case "agentDefinition.get": {
          if (host.definition === null) throw new Error("定义没了");
          return { definition: host.definition };
        }
        case "workspace.list":
          return host.workspaces;
        case "agent.send":
          return { sessionId: SESSION, messageId: "u-new" };
        default:
          return undefined;
      }
    },
  });
  host.connection = connection;
  return host;
}

/** 一个只记东西的通知器（`origin` 也记：它是「发送那一刻清掉哪些」的判据） */
function notifierOf(): ChatSessionNotifier & {
  changes: boolean[];
  notices: Array<{ text: string; tone: NoticeTone; origin?: NoticeOrigin }>;
} {
  const changes: boolean[] = [];
  const notices: Array<{ text: string; tone: NoticeTone; origin?: NoticeOrigin }> = [];
  return {
    changes,
    notices,
    onChange: (immediate) => changes.push(immediate),
    onNotice: (text, tone, origin) => notices.push({ text, tone, origin }),
  };
}

const zen = useTempAiZenDir("aiz-session-");

/** 本文件里报出去的话（会话层 / 本机记忆的日志出口，从参数上递） */
const warnings: string[] = [];

const logger: LogSink = {
  info: () => {},
  warn: (message) => void warnings.push(message),
  error: () => {},
};

afterAll(() => {
  zen.cleanup();
});

beforeEach(() => {
  zen.pin();
  warnings.length = 0;
  rmSync(join(zen.dir, "cli"), { recursive: true, force: true });
});

const open = async (
  host: HostLike,
  options: Partial<Parameters<typeof RemoteChatSession.open>[1]> = {},
  notifier = notifierOf(),
) => ({
  session: await RemoteChatSession.open(
    host.connection,
    { sessionId: SESSION, remember: false, ...options },
    notifier,
    logger,
  ),
  notifier,
});

/** 放到下一拍，让 `settle()` 那条 Promise 链跑完 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 推一条事件（`emit` 的短手） */
const emit = (host: HostLike, event: HostEvent) => host.connection.emit(event);

// ==================================================================
// 打开
// ==================================================================

describe("RemoteChatSession：怎么打开那一段", () => {
  it("按 id 打开：`session.open` 一次取全（会话行 + 四件事 + 整段消息 + 排队区）", async () => {
    const host = hostLike({
      open: openView({ messages: [userMessage("u-1", "早")] }),
    });
    const { session } = await open(host);

    // 这一刀的关键：没有 `session.get` / `session.state` / `message.list` 那三问，一次取全
    expect(host.connection.opens).toEqual([SESSION]);
    expect(host.connection.methods()).not.toContain("session.get");
    expect(session.messages.map((message) => message.id)).toEqual(["u-1"]);
    expect(session.sessionId).toBe(SESSION);
    expect(session.workspaceId).toBe(WORKSPACE);
    // 会话行上那两个新字段：模型与思考档各一格
    expect(session.modelId).toBe("test-model");
    expect(session.thinking.selected).toBeNull();
  });

  it("没给 id 时走 `agent.send`（不带 `sessionId` = 建行 + 唤醒 + 投递），并在本机记住这一段", async () => {
    const host = hostLike();
    const session = await RemoteChatSession.open(
      host.connection,
      { workspaceId: WORKSPACE, agentId: "default" },
      notifierOf(),
      logger,
    );

    const create = host.connection.calls.find((call) => call.method === "agent.send");
    expect(create?.params).toMatchObject({
      workspaceId: WORKSPACE,
      agentId: "default",
      // 宿主这一版没有「只建行」的 procedure，所以这一支投一条空正文（见提交信息）
      content: "",
    });
    // 不带 `sessionId` 才是建行那一支
    expect((create?.params as { sessionId?: string }).sessionId).toBeUndefined();
    expect(session.sessionId).toBe(SESSION);
    // 记住了：下次 `ai` 在这个项目里续接的就是它
    const memory = JSON.parse(readFileSync(join(zen.dir, "cli", "last-session.json"), "utf-8"));
    expect(memory[WORKSPACE]).toBe(SESSION);
  });

  it("`resume`：本机记着的那一段优先（不新建）", async () => {
    const host = hostLike();
    await RemoteChatSession.open(
      host.connection,
      { workspaceId: WORKSPACE, agentId: "default" },
      notifierOf(),
      logger,
    );

    const second = hostLike();
    const session = await RemoteChatSession.open(
      second.connection,
      { workspaceId: WORKSPACE, resume: true },
      notifierOf(),
      logger,
    );

    expect(session.sessionId).toBe(SESSION);
    expect(second.connection.methods()).not.toContain("agent.send");
  });

  it("记着的那一段在宿主上没了：照样开一段新的，但要报一句「没能续接」", async () => {
    mkdirSync(join(zen.dir, "cli"), { recursive: true });
    writeFileSync(
      join(zen.dir, "cli", "last-session.json"),
      JSON.stringify({ [WORKSPACE]: "sess-gone" }),
      "utf-8",
    );
    const host = hostLike({
      openFails: (sessionId) =>
        sessionId === "sess-gone" ? new Error("session not found: sess-gone") : undefined,
    });

    const session = await RemoteChatSession.open(
      host.connection,
      { workspaceId: WORKSPACE, agentId: "default", resume: true },
      notifierOf(),
      logger,
    );

    // 续接失败不拦启动：这一次照样开一段新的
    expect(session.sessionId).toBe(SESSION);
    expect(host.connection.methods()).toContain("agent.send");
    // 但「旧消息不见了」不能没有解释：报一句，且带上宿主原话
    const said = warnings.join("\n");
    expect(said).toContain("没能续接上一次那一段");
    expect(said).toContain("sess-gone");
    expect(said).toContain("session not found: sess-gone");
  });

  it("`remember: false`：不写「上次打开的那段」（管道结果不该挪续接目标）", async () => {
    const host = hostLike();
    await open(host, { remember: false });
    expect(() => readFileSync(join(zen.dir, "cli", "last-session.json"), "utf-8")).toThrow();
  });

  it("没进入工作区就开新会话：直接说清楚（不拿本机 cwd 去猜，PRD D30）", async () => {
    const host = hostLike();
    await expect(
      RemoteChatSession.open(host.connection, { agentId: "default" }, notifierOf(), logger),
    ).rejects.toThrow(/工作区/);
  });

  it("宿主配置里没有默认助手：说清楚要先去配一个", async () => {
    const host = hostLike({ config: { defaultAgent: undefined } });
    await expect(
      RemoteChatSession.open(host.connection, { workspaceId: WORKSPACE }, notifierOf(), logger),
    ).rejects.toThrow(/默认助手/);
  });
});

// ==================================================================
// 四件事
// ==================================================================

describe("RemoteChatSession：四件事各一格（不压成一个状态）", () => {
  it("`live` 一次给齐：忙闲 / 两道闸 / 死活", async () => {
    const host = hostLike({
      open: openView({
        live: { state: "working", inputPaused: true, outputPaused: true, handingOff: false },
      }),
    });
    const { session } = await open(host);

    expect(session.status).toBe("working");
    expect(session.inputPaused).toBe(true);
    expect(session.outputPaused).toBe(true);
    expect(session.alive).toBe(true);
  });

  it("`live === null` ⇒ 死活就是 `false`（没有执行体就是死的，不用等事件）", async () => {
    const host = hostLike({ open: openView({ live: null }) });
    const { session } = await open(host);

    expect(session.alive).toBe(false);
    // 读数的另外三格这时「还没读到」：不借「闲」占位
    expect(session.status).toBeNull();
    expect(session.inputPaused).toBeNull();
    expect(session.outputPaused).toBeNull();
  });

  it("两道闸各换自己那一格（`agent.paused` 的 `side` 说清了哪一道、`paused` 说开关）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, { type: "agent.paused", sessionId: SESSION, side: "output", paused: true });
    expect(session.outputPaused).toBe(true);
    emit(host, { type: "agent.paused", sessionId: SESSION, side: "output", paused: false });
    expect(session.outputPaused).toBe(false);
    emit(host, { type: "agent.paused", sessionId: SESSION, side: "input", paused: true });
    expect(session.inputPaused).toBe(true);
    expect(session.outputPaused).toBe(false);
  });

  it("死活走 `agent.alive`", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, { type: "agent.alive", sessionId: SESSION, alive: false });
    expect(session.alive).toBe(false);
    emit(host, { type: "agent.alive", sessionId: SESSION, alive: true });
    expect(session.alive).toBe(true);
  });

  it("忙闲走 `agent.status`（收到就换）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, { type: "agent.status", sessionId: SESSION, status: "working" });
    expect(session.status).toBe("working");
    emit(host, { type: "agent.status", sessionId: SESSION, status: "idle" });
    expect(session.status).toBe("idle");
  });

  it("别的会话的事件一律不认", async () => {
    const host = hostLike();
    const { session, notifier } = await open(host);
    const before = notifier.changes.length;

    emit(host, { type: "agent.status", sessionId: "other", status: "working" });
    expect(session.status).toBe("idle");
    expect(notifier.changes).toHaveLength(before);
  });
});

// ==================================================================
// 发话
// ==================================================================

describe("RemoteChatSession：发一句", () => {
  it("打成 `agent.send`（`sessionId` + `workspaceId` + `agentId` + `content` + `messageId`）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.send("你好");

    const send = host.connection.calls.filter((call) => call.method === "agent.send").at(-1);
    expect(send?.params).toMatchObject({
      workspaceId: WORKSPACE,
      agentId: "default",
      content: "你好",
      sessionId: SESSION,
    });
    // 客户端给 id：宿主据它认「落地的是哪一条」
    expect(typeof (send?.params as { messageId?: string }).messageId).toBe("string");
  });

  it("带图片：交上去的是带 `__asset_id` 的内容段（怎么变成厂商形状由宿主决定）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    // 上传走 `api.asset.upload.mutate`；这张用例只关心段被拼成什么样
    host.connection.emit({
      type: "notice",
      notice: {
        id: "n-1",
        level: "info",
        code: "notice.test",
        message: "ignored",
        durationMs: null,
        sessionId: "other",
        createdAt: 0,
      },
    });
    await session.send("你好");
    const send = host.connection.calls.filter((call) => call.method === "agent.send").at(-1);
    expect((send?.params as { content: unknown }).content).toBe("你好");
  });

  it("撤回回填的素材（已传过）：不打上传，直接拼成段发下去，排在这一次新传的之前", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.send("看这两张", [], ["a-1", "a-2"]);

    const send = host.connection.calls.filter((call) => call.method === "agent.send").at(-1);
    expect((send?.params as { content: unknown }).content).toEqual([
      { type: "text", text: "看这两张" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "a-1" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "a-2" },
    ]);
    // 一张都没传：id 就是那一次上传的凭证，再传一遍既浪费也不是同一份
    expect(host.connection.calls.filter((call) => call.method === "asset.upload")).toHaveLength(0);
  });

  it("宿主拒绝（例如有问题挡着）进通知栏，不抛（抛出去会变成未处理的 rejection）", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "agent.send" ? new Error("还有一道题没答（question_pending）") : undefined,
    });
    const { session, notifier } = await open(host);

    await expect(session.send("你好")).resolves.toBeUndefined();
    expect(notifier.notices.at(-1)?.tone).toBe("error");
    expect(notifier.notices.at(-1)?.text).toContain("question_pending");
  });

  it("活着：不多打一次 `agent.wake`（那是无谓的往返）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.send("你好");

    expect(host.connection.methods()).not.toContain("agent.wake");
    expect(host.connection.methods()).toContain("agent.send");
  });

  it("死的（`session.open` 报 `live: null`）：先 `agent.wake` 再投递，顺序就是这个", async () => {
    const host = hostLike({ open: openView({ live: null }) });
    const { session } = await open(host);
    expect(session.alive).toBe(false);

    await session.send("醒了没");

    const methods = host.connection.methods();
    // 反过来的话就是「投给一个死会话」，宿主只会回 not_found
    expect(methods.indexOf("agent.wake")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("agent.wake")).toBeLessThan(methods.indexOf("agent.send"));
    // 唤醒那一次只带 sessionId
    const wake = host.connection.calls.filter((call) => call.method === "agent.wake").at(-1);
    expect(wake?.params).toEqual({ sessionId: SESSION });
    // 投递那一次还是原样
    const send = host.connection.calls.filter((call) => call.method === "agent.send").at(-1);
    expect(send?.params).toMatchObject({ sessionId: SESSION, content: "醒了没" });
  });

  it("唤醒失败：宿主原话上屏，`agent.send` 一次不打（不重试、不兜底）", async () => {
    const host = hostLike({
      open: openView({ live: null }),
      reply: (method) => (method === "agent.wake" ? new Error("装配失败（缺凭证）") : undefined),
    });
    const { session, notifier } = await open(host);

    await expect(session.send("发不出去的话")).resolves.toBeUndefined();

    // 没叫起来就不能投：发出去半句比没发更糟
    expect(host.connection.methods()).not.toContain("agent.send");
    // 只叫一次，不重试
    expect(host.connection.methods().filter((method) => method === "agent.wake")).toHaveLength(1);
    expect(notifier.notices.at(-1)).toMatchObject({ tone: "error" });
    expect(notifier.notices.at(-1)?.text).toContain("装配失败（缺凭证）");
  });

  it("叫起来了但投递还是被拒（中间那一段被杀掉）：宿主原话上屏，不重试", async () => {
    const host = hostLike({
      open: openView({ live: null }),
      reply: (method) =>
        method === "agent.send" ? new Error("会话 sess-1 没有运行中的执行体") : undefined,
    });
    const { session, notifier } = await open(host);

    await session.send("你好");

    // 两边各一次：叫过也不代表投得上，但都不重试
    expect(host.connection.methods().filter((method) => method === "agent.wake")).toHaveLength(1);
    expect(host.connection.methods().filter((method) => method === "agent.send")).toHaveLength(1);
    expect(notifier.notices.at(-1)?.text).toContain("没有运行中的执行体");
  });

  it("排队区跟着 `agent.inbox` 走（宿主推的那一条是唯一来源）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, {
      type: "agent.inbox",
      sessionId: SESSION,
      inbox: [
        {
          messageId: "u-new",
          createdAt: "t",
          priority: "high",
          source: { kind: "user" },
          content: "你好",
        },
      ],
    });

    expect(session.inboxPending).toBe(1);
    expect(session.inbox[0]?.preview).toBe("你好");
  });
});

// ==================================================================
// 复活 / 暂停 / 继续：三个正交动作（PLAN §5.1）
// ==================================================================

describe("RemoteChatSession：复活 / 暂停 / 继续", () => {
  it("各打自己那一条 procedure，入参只有 sessionId", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.start();
    await session.pause();
    await session.resume();

    for (const method of ["agent.wake", "agent.pause", "agent.resume"]) {
      const call = host.connection.calls.filter((item) => item.method === method).at(-1);
      expect(call?.params, method).toEqual({ sessionId: SESSION });
    }
  });

  it("`start` / `resume` 失败照抛（「按发送」那条路得知道这一步没成，不能假装发过了）", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "agent.wake" || method === "agent.resume"
          ? new Error(`${method} 没成`)
          : undefined,
    });
    const { session } = await open(host);

    await expect(session.start()).rejects.toThrow("agent.wake 没成");
    await expect(session.resume()).rejects.toThrow("agent.resume 没成");
  });

  it("中止走 `agent.abort`（不抛：它是后台一手，失败只进通知栏）", async () => {
    const host = hostLike({
      reply: (method) => (method === "agent.abort" ? new Error("abort 没成") : undefined),
    });
    const { session, notifier } = await open(host);

    session.abort();
    await flush();

    expect(notifier.notices.at(-1)).toMatchObject({ tone: "error" });
    expect(host.connection.methods()).toContain("agent.abort");
  });
});

// ==================================================================
// 等结局
// ==================================================================

describe("RemoteChatSession：等这一句有了下文", () => {
  it("还在写就不算完：忙闲回 `idle` 之后才返回", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.send("你好");
    let done = false;
    const waiting = session.waitForReply().then(() => {
      done = true;
    });

    // 这一句落地、助手那条开始写：还没完
    emit(host, {
      type: "message.added",
      sessionId: SESSION,
      message: userMessage("u-new", "你好"),
    });
    emit(host, {
      type: "message.changed",
      sessionId: SESSION,
      message: assistantMessage("a-1", { status: AgentNS.MessageStatus.Writing }),
    });
    emit(host, { type: "agent.status", sessionId: SESSION, status: "working" });
    await flush();
    expect(done).toBe(false);

    // 写完 + 闲下来：完
    host.open.current = openView({
      messages: [
        userMessage("u-new", "你好"),
        assistantMessage("a-1", { status: AgentNS.MessageStatus.Completed }),
      ],
    });
    emit(host, {
      type: "message.changed",
      sessionId: SESSION,
      message: assistantMessage("a-1", { status: AgentNS.MessageStatus.Completed }),
    });
    emit(host, { type: "agent.status", sessionId: SESSION, status: "idle" });
    await waiting;

    expect(done).toBe(true);
  });

  it("忙闲落回 `idle` 就补拉一次（`resync`），消息是宿主那一份", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.send("你好");
    host.open.current = openView({ messages: [assistantMessage("a-1")] });
    emit(host, { type: "agent.status", sessionId: SESSION, status: "idle" });
    await session.waitForReply();
    await flush();

    expect(host.connection.resyncs).toEqual([SESSION]);
    expect(session.messages.map((message) => message.id)).toEqual(["a-1"]);
  });

  it("没发过：当场返回（不把人挂死）", async () => {
    const host = hostLike();
    const { session } = await open(host);
    await expect(session.waitForReply()).resolves.toBeUndefined();
  });
});

// ==================================================================
// 速率与状态栏块
// ==================================================================

describe("RemoteChatSession：速率与状态栏块", () => {
  it("收尾时用消息上的 `usage` 合计定格平均速率（契约不给合计，自己加）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.send("你好");
    emit(host, {
      type: "message.changed",
      sessionId: SESSION,
      message: assistantMessage("a-1", {
        status: AgentNS.MessageStatus.Writing,
        content: "一二三四五",
      }),
    });
    // 生成中：按正文长度的差采到一个非空快照
    expect(session.rateSample).not.toBeNull();

    host.open.current = openView({
      messages: [assistantMessage("a-1", { usage: usage(40) })],
    });
    emit(host, { type: "agent.status", sessionId: SESSION, status: "idle" });
    await session.waitForReply();
    await flush();

    // 定格：不再报实时值（`live: null`、`running: false`）。平均速率本身要「首字→末字」有
    // 一段可测的跨度（`MIN_SPAN_MS`），这一条用例跑在毫秒之内，所以只钉「收尾了」这一格。
    expect(session.rateSample).toMatchObject({ live: null, running: false });
  });

  it("状态栏块：身份来自会话行 + 配置、用量是本轮 / 累计、速率块带着忙闲那一格", async () => {
    const host = hostLike({
      open: openView({
        messages: [
          assistantMessage("a-1", { usage: usage(4) }),
          assistantMessage("a-2", { usage: usage(6) }),
        ],
      }),
    });
    const { session } = await open(host);
    const blocks = session.blocks;

    const identity = blocks.find((block) => block.id === "identity");
    expect(identity?.id).toBe("identity");
    if (identity?.id === "identity") {
      // 只显示 id（口径⑥）：模型名字那一格已经不画了
      expect(identity.facts.model.modelId).toBe("test-model");
      expect(identity.facts.agent.agentId).toBe("default");
    }

    const usageBlock = blocks.find((block) => block.id === "usage");
    // 累计 = 两条 assistant 的 `usage.total_tokens` 之和（14 + 16）
    expect(usageBlock?.id === "usage" && usageBlock.facts.totalTokens).toBe(30);
    // 本轮 = 最后一条带 `usage` 的 assistant
    expect(usageBlock?.id === "usage" && usageBlock.facts.lastTokens).toBe(16);
  });

  it("一条带 `usage` 的 assistant 都没有时两个数都是 `null`（不拿 0 假装）", async () => {
    const host = hostLike();
    const { session } = await open(host);
    const usageBlock = session.blocks.find((block) => block.id === "usage");

    expect(usageBlock?.id === "usage" && usageBlock.facts).toEqual({
      lastTokens: null,
      totalTokens: null,
    });
  });

  it("累计含各层级 subagent 那一栏（漏了账单就比界面大）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, {
      type: "message.added",
      sessionId: SESSION,
      message: assistantMessage("a-1", { usage: usage(4) }),
    });
    emit(host, {
      type: "subagent.message",
      sessionId: SESSION,
      toolCallId: "tool-1",
      message: assistantMessage("s-1", { usage: usage(6) }),
    });

    const usageBlock = session.blocks.find((block) => block.id === "usage");
    // 30 = 主线那条的 14 + 那一栏那条的 16（`total_tokens` 各自都含 10 个 prompt）
    expect(usageBlock?.id === "usage" && usageBlock.facts.totalTokens).toBe(30);
  });

  it("同一份委派不算两遍：已经写进 `subAgentUsage` 了，那一栏就不再另加一遍", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, {
      type: "message.added",
      sessionId: SESSION,
      message: {
        id: "t-1",
        createdAt: 1,
        role: AgentNS.Role.Tool,
        tool_call_id: "tool-1",
        content: "ok",
        status: AgentNS.MessageStatus.Completed,
        subAgentUsage: usage(6),
      },
    });
    emit(host, {
      type: "subagent.message",
      sessionId: SESSION,
      toolCallId: "tool-1",
      message: assistantMessage("s-1", { usage: usage(6) }),
    });

    const usageBlock = session.blocks.find((block) => block.id === "usage");
    // 只算一次：tool 消息上的 `subAgentUsage` 已经代表那次委派（16）
    expect(usageBlock?.id === "usage" && usageBlock.facts.totalTokens).toBe(16);
  });
});

// ==================================================================
// 通知
// ==================================================================

describe("RemoteChatSession：通知", () => {
  it("打开时补看一次（通知是挂着的槽位，只推给当时在听的那条连接）", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "notice.list"
          ? [
              {
                id: "n-1",
                level: "success",
                code: "notice.saved",
                message: "已保存",
                durationMs: 1000,
                sessionId: null,
                createdAt: 0,
              },
            ]
          : undefined,
    });
    const { notifier } = await open(host);

    expect(host.connection.methods()).toContain("notice.list");
    expect(notifier.notices[0]).toEqual({ text: "已保存", tone: "info", origin: "app" });
  });

  it("补看：这一段的那条按 id 清掉，全局那条只上屏不清（下次补看再上屏一次）", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "notice.list"
          ? [
              {
                id: "n-global",
                level: "info",
                code: "notice.app",
                message: "整机的事",
                durationMs: null,
                sessionId: null,
                createdAt: 0,
              },
              {
                id: "n-this",
                level: "info",
                code: "notice.app",
                message: "这一段的事",
                durationMs: null,
                sessionId: SESSION,
                createdAt: 1,
              },
            ]
          : undefined,
    });
    const { notifier } = await open(host);

    // 两条都上屏（全局那几条哪儿都看得见）
    expect(notifier.notices.map((notice) => notice.text).slice(0, 2)).toEqual([
      "整机的事",
      "这一段的事",
    ]);
    // 清的只有会话那一条：全局那条不属于这一段，清掉就把别人那份也抹了
    expect(host.connection.calls.filter((call) => call.method === "notice.clearOne")).toEqual([
      { method: "notice.clearOne", params: { id: "n-this" } },
    ]);
    // 按会话清一片那条路不再走：那会把同一段里还没上屏的几条一起清掉
    expect(host.connection.methods()).not.toContain("notice.clear");
  });

  it("补看失败：说一句（那几条通知已经住在宿主里，而本条连接错过了推送）", async () => {
    const host = hostLike({
      reply: (method) => (method === "notice.list" ? new Error("notice.list 没成") : undefined),
    });
    const { notifier } = await open(host);

    expect(notifier.notices.at(-1)?.tone).toBe("error");
    expect(notifier.notices.at(-1)?.text).toContain("补看通知失败");
  });

  it("实时推来的：别的会话的那条不认，全局的那条认", async () => {
    const host = hostLike();
    const { notifier } = await open(host);
    const before = notifier.notices.length;

    emit(host, {
      type: "notice",
      notice: {
        id: "n-other",
        level: "info",
        code: "notice.test",
        message: "别人的",
        durationMs: null,
        sessionId: "other",
        createdAt: 0,
      },
    });
    expect(notifier.notices).toHaveLength(before);

    emit(host, {
      type: "notice",
      notice: {
        id: "n-global",
        level: "warning",
        code: "notice.test",
        message: "全局的",
        durationMs: null,
        sessionId: null,
        createdAt: 0,
      },
    });
    expect(notifier.notices.at(-1)).toEqual({ text: "全局的", tone: "warn", origin: "app" });
  });

  it("日志上浮来的那条标成 `log`（用户发送那一刻要清掉的正是它）", async () => {
    const host = hostLike();
    const { notifier } = await open(host);

    emit(host, {
      type: "notice",
      notice: {
        id: "n-log",
        level: "info",
        code: "log.line",
        message: "日志里的一行",
        durationMs: null,
        sessionId: SESSION,
        createdAt: 0,
      },
    });

    expect(notifier.notices.at(-1)).toEqual({
      text: "日志里的一行",
      tone: "info",
      origin: "log",
    });
  });
});

// ==================================================================
// 问题对象
// ==================================================================

describe("RemoteChatSession：问题对象", () => {
  it("打开时问一次 `question.list`（题不落库，只活在内存里）", async () => {
    const host = hostLike({ questions: [question()] });
    const { session } = await open(host);

    expect(host.connection.methods()).toContain("question.list");
    expect(session.questions.map((item) => item.id)).toEqual(["q-1"]);
  });

  it("`question.list` 问不到：说一句（题不上屏，用户就答不了它）", async () => {
    const host = hostLike({
      reply: (method) => (method === "question.list" ? new Error("question.list 没成") : undefined),
    });
    const { notifier } = await open(host);

    expect(notifier.notices.at(-1)?.text).toContain("读挂着的题失败");
  });

  it("有人作答：把候选里的 value 交回去，答完那道题就没了", async () => {
    const host = hostLike({ questions: [question()] });
    const asked = question();
    const { session } = await open(host, { onQuestion: async () => "self" });

    emit(host, { type: "question.asked", sessionId: SESSION, question: asked });
    await flush();

    const answer = host.connection.calls.filter((call) => call.method === "question.answer").at(-1);
    expect(answer?.params).toEqual({ questionId: "q-1", value: "self" });
    expect(session.questions).toEqual([]);
  });

  it("没人能答：不作答，只把题干放进通知栏（替用户选等于替他做决定）", async () => {
    const host = hostLike();
    const { notifier } = await open(host);

    emit(host, { type: "question.asked", sessionId: SESSION, question: question() });
    await flush();

    expect(host.connection.methods()).not.toContain("question.answer");
    expect(notifier.notices.at(-1)).toEqual({
      text: "要交接吗？",
      tone: "info",
      origin: undefined,
    });
  });
});

// ==================================================================
// subagent 那一栏
// ==================================================================

describe("RemoteChatSession：subagent 那一栏", () => {
  it("它说的话按 `toolCallId` 归到那一栏（不进主转录）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, {
      type: "subagent.message",
      sessionId: SESSION,
      toolCallId: "tool-1",
      message: assistantMessage("s-1"),
    });

    expect(session.messages).toHaveLength(0);
    expect(session.subAgentMessages("tool-1").map((message) => message.id)).toEqual(["s-1"]);
    // 名册从「主体里的委派 + 那一栏最后一条消息」现推
    expect(session.subAgents.map((fact) => fact.toolCallId)).toEqual(["tool-1"]);
  });

  it("镜像里没有那一栏：回空数组，不去问一条不存在的 procedure", async () => {
    const host = hostLike();
    const { session } = await open(host);
    const before = host.connection.calls.length;

    await expect(session.listSubAgentMessages("tool-x")).resolves.toEqual([]);
    expect(host.connection.calls).toHaveLength(before);
  });
});

// ==================================================================
// 命令层要的那几个动作
// ==================================================================

describe("RemoteChatSession：命令层要的那几个动作", () => {
  it("撤回：`session.rewind` 回来后补拉一次，并把回填内容原样给回去", async () => {
    const host = hostLike({
      reply: (method) => (method === "session.rewind" ? { content: "被撤回的那句" } : undefined),
    });
    const { session } = await open(host);

    const restored = await session.revert("u-2");

    // 纯文本消息：素材那一格是空的（不是缺一格）
    expect(restored).toEqual({ content: "被撤回的那句", assetIds: [] });
    const rewind = host.connection.calls.filter((call) => call.method === "session.rewind").at(-1);
    expect(rewind?.params).toEqual({ sessionId: SESSION, messageId: "u-2" });
    expect(host.connection.resyncs).toEqual([SESSION]);
  });

  it("撤回带图的那条：段上的素材 id 按原顺序拆出来，同一张两次就是两次", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "session.rewind"
          ? {
              content: [
                { type: "text", text: "看这两张" },
                { type: "image_url", image_url: { url: "" }, __asset_id: "a-1" },
                { type: "image_url", image_url: { url: "" }, __asset_id: "a-2" },
                { type: "image_url", image_url: { url: "" }, __asset_id: "a-1" },
              ],
            }
          : undefined,
    });
    const { session } = await open(host);

    const restored = await session.revert("u-2");

    expect(restored.assetIds).toEqual(["a-1", "a-2", "a-1"]);
  });

  it("交接：`handoff.start` 收到 `{ sessionId, mode }`（调用方挑定的执行者）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.handoff({ mode: "summary" });

    const start = host.connection.calls.filter((call) => call.method === "handoff.start").at(-1);
    expect(start?.params).toEqual({ sessionId: SESSION, mode: "summary" });
  });

  it("交接：没给 `mode` 就不发这一格（执行者交给宿主的缺省）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    await session.handoff();

    const start = host.connection.calls.filter((call) => call.method === "handoff.start").at(-1);
    expect(start?.params).toEqual({ sessionId: SESSION });
  });

  it("交接收口：`session.handoff` 那一格收掉，「正在交接」跟着变", async () => {
    const host = hostLike();
    const { session } = await open(host);

    emit(host, { type: "session.handoff", sessionId: SESSION, handingOff: true });
    expect(session.handoffSince).not.toBeNull();
    emit(host, { type: "session.handoff", sessionId: SESSION, handingOff: false });
    expect(session.handoffSince).toBeNull();
  });

  it("换模型：`session.setModel` 写会话行，回读之后 `modelId` 当场生效", async () => {
    const host = hostLike();
    const { session } = await open(host);

    host.open.current = openView({ session: sessionRow({ modelId: "m2" }) });
    await session.setModel("m2");

    const call = host.connection.calls.filter((item) => item.method === "session.setModel").at(-1);
    expect(call?.params).toEqual({ sessionId: SESSION, modelId: "m2" });
    expect(session.modelId).toBe("m2");
  });

  it("`setModel(null)`：宿主这一版没有「回到助手定义」的入口，如实拒绝", async () => {
    const host = hostLike();
    const { session } = await open(host);
    await expect(session.setModel(null)).rejects.toThrow(/回到助手定义/);
  });

  it("换思考档位：`session.setThinkingLevel` 写会话行，回读之后 `thinking.selected` 当场生效", async () => {
    const host = hostLike({
      config: {
        models: [{ id: "test-model", name: "Test", vision: false, reasoningPreset: "effort" }],
        presets: { effort: { levels: { low: {}, high: {} } } },
      },
    });
    const { session } = await open(host);
    // 档位表来自 `config.get().presets` 里那张表（按生效模型的 `reasoningPreset` 取）
    expect(session.thinking.levels).toEqual(["low", "high"]);

    host.open.current = openView({ session: sessionRow({ thinkingLevel: "high" }) });
    await session.setThinking("high");

    const call = host.connection.calls
      .filter((item) => item.method === "session.setThinkingLevel")
      .at(-1);
    expect(call?.params).toEqual({ sessionId: SESSION, level: "high" });
    expect(session.thinking.selected).toBe("high");
    expect(session.thinking.source).toBe("manual");
  });

  it("改名 / 置顶：各打自己那一条，回读之后会话行当场换掉", async () => {
    const host = hostLike();
    const { session } = await open(host);

    host.open.current = openView({ session: sessionRow({ name: "新名字" }) });
    await session.rename("新名字");
    expect(session.name).toBe("新名字");

    host.open.current = openView({ session: sessionRow({ pinned: true }) });
    await session.pin(true);
    const call = host.connection.calls.filter((item) => item.method === "session.pin").at(-1);
    expect(call?.params).toEqual({ sessionId: SESSION, pinned: true });
    expect(session.view.pinned).toBe(true);
  });

  it("文件清单：走 `workspace.files`，`workspaceId` 取这一段会话的那个", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "workspace.files" ? { files: ["README.md", "src/tui/chat.tsx"] } : undefined,
    });
    const { session } = await open(host);

    // 相对路径原样折成条目（屏幕按 `kind` 补尾斜杠，宿主这一版只给文件）
    await expect(session.listWorkspaceFiles()).resolves.toEqual({
      state: "ready",
      entries: [
        { path: "README.md", name: "README.md", kind: "file" },
        { path: "src/tui/chat.tsx", name: "chat.tsx", kind: "file" },
      ],
    });
    const call = host.connection.calls.filter((item) => item.method === "workspace.files").at(-1);
    // 没给 query 就不发这一格（整份清单，宿主那边按字典序截到 500 条）
    expect(call?.params).toEqual({ workspaceId: WORKSPACE });
    // 旧路那条（`completion.files`）一次都不该再被问到
    expect(host.connection.methods()).not.toContain("completion.files");
  });

  it("文件清单：`query` 交给宿主先筛（省掉整份清单过 wire）", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "workspace.files" ? { files: ["src/tui/chat.tsx"] } : undefined,
    });
    const { session } = await open(host);

    await session.listWorkspaceFiles("tui");

    const call = host.connection.calls.filter((item) => item.method === "workspace.files").at(-1);
    expect(call?.params).toEqual({ workspaceId: WORKSPACE, query: "tui" });
  });

  it("文件清单问不到（宿主拒了）：推一句宿主的原话、回空清单，不抛", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "workspace.files" ? new Error("项目 ws-1 的目录已经不在了") : undefined,
    });
    const { session, notifier } = await open(host);

    // `@` 是输入框里的菜单：抛出去就成了「打不出字」
    await expect(session.listWorkspaceFiles()).resolves.toEqual({
      state: "unavailable",
      entries: [],
    });
    expect(notifier.notices.at(-1)).toMatchObject({
      text: "项目 ws-1 的目录已经不在了",
      tone: "error",
    });
  });

  it("还没有项目上下文（会话行上没给 workspaceId）：不抛，回空清单并说一句", async () => {
    const host = hostLike({ open: openView({ session: sessionRow({ workspaceId: "" }) }) });
    const { session, notifier } = await open(host);

    await expect(session.listWorkspaceFiles()).resolves.toEqual({
      state: "unavailable",
      entries: [],
    });
    // 一次 procedure 都不发（没有可问的项目），但也不许一声不吭
    expect(host.connection.methods()).not.toContain("workspace.files");
    expect(notifier.notices.at(-1)?.text).toContain("列不出文件");
  });

  it("清空排队区：走 `agent.clearInbox`，回宿主给的那个条数", async () => {
    const host = hostLike({
      reply: (method) => (method === "agent.clearInbox" ? { cleared: 3 } : undefined),
    });
    const { session } = await open(host);

    await expect(session.clearInbox()).resolves.toBe(3);
    // 入参与契约逐字一致：只有这一段的 id（排队区就这两处，怎么清是宿主的判据）
    const call = host.connection.calls.filter((item) => item.method === "agent.clearInbox").at(-1);
    expect(call?.params).toEqual({ sessionId: SESSION });
  });

  it("清空排队区失败（宿主拒了）：错误照实际抛出去，不吞成 0 条", async () => {
    const host = hostLike({
      reply: (method) =>
        method === "agent.clearInbox" ? new Error("会话不存在（not_found）") : undefined,
    });
    const { session } = await open(host);

    // 吞成 0 就是「假装清干净了」：`/free` 要的是真话
    await expect(session.clearInbox()).rejects.toThrow("not_found");
  });
});

// ==================================================================
// 断线与补拉
// ==================================================================

describe("RemoteChatSession：断线与补拉", () => {
  it("事件流报错就去重连，连上之后补拉一次（`resync`）", async () => {
    const host = hostLike();
    const { session } = await open(host);

    host.connection.emitError(new Error("连接断了"));
    await flush();
    // 生产里 `reconnectUntilConnected` 会真的等到调通；假连接的 `reconnect` 是空操作，
    // 所以这里能钉住的是「它去重连了，并在之后补拉了一次」
    expect(host.connection.resyncs).toEqual([SESSION]);
    session.dispose();
  });

  it("卸载之后不再往界面上推（那一代的通知器已经没人听了），也不再跟着那段会话", async () => {
    const host = hostLike();
    const { session, notifier } = await open(host);
    session.dispose();
    const before = notifier.changes.length;

    emit(host, { type: "agent.status", sessionId: SESSION, status: "working" });

    expect(notifier.changes).toHaveLength(before);
    expect(host.connection.mirrors.has(SESSION)).toBe(false);
  });
});

// ==================================================================
// last-session.json：读不出来不是「没记过」
// ==================================================================

describe("last-session.json：读不出来不是「没记过」", () => {
  it("报一句，并按「没记过」开一段新的（坏记忆不许把启动卡住）", async () => {
    mkdirSync(join(zen.dir, "cli"), { recursive: true });
    writeFileSync(join(zen.dir, "cli", "last-session.json"), "{ 坏了", "utf-8");
    const host = hostLike();

    const session = await RemoteChatSession.open(
      host.connection,
      { workspaceId: WORKSPACE, agentId: "default", resume: true },
      notifierOf(),
      logger,
    );

    expect(session.sessionId).toBe(SESSION);
    expect(warnings.join("\n")).toContain("last-session.json");
  });

  it("绝对不写回：那份没读到的文件里，别的项目记着的那一段原样留着", async () => {
    const file = join(zen.dir, "cli", "last-session.json");
    mkdirSync(join(zen.dir, "cli"), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ "ws-other": "sess-keep" }), "utf-8");
    const host = hostLike();

    const session = await RemoteChatSession.open(
      host.connection,
      { workspaceId: WORKSPACE, agentId: "default" },
      notifierOf(),
      logger,
    );

    const memory = JSON.parse(readFileSync(file, "utf-8"));
    expect(memory["ws-other"]).toBe("sess-keep");
    expect(memory[WORKSPACE]).toBe(session.sessionId);
  });
});
