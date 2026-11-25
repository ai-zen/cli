// 命令层回归：表驱动的那 22 条命令在**假连接 + 假会话**上的行为。
//
// 这一层最容易错的地方是「写错层 / 写错地方」，而它错得很安静 —— 界面说「改好了」，请求里
// 还是旧的，或者撤回成功了屏幕却一片空白。所以这份文件钉的是四类：
//
//   · 每条命令**只调一个契约方法**，入参形状与宿主 `wire` 一致（会话域走会话层，其余走 `call`）；
//   · `/model` `/think` `/agent` 各自写到哪一层（会话行 / AgentDefinition / 全局兜底），谁需要 reload；
//   · `/back` `/new` `/migrate` 之后转录显示起点必须跟着重置（否则 `slice()` 恒为空）；
//   · 失败只有一个出口：宿主拒绝是一条通知，不是一条未处理的 rejection。
//
// 真宿主的行为（排序、可用性、降级、引用检查）由宿主用例覆盖，客户端一份都不重复覆盖。
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import { QUIET_LOG } from "../test-support/log.js";
import { moveAfterGone, runCommand, type ChatCommandHost } from "./handlers.js";
import { getCommandHints } from "./registry.js";
import type {
  AgentDefinition,
  AppConfig,
  EndpointDefinition,
  McpEntry,
  ModelDefinition,
  ReasoningPresets,
} from "../config.js";
import type {
  ChatSessionLike,
  HostConnection,
  NoticeTone,
  ScopeReloadReport,
  SessionSnapshot,
} from "../session/types.js";
import type { LiveSession } from "../sessions-registry.js";
import { useTempAiZenDir } from "../test-support/temp-dir.js";
import { setLocale, t } from "../i18n/index.js";

/**
 * 独立的临时 `AI_ZEN_DIR`：`/lang` 会把语言偏好写盘。
 */
const zen = useTempAiZenDir("aiz-cmd-test-");
beforeEach(() => {
  zen.pin();
  // 断言的是中文文案（消息词典），锁死语言，不受环境 LANG 影响
  setLocale("zh");
});
afterAll(() => zen.cleanup());

// ==================== 假连接 / 假会话 ====================

/** 一次契约调用的记录：断言「调了哪个方法、给了什么入参」 */
interface CallRecord {
  method: string;
  params: Record<string, unknown>;
}

type Routes = Record<string, (params: Record<string, unknown>) => unknown>;

/**
 * 造一个只认「调一个方法」的连接口。
 *
 * 打桩按方法名登记，**没登记就抛** —— 这样「命令偷偷调了第二个方法」会当场红，
 * 而不是靠断言调用次数去猜。
 */
function fakeCall(routes: Routes, calls: CallRecord[]): HostConnection["call"] {
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    const route = routes[method];
    if (!route) throw new Error(`用例没给 ${method} 打桩`);
    return route(params);
  };
  return call as unknown as HostConnection["call"];
}

/**
 * 会话域 / 工作区域**直连**的那一面（`api`）：与 {@link fakeCall} 共用同一张路由表。
 *
 * 路径按 `Proxy` 拼成 procedure 名（`api.workspace.list.query` → `"workspace.list"`），于是
 * 「打了哪条」在两种路上是同一套名字、同一份 `calls`。
 */
function fakeApi(routes: Routes, calls: CallRecord[]): HostConnection["api"] {
  const make = (path: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, property: string) {
        if (property === "query" || property === "mutate") {
          const method = path.join(".");
          return async (params: Record<string, unknown> = {}) => {
            calls.push({ method, params });
            const route = routes[method];
            if (!route) throw new Error(`用例没给 ${method} 打桩`);
            return route(params);
          };
        }
        return make([...path, property]);
      },
    });
  return make([]) as HostConnection["api"];
}

/** 一个模型（`tokenThresholds` 是契约必填，用例不关心具体数值） */
function modelView(
  id: string,
  name: string,
  overrides: Partial<ModelDefinition> = {},
): ModelDefinition {
  return {
    id,
    name,
    endpointId: "ep-main",
    tokenThresholds: { handoff: 1000, guard: 2000 },
    defaultParams: {},
    ...overrides,
  };
}

const ENDPOINT: EndpointDefinition = {
  id: "ep-main",
  name: "主端点",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-live-1234",
  capabilities: { filesApi: false },
};

function configView(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoints: [ENDPOINT],
    models: [modelView("m1", "模型一"), modelView("m2", "模型二")],
    imageModels: [],
    defaultAgent: "default",
    ...overrides,
  };
}

/** 档位表：`effort` 那一族两档，模型用它来指（`reasoningPreset`） */
function presetsView(): ReasoningPresets {
  return {
    effort: {
      levels: {
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" },
      },
    },
  };
}

function agentView(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "default",
    name: "默认 Agent",
    messages: [],
    modelId: "m1",
    modelParams: {},
    custom: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

/** `mcp.list` 的一行：这一条 + 它写在哪一层 */
function mcpEntry(scope: McpEntry["scope"], server: McpEntry["server"]): McpEntry {
  return { scope, server };
}

function discoveryView(): { servers: McpEntry[] } {
  return {
    servers: [mcpEntry("workspaceAiZen", { id: "pty", transport: "stdio", command: "npx" })],
  };
}

/**
 * 一段会话的完整视图（宿主 `SessionView`）。
 *
 * 类型直接按方法表取（`MethodResult<"session.get">`），不在这里重写一份：`/pin` 读与写的那两个
 * 方法回的 `{ session }` 都是它，字段一改这份用例就编译不过。
 */
function sessionView(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "sess-1",
    workspaceId: "ws-1",
    name: "会话一",
    nameSource: "user",
    pinned: false,
    agentId: "default",
    modelId: "m1",
    thinkingLevel: null,
    handoffThreshold: null,
    guardThreshold: null,
    autoHandoff: false,
    lineage: null,
    // 时间一律 epoch 毫秒（新宿主的口径）
    createdAt: Date.parse("2026-10-01T00:00:00.000Z"),
    updatedAt: Date.parse("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

const MCP_ENTRY: McpEntry = {
  scope: "workspaceAiZen",
  server: {
    id: "chrome",
    transport: "stdio",
    command: "npx",
    args: ["chrome-devtools-mcp@latest"],
  },
};

/**
 * 会话假件：**只造命令层真正读的那几个字段**（其余成员由 `ChatSessionLike` 的实现提供，
 * 命令层一个都不碰）。所以这里能直接用，而不是逐个补空。
 */
interface SessionStub {
  agentId: string;
  sessionId: string;
  name: string;
  workspaceId: string;
  currentWorkspaceId: string;
  selectWorkspace: (workspaceId: string) => void;
  messages: AgentNS.Message[];
  model: { modelId: string; name: string; vision: boolean; source: "agent" | "session" };
  modelId: string;
  /** 忙闲那一格（`null` = 读数还没回来；`/model` `/think` 忙时那一问看它） */
  status: "working" | "idle" | null;
  /** 死活那一格：这一段此刻有没有 agent（`/kill` 的代价与「已经是死的」那一支看它） */
  alive: boolean | null;
  /** 排队条数（`/kill` 说「几条会作废」看它；会话那边 = `inbox.length`） */
  inboxPending: number;
  thinking: ChatSessionLike["thinking"];
  reset: () => Promise<string>;
  reload: () => Promise<ScopeReloadReport>;
  updateModel: (modelId: string | null) => Promise<void>;
  updateThinkingLevel: (level: string | null) => Promise<void>;
  rewind: (messageId: string) => Promise<{ content: AgentNS.MessageContent; assetIds?: string[] }>;
  handoff: (options: { mode?: string; kind?: string }) => Promise<void>;
  clearInbox: () => Promise<number>;
  rename: (name: string) => Promise<void>;
}

function sessionStub(overrides: Partial<SessionStub> = {}): SessionStub {
  const thinking: ChatSessionLike["thinking"] = {
    preset: "effort",
    levels: ["low", "high"],
    selected: null,
    source: "following_default",
    params: {},
  };
  return {
    agentId: "default",
    sessionId: "sess-1",
    name: "第一段",
    // 会话行那一份（`sessionLabel` 读它：名字的来源与建行时刻都在这上面）
    view: sessionView({ id: "sess-1", name: "第一段" }),
    workspaceId: "ws-1",
    currentWorkspaceId: "ws-1",
    selectWorkspace: vi.fn(),
    messages: [
      { id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "第一条" },
      { id: "a-1", createdAt: 2, role: AgentNS.Role.Assistant, content: "答一" },
      { id: "u-2", createdAt: 3, role: AgentNS.Role.User, content: "第二条" },
    ],
    model: { modelId: "m1", name: "模型一", vision: false, source: "agent" },
    modelId: "m1",
    // 缺省「不知道忙不忙」：要验忙时那一问的用例自己改成 `working`
    status: null,
    // 缺省这一段有 agent、排队区是空的（`/kill` 那一组按需覆盖）
    alive: true,
    inboxPending: 0,
    thinking,
    reset: vi.fn(async () => "sess-2"),
    // 缺省：宿主那边一份容器、刷成了（`/reload` 那组按需覆盖成三档）
    reload: vi.fn(async () => ({ total: 1, refreshed: 1, failed: [] })),
    updateModel: vi.fn(async () => {}),
    updateThinkingLevel: vi.fn(async () => {}),
    rewind: vi.fn(async () => ({ content: "第二条" })),
    handoff: vi.fn(async () => undefined),
    clearInbox: vi.fn(async () => 0),
    rename: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * 缺省打桩：一条「哪都能问一句」的路由表，单个用例按需覆盖。
 *
 * 配置域这一刀的读口都换了名字：模型表在 `config.get` 里、AgentDefinition 是 `agentDefinition.*`、
 * MCP 是 `mcp.list`（每条带 `scope`）。
 */
function baseRoutes(): Routes {
  return {
    "config.get": () => ({ config: configView(), presets: presetsView() }),
    "config.defaults.update": () => ({ config: configView() }),
    "config.agents.get": () => ({ definition: agentView() }),
    "config.agents.list": () => [agentView()],
    "config.agents.update": () => ({ definition: agentView() }),
    // `session.list` 的出参是会话行数组（顺序宿主排好：置顶优先 + 创建时间倒序）
    "session.list": () => [
      sessionView({ id: "sess-1", name: "会话一" }),
      sessionView({ id: "sess-2", name: "会话二" }),
    ],
    "config.mcp.list": () => discoveryView(),
    // `/kill` 的回执只有会话 id（宿主那边的 Agent 销毁没有别的可报）
    "runtime.agent.kill": (params) => ({ sessionId: params.sessionId }),
    // 缺省按真宿主的样子回：收到的那几格写进整份配置再交回来
    "config.update": (params) => ({ config: configView(params as Partial<AppConfig>) }),
  };
}

function createHost(
  options: {
    session?: Partial<SessionStub>;
    routes?: Routes;
    /** 这次连的是哪台宿主（`/ws` 靠它分辨本机与远端）；缺省本机 */
    workspaceHost?: ChatCommandHost["workspaceHost"];
    /** 本进程挂着的会话（`/sessions` 的两处数据之一，缺省一段也没有） */
    liveSessions?: LiveSession[];
  } = {},
): {
  host: ChatCommandHost;
  session: SessionStub;
  calls: CallRecord[];
  notices: Array<{ text: string; tone?: NoticeTone }>;
} {
  const notices: Array<{ text: string; tone?: NoticeTone }> = [];
  const calls: CallRecord[] = [];
  const session = sessionStub(options.session);
  const host: ChatCommandHost = {
    session: session as unknown as ChatSessionLike,
    call: fakeCall({ ...baseRoutes(), ...options.routes }, calls),
    // 会话域 / 工作区域直连的那一面：与 `call` 走同一张路由表，于是「打了哪条」照旧可断言
    api: fakeApi({ ...baseRoutes(), ...options.routes }, calls),
    workspaceHost: options.workspaceHost ?? { local: true, key: "local" },
    // 日志出口：`/ws` 记工作区、`/lang` 写偏好两处失败的去处（这一组不关心它们说了什么）
    logger: QUIET_LOG,
    notice: (text, tone) => notices.push({ text, tone }),
    clearTranscript: vi.fn(),
    exit: vi.fn(),
    suspendTerminal: async (fn: () => void | Promise<void>) => {
      await fn();
    },
    openWizard: vi.fn(async () => {}),
    openKeyEditor: vi.fn(async () => {}),
    // 「让这个端点的密钥就位」：缺省「配不上」（`/model` 那组用例按需覆写成 `true`）
    ensureKey: vi.fn(async () => false),
    doExit: vi.fn(async () => {}),
    // 覆盖层入口是一个**异步口**（命令层拿不到 React setter）：默认「没人作答」，
    // 需要作答的用例自己替换它。
    pick: vi.fn(async () => null),
    // 换会话的两个口子（`/new` / `/sessions`）：会话归进程所有（PRD D4），命令层只说「换成哪一段」
    newSession: vi.fn(async () => "conv-new"),
    liveSessions: options.liveSessions ?? [],
    // `/delete` 删完之后把这一段从登记里摘掉（注册表的口子；这一组只看它调没调、传的哪一段）
    dropSession: vi.fn(),
    // 「这一次删除是我自己叫的」：`/delete` / `/ws delete` 真删之前报个名（这里只记账，不放行）
    expectOwnRemoval: vi.fn(() => () => {}),
    setInputText: vi.fn(),
    setEffortView: vi.fn(),
    refreshLocale: vi.fn(),
  };
  return { host, session, calls, notices };
}

/** 接管选择器：记下标题 / 标签 / 提示 / 值并立即作答（不真弹覆盖层） */
function capturePick(host: ChatCommandHost, answer: string | null) {
  const seen = {
    title: "",
    labels: [] as string[],
    hints: [] as (string | undefined)[],
    // `value` 也记一份：有些项的值是命令层自己定的哨兵（比如「清掉」），用例要从这儿取回来，
    // 而不是把哨兵值在用例里再写一遍
    values: [] as string[],
  };
  host.pick = async (title, items) => {
    seen.title = title;
    seen.labels = items.map((item) => item.label);
    seen.hints = items.map((item) => item.hint);
    seen.values = items.map((item) => item.value);
    return answer;
  };
  return seen;
}

/** 多级选择器：按顺序把答案交回去，并把每一级看到的东西记下来 */
function capturePicks(host: ChatCommandHost, answers: Array<string | null>) {
  const seen: Array<{
    title: string;
    labels: string[];
    hints: (string | undefined)[];
    values: string[];
  }> = [];
  let index = 0;
  host.pick = async (title, items) => {
    seen.push({
      title,
      labels: items.map((item) => item.label),
      hints: items.map((item) => item.hint),
      values: items.map((item) => item.value),
    });
    return answers[index++] ?? null;
  };
  return seen;
}

const texts = (notices: Array<{ text: string }>) => notices.map((n) => n.text).join("\n");
const methods = (calls: CallRecord[]) => calls.map((call) => call.method);

// ==================== /new ====================

describe("/new：开新的一段，不打断当前那一段", () => {
  it("向注册表要一段新的（不要原地 `reset`），并带着一句话换屏过去", async () => {
    const { host, session, notices } = createHost();

    await runCommand("new", "/new", host);

    // 开新会话的路走注册表：原地 `adopt` 会把这一段会话挪到新会话上，旧那段就丢订阅了
    expect(host.newSession).toHaveBeenCalledTimes(1);
    expect(host.clearTranscript).not.toHaveBeenCalled();
    // 换屏时把「已开始新会话」带到新屏（旧屏的通知栏跟着卸载了）
    expect(host.exit).toHaveBeenCalledWith({
      load: { sessionId: "conv-new" },
      notice: t("cmd.new.started"),
    });
    // 走重挂载这一支就不会再就地弹一句话（新屏会自己说）
    expect(notices).toEqual([]);
    // 当前那一段的会话一个方法都没被叫：没在它身上开新会话，也没被 dispose
    expect(session.reset).not.toHaveBeenCalled();
  });
});

// ==================== /sessions ====================

/** 本进程挂着的一段会话（`/sessions` 列表里来自注册表的那一半） */
function live(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId: "sess-1",
    name: "当前这段",
    status: "working",
    alive: true,
    phaseText: t("phase.thinking"),
    inboxPending: 0,
    // 这一段是几点开的（`SessionView.createdAt`）
    // 用本地时刻构造：`clockOf` 按时区换算，写死 UTC 串会让这条用例在别的时区红
    createdAt: new Date(2026, 9, 1, 9, 30).toISOString(),
    ...overrides,
  };
}

/** 本地时刻构造成的 epoch 毫秒（列表里「{time} 更新」那一格按时区换算，写死 UTC 串会跨时区红） */
const at = (hour: number, minute: number) => new Date(2026, 9, 1, hour, minute).getTime();

describe("/sessions：列会话与切换", () => {
  /**
   * 名字那一格按**来源**写：占位名（`default`）不该把库里的 ISO 时刻串直接上屏，存档（`handoff`）
   * 要和它抄自的那一段区分得开 —— 两者的名字本来就一模一样。
   */
  it("名字按来源写：占位名说「新会话 + 时刻」，存档名标一句「存档」", async () => {
    const { host } = createHost({
      routes: {
        "session.list": () => [
          sessionView({
            id: "sess-a",
            name: "2026-11-25T08:44:30.609Z",
            nameSource: "default",
            createdAt: at(9, 30),
          }),
          sessionView({ id: "sess-b", name: "重构交接", nameSource: "handoff" }),
          sessionView({ id: "sess-c", name: "自动起的名", nameSource: "auto" }),
        ],
      },
    });
    const seen = capturePick(host, null);

    await runCommand("sessions", "/sessions", host);

    expect(seen.labels).toEqual([
      t("cmd.sessions.untitled", { time: "09:30" }),
      t("cmd.sessions.archived", { name: "重构交接" }),
      "自动起的名",
    ]);
  });

  it("行从 `session.list` 来（按当前项目）；状态那一格只说本进程订阅着的那一段，其余不猜", async () => {
    const { host, calls } = createHost({
      liveSessions: [live({ inboxPending: 2 })],
      routes: {
        // 宿主按项目列，顺序也是它排好的（置顶优先 + 创建时间倒序）；这里原样交给命令层
        "session.list": () => [
          sessionView({ id: "sess-1", name: "当前这段", updatedAt: at(9, 30) }),
          sessionView({ id: "sess-2", name: "另一段", pinned: true, updatedAt: at(8, 0) }),
          sessionView({
            id: "7f3c9a10b2e4",
            name: "长 id 那段",
            modelId: null,
            updatedAt: at(7, 5),
          }),
        ],
      },
    });
    const seen = capturePick(host, null);

    await runCommand("sessions", "/sessions", host);

    // 一次 `session.list`，带当前项目（不再走旧那套 `{ sessions, total }`）
    expect(calls).toEqual([{ method: "session.list", params: { workspaceId: "ws-1" } }]);
    expect(seen.labels).toEqual(["当前这段（当前）", "另一段", "长 id 那段"]);
    // 本进程订阅着的那一段：忙闲/在忙什么、排队条数都说得出（然后是 id、模型、更新时刻）
    expect(seen.hints[0]).toBe(
      [
        t("phase.thinking"),
        t("cmd.sessions.inboxPending", { n: 2 }),
        "sess-1",
        t("cmd.sessions.model", { id: "m1" }),
        t("cmd.sessions.updated", { time: "09:30" }),
      ].join(" · "),
    );
    // 这一边没挂着的那两段：**状态那一格一个字不说**（不把「不知道」写成「在忙」/「空闲」）
    expect(seen.hints[1]).toBe(
      [
        t("cmd.sessions.pinned"),
        "sess-2",
        t("cmd.sessions.model", { id: "m1" }),
        t("cmd.sessions.updated", { time: "08:00" }),
      ].join(" · "),
    );
    // id 长的时候只印前 8 个字符（不加省略号：那 8 个字符可以直接当 `/kill` 的前缀用）
    expect(seen.hints[2]).toBe(
      ["7f3c9a10", t("cmd.sessions.noModel"), t("cmd.sessions.updated", { time: "07:05" })].join(
        " · ",
      ),
    );
  });

  it("`--all` / `-a`：客户端编排（`workspace.list` + 逐个 `session.list`），合并后置顶优先 + 最后活动时刻倒序，每行带项目名", async () => {
    for (const flag of ["--all", "-a"]) {
      const { host, calls } = createHost({
        routes: {
          "workspace.list": () => [
            workspaceRow("ws-1", "/p1", "项目一"),
            workspaceRow("ws-2", "/p2", "项目二"),
          ],
          // 每个项目内部是宿主排好的；拼起来的那一份没人替你排
          "session.list": (params) =>
            params.workspaceId === "ws-1"
              ? [
                  sessionView({
                    id: "sess-new",
                    name: "本项目新会话",
                    createdAt: at(9, 0),
                    updatedAt: at(9, 0),
                  }),
                  sessionView({
                    id: "sess-1",
                    name: "当前这段",
                    createdAt: at(8, 0),
                    updatedAt: at(8, 0),
                  }),
                ]
              : [
                  sessionView({
                    id: "sess-9",
                    name: "别处的置顶会话",
                    workspaceId: "ws-2",
                    pinned: true,
                    createdAt: at(7, 0),
                    updatedAt: at(7, 0),
                  }),
                ],
        },
      });
      const seen = capturePick(host, null);

      await runCommand("sessions", `/sessions ${flag}`, host);

      expect(methods(calls)).toEqual(["workspace.list", "session.list", "session.list"]);
      // 置顶的在最前（不管它属于哪个项目），其余新的在前
      expect(seen.labels).toEqual(["别处的置顶会话", "本项目新会话", "当前这段（当前）"]);
      // 跨项目时每一行都说得出自己属于哪个项目
      expect(seen.hints[0]).toContain(t("cmd.sessions.workspace", { name: "项目二" }));
      expect(seen.hints[1]).toContain(t("cmd.sessions.workspace", { name: "项目一" }));
    }
  });

  it("活动时间压过创建时间：老会话刚聊过就排在前面", async () => {
    const { host } = createHost({
      routes: {
        "workspace.list": () => [workspaceRow("ws-1", "/p1", "项目一")],
        // 项目内部已由宿主排好 —— 这里就是「排好的」那一个样子：先建的后动过
        "session.list": () => [
          sessionView({
            id: "sess-old",
            name: "上周建的",
            createdAt: at(7, 0),
            updatedAt: at(9, 0),
          }),
          sessionView({
            id: "sess-new",
            name: "今早建的",
            createdAt: at(8, 0),
            updatedAt: at(8, 0),
          }),
        ],
      },
    });
    const seen = capturePick(host, null);

    await runCommand("sessions", "/sessions --all", host);

    expect(seen.labels).toEqual(["上周建的", "今早建的"]);
    // 行上那个时刻读的也是活动那一刻，不是建行那一刻
    expect(seen.hints[0]).toContain(t("cmd.sessions.updated", { time: "09:00" }));
    expect(seen.hints[1]).toContain(t("cmd.sessions.updated", { time: "08:00" }));
  });

  it("选中即切：把选中那段交给重挂载（不碰任何会话的生死）", async () => {
    const { host, session } = createHost({
      liveSessions: [live(), live({ sessionId: "sess-2", name: "另一段", phaseText: null })],
      routes: {
        "session.list": () => [
          sessionView({ id: "sess-1", name: "当前这段" }),
          sessionView({ id: "sess-2", name: "另一段" }),
        ],
      },
    });
    capturePick(host, "sess-2");

    await runCommand("sessions", "/sessions", host);

    expect(host.exit).toHaveBeenCalledWith({ load: { sessionId: "sess-2" } });
    // 命令层不往任何会话里插手（不 abort、不 dispose）
    expect(session.reset).not.toHaveBeenCalled();
  });

  it("选中当前那一段：只说一声，不重挂载", async () => {
    const { host, notices } = createHost({
      liveSessions: [live(), live({ sessionId: "sess-2", name: "另一段" })],
      routes: {
        "session.list": () => [
          sessionView({ id: "sess-1", name: "当前这段" }),
          sessionView({ id: "sess-2", name: "另一段" }),
        ],
      },
    });
    capturePick(host, "sess-1");

    await runCommand("sessions", "/sessions", host);

    expect(host.exit).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.sessions.already"));
  });

  it("Esc / 取消：只说一声，不换屏", async () => {
    const { host, notices } = createHost({
      routes: {
        "session.list": () => [
          sessionView({ id: "sess-1", name: "当前这段" }),
          sessionView({ id: "sess-2", name: "另一段" }),
        ],
      },
    });
    capturePick(host, null);

    await runCommand("sessions", "/sessions", host);

    expect(host.exit).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.sessions.cancelled"));
  });

  it("只有当前这一段：给一句人话，不弹只有一行的选择器", async () => {
    const { host, notices } = createHost({
      liveSessions: [live()],
      routes: { "session.list": () => [sessionView({ id: "sess-1", name: "当前这段" })] },
    });
    // `pick` 被调到就是错：只有一行的选择器等于让用户确认一件已经成立的事
    const pick = vi.fn(async () => null);
    host.pick = pick;

    await runCommand("sessions", "/sessions", host);

    expect(pick).not.toHaveBeenCalled();
    expect(host.exit).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.sessions.onlyOne"));
  });

  it("一条都没有：给一句能照着做的话（项目里 / 整台宿主两种口径）", async () => {
    const here = createHost({ routes: { "session.list": () => [] } });
    await runCommand("sessions", "/sessions", here.host);
    expect(texts(here.notices)).toBe(t("cmd.sessions.none"));
    expect(here.host.pick).not.toHaveBeenCalled();

    const everywhere = createHost({
      routes: { "workspace.list": () => [workspaceRow("ws-1", "/p1")], "session.list": () => [] },
    });
    await runCommand("sessions", "/sessions --all", everywhere.host);
    expect(texts(everywhere.notices)).toBe(t("cmd.sessions.noneAll"));
  });

  it("死掉的那一段也在列表里（切过去只是看，要发话才会重新叫起来）", async () => {
    const { host } = createHost({
      // 本进程挂着的这一段，宿主已经把它收了（`agent.alive` 报 false）
      liveSessions: [live({ alive: false, status: null, phaseText: null })],
      routes: {
        "session.list": () => [
          sessionView({ id: "sess-1", name: "当前这段" }),
          sessionView({ id: "sess-2", name: "另一段" }),
        ],
      },
    });
    const seen = capturePick(host, null);

    await runCommand("sessions", "/sessions", host);

    expect(seen.labels).toEqual(["当前这段（当前）", "另一段"]);
    expect(seen.hints[0]).toContain(t("cmd.sessions.dead"));
    // 死活那一格说得出来就不说忙闲（人都没了，谈不上忙）
    expect(seen.hints[0]).not.toContain(t("cmd.sessions.idle"));
  });

  it("别名 /ps 与 /sessions 是同一条（斜杠菜单也只列一次）", async () => {
    const { host } = createHost({ liveSessions: [live()] });
    const pick = vi.fn(async () => null);
    host.pick = pick;

    await runCommand("ps", "/ps", host);

    const hints = getCommandHints().filter((hint) => hint.names.includes("sessions"));
    expect(hints).toHaveLength(1);
    expect(hints[0]!.label).toBe("/sessions /ps");
  });
});

// ==================== /back ====================

describe("/back：按消息 id 撤回，内容回填输入框", () => {
  it("只列用户消息、最近的在最前，选中的是**消息 id** 不是下标", async () => {
    const { host, session } = createHost();
    const seen = capturePick(host, "u-1");

    await runCommand("back", "/back", host);

    expect(seen.labels).toEqual(["第二条", "第一条"]);
    expect(session.rewind).toHaveBeenCalledWith("u-1");
  });

  it("撤回后重挂载：带上此刻的会话 id、宿主那份消息、以及被撤回的内容", async () => {
    /**
     * 宿主的撤回会真的把消息砍短（`session.rewind` + 重取），所以这里让假会话也砍：
     * 「删掉几条」这个数是从撤前撤后两次长度里算出来的，不是从选择结果里抄的。
     */
    const messages: AgentNS.Message[] = [
      { id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "第一条" },
      { id: "a-1", createdAt: 2, role: AgentNS.Role.Assistant, content: "答一" },
      { id: "u-2", createdAt: 3, role: AgentNS.Role.User, content: "第二条" },
      { id: "a-2", createdAt: 4, role: AgentNS.Role.Assistant, content: "答二" },
    ];
    const { host, session, notices } = createHost({
      session: {
        messages,
        rewind: vi.fn(async () => {
          // 撤到 `u-2` 之前：它自己与它之后那条都没了
          messages.splice(2);
          return { content: "第二条" };
        }),
      },
    });
    capturePick(host, "u-2");

    await runCommand("back", "/back", host);

    expect(host.exit).toHaveBeenCalledWith({
      restart: true,
      sessionId: session.sessionId,
      messages: session.messages,
      initialInput: "第二条",
      // 不带图的消息：Asset 那一格是空的（不是缺一格）
      initialAssetIds: [],
      // 两件事实带到新屏上：删掉几条、那句话已经回到输入框
      notice: t("cmd.back.done", { n: 2 }),
    });
    // 旧屏的通知栏跟着卸载了，所以这句话不能只在本地 push
    expect(notices).toEqual([]);
  });

  it("带图的那条：素材按原顺序跟着回填一起交回输入框", async () => {
    const { host } = createHost({
      session: {
        // 段上的本地标记就是 `__asset_id`（`user-content.ts` 写它的那个词）：同一张图
        // 出现两次就是两次，不去重
        rewind: vi.fn(async () => ({
          content: [
            { type: "text" as const, text: "看这两张" },
            { type: "image_url" as const, image_url: { url: "" }, __asset_id: "a-1" },
            { type: "image_url" as const, image_url: { url: "" }, __asset_id: "a-2" },
            { type: "image_url" as const, image_url: { url: "" }, __asset_id: "a-1" },
          ],
          assetIds: ["a-1", "a-2", "a-1"],
        })),
      },
    });
    capturePick(host, "u-1");

    await runCommand("back", "/back", host);

    expect(host.exit).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput: "看这两张",
        initialAssetIds: ["a-1", "a-2", "a-1"],
      }),
    );
  });

  it("取消选择：不调撤回、不重挂载", async () => {
    const { host, session, notices } = createHost();
    capturePick(host, null);

    await runCommand("back", "/back", host);

    expect(session.rewind).not.toHaveBeenCalled();
    expect(host.exit).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.back.cancelled"));
  });

  it("没有用户消息：报「还没有可撤回的消息」，不弹选择器", async () => {
    const { host, notices } = createHost({ session: { messages: [] } });

    await runCommand("back", "/back", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.back.empty"));
  });

  it("候选一条不丢：怎么滚动是渲染层的事，命令层把全部消息都交上去", async () => {
    const messages = Array.from({ length: 20 }, (_v, index) => ({
      id: `u-${index}`,
      createdAt: index,
      role: AgentNS.Role.User,
      content: `第 ${index} 条`,
    }));
    const { host } = createHost({ session: { messages } });
    const seen = capturePick(host, null);

    await runCommand("back", "/back", host);

    expect(seen.labels).toHaveLength(20);
  });

  /**
   * 旧写法 `/revert` 退成别名：名字换了、能力一样（`session.revert` + 回填 `restoredInput`）。
   */
  it("`/revert` 是别名：落到同一个处理器", async () => {
    const { host, session } = createHost();
    capturePick(host, "u-1");

    await runCommand("revert", "/revert", host);

    expect(session.rewind).toHaveBeenCalledWith("u-1");
  });
});

// ==================== /load ====================

describe("/load：列表来自 session.list，选中后换会话", () => {
  it("按当前项目问列表，读的是宿主给的顺序（不自己排）", async () => {
    const { host, calls } = createHost();
    const seen = capturePick(host, null);

    await runCommand("load", "/load", host);

    expect(calls).toEqual([{ method: "session.list", params: { workspaceId: "ws-1" } }]);
    expect(seen.labels).toEqual(["会话一（当前）", "会话二"]);
  });

  it("`--all` / `-a`：宿主没有「全库列会话」这条口，客户端自己编排（`workspace.list` + 逐个 `session.list`）", async () => {
    for (const flag of ["--all", "-a"]) {
      const { host, calls } = createHost({
        routes: {
          "workspace.list": () => [workspaceRow("ws-1", "/p1"), workspaceRow("ws-2", "/p2")],
        },
      });
      capturePick(host, null);

      await runCommand("load", `/load ${flag}`, host);

      // 每个工作区各问一次（`workspaceId` 是必填的），一个也不漏
      expect(calls).toEqual([
        { method: "workspace.list", params: {} },
        { method: "session.list", params: { workspaceId: "ws-1" } },
        { method: "session.list", params: { workspaceId: "ws-2" } },
      ]);
    }
  });

  it("`--all`：合起来按「置顶优先 + 创建时间倒序」重排，每条带上自己属于哪个工作区", async () => {
    const at = (minutes: number) => Date.parse("2026-10-01T00:00:00.000Z") + minutes * 60_000;
    const { host } = createHost({
      routes: {
        "workspace.list": () => [workspaceRow("ws-1", "/p1"), workspaceRow("ws-2", "/p2")],
        // 每个工作区内部已经是宿主排好的顺序；拼起来的那一份没人替你排
        "session.list": (params) =>
          params.workspaceId === "ws-1"
            ? [
                sessionView({ id: "sess-new", name: "本项目新会话", createdAt: at(30) }),
                sessionView({ id: "sess-1", name: "本项目旧会话", createdAt: at(10) }),
              ]
            : [
                sessionView({
                  id: "sess-9",
                  name: "别处的置顶会话",
                  workspaceId: "ws-2",
                  pinned: true,
                  createdAt: at(20),
                }),
              ],
      },
    });
    const seen = capturePick(host, null);

    await runCommand("load", "/load --all", host);

    // 置顶的在最前，其余按创建时间倒序（跨项目也成立）
    expect(seen.labels).toEqual(["别处的置顶会话", "本项目新会话", "本项目旧会话（当前）"]);
    // 重名分得开：每一条的 hint 上是它自己那个工作区
    expect(seen.hints).toEqual([
      t("cmd.load.hintAll", { workspace: "ws-2", id: "sess-9" }),
      t("cmd.load.hintAll", { workspace: "ws-1", id: "sess-new" }),
      t("cmd.load.hintAll", { workspace: "ws-1", id: "sess-1" }),
    ]);
    // 标题也说明了这一次列的是所有工作区
    expect(seen.title).toBe(t("cmd.load.titleAll", { n: 24 }));
  });

  it("`--all` 但宿主上一个工作区也没有：同样报「还没有会话」，不弹选择器", async () => {
    const { host, calls, notices } = createHost({ routes: { "workspace.list": () => [] } });

    await runCommand("load", "/load --all", host);

    expect(methods(calls)).toEqual(["workspace.list"]);
    expect(host.pick).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.load.none"));
  });

  it("不带 `--all` 时只看这一段自己的项目（一次 session.list，不问 workspace.list）", async () => {
    const { host, calls } = createHost();
    capturePick(host, null);

    await runCommand("load", "/load", host);

    expect(calls).toEqual([{ method: "session.list", params: { workspaceId: "ws-1" } }]);
  });

  it("选中后交给上层换会话（只给 id，消息与助手定义由新的会话自己取）", async () => {
    const { host } = createHost();
    capturePick(host, "sess-2");

    await runCommand("load", "/load", host);

    expect(host.exit).toHaveBeenCalledWith({ load: { sessionId: "sess-2" } });
  });

  it("交接另起的那段存档会话出现在候选里（列表每次现问 `session.list`，不缓存）", async () => {
    // 交接前：这一段
    let sessions = [sessionView({ id: "sess-1", name: "原会话" })];
    const { host } = createHost({ routes: { "session.list": () => sessions } });

    // 交接换记忆之后，宿主那边多出「已存档_原会话」（`session.changed` 的 `created` 只说这件事
    // 发生了；内容靠这一次 `session.list` 拿回来）
    sessions = [
      sessionView({ id: "sess-arch", name: "已存档_原会话" }),
      sessionView({ id: "sess-1", name: "原会话" }),
    ];
    const seen = capturePick(host, null);

    await runCommand("load", "/load", host);

    // 顺序是宿主给的（存档按它自己的创建时间排），命令层只摊开
    expect(seen.labels).toEqual(["已存档_原会话", "原会话（当前）"]);
  });

  it("没有会话：报「还没有会话」，不弹选择器", async () => {
    const { host, notices } = createHost({ routes: { "session.list": () => [] } });

    await runCommand("load", "/load", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.load.none"));
  });

  /**
   * 候选一条不丢：装不下由选择器自己滚动（视窗在 `SelectList`），命令层不再截断、也不再
   * 在标题里报「只显示最近 N 条」。
   */
  it("会话很多也全部交给选择器（不截断，标题不再说「只显示前几条」）", async () => {
    const many = Array.from({ length: 20 }, (_v, index) =>
      sessionView({ id: `sess-${index}`, name: `会话 ${index}` }),
    );
    const { host } = createHost({ routes: { "session.list": () => many } });
    const seen = capturePick(host, null);

    await runCommand("load", "/load", host);

    expect(seen.labels).toHaveLength(20);
    expect(seen.title).toBe(t("cmd.load.titleReplacing"));
  });

  it("`--all` 一样全量交上去，标题说清「所有工作区」", async () => {
    const many = Array.from({ length: 20 }, (_v, index) =>
      sessionView({ id: `sess-${index}`, name: `会话 ${index}` }),
    );
    const { host } = createHost({
      routes: {
        "workspace.list": () => [workspaceRow("ws-1", "/p1")],
        "session.list": () => many,
      },
    });
    const seen = capturePick(host, null);

    await runCommand("load", "/load --all", host);

    expect(seen.labels).toHaveLength(20);
    expect(seen.title).toBe(t("cmd.load.titleAll"));
  });
});

// ==================== 忙时禁用（`needsIdle`） ====================

/**
 * 「这一段正在跑」时哪几条命令不可用，以及**为什么**其余照旧可用。
 *
 * 判据表在 `registry.ts`（`CommandMeta.needsIdle`），门在 `runCommand` 入口。这一组钉两件事：
 *
 *   1. 那五条**一个字节都不写**（不弹选择器、不发 procedure、也不问「要不要现在试」）——
 *      `/back` `/handoff` `/migrate` 宿主本来就会拒，`/model` `/think` 则是**一批内部换家**
 *      （写会话行当场生效，下一轮请求就换模型与思考参数）；
 *   2. 会话的**新建与切换**不受影响：它们不动运行中的那一段，这正是「忙也能干的事」。
 */
describe("忙时禁用", () => {
  it("`/back` 处理中不可用：不弹选择器，一个 procedure 都不发", async () => {
    const { host, calls, notices } = createHost({
      session: {
        status: "working",
        messages: [{ id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "第一句" }],
      },
    });

    await runCommand("back", "/back", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(texts(notices)).toBe(t("cmd.needsIdle", { name: "/back" }));
  });

  it("`/handoff` 与 `/migrate` 处理中不可用：宿主本来就会拒，别让人先走完选择器", async () => {
    for (const [name, raw] of [
      ["handoff", "/handoff"],
      ["migrate", "/migrate"],
    ] as const) {
      const { host, calls, notices } = createHost({
        session: {
          status: "working",
          messages: [{ id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "第一句" }],
        },
      });

      await runCommand(name, raw, host);

      expect(calls).toEqual([]);
      expect(texts(notices)).toBe(t("cmd.needsIdle", { name: `/${name}` }));
    }
  });

  it("`/new` 忙时照旧可用（新开一段不动运行中的那一段）", async () => {
    const { host, calls } = createHost({ session: { status: "working" } });

    await runCommand("new", "/new", host);

    expect(host.newSession).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("`/clear` 忙时照旧可用（只清屏，上下文一个字不动）", async () => {
    const { host } = createHost({ session: { status: "working" } });

    await runCommand("clear", "/clear", host);

    expect(host.clearTranscript).toHaveBeenCalledTimes(1);
  });

  it("`/ws` 忙时照旧可用（换的是「下一个新会话开在哪」）", async () => {
    const { host, notices } = createHost({
      session: { status: "working" },
      routes: { "workspace.list": () => [workspaceRow("ws-1", "/p1")] },
    });
    const seen = capturePick(host, "ws-1");

    await runCommand("ws", "/ws", host);

    // 没被那道门拦住：选择器真弹了，也确实切了
    expect(seen.values).toEqual(["ws-1"]);
    expect(texts(notices)).toContain(t("cmd.ws.switched", { name: "ws-1", path: "/p1" }));
  });
});

// ==================== /pin ====================

/**
 * `/pin` 只碰 `pinned` 一个字段：列表怎么排（置顶优先 + 创建时间倒序）是宿主的事，
 * 这批用例钉的就是「调了哪个方法、入参什么形状、上屏用的是谁给的句子」。
 *
 * 读写两条都在 procedure 面上：现状读 `session.open`（那一条同时给出会话行），写入是
 * `session.pin`，它回**改完之后**的那一行。
 */
describe("/pin：仅生成 pinned 一个字段，顺序归宿主", () => {
  it("无参：先从 `session.open` 读现状，再按相反值写（入参与宿主 procedure 逐字一致）", async () => {
    const { host, calls, notices } = createHost({
      routes: {
        // `session.open` 出参：会话行 + Agent（`null` = 这一段没有 Agent）+ 消息 + 排队区
        "session.open": () => ({
          session: sessionView({ pinned: false }),
          live: null,
          messages: [],
          inbox: [],
        }),
        // 回来的名字故意与请求前不同：上屏那句话必须用宿主回来那份
        "session.pin": () => ({
          session: sessionView({ pinned: true, name: "周报汇总" }),
        }),
      },
    });

    await runCommand("pin", "/pin", host);

    // 现状只有宿主知道：读一次（`session.open` 的 `session.pinned`）、写一次（写的是反过来的那个值）
    expect(calls).toEqual([
      { method: "session.open", params: { sessionId: "sess-1" } },
      { method: "session.pin", params: { sessionId: "sess-1", pinned: true } },
    ]);
    expect(notices.at(-1)).toEqual({ text: t("cmd.pin.done", { name: "周报汇总" }), tone: "info" });
  });

  it("已经置顶时无参：写 pinned: false，报「已取消置顶」", async () => {
    const { host, calls, notices } = createHost({
      routes: {
        "session.open": () => ({
          session: sessionView({ pinned: true }),
          live: null,
          messages: [],
          inbox: [],
        }),
        "session.pin": () => ({ session: sessionView({ pinned: false }) }),
      },
    });

    await runCommand("pin", "/pin", host);

    expect(calls.at(-1)).toEqual({
      method: "session.pin",
      params: { sessionId: "sess-1", pinned: false },
    });
    expect(texts(notices)).toBe(t("cmd.pin.undone", { name: "会话一" }));
  });

  it("写了 on / off 就只跑一个往返（不多读一次现状）", async () => {
    const { host, calls } = createHost({
      routes: {
        "session.pin": (params) => ({
          session: sessionView({ pinned: params.pinned as boolean }),
        }),
      },
    });

    await runCommand("pin", "/pin on", host);
    await runCommand("pin", "/pin off", host);

    // `session.open` 故意没打桩：多读一次现状会当场炸在这里
    expect(calls).toEqual([
      { method: "session.pin", params: { sessionId: "sess-1", pinned: true } },
      { method: "session.pin", params: { sessionId: "sess-1", pinned: false } },
    ]);
  });

  it("参数非法：一个方法都不调，报出可选值", async () => {
    const { host, calls, notices } = createHost();

    await runCommand("pin", "/pin maybe", host);

    expect(calls).toEqual([]);
    expect(notices.at(-1)).toEqual({
      text: t("cmd.pin.unknown", { value: "maybe" }),
      tone: "error",
    });
  });

  it("宿主拒绝：走 runCommand 的兜底出口，不炸进程", async () => {
    const { host, notices } = createHost({
      routes: {
        "session.pin": () => {
          throw new Error("connection lost");
        },
      },
    });

    await runCommand("pin", "/pin on", host);

    expect(notices.at(-1)).toEqual({
      text: t("cmd.failed", { name: "pin", error: "connection lost" }),
      tone: "error",
    });
  });
});

// ==================== /model ====================

/**
 * AgentDefinition 级思考档位那两趟读：定义本身（`modelParams` 存的是**展开后的参数**）+ 档位表。
 *
 * 档位由客户端拿表反查（`reasoning-effort.ts` 的 `agentThinkingOf`），所以模型必须挂着
 * `reasoningPreset`，否则「不可调档」—— 那也是一种事实，另有用例守它。
 */
function effortRoutes(definition: AgentDefinition) {
  const config = configView({
    models: [modelView("m1", "模型一", { reasoningPreset: "effort" }), modelView("m2", "模型二")],
  });
  return {
    "config.get": () => ({ config, presets: presetsView() }),
    "config.agents.get": () => ({ definition }),
    "config.agents.update": () => ({ definition }),
  };
}

describe("/model：三档作用级别各写各的那一层", () => {
  it("默认（会话级）：写会话行，不 reload、不重挂载", async () => {
    const { host, session, calls, notices } = createHost();

    await runCommand("model", "/model m2", host);

    expect(session.updateModel).toHaveBeenCalledWith("m2");
    // 只有「读模型表」这一次往返（`config.get` 一次给全），没有顺手改 AgentDefinition 或全局兜底
    expect(methods(calls)).toEqual(["config.get"]);
    // 会话级写完宿主就回完整视图，再 reload 是白跑一个往返
    expect(session.reload).not.toHaveBeenCalled();
    expect(host.exit).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({
      text: t("cmd.model.done", { scope: t("cmd.model.scope.session"), name: "模型二", id: "m2" }),
      tone: "info",
    });
  });

  it("--agent / -a：写助手定义，并按新定义重建这段会话", async () => {
    const { host, session, calls, notices } = createHost();

    await runCommand("model", "/model -a m2", host);

    expect(calls).toContainEqual({
      method: "config.agents.update",
      params: { agentId: "default", change: { modelId: "m2" } },
    });
    expect(session.updateModel).not.toHaveBeenCalled();
    // 定义变了：活着的这段会话要按新定义重建，状态栏与下一轮的请求才会跟上
    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)!.text).toBe(
      t("modelSwitch.summary", {
        name: "模型二",
        id: "m2",
        agent: "default",
        hint: t("modelSwitch.resetHint"),
      }),
    );
  });

  it("--global / -g：仅生成全局兜底（`defaultModel`），同样要重建会话", async () => {
    const { host, session, calls, notices } = createHost();

    await runCommand("model", "/model --global m2", host);

    expect(calls).toContainEqual({
      method: "config.defaults.update",
      params: { defaultModel: "m2" },
    });
    expect(session.updateModel).not.toHaveBeenCalled();
    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)!.text).toBe(
      t("cmd.model.done", { scope: t("cmd.model.scope.global"), name: "模型二", id: "m2" }),
    );
  });

  it("未知模型：一档都不写，只报错并列出可选项", async () => {
    const { host, session, calls, notices } = createHost();

    await runCommand("model", "/model -a nope", host);

    expect(methods(calls)).toEqual(["config.get"]);
    expect(session.updateModel).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.model.unknown", { id: "nope", options: "m1 / m2" }));
  });

  it("已经是这一档的模型：不写、不 reload，说清模型其实来自哪一档", async () => {
    // 生效模型 m1 来自 AgentDefinition（`source: "agent"`），用户 `/model m1`
    const { host, session, calls, notices } = createHost();

    await runCommand("model", "/model m1", host);

    expect(session.updateModel).not.toHaveBeenCalled();
    expect(session.reload).not.toHaveBeenCalled();
    // 只有「读模型表」这一次往返：来源那一格是会话自己给的（`model.source`），
    // 不再为此多问一次 `agentDefinition.get`
    expect(methods(calls)).toEqual(["config.get"]);
    expect(texts(notices)).toBe(
      t("cmd.model.already", { scope: t("cmd.model.scope.agent"), id: "m1" }),
    );
  });

  it("选择器两级：先选供应商（带模型数），再选那一家底下的模型", async () => {
    const { host } = createHost();
    const seen = capturePicks(host, ["ep-main", "m2"]);

    await runCommand("model", "/model", host);

    expect(seen).toHaveLength(2);

    // 第一级：只列有模型的端点，当前生效模型所在那家标「当前」，提示是这一家的模型数
    expect(seen[0]!.title).toBe(
      t("cmd.model.endpointTitle", {
        scope: t("cmd.model.scope.session"),
        level: t("cmd.model.scope.agent"),
      }),
    );
    expect(seen[0]!.labels).toEqual([`主端点${t("common.current")}`]);
    expect(seen[0]!.hints).toEqual([t("cmd.model.endpointHint", { count: 2 })]);

    // 第二级：这一家的模型；标题带上供应商名，进去之后也知道自己在哪一家
    expect(seen[1]!.title).toBe(
      t("cmd.model.title", {
        scope: t("cmd.model.scope.session"),
        level: t("cmd.model.scope.agent"),
        endpoint: "主端点",
      }),
    );
    expect(seen[1]!.labels).toEqual([`模型一${t("common.current")}`, "模型二"]);
    // 新契约里没有 `available` / `unavailableReason` 这一格：提示不编「不可用」，
    // 只说它是哪个 id（要判能不能跑得问宿主）
    expect(seen[1]!.hints).toEqual(["m1", "m2"]);
  });

  it("供应商那一级取消：整体取消，一个字节都不写", async () => {
    const { host, session, notices } = createHost();
    capturePicks(host, [null]);

    await runCommand("model", "/model", host);

    expect(texts(notices)).toBe(t("cmd.model.cancelled"));
    expect(session.updateModel).not.toHaveBeenCalled();
  });

  it("端点顺序跟配置走，只列有模型的那几家", async () => {
    const second: EndpointDefinition = { ...ENDPOINT, id: "ep-other", name: "另一家" };
    const empty: EndpointDefinition = { ...ENDPOINT, id: "ep-empty", name: "空端点" };
    const { host } = createHost({
      routes: {
        "config.get": () => ({
          config: configView({
            endpoints: [second, empty, ENDPOINT],
            models: [
              modelView("m1", "模型一"),
              modelView("m3", "模型三", { endpointId: "ep-other" }),
            ],
          }),
          presets: presetsView(),
        }),
      },
    });
    const seen = capturePicks(host, [null]);

    await runCommand("model", "/model", host);

    // 配置里的顺序是「另一家、空端点、主端点」；空端点没有模型，不该出现在一级里。
    // 「当前」跟着生效模型（m1 在主端点）走
    expect(seen[0]!.labels).toEqual(["另一家", `主端点${t("common.current")}`]);
  });

  it("配置里没有模型：报错并指路 /config", async () => {
    const { host, notices } = createHost({
      routes: { "config.get": () => ({ config: configView({ models: [] }), presets: {} }) },
    });

    await runCommand("model", "/model", host);

    expect(texts(notices)).toBe(t("cmd.model.noModels"));
    expect(host.pick).not.toHaveBeenCalled();
  });

  /**
   * 忙时**整条命令不可用**（`CommandMeta.needsIdle`）：不弹选择器、不写会话行、也不问「要不要现在试」。
   *
   * 为什么从「问一句」改成「禁用」：宿主对 `session.updateModel` / `updateThinkingLevel` **不设**
   * 忙闲守卫，写下去当场生效，下一轮请求立刻换家 —— 一批内部换模型，工具调用格式与思考参数都可能
   * 对不上（另一处注释自己写着「旧模型的参数发给新模型 → 端点 400」）。问一句只会把这件事变成
   * 「用户点了确认，然后拿到一个错位的结果」。
   */
  it("这一段在忙：整条 `/model` 不可用，一个字节都不写、也不弹选择器", async () => {
    const { host, session, calls, notices } = createHost({ session: { status: "working" } });

    await runCommand("model", "/model m2", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(session.updateModel).not.toHaveBeenCalled();
    // 连模型表都不读：门在入口，命令体根本没进去
    expect(calls).toEqual([]);
    expect(texts(notices)).toBe(t("cmd.needsIdle", { name: "/model" }));
  });

  it("闲下来之后同一条 `/model` 照旧能用（门只看忙闲那一格）", async () => {
    const { host, session } = createHost();

    await runCommand("model", "/model m2", host);

    expect(session.updateModel).toHaveBeenCalledWith("m2");
  });
});

/**
 * `/model` 切到「供应商还没配密钥」的模型。
 *
 * 判据与首启引导、`/key` 是同一个（`resolveCredential` 看那端点密钥空不空），修复入口
 * 是同一屏（`ensureKey`）。这里钉两件事：**没配成就不切**，配成了才照常切。
 */
describe("/model：供应商没配密钥时先配，配不成就不切", () => {
  /** 一个「模型在它上面、密钥还空着」的端点 */
  const bareConfig = () =>
    configView({
      endpoints: [ENDPOINT, { ...ENDPOINT, id: "ep-bare", name: "裸端点", apiKey: "" }],
      models: [modelView("m1", "模型一"), modelView("m2", "模型二", { endpointId: "ep-bare" })],
    });

  const routes = () => ({
    "config.get": () => ({ config: bareConfig(), presets: presetsView() }),
  });

  it("用户放弃配密钥：一个字节都不写，并说清是没钥匙", async () => {
    const { host, session, calls, notices } = createHost({ routes: routes() });

    await runCommand("model", "/model m2", host);

    expect(host.ensureKey).toHaveBeenCalledWith("ep-bare");
    expect(session.updateModel).not.toHaveBeenCalled();
    expect(methods(calls)).toEqual(["config.get"]);
    expect(texts(notices)).toBe(
      [
        t("cmd.model.keyMissing", { endpoint: "裸端点" }),
        t("cmd.model.keyCancelled", { model: "模型二", endpoint: "裸端点" }),
      ].join("\n"),
    );
  });

  it("配好了钥匙：照常切（密钥那一步不吞掉原本的动作）", async () => {
    const { host, session } = createHost({ routes: routes() });
    host.ensureKey = vi.fn(async () => true);

    await runCommand("model", "/model m2", host);

    expect(host.ensureKey).toHaveBeenCalledWith("ep-bare");
    expect(session.updateModel).toHaveBeenCalledWith("m2");
  });

  it("密钥本来就配好了：不问那一屏，直接切", async () => {
    const { host, session } = createHost();

    await runCommand("model", "/model m2", host);

    expect(host.ensureKey).not.toHaveBeenCalled();
    expect(session.updateModel).toHaveBeenCalledWith("m2");
  });
});

// ==================== /think ====================

describe("/think：会话行与助手定义两个作用级别", () => {
  it("默认写会话行，并把状态栏刷新成新的那份现状", async () => {
    const { host, session, notices } = createHost();

    await runCommand("think", "/think high", host);

    expect(session.updateThinkingLevel).toHaveBeenCalledWith("high");
    expect(host.setEffortView).toHaveBeenCalled();
    // 会话行上的档位由宿主存，不需要重建 Agent
    expect(session.reload).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(
      t("effort.summarySession", {
        label: t("effort.quoted", { label: t("effort.high") }),
        model: "m1",
      }),
    );
  });

  it("`/think default`：会话行写 null（回到助手定义上那份）", async () => {
    // 现状是手动设了一档，才有「清回跟随默认」这个动作可做
    const { host, session } = createHost({
      session: {
        thinking: {
          preset: "effort",
          levels: ["low", "high"],
          selected: "high",
          source: "manual",
          params: { reasoning_effort: "high" },
        },
      },
    });

    await runCommand("think", "/think default", host);

    expect(session.updateThinkingLevel).toHaveBeenCalledWith(null);
  });

  it("-a / --agent：写助手定义，并按新定义重建这段会话", async () => {
    const { host, session, calls, notices } = createHost({
      // 定义上没有任何思考参数 → 跟随模型默认
      routes: effortRoutes(agentView({ modelId: "m1", modelParams: {} })),
    });

    await runCommand("think", "/think -a high", host);

    expect(calls).toContainEqual({
      method: "config.agents.update",
      params: {
        agentId: "default",
        // 档位展开成参数写进定义（配置即事实）：`high` → `{ reasoning_effort: "high" }`
        change: { modelParams: { reasoning_effort: "high" } },
      },
    });
    expect(session.updateThinkingLevel).not.toHaveBeenCalled();
    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(texts(notices)).toBe(
      t("effort.summary", {
        label: t("effort.quoted", { label: t("effort.high") }),
        id: "default",
        model: "m1",
      }),
    );
  });

  it("未知档位：一档都不写，可选档位来自宿主给的 levels", async () => {
    const { host, session, notices } = createHost();

    await runCommand("think", "/think turbo", host);

    expect(session.updateThinkingLevel).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.think.unknown", { level: "turbo", options: "low / high" }));
  });

  it("这个模型的档位不可调（levels 为空）：直接说不可调，不弹选择器", async () => {
    const { host, notices } = createHost({
      session: {
        thinking: {
          preset: null,
          levels: [],
          selected: null,
          source: "not_adjustable",
          params: {},
        },
      },
    });

    await runCommand("think", "/think", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.think.notAdjustable", { id: "m1" }));
  });

  it("已经是这一档：判「未变化」，不写", async () => {
    const { host, session, notices } = createHost({
      session: {
        thinking: {
          preset: "effort",
          levels: ["low", "high"],
          selected: "high",
          source: "manual",
          params: { reasoning_effort: "high" },
        },
      },
    });

    await runCommand("think", "/think high", host);

    expect(session.updateThinkingLevel).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.think.unchanged"));
  });

  it("选择器把「跟随默认」标在会话级那一条上，助手定义级不出现它", async () => {
    const { host } = createHost();
    const seen = capturePick(host, null);

    await runCommand("think", "/think", host);

    expect(seen.labels).toEqual(["跟随模型默认（当前）", "低", "高"]);
  });

  // 两档选择器的 InboxEntry 几乎一样，标题是唯一说清「改的是哪一层」的地方（PRD 4.7）
  it("标题印出作用级别：会话级是「这一段」、助手定义级是「这个助手定义（影响之后新建的会话）」", async () => {
    const { host } = createHost();
    const sessionSeen = capturePick(host, null);
    await runCommand("think", "/think", host);

    const agentHost = createHost({
      routes: effortRoutes(agentView({ modelId: "m1", modelParams: { reasoning_effort: "high" } })),
    }).host;
    const agentSeen = capturePick(agentHost, null);
    await runCommand("think", "/think -a", agentHost);

    // 两档各自的标题（当前档也都在里面）
    expect(sessionSeen.title).toBe(t("cmd.think.titleSession", { level: t("effort.default") }));
    expect(agentSeen.title).toBe(t("cmd.think.titleAgent", { level: t("effort.high") }));
    // 两句话必须不一样，而且 AgentDefinition 级要说清它管的是以后（不只是这一段）
    expect(sessionSeen.title).not.toBe(agentSeen.title);
    expect(agentSeen.title).toContain("影响之后新建的会话");
  });

  it("-a 的选择器里有一项「清掉助手定义上的思考参数」", async () => {
    const { host } = createHost({
      routes: effortRoutes(agentView({ modelId: "m1", modelParams: { reasoning_effort: "high" } })),
    });
    const seen = capturePick(host, null);

    await runCommand("think", "/think -a", host);

    // 第一项就是「这一层不再写档位」那一项：标签与会话级那条同一个说法，
    // hint 说清它删的是**AgentDefinition**上的参数（会话级那条说的是本次会话）
    expect(seen.labels).toEqual(["跟随模型默认", "低", "高（当前）"]);
    expect(seen.hints[0]).toBe(t("cmd.think.clearHintAgent"));
    expect(seen.hints.slice(1)).toEqual(["low", "high"]);
    // 它的值既不是档位名、也不是会话级那个 `default`：命令层自己的哨兵，协议里对应「剔掉思考参数」
    expect(seen.values.slice(1)).toEqual(["low", "high"]);
    expect(seen.values[0]).not.toBe("default");
  });

  it("-a 选中「清掉」：写 `modelParams` 的空表，并按新定义重建这段会话", async () => {
    const { host, session, calls, notices } = createHost({
      routes: {
        "config.get": () => ({
          config: configView({
            models: [
              modelView("m1", "模型一", { reasoningPreset: "effort" }),
              modelView("m2", "模型二"),
            ],
          }),
          presets: presetsView(),
        }),
        "config.agents.get": () => ({
          definition: agentView({ modelId: "m1", modelParams: { reasoning_effort: "high" } }),
        }),
        // 清完之后宿主给的那一份：定义上没有思考参数了，跟着模型默认走
        "config.agents.update": () => ({
          definition: agentView({ modelId: "m1", modelParams: {} }),
        }),
      },
    });
    const seen = capturePick(host, null);
    // 先空跑一遍只为拿到那一项的值（哨兵值由命令层定，用例不写死它）
    await runCommand("think", "/think -a", host);
    host.pick = async () => seen.values[0] ?? null;

    await runCommand("think", "/think -a", host);

    expect(calls).toContainEqual({
      method: "config.agents.update",
      params: {
        agentId: "default",
        // 清掉 = 把思考那几个键剔掉；`undefined` 在合并语义里是「这一项不改」，所以给空表
        change: { modelParams: {} },
      },
    });
    // 写的是 AgentDefinition，不是会话行
    expect(session.updateThinkingLevel).not.toHaveBeenCalled();
    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(host.setEffortView).toHaveBeenCalledWith({ text: t("effort.default"), dimmed: false });
    expect(texts(notices)).toContain(
      t("effort.summary", { label: t("effort.followDefault"), id: "default", model: "m1" }),
    );
  });

  it("-a 的「清掉」在手写参数上也算真改动（参数还在，只是凑不成一档）", async () => {
    const { host, calls, notices } = createHost({
      routes: effortRoutes(
        agentView({ modelId: "m1", modelParams: { reasoning_effort: "ultra" } }),
      ),
    });
    const seen = capturePick(host, null);
    await runCommand("think", "/think -a", host);
    // 这一项不是「当前」：定义上还带着思考参数，清掉它是有后果的一次写入
    expect(seen.labels[0]).toBe(t("cmd.think.followDefault"));
    host.pick = async () => seen.values[0] ?? null;

    await runCommand("think", "/think -a", host);

    expect(calls).toContainEqual({
      method: "config.agents.update",
      params: { agentId: "default", change: { modelParams: {} } },
    });
    expect(texts(notices)).not.toContain(t("cmd.think.unchanged"));
  });

  /** 与 `/model` 同一道门（`needsIdle`）：忙时整条不可用，命令体一个字节都不写 */
  it("这一段在忙：整条 `/think` 不可用，不弹选择器、不写会话行", async () => {
    const { host, session, calls, notices } = createHost({ session: { status: "working" } });

    await runCommand("think", "/think high", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(session.updateThinkingLevel).not.toHaveBeenCalled();
    expect(host.setEffortView).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(texts(notices)).toBe(t("cmd.needsIdle", { name: "/think" }));
  });

  it("闲下来之后照旧能用：写会话行并刷新状态栏那一格", async () => {
    const { host, session } = createHost();

    await runCommand("think", "/think high", host);

    expect(session.updateThinkingLevel).toHaveBeenCalledWith("high");
    expect(host.setEffortView).toHaveBeenCalled();
  });
});

// ==================== /agent ====================

describe("/agent：选「以后的会话用哪个助手定义」（写默认助手定义）", () => {
  it("选中之后仅生成 defaultAgent 这一个字段", async () => {
    const { host, calls, notices } = createHost({
      routes: {
        // `agentDefinition.list` 回的是**定义数组**（默认 AgentDefinition 是配置里的那一格，见 `agentListOf`）
        "config.agents.list": () => [
          agentView(),
          agentView({ id: "coder", name: "编程 Agent", modelId: "m2" }),
        ],
      },
    });
    capturePick(host, "coder");

    await runCommand("agent", "/agent", host);

    expect(calls).toContainEqual({
      method: "config.defaults.update",
      params: { defaultAgent: "coder" },
    });
    expect(texts(notices)).toBe(
      t("agentSwitch.summary", {
        name: "编程 Agent",
        id: "coder",
        model: "模型二",
        modelId: "m2",
      }),
    );
  });

  it("当前会话已使用该助手：补一句「已在该助手」，不重挂载", async () => {
    const { host, notices } = createHost();

    await runCommand("agent", "/agent default", host);

    expect(texts(notices)).toContain("当前会话已使用该助手");
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("没有主助手定义：报错并指路 /config", async () => {
    const { host, notices } = createHost({
      routes: { "config.agents.list": () => [] },
    });

    await runCommand("agent", "/agent", host);

    expect(texts(notices)).toBe(t("cmd.agent.noAgents"));
  });
});

// ==================== /mcp ====================

describe("/mcp：入口作用域看 mcp.list 的 scope", () => {
  it("项目层有条目时默认进项目层（workspace）", async () => {
    const { host, calls } = createHost({
      routes: { "config.mcp.list": () => ({ servers: [MCP_ENTRY] }) },
    });

    await runCommand("mcp", "/mcp", host);

    expect(calls).toEqual([{ method: "config.mcp.list", params: { workspaceId: "ws-1" } }]);
    expect(host.openWizard).toHaveBeenCalledWith({ kind: "mcp", scope: "workspace" });
  });

  it("项目层为空时默认进用户层（user）", async () => {
    const { host } = createHost({
      routes: {
        "config.mcp.list": () => ({
          servers: [mcpEntry("user", { id: "pty", transport: "stdio", command: "npx" })],
        }),
      },
    });

    await runCommand("mcp", "/mcp", host);

    expect(host.openWizard).toHaveBeenCalledWith({ kind: "mcp", scope: "user" });
  });

  it("显式作用域不做发现（直接进那一屏）", async () => {
    const { host, calls } = createHost();

    await runCommand("mcp", "/mcp workspace", host);

    expect(calls).toEqual([]);
    expect(host.openWizard).toHaveBeenCalledWith({ kind: "mcp", scope: "workspace" });
  });

  it("旧词 global：与 `/mcp user` 走同一条路（先是全局/用户级）", async () => {
    const { host, calls } = createHost();

    await runCommand("mcp", "/mcp global", host);

    // 旧词只在解析处映射：显式作用域照旧不读清单，进的是 user 那一屏
    expect(calls).toEqual([]);
    expect(host.openWizard).toHaveBeenCalledWith({ kind: "mcp", scope: "user" });
  });

  it("旧词 project：与 `/mcp workspace` 走同一条路（先是项目级）", async () => {
    const { host, calls } = createHost();

    await runCommand("mcp", "/mcp project", host);

    expect(calls).toEqual([]);
    expect(host.openWizard).toHaveBeenCalledWith({ kind: "mcp", scope: "workspace" });
  });

  it("作用域写错：报错并列出可选值", async () => {
    const { host, notices } = createHost();

    await runCommand("mcp", "/mcp nonsense", host);

    expect(host.openWizard).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.mcp.unknownScope", { scope: "nonsense" }));
  });
});

// ==================== /lang ====================

describe("/lang：语言是用户的属性，不是连接的属性", () => {
  /** 本机偏好文件里现在记的是哪个语言（`/lang` 落盘的那一格；没写过就是 `undefined`） */
  function prefLanguage(): string | undefined {
    const file = join(zen.dir, "cli", "preferences.json");
    if (!existsSync(file)) return undefined;
    return (JSON.parse(readFileSync(file, "utf-8")) as { language?: string }).language;
  }

  /** 缺省打桩照真宿主的样子回：把收到的那一格写进整份配置再交回来 */
  function echoGlobal(params: Record<string, unknown>) {
    return { config: configView({ language: params.language as AppConfig["language"] }) };
  }

  // 临时根在整个文件里是同一份，上一个用例落的偏好会留着：每一条都从「没选过」开始
  beforeEach(() => rmSync(join(zen.dir, "cli"), { recursive: true, force: true }));

  it("/lang en：只打一次 config.update，本机偏好取回执里那一格", async () => {
    const { host, calls, notices } = createHost({ routes: { "config.update": echoGlobal } });

    await runCommand("lang", "/lang en", host);

    expect(calls).toEqual([{ method: "config.update", params: { language: "en" } }]);
    expect(prefLanguage()).toBe("en");
    expect(host.refreshLocale).toHaveBeenCalledTimes(1);
    expect(texts(notices)).toBe(t("notice.languageChanged"));
  });

  it("/lang zh：同一个写口，本机偏好回到中文", async () => {
    setLocale("en");
    const { host, calls } = createHost({ routes: { "config.update": echoGlobal } });

    await runCommand("lang", "/lang zh", host);

    expect(calls).toEqual([{ method: "config.update", params: { language: "zh" } }]);
    expect(prefLanguage()).toBe("zh");
  });

  it("无参时切到当前这一门的对面", async () => {
    const { host, calls } = createHost({ routes: { "config.update": echoGlobal } });

    await runCommand("lang", "/lang", host);

    expect(calls).toEqual([{ method: "config.update", params: { language: "en" } }]);
  });

  it("回执里没有语言这一格：不拿打算写的那个值顶上", async () => {
    // 真宿主写进去了才会回整份，这里只是钉住「本机偏好只吃回执里的那一格」
    const { host, notices } = createHost({
      routes: { "config.update": () => ({ config: configView() }) },
    });

    await runCommand("lang", "/lang en", host);

    expect(prefLanguage()).toBeUndefined();
    expect(host.refreshLocale).not.toHaveBeenCalled();
    expect(texts(notices)).toBe("");
  });

  it("候选集外的语言当场拒绝，一个宿主往返都不发", async () => {
    // 候选集就是 `i18n` 的 `SUPPORTED_LOCALES`：多一门语言只改那一处，这里跟着生效
    const { host, calls, notices } = createHost();

    await runCommand("lang", "/lang ja", host);

    expect(calls).toEqual([]);
    expect(notices.at(-1)).toEqual({
      text: t("cmd.lang.unknown", { lang: "ja" }),
      tone: "error",
    });
  });

  it("宿主拒绝时把那句话如实上屏，本机偏好不动", async () => {
    const { host, notices } = createHost({
      routes: {
        "config.update": () => {
          throw new Error("language must be one of en / zh");
        },
      },
    });

    await runCommand("lang", "/lang en", host);

    expect(prefLanguage()).toBeUndefined();
    expect(host.refreshLocale).not.toHaveBeenCalled();
    // 宿主给的那句话原样在里面：命令层不另编一句取代它
    expect(notices.at(-1)).toEqual({
      text: t("cmd.failed", { name: "lang", error: "language must be one of en / zh" }),
      tone: "error",
    });
  });
});

// ==================== /handoff / /migrate ====================

describe("/handoff 与 /migrate：同一个方法，两种后续，执行者都由宿主问", () => {
  /**
   * 这一组钉住的是「命令层一道题都不出」：没指定执行者时它只发 `kind`，题由宿主出
   * （`HandoffService.startAsked`）—— 手动与阈值撞线共用同一份题，客户端自己再拼一份就是两副面孔。
   */
  it("/handoff 不写 mode：只发 kind，不问本地选择器、也不替用户说「开始了」", async () => {
    const { host, session, notices } = createHost();

    await runCommand("handoff", "/handoff", host);

    // 题在宿主那一边：命令层连 `pick` 都不该碰
    expect(host.pick).not.toHaveBeenCalled();
    expect(session.handoff).toHaveBeenCalledWith({ kind: "document" });
    // 题一出来就是回执：用户还没选，先报一句「开始了」等于替他宣告了
    expect(texts(notices)).toBe("");
    expect(host.clearTranscript).not.toHaveBeenCalled();
  });

  it("/handoff 选好执行者（`self` / `summary`）：显式发 mode，回执「开始了」", async () => {
    const { host, session, notices } = createHost();

    await runCommand("handoff", "/handoff summary", host);

    expect(host.pick).not.toHaveBeenCalled();
    // 挑定的执行者与「仅生成文档」这一档一起交出去（宿主 `handoff.start` 的 `mode` / `kind`）
    expect(session.handoff).toHaveBeenCalledWith({ kind: "document", mode: "summary" });
    // 回执只有「开始了」：文档路径由宿主那条通知说（它才知道写到哪）
    expect(texts(notices)).toBe(t("cmd.handoff.started"));
  });

  it("/migrate 走同一条 procedure，但发的是换手那一档（显式给的 mode 照发）", async () => {
    const { host, session, notices } = createHost();

    await runCommand("migrate", "/migrate summary", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(session.handoff).toHaveBeenCalledWith({ kind: "swap", mode: "summary" });
    // 原地换记忆：这一段会话的 id 与转录都不动，旧记忆变成另一段存档会话
    expect(host.clearTranscript).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.migrate.started"));
  });

  it("/migrate 不写 mode 时也只发 kind：执行者交给宿主去问", async () => {
    const { host, session, notices } = createHost();

    await runCommand("migrate", "/migrate", host);

    expect(host.pick).not.toHaveBeenCalled();
    expect(session.handoff).toHaveBeenCalledWith({ kind: "swap" });
    expect(texts(notices)).toBe("");
  });

  it("真失败：报失败原因，且不重置显示起点", async () => {
    const { host, notices } = createHost({
      session: {
        handoff: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });

    await runCommand("migrate", "/migrate self", host);

    expect(host.clearTranscript).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({
      text: t("cmd.migrate.failed", { error: "boom" }),
      tone: "error",
    });
  });

  it("执行者参数非法：完全不调交接", async () => {
    const { host, session, notices } = createHost();

    await runCommand("migrate", "/migrate nobody", host);

    expect(session.handoff).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.handoff.unknownMode", { who: "nobody" }));
  });

  it("没有可交接的内容：一次 procedure 都不调", async () => {
    const { host, session, notices } = createHost({
      session: {
        messages: [{ id: "a-1", createdAt: 1, role: AgentNS.Role.Assistant, content: "yo" }],
      },
    });

    await runCommand("handoff", "/handoff", host);

    expect(session.handoff).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.handoff.empty"));
  });
});

// ==================== /help / /reload ====================

describe("/help：说明就是命令表里的本地词条", () => {
  it("一次宿主调用都不发，逐条印本地说明", async () => {
    const { host, calls, notices } = createHost();

    await runCommand("help", "/help", host);

    // 帮助不问宿主：宿主连不上时「不知道该怎么办」最该能用的就是这条命令
    expect(calls).toHaveLength(0);
    const text = texts(notices);
    expect(text).toContain(t("cmd.help.title"));
    expect(text).toContain(t("cmd.back.desc"));
    expect(text).toContain(t("cmd.clear.desc"));
    // 清单就是命令表：新拆出来的 `/free` 也得在 /help 里
    expect(text).toContain("/free");
    expect(text).toContain(t("cmd.free.desc"));
    expect(text).toContain("/exit /quit");
  });
});

describe("/reload：让宿主重新发现能力，再把回执说给人听", () => {
  /** 一个「宿主刷完了」的会话层：回执由用例给 */
  function reloadReturning(report: ScopeReloadReport) {
    return createHost({ session: { reload: vi.fn(async () => report) } });
  }

  it("调一次会话层的 reload（= `scope.reload`），把回执里的数字上屏", async () => {
    const { host, session, notices } = reloadReturning({ total: 2, refreshed: 2, failed: [] });

    await runCommand("reload", "/reload", host);

    expect(session.reload).toHaveBeenCalledTimes(1);
    // 说的是宿主给的那两个数，不是一句「已重新加载」
    expect(texts(notices)).toBe(t("cmd.reload.done", { total: 2, refreshed: 2 }));
  });

  it("有没刷成的：说出有几份、是哪几个目录", async () => {
    const { host, notices } = reloadReturning({
      total: 2,
      refreshed: 1,
      failed: [{ cwd: "/w/a", reason: "配置读不出来" }],
    });

    await runCommand("reload", "/reload", host);

    expect(texts(notices)).toBe(
      t("cmd.reload.doneSome", { total: 2, refreshed: 1, failed: 1, cwds: "/w/a" }),
    );
  });

  it("一份容器都没有：如实说「没有已造好的」，不假装刷过了", async () => {
    const { host, notices } = reloadReturning({ total: 0, refreshed: 0, failed: [] });

    await runCommand("reload", "/reload", host);

    expect(texts(notices)).toBe(t("cmd.reload.none"));
  });

  it("刷新本身失败（宿主拒了这条调用）：报失败，不说刷成了", async () => {
    const { host, notices } = createHost({
      session: {
        reload: vi.fn(async () => {
          throw new Error("connection lost");
        }),
      },
    });

    await runCommand("reload", "/reload", host);

    expect(texts(notices)).toBe(t("cmd.reload.failed", { error: "connection lost" }));
  });
});

// ==================== 失败只有一个出口 ====================

/**
 * `/load` `/new` `/back` 这几条**没有**自己的 `catch`，而它们的 await 全是网络往返；
 * 宿主那边 `runCommand(...)` 外面也没有 `catch`（`chat.tsx` 的 `runSubmit` 只有 `finally`），
 * 漏出去就是 `unhandledRejection` —— 而 `tui/index.tsx` 把它接成 `process.exit(1)`。
 * 所以这里钉的是：**宿主拒绝 = 一条通知**，不是一条未处理的 rejection。
 */
describe("宿主拒绝：一条通知，不是一条未处理的 rejection", () => {
  it("/load 取不到会话列表 → 通知里说清是哪条命令 + 宿主原话", async () => {
    const { host, notices } = createHost({
      routes: {
        "session.list": () => {
          throw new Error("connection lost");
        },
      },
    });

    await expect(runCommand("load", "/load", host)).resolves.toBeUndefined();

    expect(notices.at(-1)).toEqual({
      text: t("cmd.failed", { name: "load", error: "connection lost" }),
      tone: "error",
    });
  });

  it("/new 的宿主动作失败 → 同样走通知，不炸进程", async () => {
    const { host, notices } = createHost();
    // 开新会话归注册表（PRD D4）：失败就由它抛，命令层不自己 catch —— 兜底只有一处
    host.newSession = async () => {
      throw new Error("workspace missing");
    };

    await runCommand("new", "/new", host);

    expect(notices.at(-1)).toEqual({
      text: t("cmd.failed", { name: "new", error: "workspace missing" }),
      tone: "error",
    });
    // 没开成就没有「换屏」这回事
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("未知命令指向帮助", async () => {
    const { host, notices } = createHost();

    await runCommand("nope", "/nope", host);

    expect(notices.at(-1)).toEqual({
      text: t("cmd.unknown", { cmd: "/nope" }),
      tone: "error",
    });
  });
});

// ==================== /ws：工作区（PRD D30） ====================

/** 一个工作区的视图（宿主 `WorkspaceView` 原样形状） */
/**
 * 宿主 `workspace.list` 的一行（`cwd` 是**它那台机器**上的路径，时间一律 epoch 毫秒）。
 *
 * 这一版没有「目录还在不在」那一格（宿主不报），所以第三个参数只是给用例标一下意图，
 * 不再进对象。
 */
function workspaceRow(id: string, cwd: string, name = id) {
  return { id, name, cwd, createdAt: Date.parse("2026-10-01T00:00:00.000Z") };
}

/** 记忆文件（`<aiZenDir>/cli/last-workspace.json`） */
function workspaceMemory(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(zen.dir, "cli", "last-workspace.json"), "utf-8"));
  } catch {
    return {};
  }
}

describe("/ws：列 / 选 / 新建", () => {
  beforeEach(() => {
    // 记忆是落盘的：每条用例从「本机没记过」开始
    rmSync(join(zen.dir, "cli"), { recursive: true, force: true });
  });

  it("无参：列出宿主的工作区（目录与「还在不在」都来自宿主），选中就切过去并记住", async () => {
    const { host, session, calls, notices } = createHost({
      routes: {
        "workspace.list": () => [
          workspaceRow("ws-1", "/work/a", "甲"),
          workspaceRow("ws-2", "/work/b", "乙"),
        ],
      },
    });
    host.pick = vi.fn(async () => "ws-2");

    await runCommand("ws", "/ws", host);

    expect(calls.map((call) => call.method)).toEqual(["workspace.list"]);
    // 每项都带目录事实（目录在不在宿主这一版不报，所以 hint 只给路径）
    expect(host.pick).toHaveBeenCalledWith(
      t("cmd.ws.title"),
      expect.arrayContaining([
        expect.objectContaining({ value: "ws-1", hint: "/work/a" }),
        expect.objectContaining({ value: "ws-2", hint: "/work/b" }),
      ]),
    );
    expect(session.selectWorkspace).toHaveBeenCalledWith("ws-2");
    expect(texts(notices)).toContain("乙");
    // 「上次进入的那个」记在本机那一格
    expect(workspaceMemory()).toEqual({ local: "ws-2" });
  });

  it("无参 + 取消：什么都不切、不写记忆", async () => {
    const { host, session, notices } = createHost({
      routes: { "workspace.list": () => [workspaceRow("ws-1", "/work/a")] },
    });
    host.pick = vi.fn(async () => null);

    await runCommand("ws", "/ws", host);

    expect(session.selectWorkspace).not.toHaveBeenCalled();
    expect(workspaceMemory()).toEqual({});
    expect(texts(notices)).toBe(t("cmd.ws.cancelled"));
  });

  it("无参 + 宿主上一个都没有：说清怎么建（本机 / 远端两句话不一样）", async () => {
    const local = createHost({ routes: { "workspace.list": () => [] } });
    await runCommand("ws", "/ws", local.host);
    expect(texts(local.notices)).toBe(`${t("cmd.ws.none")}\n${t("cmd.ws.newHintLocal")}`);

    const remote = createHost({
      routes: { "workspace.list": () => [] },
      workspaceHost: { local: false, key: "ws://10.0.0.5:8790" },
    });
    await runCommand("ws", "/ws", remote.host);
    expect(texts(remote.notices)).toBe(`${t("cmd.ws.none")}\n${t("cmd.ws.newHintRemote")}`);
  });

  it("`new` 本机不带路径：用当前目录（有就复用、没有就登记）", async () => {
    const { host, session, calls } = createHost({
      routes: {
        // 当前目录还没登记过
        "workspace.list": () => [],
        "workspace.create": () => ({ workspace: workspaceRow("ws-new", process.cwd()) }),
      },
    });

    await runCommand("ws", "/ws new", host);

    expect(calls.map((call) => call.method)).toEqual(["workspace.list", "workspace.create"]);
    expect(calls[1]?.params).toEqual({ cwd: process.cwd() });
    expect(session.selectWorkspace).toHaveBeenCalledWith("ws-new");
    expect(workspaceMemory()).toEqual({ local: "ws-new" });
  });

  it("`new` 远端不带路径：拒绝并指路（绝不拿本机目录凑一个）", async () => {
    const { host, session, calls, notices } = createHost({
      workspaceHost: { local: false, key: "ws://10.0.0.5:8790" },
    });

    await runCommand("ws", "/ws new", host);

    // 一条契约方法都没发（更没有 workspace.create 带 process.cwd()）
    expect(calls).toEqual([]);
    expect(session.selectWorkspace).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({ text: t("cmd.ws.newNeedsPath"), tone: "error" });
  });

  it("`new <绝对路径>` 远端：就登记宿主上的那个目录", async () => {
    const { host, session, calls } = createHost({
      workspaceHost: { local: false, key: "ws://10.0.0.5:8790" },
      routes: {
        "workspace.list": () => [],
        "workspace.create": () => ({ workspace: workspaceRow("ws-remote", "/srv/repo") }),
      },
    });

    await runCommand("ws", "/ws new /srv/repo", host);

    expect(calls.at(-1)).toEqual({ method: "workspace.create", params: { cwd: "/srv/repo" } });
    expect(session.selectWorkspace).toHaveBeenCalledWith("ws-remote");
    // 记忆落在**那台宿主**那一格，不跟本机串
    expect(workspaceMemory()).toEqual({ "ws://10.0.0.5:8790": "ws-remote" });
  });

  it("`new` 被宿主拒绝：一句对症的话，不是一条未处理的 rejection", async () => {
    const { host, notices } = createHost({
      routes: {
        "workspace.list": () => [],
        "workspace.create": () => {
          throw new Error("cwd 不是绝对路径");
        },
      },
    });

    await expect(runCommand("ws", "/ws new relative/dir", host)).resolves.toBeUndefined();

    expect(notices.at(-1)).toEqual({
      text: t("cmd.ws.createFailed", { error: "cwd 不是绝对路径" }),
      tone: "error",
    });
  });

  it("不认识的参数：回显它，并给用法", async () => {
    const { host, notices } = createHost();

    await runCommand("ws", "/ws add", host);

    expect(notices.at(-1)).toEqual({ text: t("cmd.ws.unknownArg", { arg: "add" }), tone: "error" });
  });
});

// ==================== /ws delete ====================

/**
 * `/ws delete <项目名或 ID>` —— 删项目**连带删它名下的会话**（PRD 1.5），目录一个字不动；
 * 删之前把代价摆出来、再一次确认（PRD 1.6「二次确认要能先给代价、再真做」）。
 *
 * 这一组钉五件：确认之前一次写都没有、代价里带着会话数并点到目录不动、认名字也认 ID、
 * 上屏的数字用回执里的、删的是当前项目时屏幕不会停在一段已经不存在的会话上。
 */
describe("/ws delete：先摆代价、再一次确认、连带删会话", () => {
  /** 两个项目 + 各自名下的会话（`session.list` 按项目给）+ 一份删除回执 */
  function deleteRoutes(
    perWorkspace: Record<string, SessionSnapshot[]> = {},
    removed: string[] = ["sess-1", "sess-2"],
  ): Routes {
    return {
      "workspace.list": () => [
        workspaceRow("ws-1", "/work/a", "甲"),
        workspaceRow("ws-2", "/work/b", "乙"),
      ],
      "session.list": (params) => perWorkspace[String(params.workspaceId)] ?? [],
      "workspace.delete": () => ({ sessions: removed }),
    };
  }

  it("确认之前只有两次读：`workspace.delete` 一次没调，选「否」就说一句", async () => {
    const { host, calls, notices } = createHost({
      routes: deleteRoutes({ "ws-1": [sessionView()] }),
    });
    const seen = capturePick(host, "no");

    await runCommand("ws", "/ws delete 甲", host);

    // 只读了「有哪些项目」与「这个项目名下有几段会话」，一条写都没有
    expect(methods(calls)).toEqual(["workspace.list", "session.list"]);
    expect(host.exit).not.toHaveBeenCalled();
    expect(host.dropSession).not.toHaveBeenCalled();
    expect(seen.values).toEqual(["yes", "no"]);
    expect(texts(notices)).toBe(t("cmd.ws.deleteCancelled"));
  });

  it("代价里带着名下会话的段数，并点到那个目录不受影响", async () => {
    const { host } = createHost({
      routes: deleteRoutes({
        "ws-1": [
          sessionView({ id: "sess-1" }),
          sessionView({ id: "sess-2" }),
          sessionView({ id: "sess-3" }),
        ],
      }),
    });
    const seen = capturePick(host, "no");

    await runCommand("ws", "/ws delete 甲", host);

    // 问的那一句里三件事都在：是哪个项目、几段会话跟着没、那个目录不动
    expect(seen.title).toBe(t("cmd.ws.deleteTitle", { name: "甲", path: "/work/a", sessions: 3 }));
    expect(seen.title).toContain("3");
    expect(seen.title).toContain("/work/a");
    expect(seen.title).toContain("不受影响");
    expect(seen.labels).toEqual([t("cmd.ws.deleteConfirm"), t("cmd.ws.deleteCancel")]);
  });

  it("参数认名字也认 ID（ID 就认 ID 那个项目，不猜最近的那个）", async () => {
    const { host } = createHost({
      routes: deleteRoutes({ "ws-2": [sessionView({ id: "sess-9" })] }),
    });
    const seen = capturePick(host, "no");

    await runCommand("ws", "/ws delete ws-2", host);

    expect(seen.title).toBe(t("cmd.ws.deleteTitle", { name: "乙", path: "/work/b", sessions: 1 }));
  });

  it("认不出来就指路（一次写都没有，也不猜最近的那个）", async () => {
    const { host, calls, notices } = createHost({ routes: deleteRoutes() });

    await runCommand("ws", "/ws delete 没有这个项目", host);

    expect(methods(calls)).toEqual(["workspace.list"]);
    expect(host.pick).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({
      text: t("cmd.ws.deleteUnknown", { arg: "没有这个项目" }),
      tone: "error",
    });
  });

  it("不带参数：给用法，一条契约方法都不发", async () => {
    const { host, calls, notices } = createHost({ routes: deleteRoutes() });

    await runCommand("ws", "/ws delete", host);

    expect(calls).toEqual([]);
    expect(notices.at(-1)).toEqual({ text: t("cmd.ws.deleteUsage"), tone: "error" });
  });

  it("删的是别的项目：登记里那几段照样摘掉，这一屏不受影响", async () => {
    const { host, notices } = createHost({
      // 当前这一段在 ws-1（`sessionStub` 的 workspaceId），删的是乙（ws-2）
      routes: deleteRoutes({ "ws-2": [sessionView({ id: "sess-9" })] }, [
        "sess-9",
        "sess-10",
        "sess-11",
      ]),
    });
    capturePick(host, "yes");

    await runCommand("ws", "/ws delete 乙", host);

    // 上屏的数字是回执里的三段（自己数到的只有一段）
    expect(texts(notices)).toBe(
      t("cmd.ws.deleteDone", { name: "乙", path: "/work/b", sessions: 3 }),
    );
    // 回执里那几段都从本进程的登记里摘掉（哪几段会跟着没，宿主说了算）
    expect((host.dropSession as unknown as { mock: { calls: [string][] } }).mock.calls).toEqual([
      ["sess-9"],
      ["sess-10"],
      ["sess-11"],
    ]);
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("删的是当前这一段所在的项目：换到别的项目里最近的一段", async () => {
    const { host } = createHost({
      routes: deleteRoutes(
        {
          "ws-1": [sessionView({ id: "sess-1" })],
          "ws-2": [sessionView({ id: "sess-8", name: "别的项目里那段" })],
        },
        ["sess-1"],
      ),
    });
    capturePick(host, "yes");

    await runCommand("ws", "/ws delete 甲", host);

    expect(host.dropSession).toHaveBeenCalledWith("sess-1");
    expect(host.exit).toHaveBeenCalledWith({
      load: { sessionId: "sess-8" },
      // 旧屏的通知栏跟着卸载：两句话一起带到新屏
      notice: `${t("cmd.ws.deleteDone", { name: "甲", path: "/work/a", sessions: 1 })}\n${t(
        "cmd.delete.switched",
        { name: "别的项目里那段" },
      )}`,
    });
  });

  it("删的是当前这一段所在的项目、别处一段都不剩：回连接屏并说清可以用 /new", async () => {
    const { host } = createHost({
      routes: deleteRoutes({ "ws-1": [sessionView({ id: "sess-1" })] }, ["sess-1"]),
    });
    capturePick(host, "yes");

    await runCommand("ws", "/ws delete 甲", host);

    expect(host.exit).toHaveBeenCalledWith({
      backToConnect: `${t("cmd.ws.deleteDone", {
        name: "甲",
        path: "/work/a",
        sessions: 1,
      })}\n${t("cmd.ws.deleteNoSessionLeft")}`,
    });
  });

  it("宿主把删除拒了：原话上屏，登记一个字不动", async () => {
    const { host, notices } = createHost({
      routes: {
        ...deleteRoutes({ "ws-1": [sessionView()] }),
        "workspace.delete": () => {
          throw new Error("找不到这个项目");
        },
      },
    });
    capturePick(host, "yes");

    await runCommand("ws", "/ws delete 甲", host);

    expect(host.dropSession).not.toHaveBeenCalled();
    expect(host.exit).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({
      text: t("cmd.ws.deleteFailed", { error: "找不到这个项目" }),
      tone: "error",
    });
  });

  it("真删之前先报个名、删完（或删失败）把账结掉", async () => {
    const release = vi.fn();
    const { host } = createHost({ routes: deleteRoutes({ "ws-1": [sessionView()] }) });
    host.expectOwnRemoval = vi.fn(() => release);
    capturePick(host, "yes");

    await runCommand("ws", "/ws delete 甲", host);

    expect(host.expectOwnRemoval).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    // 失败那一路也要结账：不然这一段以后被别处删掉时就不出声了
    const failing = createHost({
      routes: {
        ...deleteRoutes({ "ws-1": [sessionView()] }),
        "workspace.delete": () => {
          throw new Error("宿主拒了");
        },
      },
    });
    const releaseOnFailure = vi.fn();
    failing.host.expectOwnRemoval = vi.fn(() => releaseOnFailure);
    capturePick(failing.host, "yes");

    await runCommand("ws", "/ws delete 甲", failing.host);

    expect(releaseOnFailure).toHaveBeenCalledTimes(1);
  });
});

// ==================== 一段会话没了之后往哪儿去 ====================

/**
 * `moveAfterGone` 是**三条路共用**的那一套收尾：`/delete`、`/ws delete`、以及「别处删掉了这一
 * 屏正看着的那一段」那条事件。换到哪一段、没地方可换时说什么，只有这一处。
 *
 * （InboxEntry 1 的四种处境里，「删别段不换屏」与「一次连来三条只出声一次」在注册表那一层钉，
 * 见 `sessions-registry.test.ts`；这一组钉「换屏 / 回连接屏 / 留在这一屏」三种收尾。）
 */
describe("moveAfterGone：一段会话没了之后往哪儿去", () => {
  const removed = { sessionId: "sess-1", workspaceId: "ws-1" };

  it("同一项目里还有别的段：换过去，并说一句这一段已经被删掉了", async () => {
    const { host, calls } = createHost({
      routes: {
        // 宿主排好的那一份（置顶优先 + 创建时间倒序），删掉的那一段还留在里面也要跳过
        "session.list": () => [
          sessionView({ id: "sess-1", name: "被删的那段" }),
          sessionView({ id: "sess-3", name: "会话三" }),
          sessionView({ id: "sess-2", name: "会话二" }),
        ],
      },
    });

    await moveAfterGone(host, {
      gone: [removed.sessionId],
      scope: { workspaceId: removed.workspaceId },
      notice: t("chat.sessionRemoved"),
      emptyHint: t("cmd.delete.noOtherSession"),
      whenEmpty: "connect",
    });

    expect(calls.at(-1)).toEqual({ method: "session.list", params: { workspaceId: "ws-1" } });
    expect(host.exit).toHaveBeenCalledWith({
      load: { sessionId: "sess-3" },
      notice: `${t("chat.sessionRemoved")}\n${t("cmd.delete.switched", { name: "会话三" })}`,
    });
  });

  it("同项目里没有其他会话了：回连接屏，并说清可以用 /new 开一段", async () => {
    const { host } = createHost({
      routes: { "session.list": () => [sessionView({ id: "sess-1" })] },
    });

    await moveAfterGone(host, {
      gone: [removed.sessionId],
      scope: { workspaceId: removed.workspaceId },
      notice: t("chat.sessionRemoved"),
      emptyHint: t("cmd.delete.noOtherSession"),
      whenEmpty: "connect",
    });

    // 这一屏没有会话可看了：留在这里只会让人对着一段不存在的会话敲字
    expect(host.exit).toHaveBeenCalledWith({
      backToConnect: `${t("chat.sessionRemoved")}\n${t("cmd.delete.noOtherSession")}`,
    });
  });

  it("`whenEmpty: stay`（`/delete` 的口径）：两句都进通知栏，不换屏", async () => {
    const { host, notices } = createHost({
      routes: { "session.list": () => [sessionView({ id: "sess-1" })] },
    });

    await moveAfterGone(host, {
      gone: [removed.sessionId],
      scope: { workspaceId: removed.workspaceId },
      notice: t("cmd.delete.done", { messages: 3, assets: 2 }),
      emptyHint: t("cmd.delete.noOtherSession"),
      whenEmpty: "stay",
    });

    expect(texts(notices)).toBe(
      `${t("cmd.delete.done", { messages: 3, assets: 2 })}\n${t("cmd.delete.noOtherSession")}`,
    );
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("跨项目找（`/ws delete` 那一路）：先列项目，再逐个列会话（宿主没有全库列会话这条口）", async () => {
    const { host, calls } = createHost({
      routes: {
        "workspace.list": () => [
          workspaceRow("ws-1", "/work/a", "甲"),
          workspaceRow("ws-2", "/work/b", "乙"),
        ],
        "session.list": (params) => {
          // 甲整个没了：一段都不剩；乙里有一段
          if (params.workspaceId === "ws-1") return [sessionView({ id: "sess-1" })];
          return [sessionView({ id: "sess-8", workspaceId: "ws-2", name: "乙里那段" })];
        },
      },
    });

    await moveAfterGone(host, {
      gone: ["sess-1"],
      scope: "anywhere",
      notice: t("cmd.delete.done", { messages: 1, assets: 0 }),
      emptyHint: t("cmd.delete.noOtherSession"),
      whenEmpty: "connect",
    });

    expect(methods(calls)).toEqual(["workspace.list", "session.list", "session.list"]);
    expect(host.exit).toHaveBeenCalledWith({
      load: { sessionId: "sess-8" },
      notice: `${t("cmd.delete.done", { messages: 1, assets: 0 })}\n${t("cmd.delete.switched", {
        name: "乙里那段",
      })}`,
    });
  });
});

// ==================== /kill ====================

/**
 * `/kill` 收掉的是**Agent**（PRD 1.2「死的路只有三条」、4.1「中断不是杀死」那张表）：
 * 之后没有 agent 了、在途请求被掐断、没消费的 InboxEntry 作废；而**会话行与历史一个字不动**。
 *
 * 这一组钉四件：只调 `agent.kill` 一条、先摆代价再问一次、杀完不换屏也不清历史、
 * 已经死了的那一段不扉一句「N 条会作废」（宿主那边的 kill 对没有 Agent 的一段是空操作）。
 */
describe("/kill：先摆代价、再杀 Agent、不换屏", () => {
  it("不带参数 = 杀当前这一段：代价说清排队区几条会作废，并且只调 `agent.kill`", async () => {
    const { host, calls, notices } = createHost({
      // 排队区里还有 3 条没被取走（镜像里那一格）
      session: { inboxPending: 3 },
    });
    const seen = capturePick(host, "yes");

    await runCommand("kill", "/kill", host);

    // 确认那一句把三件事都说清了：几条会作废、历史保留、下次发话会重新叫起来
    expect(seen.title).toBe(t("cmd.kill.title", { name: "第一段", pending: 3 }));
    expect(seen.values).toEqual(["yes", "no"]);
    // 只有这一条写：杀的不是会话，是它的 agent
    expect(calls).toEqual([{ method: "runtime.agent.kill", params: { sessionId: "sess-1" } }]);
    expect(texts(notices)).toBe(t("cmd.kill.done", { name: "第一段" }));
    // 不换屏（这一段还在，只是没有 agent 了）、不摘登记、不清历史
    expect(host.exit).not.toHaveBeenCalled();
    expect(host.dropSession).not.toHaveBeenCalled();
    expect(host.clearTranscript).not.toHaveBeenCalled();
  });

  it("选「否」/ Esc：一次写都没有", async () => {
    const { host, calls, notices } = createHost({ session: { inboxPending: 1 } });
    capturePick(host, null);

    await runCommand("kill", "/kill", host);

    expect(calls).toEqual([]);
    expect(texts(notices)).toBe(t("cmd.kill.cancelled"));
  });

  it("带 id 前缀：认得出是哪一段，杀的是那一段（不是当前这一段）", async () => {
    const { host, calls, notices } = createHost({
      liveSessions: [
        live(),
        live({ sessionId: "7f3c9a10b2e4", name: "另一段", alive: true, inboxPending: 0 }),
      ],
      routes: {
        "session.list": () => [
          sessionView({ id: "sess-1", name: "第一段" }),
          sessionView({ id: "7f3c9a10b2e4", name: "另一段" }),
        ],
      },
    });
    const seen = capturePick(host, "yes");

    await runCommand("kill", "/kill 7f3c", host);

    expect(seen.title).toBe(t("cmd.kill.title", { name: "另一段", pending: 0 }));
    expect(calls.at(-1)).toEqual({
      method: "runtime.agent.kill",
      params: { sessionId: "7f3c9a10b2e4" },
    });
    expect(texts(notices)).toBe(t("cmd.kill.done", { name: "另一段" }));
  });

  it("带名字也认，代价从 `session.open` 那份快照里现数（本进程没挂着那一段）", async () => {
    const named = createHost({
      routes: {
        "session.list": () => [sessionView({ id: "sess-9", name: "另一段" })],
        // 这一段不在本进程的登记里（别的终端开的）：死活与排队区只能现问一次
        "session.open": () => ({
          session: sessionView({ id: "sess-9", name: "另一段" }),
          live: { state: "idle", inputPaused: false, outputPaused: false, handingOff: false },
          messages: [],
          inbox: [
            {
              messageId: "u-1",
              createdAt: "t",
              priority: "high",
              source: { kind: "user" },
              content: "一",
            },
            {
              messageId: "u-2",
              createdAt: "t",
              priority: "high",
              source: { kind: "user" },
              content: "二",
            },
          ],
        }),
      },
    });
    const seen = capturePick(named.host, "yes");
    await runCommand("kill", "/kill 另一段", named.host);

    expect(seen.title).toBe(t("cmd.kill.title", { name: "另一段", pending: 2 }));
    expect(methods(named.calls)).toEqual(["session.list", "session.open", "runtime.agent.kill"]);
    expect(named.calls.at(-1)).toEqual({
      method: "runtime.agent.kill",
      params: { sessionId: "sess-9" },
    });
    expect(texts(named.notices)).toBe(t("cmd.kill.done", { name: "另一段" }));
  });

  it("不认识的名字：指路到 `/sessions`，一个方法都不调（不猜最近那一段）", async () => {
    const unknown = createHost({
      routes: { "session.list": () => [sessionView({ id: "sess-9", name: "另一段" })] },
    });
    const pick = vi.fn(async () => "yes");
    unknown.host.pick = pick;

    await runCommand("kill", "/kill 没这一段", unknown.host);

    expect(pick).not.toHaveBeenCalled();
    expect(methods(unknown.calls)).toEqual(["session.list"]);
    expect(texts(unknown.notices)).toBe(t("cmd.kill.unknown", { arg: "没这一段" }));
  });

  it("前缀对得上好几段：把对得上的那几个列出来，不自己挑一段", async () => {
    const { host, calls, notices } = createHost({
      routes: {
        "session.list": () => [
          sessionView({ id: "abc111", name: "一" }),
          sessionView({ id: "abc222", name: "二" }),
        ],
      },
    });
    capturePick(host, "yes");

    await runCommand("kill", "/kill abc", host);

    expect(calls).toEqual([{ method: "session.list", params: { workspaceId: "ws-1" } }]);
    expect(texts(notices)).toBe(
      t("cmd.kill.ambiguous", {
        arg: "abc",
        n: 2,
        ids: ["abc111", "abc222"].join(t("common.listSeparator")),
      }),
    );
  });

  it("已经死了的那一段：不扉「N 条会作废」（宿主的 kill 是空操作），并指到 `/free`", async () => {
    const { host, calls, notices } = createHost({ session: { alive: false, inboxPending: 2 } });
    // 弹了确认框就是错：那一句代价在这个状态下是假话
    const pick = vi.fn(async () => "yes");
    host.pick = pick;

    await runCommand("kill", "/kill", host);

    expect(pick).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(texts(notices)).toBe(t("cmd.kill.alreadyDead", { name: "第一段" }));
  });

  it("宿主拒了：原话上屏，不重试、不兜底", async () => {
    const { host, calls, notices } = createHost({
      routes: {
        "runtime.agent.kill": () => {
          throw new Error("这一段正忙着，杀不了");
        },
      },
    });
    capturePick(host, "yes");

    await runCommand("kill", "/kill", host);

    expect(methods(calls)).toEqual(["runtime.agent.kill"]);
    expect(texts(notices)).toBe(t("cmd.kill.failed", { error: "这一段正忙着，杀不了" }));
  });
});

// ==================== /delete ====================

/**
 * `/delete` 是**硬删**（PRD 1.2 三条死路之一，4.1 要求删前警告并把代价说清）。
 *
 * 这一组钉四件：先摆代价再问、确认之前一次写都没有、删完不能停在一段已经不存在的会话上、
 * 宿主说找不到时原话上屏而屏幕不换。
 */
describe("/delete：先摆代价、再硬删、然后换一段", () => {
  /**
   * 这一段的三条消息 + 一张被引用两次的图（`session.open` 快照里的那一份）。
   *
   * 段上的本地标记就是 `__asset_id`（`user-content.ts` 写它的那个词）：同一个 id 出现两次
   * 只算一份 Asset，所以这一段是「3 条消息、2 份 Asset」。
   */
  const snapshotMessages = [
    { id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "第一条" },
    {
      id: "u-2",
      createdAt: 2,
      role: AgentNS.Role.User,
      content: [
        { type: "text" as const, text: "看这两张" },
        { type: "image_url" as const, image_url: { url: "" }, __asset_id: "a-1" },
        { type: "image_url" as const, image_url: { url: "" }, __asset_id: "a-2" },
        // 同一张图引用两次只算一份
        { type: "image_url" as const, image_url: { url: "" }, __asset_id: "a-1" },
      ],
    },
    { id: "a-1", createdAt: 3, role: AgentNS.Role.Assistant, content: "答" },
  ];

  /** `session.open` 与 `session.delete` 的字面回执（不带 `session.list`：那条要按用例给） */
  function deleteRoutes(
    removed: { messages: number; assets: number } = { messages: 3, assets: 2 },
  ) {
    return {
      "session.open": () => ({
        session: sessionView({ name: "第一段" }),
        live: null,
        messages: snapshotMessages,
        inbox: [],
      }),
      "session.delete": () => removed,
    };
  }

  it("代价从 `session.open` 那一份快照里数：消息条数与素材份数（同一张图只算一份），然后问一次", async () => {
    const { host, calls } = createHost({ routes: deleteRoutes() });
    const seen = capturePick(host, "no");

    await runCommand("delete", "/delete", host);

    expect(calls).toEqual([{ method: "session.open", params: { sessionId: "sess-1" } }]);
    // 3 条消息、2 份 Asset（a-1 被引用两次）
    expect(seen.title).toBe(t("cmd.delete.title", { name: "第一段", messages: 3, assets: 2 }));
    expect(seen.values).toEqual(["yes", "no"]);
    expect(seen.labels).toEqual([t("cmd.delete.confirm"), t("cmd.delete.cancel")]);
  });

  it("选「否」/ Esc：一次写都没有（`session.delete` 一次没调），这一段还在", async () => {
    for (const answer of ["no", null]) {
      const { host, calls, notices } = createHost({ routes: deleteRoutes() });
      capturePick(host, answer);

      await runCommand("delete", "/delete", host);

      expect(calls).toEqual([{ method: "session.open", params: { sessionId: "sess-1" } }]);
      expect(host.exit).not.toHaveBeenCalled();
      expect(texts(notices)).toBe(t("cmd.delete.cancelled"));
    }
  });

  it("确认：调 `session.delete`，上屏的数字用回执里的（不用自己数的那一份）", async () => {
    const { host, calls } = createHost({
      // 回执与自己数的不一样：Asset 按引用归零才算删掉，可能少于这一段引用过的份数
      routes: deleteRoutes({ messages: 2, assets: 1 }),
      // 这个项目里还有其他会话（`baseRoutes` 的 `session.list` 给了两段）：两句话跟着 `load` 一起带到新屏去
    });
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    expect(methods(calls)).toEqual(["session.open", "session.delete", "session.list"]);
    expect(calls[1]).toEqual({ method: "session.delete", params: { sessionId: "sess-1" } });
    // 屏幕换到同一段项目里最近的那一段，**上屏的数字是回执里的 2 / 1**（自己数的是 3 / 2）
    expect(host.exit).toHaveBeenCalledWith({
      load: { sessionId: "sess-2" },
      notice: `${t("cmd.delete.done", { messages: 2, assets: 1 })}\n${t("cmd.delete.switched", { name: "会话二" })}`,
    });
  });

  it("删完之后换到同一个项目里最近的那一段（宿主已排好序，这里只取第一条）", async () => {
    const { host, calls } = createHost({
      routes: {
        ...deleteRoutes(),
        // 宿主排好的那一份：置顶优先 + 创建时间倒序；删掉的那一段不在里面了
        "session.list": () => [
          sessionView({ id: "sess-1", name: "第一段" }),
          sessionView({ id: "sess-3", name: "会话三" }),
          sessionView({ id: "sess-2", name: "会话二" }),
        ],
      },
    });
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    // 按**这一段自己的项目**列（不是当前选中的那一个）
    expect(calls.at(-1)).toEqual({ method: "session.list", params: { workspaceId: "ws-1" } });
    expect(host.exit).toHaveBeenCalledWith({
      load: { sessionId: "sess-3" },
      // 旧屏的通知栏跟着卸载：两句话一起带到新屏
      notice: `${t("cmd.delete.done", { messages: 3, assets: 2 })}\n${t("cmd.delete.switched", { name: "会话三" })}`,
    });
  });

  it("删成功之后先把这一段从本进程的登记里摘掉，再换屏", async () => {
    const { host } = createHost({ routes: deleteRoutes() });
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    expect(host.dropSession).toHaveBeenCalledWith("sess-1");
    // 次序：先摘登记（不再往那一段投任何东西），再换屏
    const dropped = (host.dropSession as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0];
    const exited = (host.exit as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(dropped).toBeLessThan(exited!);
  });

  /**
   * 宿主在 mutation 里就把 `session.removed` 推到那条流上，它到得比回执**早**。所以这一条命令
   * 必须**先报名**再删：不报的话，注册表会先把「这一段被删掉了」演一遍（说一句话、换一次屏），
   * 紧接着这里的收尾又来一次 —— 同一件事两句话。
   */
  it("真删之前先报个名，删完把账结掉（`session.removed` 不再演一遍）", async () => {
    const release = vi.fn();
    const { host } = createHost({ routes: deleteRoutes() });
    host.expectOwnRemoval = vi.fn(() => release);
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    expect(host.expectOwnRemoval).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    // 报名在前（那时事件可能已经在路上），结账在收尾之后
    const registered = (
      host.expectOwnRemoval as unknown as { mock: { invocationCallOrder: number[] } }
    ).mock.invocationCallOrder[0]!;
    const released = (release as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0]!;
    const dropped = (host.dropSession as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0]!;
    expect(registered).toBeLessThan(dropped);
    expect(released).toBeGreaterThanOrEqual(dropped);
  });

  it("这个项目里只剩它一段：登记照样摘（不因为没地方换就不摘），且不报错", async () => {
    const { host, notices } = createHost({
      routes: {
        ...deleteRoutes(),
        "session.list": () => [sessionView({ id: "sess-1", name: "第一段" })],
      },
    });
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    expect(host.dropSession).toHaveBeenCalledWith("sess-1");
    expect(host.exit).not.toHaveBeenCalled();
    // 没有一句错误：删掉了就是删掉了，没地方可换只是下一句说明
    expect(notices.filter((notice) => notice.tone === "error")).toEqual([]);
  });

  it("宿主把删除拒了：登记一个字不动（那一段还在）", async () => {
    const { host } = createHost({
      routes: {
        ...deleteRoutes(),
        "session.delete": () => {
          throw new Error("找不到 id 为 sess-1 的会话");
        },
      },
    });
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    expect(host.dropSession).not.toHaveBeenCalled();
  });

  it("这个项目里只剩它一段：说清用 /new 开一段，不替用户开、也不换屏", async () => {
    const { host, notices } = createHost({
      routes: {
        ...deleteRoutes(),
        "session.list": () => [sessionView({ id: "sess-1", name: "第一段" })],
      },
    });
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    expect(texts(notices)).toBe(
      `${t("cmd.delete.done", { messages: 3, assets: 2 })}\n${t("cmd.delete.noOtherSession")}`,
    );
    // 不替用户开新会话，也不换屏
    expect(host.newSession).not.toHaveBeenCalled();
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("宿主回 not_found：原话上屏、屏幕不换（这一段已经不在了，但这一屏还连着）", async () => {
    const { host, notices } = createHost({
      routes: {
        ...deleteRoutes(),
        "session.delete": () => {
          throw new Error("找不到 id 为 sess-1 的会话");
        },
      },
    });
    capturePick(host, "yes");

    await runCommand("delete", "/delete", host);

    expect(host.exit).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({
      text: t("cmd.delete.failed", { error: "找不到 id 为 sess-1 的会话" }),
      tone: "error",
    });
  });
});

// ==================== /shutdown ====================

/**
 * `/shutdown` 会**真关掉宿主**，所以这里只在假连接上验：确认框说什么、调的是哪个方法、
 * 确认之后这一屏往哪去。真关一台宿主的端到端由 e2e 自己起一台临时宿主来做。
 */
describe("/shutdown：一次二次确认，确认之后回连接屏", () => {
  it("确认框把「会踢掉别人」说清楚，且只有一条确认项", async () => {
    const { host } = createHost();
    const seen = capturePick(host, "no");

    await runCommand("shutdown", "/shutdown", host);

    // 标题说的是破坏性事实：一台机器一个宿主、可能多客户端共用
    expect(seen.title).toBe(t("cmd.shutdown.title"));
    expect(seen.labels).toEqual([t("cmd.shutdown.confirm"), t("cmd.shutdown.cancel")]);
  });

  it("取消（Esc 也是这一支）：一个方法都不调，不重挂载", async () => {
    const { host, calls, notices } = createHost();
    capturePick(host, null);

    await runCommand("shutdown", "/shutdown", host);

    expect(calls).toEqual([]);
    expect(host.exit).not.toHaveBeenCalled();
    expect(texts(notices)).toBe(t("cmd.shutdown.cancelled"));
  });

  it("确认：调 host.shutdown（无入参），并带着那句话回连接屏", async () => {
    const { host, calls } = createHost({
      routes: { "host.shutdown": () => ({ accepted: true }) },
    });
    capturePick(host, "yes");

    await runCommand("shutdown", "/shutdown", host);

    // 契约里这一条**没有入参**：关哪个宿主由这条连接决定，确认已经在这一屏做过
    expect(calls).toEqual([{ method: "host.shutdown", params: {} }]);
    expect(host.exit).toHaveBeenCalledWith({ backToConnect: t("cmd.shutdown.done") });
  });

  it("宿主拒绝（报错）：原话上屏、走兜底出口，不回连接屏", async () => {
    const { host, notices } = createHost({
      routes: {
        "host.shutdown": () => {
          throw new Error("unauthorized");
        },
      },
    });
    capturePick(host, "yes");

    await expect(runCommand("shutdown", "/shutdown", host)).resolves.toBeUndefined();

    // 没受理就还是原来的样子：服务还在跑，这一屏也还连得上
    expect(host.exit).not.toHaveBeenCalled();
    expect(notices.at(-1)).toEqual({
      text: t("cmd.failed", { name: "shutdown", error: "unauthorized" }),
      tone: "error",
    });
  });
});

// ==================== /clear / /free ====================

/**
 * 一条命令一件事：`/clear` 只动屏幕，`/free` 只动排队区。
 *
 * 从前 `/clear` 两样都做（PRD 4.5 那一版口径），于是「清了屏」与「清了队列」在按下去那一刻
 * 分不开，也没法只要其中一件。现在清队列归 `/free`（宿主 `agent.clearInbox`）。
 */
describe("/clear：只清屏", () => {
  it("屏幕起点后移一次，不碰排队区", async () => {
    const { host, session, notices } = createHost({
      session: { clearInbox: vi.fn(async () => 3) },
    });

    await runCommand("clear", "/clear", host);

    expect(host.clearTranscript).toHaveBeenCalledTimes(1);
    // 排队区归 `/free`：`/clear` 一次都不该调它
    expect(session.clearInbox).not.toHaveBeenCalled();
    // 也不报条数：屏幕那一半没有「几条」这回事
    expect(notices).toEqual([]);
  });
});

describe("/free：清排队区", () => {
  it("调一次 `session.clearInbox`，清掉几条就说几条", async () => {
    const { host, session, notices } = createHost({
      session: { clearInbox: vi.fn(async () => 3) },
    });

    await runCommand("free", "/free", host);

    expect(session.clearInbox).toHaveBeenCalledTimes(1);
    expect(texts(notices)).toContain(t("cmd.free.inboxCleared", { n: 3 }));
    // 清屏不归它管
    expect(host.clearTranscript).not.toHaveBeenCalled();
  });

  it("本来就没排队（0 条）：什么都不说", async () => {
    const { host, session, notices } = createHost();

    await runCommand("free", "/free", host);

    expect(session.clearInbox).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("清失败（连接断了）：走兜底出口，不假装清干净了", async () => {
    const { host, notices } = createHost({
      session: {
        clearInbox: vi.fn(async () => {
          throw new Error("连接已断开");
        }),
      },
    });

    await expect(runCommand("free", "/free", host)).resolves.toBeUndefined();

    // 它没有「另一半已经生效」要护，所以走 `runCommand` 那个唯一出口（说清是哪条命令）
    expect(notices.at(-1)).toEqual({
      text: t("cmd.failed", { name: "free", error: "连接已断开" }),
      tone: "error",
    });
  });
});

// ==================== /rename ====================

describe("/rename：给这一段起个自己能认出的名字（PRD 1.5）", () => {
  it("带名字：写会话行，并把改成了什么说出来", async () => {
    const { host, session, notices } = createHost();

    await runCommand("rename", "/rename 排查-cache", host);

    expect(session.rename).toHaveBeenCalledWith("排查-cache");
    expect(texts(notices)).toContain(t("cmd.rename.done", { name: "排查-cache" }));
  });

  it("名字里有空格：整串交过去，不按空格切碎", async () => {
    const { host, session } = createHost();

    await runCommand("rename", "/rename 上周那个 排查", host);

    expect(session.rename).toHaveBeenCalledWith("上周那个 排查");
  });

  it("不带名字：说出现在叫什么，一个字都不写", async () => {
    const { host, session, notices } = createHost();

    await runCommand("rename", "/rename", host);

    expect(session.rename).not.toHaveBeenCalled();
    expect(texts(notices)).toContain(t("cmd.rename.usage", { name: "第一段" }));
  });

  it("`/save <名字>` 走同一条路（旧肌肉记忆，那半动作还在）", async () => {
    const { host, session } = createHost();

    await runCommand("save", "/save 老写法", host);

    expect(session.rename).toHaveBeenCalledWith("老写法");
  });
});

describe("/title：让模型给这一段重新起个名字", () => {
  /** 宿主那一支的回执：新的一行 + 到底换成了没有 */
  const answered = (name: string, named: boolean) => () => ({
    session: sessionView({ id: "sess-1", name, nameSource: "auto" }),
    named,
  });

  it("成了：一次 `session.autoTitle`，把新名字说出来", async () => {
    const { host, calls, notices } = createHost({
      routes: { "session.autoTitle": answered("交接状态机", true) },
    });

    await runCommand("title", "/title", host);

    expect(calls.map((call) => call.method)).toContain("session.autoTitle");
    expect(texts(notices)).toContain(t("cmd.title.done", { name: "交接状态机" }));
  });

  /**
   * 「模型没给出能用的名字」不是错误：名字没换，但这一次命令确实跑完了 —— 所以那一句不带
   * error 的语气，也不该让用户以为出了故障。
   */
  it("模型没给出名字：直说没换，不当成失败", async () => {
    const { host, notices } = createHost({
      routes: { "session.autoTitle": answered("第一段", false) },
    });

    await runCommand("title", "/title", host);

    const unchanged = t("cmd.title.unchanged");
    expect(texts(notices)).toContain(unchanged);
    // 不是 error 那一档：这一次命令跑完了，只是名字没变
    expect(notices.find((item) => item.text === unchanged)?.tone).not.toBe("error");
  });

  it("宿主拒了（例如没有起名模型）：把它的原话上屏，语气是 error", async () => {
    const { host, notices } = createHost({
      routes: {
        "session.autoTitle": () => {
          throw new Error("没有可用的起名模型");
        },
      },
    });

    await runCommand("title", "/title", host);

    const failed = t("cmd.title.failed", { error: "没有可用的起名模型" });
    expect(texts(notices)).toContain(failed);
    expect(notices.find((item) => item.text === failed)?.tone).toBe("error");
  });
});
