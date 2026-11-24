// Chat 集成测试 —— 屏幕主链路的护栏。
//
// 这个组件依赖一条到宿主的连接与会话实例，不换假件就渲染不起来 —— 于是
// 「输入 → 提交 → 忙碌 → 通知 → 中止」这条主链路的断言全在这里。
//
// 这里把 `sessions`（会话注册表）换成一个只转给假会话的假件（实现 `ChatSessionLike` 的那几个
// 只读字段与方法），连接换成一个只认 `call` 的假件（配置向导要用它读快照），让组件能在
// ink-testing-library 里跑起来。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { setLocale, t } from "../../i18n/index.js";
import { statusBlocksOf } from "../../status-blocks.js";
import type { AgentNS } from "@ai-zen/agents-core";
import { QUIET_LOG } from "../../test-support/log.js";
import { LogNotices } from "../../log-notices.js";
import { forgetAssetFacts, rememberAssetFacts } from "../../user-content.js";
import { forgetSubAgentEndings } from "../../subagent-status.js";

// 「这个结局已经说过了」的记账在模块里（重挂载之后不重说）：用例共享一张模块图，
// 上一条说过的结局要清掉，否则下一条用例一挂上就见不到提示
beforeEach(() => forgetSubAgentEndings());

const { created, createFakeSession } = vi.hoisted(() => {
  const created: {
    notifier: any;
    session: any;
    options: any;
    detached: any[];
    /** `/new` 这类「换一段会话」的动作真的被调用了几次（负向断言要先有它当证据） */
    newSegments: number;
  } = {
    notifier: null,
    session: null,
    options: null,
    /** `detach` 收到的听众（断言「屏幕卸载只摘听众、不 dispose 会话」用） */
    detached: [],
    newSegments: 0,
  };

  /**
   * 本工作区的文件 InboxEntry —— 假会话的「宿主磁盘」。
   *
   * 它刻意不代表本机目录：`@` 补全只能从这里出候选（会话跑在宿主里，屏幕这边扫本机磁盘
   * 只会列出客户端的文件）。形状就是 `completion.files` 的出参元素（`path` / `name` / `kind`）。
   */
  const fakeIndex = [
    { path: "src/tui", name: "tui", kind: "directory" },
    { path: "src/tui/screens/chat.tsx", name: "chat.tsx", kind: "file" },
    { path: "README.md", name: "README.md", kind: "file" },
  ];

  /** 假会话的视图：状态栏身份块里那一格（思考档位）从这里来 */
  const fakeThinking = () => ({
    preset: null,
    levels: [],
    selected: null,
    source: "not_adjustable" as const,
    params: {},
  });

  /** 只实现 `Chat` 会用的成员；`send` 默认立即把用户消息追加进 messages */
  const createFakeSession = (notifier: any) => {
    const messages: any[] = [];
    /** 主 / 子 Agent 切换条的数据源（`RunState.subagents` 原样）；用例里直接 push 进去 */
    const subAgents: any[] = [];
    /** 每个子 Agent 自己的消息（`message.list` 带 `toolCallId` 取的是这一份） */
    const subMessages = new Map<string, AgentNS.Message[]>();
    const session = {
      agentId: "default",
      sessionId: "chat_test",
      workspaceId: "ws_test",
      currentWorkspaceId: "ws_test",
      name: "测试会话",
      folder: { cwd: "/work/demo", exists: true },
      modelId: "gpt-6-astra",
      model: { modelId: "gpt-6-astra", name: "gpt-6-astra", vision: false, source: "agent" },
      /** 宿主给的附件上限（`hello.limits`）；缺省 null = 还没握上手，屏幕用本地兜底值 */
      attachmentLimits: null as { maxAssetBytes: number; maxAssetsPerMessage: number } | null,
      thinking: { preset: null, levels: [], selected: null, source: "not_adjustable", params: {} },
      messages,
      subAgents,
      // 四件事各一格（`session.state` 里那几格；`null` = 还没读到）
      status: "idle" as "working" | "idle" | null,
      inputPaused: false as boolean | null,
      outputPaused: false as boolean | null,
      alive: true as boolean | null,
      handoffSince: null as string | null,
      view: {
        id: "chat_test",
        workspaceId: "ws_test",
        name: "测试会话",
        agent: { agentId: "default", name: "default", available: true },
        model: { modelId: "gpt-6-astra", name: "gpt-6-astra", vision: false, source: "agent" },
        thinking: fakeThinking(),
        folder: { cwd: "/work/demo", exists: true },
      },
      // 状态栏的块用**真函数**现拼（`status-blocks.ts`）：刻意不写一份夹具，
      // 否则契约一改、拼法一改，这里都会变成「看起来还在用的死数据」
      get blocks() {
        return statusBlocksOf({
          model: { modelId: "gpt-6-astra", name: "gpt-6-astra", vision: false, source: "agent" },
          thinking: fakeThinking(),
          // 用量那两个数在真会话里由会话层从消息的 `usage` 上算（`session.ts`）：
          // 假件只当搬运工（算得对不对是 `session.test.ts` 的事）
          lastTokens: this.lastTokens,
          totalTokens: this.totalTokens,
          rate: this.rateSample,
          working: this.status === "working",
          status: this.status,
          inputPaused: this.inputPaused,
          outputPaused: this.outputPaused,
          alive: this.alive,
        });
      },
      /** 本次 / 累计 tok（真会话里从消息的 `usage` 上算，用例直接摆值） */
      lastTokens: 1284 as number | null,
      totalTokens: 20345 as number | null,
      questions: [],
      rateSample: { live: null, average: null, running: false },
      send: vi.fn(
        async (input: string, images: readonly { base64: string; mime: string }[] = []) => {
          // 与真实会话同形：有图时内容是多段（文本 + image_url 的 data URL），
          // 于是 messages 里真的带着图片 —— `↑` 的图片还原才有东西可解。
          const content =
            images.length === 0
              ? input
              : [
                  { type: "text", text: input },
                  ...images.map((image) => ({
                    type: "image_url",
                    image_url: { url: `data:${image.mime};base64,${image.base64}` },
                  })),
                ];
          messages.push({ id: `m${messages.length}`, role: "user", content });
          // 与真实会话一致：新一次输入清空上一次的子 Agent
          subAgents.length = 0;
          notifier.onChange(true);
        },
      ),
      abort: vi.fn(),
      // `/model` 的会话级那一档（`session.updateModel`）：写的是会话行，这里只记「写没写、写了什么」
      updateModel: vi.fn(async () => undefined),
      // 复活 / 暂停 / 继续：三个动作各管一件事（PLAN §5.1），「按发送」那三步由屏幕编排
      start: vi.fn(async () => undefined),
      pauseOutput: vi.fn(async () => undefined),
      resumeOutput: vi.fn(async () => undefined),
      // `send()`（受理即回）+ `waitForReply()`（等这一句有了下文）：假件里这一句同步就答完了，
      // 所以后者立即 resolve —— 断言看的是 `send` 有没有被叫、参数对不对。
      waitForReply: vi.fn(async () => {}),
      // 还压在队里、没被取走的那几句（`session.state.inbox`；条数 = 长度）
      inbox: [] as Array<{
        messageId: string;
        source: unknown;
        createdAt: string;
        preview: string;
      }>,
      /** 排队条数由数组派生（与真会话同一个口径，不另存一份计数） */
      get inboxPending() {
        return this.inbox.length;
      },
      dispose: vi.fn(),
      reload: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinking: vi.fn(async () => undefined),
      revert: vi.fn(async () => ({ content: "", assetIds: [] })),
      // 交接只回「开始了」：文档路径由宿主那一条通知给
      handoff: vi.fn(async () => undefined),
      // `@` 补全的唯一来源：清单由会话提供，屏幕不碰本地磁盘
      // 清单与「建好了没有」一起回（`WorkspaceFiles`）：屏幕上分得出「扫完了、是空的」
      // 与「还在扫」—— 后者要继续挂着「扫描中…」并重问
      listWorkspaceFiles: vi.fn(async () => ({ state: "ready" as const, entries: fakeIndex })),
      // 子 Agent 自己的消息：按 `toolCallId` 取
      listSubAgentMessages: vi.fn(async (toolCallId: string) => subMessages.get(toolCallId) ?? []),
      // 渲染期现取：这一份在假会话里没有「流式」可走（真会话里是本次实时那份）
      subAgentMessages: (toolCallId: string) => subMessages.get(toolCallId) ?? [],
      /** 用例专用：登记某个工具调用下面的子 Agent 消息 */
      __subMessages: subMessages,
    };
    return session;
  };

  return { created, createFakeSession };
});

/**
 * 全部依赖改为**注入**（`Chat` 的 `deps`），不再 `vi.mock`：
 * 模块级 mock 是全局注册的，进程内共享模块（`isolate: false`）时会污染其他测试文件。
 */

import { Chat } from "./chat.js";
import { getCommandHints } from "../../commands/registry.js";
import type { ClipboardTextResult } from "../../clipboard.js";

/** 剪贴板桩：不打桩就会真去 spawn `pbpaste` / `wl-paste` */
const clipboardMock = vi.hoisted(() => ({
  image: { kind: "none" } as {
    kind: string;
    image?: { base64: string; mime: string };
    /** `kind: "too-large"` 时那一张有多少字节 */
    bytes?: number;
  },
  text: { kind: "unavailable" } as ClipboardTextResult,
  /** 屏幕传进来的单张字节上限（断言「这一层不比大小」用） */
  maxBytes: 0,
}));

/** 等 effect / Promise / FrameBuffer 合帧跑完（合帧间隔 60ms） */
const flush = async (ms = 4) => {
  // 先让一拍执行顺序，再计时：刚 mount 的屏「帧已经画出来了」不等于「按键有人接」
  // （见 {@link settle}）。少了这一拍，紧跟在 mount 后面的第一个键会被丢掉 ——
  // 负载高时这不是概率问题，是常常发生。
  await settle(1);
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 轮询直到条件成立（上限 `ms`，超时就抛错并说清在等什么）。
 *
 * 合帧间隔是 60ms，而按键触发的状态更新要等一次重渲染才会被下一个按键看到 ——
 * 用固定的 `flush(20)` 等这件事就是玄学：本机快的时候够、CI 或负载高的时候不够，
 * 于是同一份代码时红时绿。这里改成「等到可观测的效果出现」。
 */
const waitFor = async (predicate: () => boolean, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      // 超时就该红：把「等的是什么」带出来（只把它交给后面那句断言，失败信息看不出在等什么）
      throw new Error(`等不到：${predicate.toString()}（上限 ${ms}ms）`);
    }
    await flush(8);
  }
};

/**
 * 让出几拍宏任务 —— 让这一拍里**排在后面**的活先跑完。让的是执行顺序，不是一个时长。
 *
 * 帧是在 commit 里画的，而 `useInput` 的订阅落在 passive effect 里，同一拍里排在画帧**之后**
 * （React 的 Scheduler 在 Node 下走 `setImmediate`）：所以「某个屏幕刚画出来」还不等于
 * 「按键有人接」，此刻敲进去的键会被直接**丢掉**（实测），之后再睡多久都没用。
 */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** 取帧里输入框那一行的内容（分隔线之后、状态栏之前），用于判断草稿是否已经落到输入框 */
const inputLineOf = (frame: string): string => {
  const lines = frame.split("\n");
  const divider = lines.map((line) => line.includes("───")).lastIndexOf(true);
  return divider >= 0 ? (lines[divider + 1] ?? "") : "";
};

/** 状态栏把「数字 + 单位」用不换行空格绑定，断言前统一归一化 */
const normalised = (frame: string): string => frame.replace(/\u00a0/g, " ");

/** 一句话在帧里出现了几次（「同一条提示只说一次」这类断言用） */
const countOf = (frame: string, needle: string): number => frame.split(needle).length - 1;

/**
 * 等到输入区真的能收到键（会话就绪）。
 *
 * 发送后的 `busy` 翻转要等 Promise 回调 + 合帧，用固定 `flush(20)` 撞不撞得上全看
 * 机器快慢，于是同一条用例时红时绿（发版门禁被它卡住过一次）。
 *
 * 判据用「敲一个字符看输入框有没有回显」：有回显就证明编辑处理器在收键，
 * 随即退格清掉，不影响后续断言。
 *
 * 注：生成中**不再**失活（PRD 需求 3），所以这一招只能证明“键能进去”；
 * 需要“本次已落定”的用例自己用 `waitFor` 盯可观测的效果。
 */
const waitUntilEditable = async (
  stdin: { write: (data: string) => void },
  lastFrame: () => string | undefined,
) => {
  for (let i = 0; i < 60; i++) {
    stdin.write("z");
    await flush(16);
    if (inputLineOf(lastFrame() ?? "").includes("z")) {
      stdin.write("\u007f"); // Backspace：把探针字符退掉
      await flush(16);
      return;
    }
  }
};

/** 一份最小可用配置（`config.get` 出参里的 `config`：SDK 的 `AppConfig`） */
const fakeConfigView = () => ({
  endpoints: [],
  models: [],
  imageModels: [],
  defaultAgent: "default",
});

/** 一份 AgentDefinition（`agentDefinition.list` 的一项） */
const fakeDefinition = () => ({
  id: "default",
  name: "Default",
  messages: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * 假连接 —— 两面对外：
 *
 *   · `api`（tRPC 客户端）：会话域、命令层与**配置向导**的读写都走它；
 *   · `call`（旧路）：还没搬的域（`session.list` / `host.*` …）仍按旧方法名说话。
 *
 * 向导的读写与会话的说话落在**同一条连接**上，所以这里一张 procedure 流水
 * （{@link FakeConnection.apiCalls}）就够断言「那次写有没有真的发出去」。
 */
const fakeConnection = (
  options: {
    config?: unknown;
    notices?: unknown[];
    /** `asset.get` 怎么回（用 `assetId` 决定）；不给就是「用例没打桩」 */
    assetGet?: (assetId: string) => { mime: string; base64: string };
    /** `session.list` 回什么（这一段被别处删掉之后「换到哪一段」看它） */
    sessionList?: Array<{ id: string; name: string }>;
  } = {},
) => {
  const apiCalls: { method: string; params: any }[] = [];
  const config = () => options.config ?? fakeConfigView();

  const makeApi = (path: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, property: string) {
        if (property === "query" || property === "mutate") {
          const method = path.join(".");
          return async (params: any = {}) => {
            apiCalls.push({ method, params });
            switch (method) {
              case "config.get":
                return { config: config(), presets: {} };
              case "config.agents.list":
                return [fakeDefinition()];
              case "config.mcp.list":
                return { servers: [] };
              case "notice.list":
                // 「清全部」先数一遍整个库（不带 `sessionId`）：条数由用例摆
                return options.notices ?? [];
              case "session.list":
                // 这一段被删之后要问「同项目里还有哪几段」（`moveAfterGone`）：缺省一段不剩
                return options.sessionList ?? [];
              case "notice.deleteAll":
                // 宿主这一档没有回执（`notice.deleteAll` 的 out 是空）
                return undefined;
              case "asset.get":
                // 图片那条路：取回来的就是字节（尺寸不在这条口的出参里）
                if (options.assetGet === undefined) throw new Error("用例没给 asset.get 打桩");
                return options.assetGet(params.assetId);
              default:
                // 其余写类 procedure（用例不走它们）只记流水，回改完之后那一份配置
                return { config: config() };
            }
          };
        }
        return makeApi([...path, property]);
      },
    });

  return {
    call: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({})),
    api: makeApi([]) as never,
    apiCalls,
  };
};

type FakeConnection = ReturnType<typeof fakeConnection>;

const mount = (
  options: {
    initialInput?: string;
    /** 撤回回填的那几张 Asset（与 `initialInput` 同一次回填的两半） */
    initialAssetIds?: readonly string[];
    /** 重挂载附属的那一句系统提示（`/back` 的「删掉几条」就走这一格） */
    initialNotice?: string;
    resume?: boolean;
    workspaceId?: string;
    connection?: FakeConnection;
    /** 启动期已经知道的那句失败（会话那一层已经试过、没开成） */
    bootError?: string;
    /** 日志 → 通知栏那一格（要在用例里推一条日志时自己给一个，否则用一个新的空壳） */
    logNotices?: LogNotices;
    /** 图片那条路：用本机默认程序打开（替身；不打就真 spawn，这一组用例自己给） */
    openPath?: (
      file: string,
    ) => Promise<{ kind: "opened" } | { kind: "no-command"; command: string }>;
    /** 图片那条路：把字节落到临时文件（替身） */
    writeTempImage?: (base64: string, mime: string) => Promise<string>;
  } = {},
) => {
  const connection = options.connection ?? fakeConnection();
  return render(
    <Chat
      agentId="default"
      initialInput={options.initialInput}
      initialAssetIds={options.initialAssetIds}
      initialNotice={options.initialNotice}
      resume={options.resume}
      workspaceId={options.workspaceId}
      bootError={options.bootError}
      // 「这台宿主是不是本机」是连接的事实：屏幕只把它转给 `/ws`，不自己推
      workspaceHost={{ local: true, key: "local" }}
      deps={{
        // 那**一条**连接：会话说话与向导读写都从它走（屏幕没有兜底）
        connection: connection as any,
        // 会话注册表：屏幕只借、不管生死（PRD D4）。假注册表只做两件事 ——
        // `enter` 转给假会话、`detach` 记下听众身份
        sessions: {
          enter: async (sessionOptions: unknown, notifier: any) => {
            const session = createFakeSession(notifier);
            created.notifier = notifier;
            created.session = session;
            // 存下屏幕交给会话的选项：`resume` 这类「意图」是否透传就看它
            created.options = sessionOptions;
            return session;
          },
          detach: (sink: any) => {
            created.detached.push(sink);
          },
          // 这段用例里不走这两条（`/new` 与 `/sessions` 的切换在命令层与注册表层钉住）
          newSegment: async () => {
            created.newSegments += 1;
            return "chat_next";
          },
          list: () => [],
          // `/delete` / `/ws delete` 真删之前的报名（这一组不走那两条命令）
          drop: vi.fn(),
          expectOwnRemoval: () => () => {},
        } as any,
        // 日志出口：屏幕仅把它转给命令层（`/ws` / `/lang` 两处的失败）
        logger: QUIET_LOG,
        // 日志 → 通知栏那一格：屏幕挂上来时把本屏的通知通道注册成它的入口
        logNotices: options.logNotices ?? new LogNotices({ logFile: null }),
        readClipboardImage: async (_deps: unknown, maxBytes?: number) => {
          // 记下屏幕传进来的上限：上限的真相在宿主，屏幕不该自己拍
          clipboardMock.maxBytes = maxBytes ?? 0;
          return clipboardMock.image as any;
        },
        readClipboardText: async () => clipboardMock.text,
        // 图片那两格只在用例里换（缺省就是 `system-editor.ts` 的真实现；不打桩就不该被调到）
        ...(options.openPath === undefined ? {} : { openPath: options.openPath }),
        ...(options.writeTempImage === undefined ? {} : { writeTempImage: options.writeTempImage }),
      }}
    />,
  );
};

describe("Chat 集成（拆分前的护栏）", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
    created.detached.length = 0;
  });

  it("会话就绪后渲染输入占位与状态栏身份块", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("输入消息");
    expect(frame).toContain("gpt-6-astra");
    unmount();
  });

  it("启动期已经知道开不出来（配置残缺）：首帧就上失败屏，且不再去开一次会话", async () => {
    const { lastFrame, unmount } = mount({
      // 宿主渲染好的那一句（`error.modelUnresolved`），客户端不翻译也不改写
      bootError: "这个助手定义没有可用的模型 —— 给它挑一个模型，或者在设置里指定一个默认模型。",
    });
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("无法启动会话");
    expect(frame).toContain("这个助手定义没有可用的模型");
    // 改配置的入口就在屏上（不是启动期报一句然后退出）
    expect(frame).toContain("按 k 打开配置中心");
    // 会话层已经试过而且没开成：不再问一遍宿主（同一个错问两遍没有好处）
    expect(created.session).toBeNull();
    unmount();
  });

  it("空会话在会话区顶部显示欢迎块（logo + 标语），且不阻塞输入", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("终端里的 AI 协作台");
    // 品牌 logo（宽终端出 6 行宽版，窄终端退化成单行）
    expect(frame).toMatch(/█████╗|AI · ZEN/);
    // 底部输入框与状态栏照常在
    expect(frame).toContain("输入消息");
    unmount();
  });

  it("发出首条消息后欢迎块消失", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame() ?? "").not.toContain("终端里的 AI 协作台");
    unmount();
  });

  it("回车把输入框内容作为消息发出", async () => {
    const { stdin, unmount } = mount();
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await flush();
    expect(created.session.send).toHaveBeenCalledWith("你好", [], []);
    unmount();
  });

  // -------------------------------------------------------------------------
  // 按发送的两步（屏幕这一侧）：开开关 → 投递。复活归会话层的 `send()`（PRD 4.1「生死」：
  // 客户端点发送时先判这段是死是活，死的就调接口复活、再投递）。
  // -------------------------------------------------------------------------

  /** 走真按键那条路提交一句（写进输入框 → 回车），等一个可观测的结果由调用方给 */
  const submit = async (stdin: { write: (data: string) => void }, text: string) => {
    stdin.write(text);
    await flush();
    stdin.write("\r");
    await flush();
  };

  it("死了：屏幕**不**自己叫一次 `start`（那一步在会话层的 `send` 里，屏幕再叫一次就是白跑一趟）", async () => {
    const { stdin, unmount } = mount();
    await flush();
    // 宿主报「这一段没有 agent」（死活那一格是现读的，不是我们记的）
    created.session.alive = false;
    created.notifier.onChange(true);
    await flush();

    await submit(stdin, "醒醒");
    await waitFor(() => created.session.send.mock.calls.length === 1);

    // 复活与投递只由会话层编排一次：屏幕这边只投
    expect(created.session.start).not.toHaveBeenCalled();
    expect(created.session.send).toHaveBeenCalledWith("醒醒", [], []);
    // 输出开关本来就开着：没人去动它（每一步只看自己那一格）
    expect(created.session.resumeOutput).not.toHaveBeenCalled();
    unmount();
  });

  it("输出闸关着：先 `resume` 开闸，再 `send`（「用户点发送就是继续」）", async () => {
    const { stdin, unmount } = mount();
    await flush();
    // 宿主报「输出开关关着」（中断之后就是这个样子）
    created.session.outputPaused = true;
    created.notifier.onChange(true);
    await flush();

    await submit(stdin, "接着说");
    await waitFor(() => created.session.send.mock.calls.length === 1);

    expect(created.session.resumeOutput).toHaveBeenCalledTimes(1);
    expect(created.session.resumeOutput.mock.invocationCallOrder[0]!).toBeLessThan(
      created.session.send.mock.invocationCallOrder[0]!,
    );
    // 活着：不必复活
    expect(created.session.start).not.toHaveBeenCalled();
    unmount();
  });

  it("都正常：`start` / `resume` 都不调，只投递", async () => {
    const { stdin, unmount } = mount();
    await flush();

    await submit(stdin, "你好");
    await waitFor(() => created.session.send.mock.calls.length === 1);

    expect(created.session.send).toHaveBeenCalledWith("你好", [], []);
    expect(created.session.start).not.toHaveBeenCalled();
    expect(created.session.resumeOutput).not.toHaveBeenCalled();
    unmount();
  });

  it("`resume` 失败：说清是这一步，`send` 不执行", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.outputPaused = true;
    created.session.resumeOutput = vi.fn(async () => {
      throw new Error("正在交接");
    });
    created.notifier.onChange(true);
    await flush();

    await submit(stdin, "发不出去的话");
    await waitFor(() => (lastFrame() ?? "").includes("继续失败"));

    expect(lastFrame() ?? "").toContain("正在交接");
    expect(created.session.send).not.toHaveBeenCalled();
    unmount();
  });

  it("手上在动时：阶段行在分隔线之上，输入框仍在分隔线之下", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    // 宿主报「手上在动」（`state` 那一格）—— 这一格是契约给的，不是我们记的
    created.session.status = "working";
    created.notifier.onChange(true);
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("连接中");
    expect(inputLineOf(frame)).toContain("输入消息");

    // 阶段行紧贴在分隔线**之上**（它只占自己那一行，不抢输入框的位置）
    const phase = rowOf(frame, "连接中");
    const divider = rowOf(frame, "───");
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBe(divider - 1);
    // 输入框照旧在分隔线之下（不再被 Spinner 顶替）
    expect(inputLineOf(frame)).toContain("输入消息");
    unmount();
  });

  /**
   * 队里的话**只由排队区回显**：阶段行说的是「这一任此刻在干什么」，它不再兼说一句「排队中」。
   *
   * 两件事分开看才知道各自说对了没有：那一条「排队中」出现在**队列那两句自己的行首**
   * （`inbox.pending` 前缀），而不是出现在阶段行上。
   */
  it("队里的话由排队区自己回显，阶段行不喊「排队」", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    created.session.status = "working";
    // 队里压着两句还没被取走（`session.state.inbox` 现读）
    created.session.inbox = [
      { messageId: "i-1", source: { kind: "user" }, createdAt: "t", preview: "还有一句" },
      { messageId: "i-2", source: { kind: "user" }, createdAt: "t", preview: "再一句" },
    ];
    created.notifier.onChange(true);
    await flush();

    const frame = lastFrame() ?? "";
    const rows = frame.split("\n");
    const divider = rowOf(frame, "───");
    // 排队区：那两句连同它们自己的「排队中」前缀都在分割线之上
    expect(rowOf(frame, "还有一句")).toBeLessThan(divider);
    expect(rowOf(frame, "再一句")).toBeLessThan(divider);
    // 阶段行说的是手上在干什么（这里：这一批还没落下来 → 连接中），不是「排队中」
    const phaseRow = rows.findIndex((row) => row.includes(t("phase.connecting")));
    expect(phaseRow).toBeGreaterThanOrEqual(0);
    expect(phaseRow).toBeLessThan(divider);
    // 「排队」只出现在队列那两句自己的行首（`inbox.pending` 前缀），一行一句
    const queueRows = rows.filter((row) => row.includes("排队"));
    expect(queueRows).toHaveLength(2);
    unmount();
  });

  it("状态栏摆着本次 / 累计 tok（数字由会话层从消息的 `usage` 上算）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    const frame = normalised(lastFrame() ?? "");
    expect(frame).toContain("本次 1284 tok");
    expect(frame).toContain("累计 20345 tok");
    created.session.lastTokens = null;
    created.session.totalTokens = null;
    created.notifier.onChange(true);
    await flush();
    // 一条带 `usage` 的 assistant 都还没有：整段不占位，不写 0 假装
    expect(normalised(lastFrame() ?? "")).not.toContain("tok");
    unmount();
  });

  it("交接把记忆换短之后：屏幕接着显示换过之后的那份（不因为显示起点越界变成一片空白）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.messages.push(
      { id: "m1", role: "user", content: "旧问题" },
      { id: "m2", role: "assistant", content: "旧答复" },
    );
    created.notifier.onChange(true);
    await flush();
    expect(lastFrame() ?? "").toContain("旧答复");

    // Ctrl+L：显示起点推到末尾（这一段此后不再重画旧内容）
    stdin.write("\u000c");
    await flush();
    expect(lastFrame() ?? "").not.toContain("旧答复");

    // 交接换记忆：同一段会话（id 不变），消息只剩一条断点消息 —— 起点落在末尾之外了
    created.session.messages.length = 0;
    created.session.messages.push({
      id: "break-1",
      role: "assistant",
      content: "接手：见交接文档",
    });
    created.notifier.onChange(true);
    await flush();

    expect(lastFrame() ?? "").toContain("接手：见交接文档");
    unmount();
  });

  it("不忙时没有阶段行（这一行不存在，也不占行）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("连接中");
    expect(frame).not.toContain("处理中");
    // 分隔线直接压在输入框上方：中间没有任何“阶段”行
    expect(inputLineOf(frame)).toContain("输入消息");
    unmount();
  });

  it("手上在动时仍然能输入、能回车发送（客户端不拦「运行中不许发」）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 第一轮还在跑：屏幕停在忙碌态（忙闲那一格由宿主说）
    created.session.status = "working";
    created.notifier.onChange(true);
    stdin.write("hi");
    await flush();
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("连接中"));

    // 忙碌中继续打字：按键真的落进输入框
    stdin.write("还有一句");
    await waitFor(() => inputLineOf(lastFrame() ?? "").includes("还有一句"));
    // 阶段行也还在（没被这一次输入赶走）
    expect(lastFrame() ?? "").toContain("连接中");

    // 回车：没有客户端的「运行中禁止发送」分支，掉头走既有 `session.send`
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 2);
    expect(created.session.send).toHaveBeenLastCalledWith("还有一句", [], []);
    unmount();
  });

  it("手上的活在跑时 `/` 仍能唤出命令菜单（运行中允许执行命令）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.status = "working";
    created.notifier.onChange(true);
    stdin.write("hi");
    await flush();
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("连接中"));

    stdin.write("/e");
    await waitFor(() => (lastFrame() ?? "").includes("/editor"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/exit");
    // 菜单仍在分隔线之上（阶段行也在上面，两者不抢输入框那一行）
    expect(rowOf(frame, "/editor")).toBeLessThan(rowOf(frame, "───"));
    expect(inputLineOf(frame)).toContain("/e");
    unmount();
  });

  it("通知通道的内容出现在提示栏（不进会话转录）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    created.notifier.onNotice("配置已更新：模型名");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("配置已更新：模型名");
    unmount();
  });

  /**
   * 这条要连走两屏（`/key` → 输入 → 保存），用例自己的等待上限合计 8000ms —— 比 vitest
   * 默认的 `testTimeout`（5000ms，本仓没有改过）还长。所以显式放宽这一条的时限。
   *
   * 为什么不把那些 2000/4000 调小：它们是「慢机器上最多等多久」，调小了就在慢机器上误伤；
   * 而**预算合计 > 时限**这个结构问题，只能从时限这一侧修（逻辑写错时仍然会在第一个
   * 等不到的 `waitFor` 上以清晰的断言失败报出来，不会因为时限放宽而变成挂死）。
   */
  it("向导落盘走那条连接：`/key` 保存时调 config.endpoints.update", async () => {
    // 有模型 + 端点的配置，`/key` 才能定位到「当前模型用的那个端点」；密钥空 = 要人填
    const connection = fakeConnection({
      config: {
        ...fakeConfigView(),
        endpoints: [
          {
            id: "ep1",
            name: "EP",
            baseUrl: "https://api.example.com/v1",
            // 密钥那一格是空串 = 还没配（`resolveCredential` 据此判定 `configured: false`）
            apiKey: "",
          },
        ],
        models: [
          {
            id: "gpt-6-astra",
            name: "Astra",
            endpointId: "ep1",
            tokenThresholds: { handoff: 1, guard: 2 },
          },
        ],
      },
    });
    const { stdin, lastFrame, unmount } = mount({ connection });
    await waitUntilEditable(stdin, lastFrame);

    stdin.write("/key");
    await flush();
    stdin.write("\r");
    // 向导整屏接管（标题含「设置 API Key」）—— 配置也是从那条连接读出来的
    await waitFor(() => (lastFrame() ?? "").includes("设置 API Key"), 4000);
    // 帧先出现、向导自己的 useInput 监听稍后（mount 后的 effect）才就位：
    // 不等这一步就敲字，按键会落在一个还没人收的窗口里（实测丢字）。
    // 让出几拍宏任务（`setImmediate`）—— 让的是**执行顺序**，不是一个时长（`flush(40)` 就是
    // 赌 40ms 够：负载高时会睡进那个窗口，键直接丢掉，之后再等多久都没用）。
    await settle();

    stdin.write("sk-test-123");
    // 看到掩码回显再回车：状态与渲染就绪后，Enter 拿到的才是刚输入的值
    await waitFor(() => (lastFrame() ?? "").includes("••"), 2000);
    stdin.write("\r");
    await flush(20);
    await waitFor(
      () => connection.apiCalls.some((one) => one.method === "config.endpoints.update"),
      2000,
    );

    // 写的是**procedure**，不是某个本地文件：这一跳就是「写到宿主那份配置」
    const write = connection.apiCalls.find((one) => one.method === "config.endpoints.update");
    expect(write).toBeTruthy();
    // 只发改的那一格（`update` 是合并语义：省略 = 保留原值）
    expect(write!.params).toEqual({ id: "ep1", change: { apiKey: "sk-test-123" } });
    unmount();
  }, 15_000);

  /**
   * `/config` 打开配置中心：整屏接管读的那三份快照都来自**同一条连接**。
   *
   * 菜单里印着读回来的端点摘要（`✓` 来自配置里那一格），所以「读到了哪一份」在帧上看得见 ——
   * 这条盖的是「chat 打开的向导接的是那条连接」，具体每一步写什么由 `config-wizard.test.tsx`
   * 逐条盖（那边是同一个 `api` 接缝）。
   */
  it("`/config` 打开的配置中心读的是那条连接给的配置", async () => {
    const connection = fakeConnection({
      config: {
        ...fakeConfigView(),
        endpoints: [
          {
            id: "ep1",
            name: "EP",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-live-1",
          },
        ],
        models: [
          {
            id: "gpt-6-astra",
            name: "Astra",
            endpointId: "ep1",
            tokenThresholds: { handoff: 1, guard: 2 },
          },
        ],
      },
    });
    const { stdin, lastFrame, unmount } = mount({ connection });
    await waitUntilEditable(stdin, lastFrame);

    stdin.write("/config");
    await flush();
    stdin.write("\r");
    // 等「三份快照都读回来、向导整屏接管」：命令候选菜单里也有「配置中心」这几个字，
    // 只等它会出现会把「菜单还没收起」当成「向导已打开」
    await waitFor(
      () =>
        connection.apiCalls.some((one) => one.method === "config.mcp.list") &&
        (lastFrame() ?? "").includes("EP ✓"),
      10_000,
    );
    const methods = connection.apiCalls.map((one) => one.method);
    expect(methods).toContain("config.get");
    expect(methods).toContain("config.agents.list");
    expect(methods).toContain("config.mcp.list");
    unmount();
  }, 20_000);

  /**
   * 候选比屏幕多时选择器**自己滚动**，不再截断、也不把画面顶高。
   *
   * 这条走的是真键盘：`/model` → 选端点 → 在 30 条模型里一路按到底 → 回车。旧行为下
   * 二级那份清单会被 `pickerCapacity` 之外的部分直接丢掉（或整帧溢出把状态栏挤出屏幕），
   * 于是「最后一个模型」永远选不到；现在它必须选得到，且状态栏一直在。
   */
  it("`/model` 二级清单比窗高：能一路滚到最后一条，状态栏不被顶出屏幕", async () => {
    const models = Array.from({ length: 30 }, (_v, index) => ({
      id: `m-${index + 1}`,
      name: `模型 ${index + 1}`,
      endpointId: "ep-1",
      tokenThresholds: { handoff: 1000, guard: 2000 },
      defaultParams: {},
    }));
    const connection = fakeConnection({
      config: {
        endpoints: [
          { id: "ep-1", name: "端点一", baseUrl: "https://example.test/v1", apiKey: "sk-x" },
        ],
        models,
        imageModels: [],
        defaultAgent: "default",
      },
    });
    const { stdin, lastFrame, unmount } = mount({ connection });
    await flush();

    stdin.write("/model");
    await flush();
    stdin.write("\r");
    // 第一级：端点（帧画出来 ≠ 按键有人接，见 `waitFor` 的文件头）
    await waitFor(() => (lastFrame() ?? "").includes("端点一"));
    await flush(20);
    stdin.write("\r");
    // 第二级：30 条模型 —— 只画得下窗口那几条，但每一条都按得到
    await waitFor(() => (lastFrame() ?? "").includes("模型 1"));
    await flush(20);
    for (let i = 0; i < 29; i += 1) {
      stdin.write("\u001b[B");
    }
    await flush(20);

    // 窗口里出现的是尾段（首行说「上面还有」），而且最后一条被高亮
    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯ 模型 30");
    expect(frame).toContain("↑");
    // 状态栏还在（覆盖层没有把画面顶高）
    expect(frame).toContain("◆");

    stdin.write("\r");
    await waitFor(() => (created.session.updateModel as any).mock.calls.length > 0);
    expect(created.session.updateModel).toHaveBeenCalledWith("m-30");
    unmount();
  }, 20_000);

  it("手上在动时 Ctrl+C 触发中止（不退出）", async () => {
    const { stdin, unmount } = mount();
    await flush();
    // 忙闲那一格来自宿主：在动的时候 Ctrl+C 才是「中止」
    created.session.status = "working";
    created.notifier.onChange(true);
    await flush();
    stdin.write("\u0003");
    // 等「中止真的发生了」（一次异步调用），不是数那 4ms
    await waitFor(() => created.session.abort.mock.calls.length > 0);
    expect(created.session.abort).toHaveBeenCalled();
    unmount();
  });

  it("PgUp 把视口切到滚动态（状态栏提示变更）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 塞满转录，保证「一屏放不下」——否则贴底时往上翻会被钳制回 null，观察不到变化
    for (let i = 0; i < 200; i++) {
      created.session.messages.push({ id: `m${i}`, role: "user", content: `第 ${i} 行` });
    }
    stdin.write("x"); // 任意按键触发一次重渲染，让新消息上屏
    await flush();
    expect(lastFrame() ?? "").toContain("Enter 发送");
    stdin.write("\u001b[5~");
    await flush();
    expect(lastFrame() ?? "").toContain("正在翻看历史");
    unmount();
  });

  it("斜杠前缀弹出命令候选菜单", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("/e");
    await flush();
    const frame = lastFrame() ?? "";
    // `/editor` / `/exit` 的说明来自词典，出现即说明候选菜单已渲染
    expect(frame).toContain("/editor");
    expect(frame).toContain("/exit");
    unmount();
  });

  // ==================== ↑/↓：多行先移光标，到边界才翻历史 ====================

  it("光标已在首行时 ↑ 才翻历史（单行输入保持原行为）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("hello");
    await flush();
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    expect(created.session.send).toHaveBeenCalledTimes(1);

    // 输入框已空、单行 → ↑ 拿回历史，再回车又发一遍同样的内容
    await waitUntilEditable(stdin, lastFrame);
    stdin.write("\u001b[A");
    await waitFor(() => inputLineOf(lastFrame() ?? "").includes("hello"));
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 2);
    expect(created.session.send).toHaveBeenCalledTimes(2);
    expect(created.session.send.mock.calls[1]![0]).toBe("hello");
    unmount();
  });

  // ==================== 多行光标移动（↑/↓ 优先在行间移动）====================

  it("输入 ≥ 2 行时 ↑/↓ 先移动光标，不到首/末行不翻历史", async () => {
    const { stdin, lastFrame, unmount } = mount({ initialInput: "aa\nbb" });
    await flush();

    stdin.write("\u001b[A"); // ↑：光标从第二行行尾移到第一行行尾
    await flush(20);
    stdin.write("X"); // 插在第一行 → 证明光标确实上去了
    await flush();
    expect(lastFrame() ?? "").toContain("aaX");

    stdin.write("\u001b[B"); // ↓：回到第二行行尾
    await flush(20);
    stdin.write("Y");
    await flush();
    expect(lastFrame() ?? "").toContain("bbY");
    unmount();
  });

  // ==================== 输入区限高 8 行 ====================

  /** 20 行草稿：L0 … L19；挂载时光标在末尾（第 19 行） */
  const twentyLines = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");

  it("草稿超过 8 行时只渲染 8 行，且光标在末行时窗口贴底", async () => {
    const { lastFrame, unmount } = mount({ initialInput: twentyLines });
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("L19"); // 光标所在行一定可见
    expect(frame).toContain("L12");
    expect(frame).not.toContain("L11"); // 窗口上方折叠
    // 只渲染 8 行输入（1 提示符行 + 7 缩进行）
    expect(frame.split("\n").filter((row) => /^\s*(❯ )?L\d+$/.test(row.trimEnd()))).toHaveLength(8);
    unmount();
  });

  it("窗口跟随光标：在末行按 ↑ 后整窗上移一行（不是钉在末尾）", async () => {
    const { stdin, lastFrame, unmount } = mount({ initialInput: twentyLines });
    await flush();
    stdin.write("\u001b[A"); // 光标到第 19 行 → 窗口 from = 11
    await flush(20);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("L18");
    expect(frame).toContain("L11");
    expect(frame).not.toContain("L19"); // 已滚到窗口下方之外
    expect(frame).not.toContain("L10");
    unmount();
  });

  // ==================== 底部锚定菜单 ====================

  /** 找出包含某片段的行号（-1 = 没渲染） */
  const rowOf = (frame: string, needle: string) =>
    frame.split("\n").findIndex((row) => row.includes(needle));

  it("斜杠菜单自底部锚定：首项紧贴分隔线，其余候选向上生长", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("/c"); // 候选只有 /clear 与 /config 两条，便于定位
    await flush();
    const frame = lastFrame() ?? "";
    const clear = rowOf(frame, "/clear");
    const config = rowOf(frame, "/config");
    const separator = rowOf(frame, "───");
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(config).toBeGreaterThanOrEqual(0);
    // 数据顺序 clear → config；视觉上 config 在 clear 上方，clear 紧贴输入框的分隔线
    expect(config).toBeLessThan(clear);
    expect(separator).toBe(clear + 1);
    // 默认高亮第一条（最底下那条）
    expect(frame.split("\n")[clear]).toContain("❯");
    unmount();
  });

  /**
   * 高亮项（菜单行的 `❯` 在**两格**缩进之后；输入行的 `❯` 只有一格缩进，不能用它）。
   *
   * 方向断言**必须用 ≥ 3 条候选**：只有 2 条时 `(i−1+n)%n` 与 `(i+1)%n` 结果恒等，
   * 映射写反了也照样“绿”—— 真机上 19 条候选才暴露出 `↑` 实际冲向最顶端。
   */
  const highlightedCommand = (frame: string): string | null => {
    for (const row of frame.split("\n")) {
      const match = /^ {2}❯ (\S+)/.exec(row);
      if (match) return match[1]!;
    }
    return null;
  };

  it("菜单打开时 ↑ 选上一条（相邻项，视觉上移）、↓ 选下一条，到顶/底才环绕", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("/"); // 全部 19 条候选
    await flush();
    const hints = getCommandHints();
    const name = (i: number) => `/${hints[i]!.names[0]}`;
    expect(hints.length).toBeGreaterThan(2);

    // 初始：高亮最底那条（`hints[0]`）
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(0));

    // ↑：上移**一格**到相邻项，而不是回卷到最顶（候选够多时才区分得出来）
    stdin.write("\u001b[A");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(1));

    // ↓：回到最底
    stdin.write("\u001b[B");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(0));

    // ↓ 在最底 → 环绕到最顶（视觉上从底部穿出、从顶部冒出来）
    stdin.write("\u001b[B");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(hints.length - 1));

    // ↑ 在最顶 → 环绕回最底
    stdin.write("\u001b[A");
    await flush(20);
    expect(highlightedCommand(lastFrame() ?? "")).toBe(name(0));
    unmount();
  });

  it("`@` 菜单与斜杠菜单共用同一套底部锚定菜单（目录带尾斜杠）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    await flush(); // 等文件清单回填（`session.listWorkspaceFiles()` 是 Promise）
    const frame = lastFrame() ?? "";
    const readme = rowOf(frame, "README.md");
    // 「src/tui/」是「src/tui/screens/chat.tsx」的子串，必须锁行尾才能定位到那 InboxEntry 录
    const dir = frame.split("\n").findIndex((row) => row.trim().endsWith("src/tui/"));
    const separator = rowOf(frame, "───");
    expect(readme).toBeGreaterThanOrEqual(0);
    expect(dir).toBeGreaterThanOrEqual(0);
    // 空查询时 rankPaths 按「浅 → 短」排序：README.md < src/tui < src/tui/screens/chat.tsx
    expect(dir).toBe(readme - 1);
    expect(readme).toBe(separator - 1);
    unmount();
  });

  // ==================== Agent 栏目（主 / 子 Agent 切换）====================

  /**
   * 造一个 subagent（`session.state.subAgents` 的元素：`toolCallId` / `name` / `state`）。
   *
   * 它自己的消息不在这份名册里 —— 名册只说「挂在哪、叫什么、散没散场」，取内容要再走
   * `message.list` 带 `toolCallId`。假会话的 `listSubAgentMessages` 因此按 id 查同一张表。
   */
  const addSubAgent = (
    content: string,
    name = "reviewer",
    state: "working" | "ended" = "working",
  ) => {
    const n = created.session.subAgents.length + 1;
    const toolCallId = `call-${n}`;
    // 名册上那一行就是 `session.state.subAgents` 的元素：谁、叫什么、在哪一格
    created.session.subAgents.push({ toolCallId, name, state });
    created.session.__subMessages.set(toolCallId, [{ id: `s${n}`, role: "assistant", content }]);
    return toolCallId;
  };
  /** 触发一帧重绘（不走输入框：敲字符会让「输入为空」的前提失效） */
  const repaint = async () => {
    created.notifier.onChange(true);
    await flush();
  };

  it("有子助手时出现栏目（主助手 + 各个子助手的名字）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    // 没有子 AgentDefinition 时整条栏目不存在
    expect(lastFrame() ?? "").not.toContain("主助手");

    addSubAgent("子结论", "reviewer");
    addSubAgent("审查结论", "writer");
    await repaint();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("主助手");
    // 标签是宿主给的 `name`（这次委派叫什么），不是客户端现编号
    expect(frame).toContain("reviewer");
    expect(frame).toContain("writer");
    unmount();
  });

  /**
   * PRD 3.9「本次结束栏目自动收起」。
   *
   * 名册的清空点在 core 外循环的下一批开头 —— 所以这一段答完之后，那条栏目会连同几个绿点
   * 一直挂着，直到用户下次说话。但客户端手上有「这一段闲下来了」这个事实（`activity`），
   * 配上名册里全是 `ended`，就该按 PRD 的字面收起来。
   */
  it("一段闲下来且子助手全散场：栏目自动收起；再有在动的又出来", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    addSubAgent("子结论", "reviewer", "ended");
    // 仍在忙：栏目挂着（跑完到清名册之间还有一拍）
    created.session.status = "working";
    await repaint();
    expect(lastFrame() ?? "").toContain("reviewer");

    // 这一段闲下来了、名册里全散场 → 收起
    created.session.status = "idle";
    await repaint();
    expect(lastFrame() ?? "").not.toContain("主助手");

    // 又有 subagent 在动 → 又出来（收起不是「把名册删掉」）
    created.session.status = "working";
    addSubAgent("第二个", "writer");
    await repaint();
    expect(lastFrame() ?? "").toContain("writer");
    unmount();
  });

  // ==================== subagent 结束了要说一句（PRD 3.9）====================

  /**
   * 跑完了要报一声：栏目随后会自动收起（「本次结束栏目自动收起」），收起之后再没谁提它。
   * 一条结局只说一次 —— 重画一帧不该再多出一条。
   */
  it("子助手跑完：说一句「已完成」，且同一条结局只说一次", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    addSubAgent("子结论", "reviewer", "working");
    await repaint();
    // 还在跑：没有结局可说
    expect(lastFrame() ?? "").not.toContain(t("notice.subAgentDone", { name: "reviewer" }));

    created.session.subAgents[0].state = "ended";
    await repaint();
    const said = t("notice.subAgentDone", { name: "reviewer" });
    // 结局是**下一帧**才进栏位：那条通知在渲染后的 effect 里 push，push 又要一次重渲染才画出来。
    // 所以等它出现，不赌「一次 flush 刚好盖住两帧」（`waitFor` 的注释里写着同一个理由）。
    await waitFor(() => (lastFrame() ?? "").includes(said));

    // 再画一帧：同一格、同一条结局消息，不重说
    await repaint();
    expect(countOf(lastFrame() ?? "", said)).toBe(1);
    unmount();
  });

  /**
   * 失败必须显示失败，而且原因照传宿主的原话（不另编一句取代它）。
   */
  it("子助手失败：说一句失败，原因就是宿主给的那句话", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    addSubAgent("半截话", "reviewer", "working");
    await repaint();

    const message = created.session.__subMessages.get("call-1")[0];
    message.status = "error";
    message.error = { code: "request-failed", message: "ECONNREFUSED 127.0.0.1:443" };
    created.session.subAgents[0].state = "ended";
    await repaint();

    const expected = t("notice.subAgentFailedWhy", {
      name: "reviewer",
      error: "ECONNREFUSED 127.0.0.1:443",
    });
    await waitFor(() => (lastFrame() ?? "").includes(expected));
    unmount();
  });

  /**
   * 宿主标了出错却没给原因：只说失败，不猜一个原因出来。
   */
  it("子助手失败但宿主没给原因：只说失败，不编原因", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    addSubAgent("半截话", "reviewer", "working");
    await repaint();

    created.session.__subMessages.get("call-1")[0].status = "error";
    created.session.subAgents[0].state = "ended";
    await repaint();

    const said = t("notice.subAgentFailed", { name: "reviewer" });
    await waitFor(() => (lastFrame() ?? "").includes(said));
    // 没原因就不编：那一句里没有冒号后面的内容
    expect(lastFrame() ?? "").not.toContain("失败：");
    unmount();
  });

  /**
   * 被叫停不是失败（PRD D14）：两种说法不共用一条文案。
   */
  it("子助手被叫停：说一句被叫停（不报成失败）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    addSubAgent("半截话", "reviewer", "working");
    await repaint();

    created.session.__subMessages.get("call-1")[0].status = "aborted";
    created.session.subAgents[0].state = "ended";
    await repaint();

    const said = t("notice.subAgentAborted", { name: "reviewer" });
    await waitFor(() => (lastFrame() ?? "").includes(said));
    expect(lastFrame() ?? "").not.toContain(t("notice.subAgentFailed", { name: "reviewer" }));
    unmount();
  });

  /**
   * 子 Agent 视图的数据形状（`messages` 而不是 `agent` 实例）—— 切到栏目读的是哪份会话。
   *
   * 只断言这一件事：屏幕读的是子 Agent 自己那份 messages，不是主会话的 messages。
   * 契约若退回「实例」形态，这条会直接红（`activeSub.agent` 取不到东西）。
   */
  it("子 AGENT 栏目显示子 Agent 自己的 messages（`message.list` 按 toolCallId 取回）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.messages.push({ id: "m1", role: "assistant", content: "主 Agent 的话" });
    addSubAgent("子 Agent 自己的话");
    await repaint();

    // →：输入框为空，切到那个子 Agent
    stdin.write("\u001b[C");
    await waitFor(() => (lastFrame() ?? "").includes("子 Agent 自己的话"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("子 Agent 自己的话");
    expect(frame).not.toContain("主 Agent 的话");
    // 内容不是从快照里拿的：宿主只给「几句话」，取内容要再问一次
    expect(created.session.listSubAgentMessages).toHaveBeenCalledWith("call-1");
    unmount();
  });

  /**
   * 「这一栏是空的」与「读不出来」是两件事：宿主拒了 `message.list` 时屏幕上原来什么都没有，
   * 用户看到的是「子 Agent 一句话都没说」—— 那是在替它说话。现在补一句，栏位照样是空的。
   */
  it("子 Agent 的消息读不出来：说一句（空栏与读不出来是两件事）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    addSubAgent("子 Agent 自己的话");
    created.session.listSubAgentMessages = vi.fn(async () => {
      throw new Error("宿主拒了 message.list");
    });
    await repaint();

    stdin.write("\u001b[C");
    await waitFor(() => (lastFrame() ?? "").includes("读那个子 Agent 的消息失败"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("宿主拒了 message.list");
    unmount();
  });

  it("输入框为空时 ←/→ 切换消息列表数据源（主 ↔ 子）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.messages.push({ id: "m1", role: "user", content: "主 Agent 的提问" });
    addSubAgent("子 Agent 的结论");
    await repaint();
    expect(lastFrame() ?? "").toContain("主 Agent 的提问");

    // →：切到子 Agent，列表换成它自己的 messages
    stdin.write("\u001b[C");
    await flush();
    const subFrame = lastFrame() ?? "";
    expect(subFrame).toContain("子 Agent 的结论");
    expect(subFrame).not.toContain("主 Agent 的提问");

    // →：再切一格循环回主 Agent
    stdin.write("\u001b[C");
    await flush();
    const mainFrame = lastFrame() ?? "";
    expect(mainFrame).toContain("主 Agent 的提问");
    expect(mainFrame).not.toContain("子 Agent 的结论");

    // ←：从主 Agent 反向切到最后一个子 Agent
    stdin.write("\u001b[D");
    await flush();
    expect(lastFrame() ?? "").toContain("子 Agent 的结论");
    unmount();
  });

  it("输入框有内容时 ←/→ 仍是移光标，不切栏目", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.messages.push({ id: "m1", role: "user", content: "主 Agent 的提问" });
    addSubAgent("子 Agent 的结论");
    await repaint();

    stdin.write("abc");
    await flush();
    stdin.write("\u001b[C");
    await flush();
    const frame = lastFrame() ?? "";
    // 视图没变，输入内容也没被破坏（左右键只移光标）
    expect(frame).toContain("主 Agent 的提问");
    expect(frame).not.toContain("子 Agent 的结论");
    unmount();
  });

  it("发送消息时自动切回主 Agent 视图（否则看不到自己的提问）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    addSubAgent("子 Agent 的结论");
    await repaint();
    stdin.write("\u001b[C");
    await flush();
    expect(lastFrame() ?? "").toContain("子 Agent 的结论");

    stdin.write("继续干");
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(created.session.send).toHaveBeenCalledWith("继续干", [], []);
    expect(frame).toContain("继续干");
    expect(frame).not.toContain("子 Agent 的结论");
    unmount();
  });
});

// ==================== Esc：继续 ⇄ 中断 互切（PRD 4.4）====================

/**
 * 一个键两个含义，靠**状态**分流：忙时它是中断，忙完而输出开关还关着时它是继续（PRD 4.4
 * 「实践中输入框里只放两个：一个『继续 ⇄ 中断』互切，一个『发送』」）。
 *
 * 优先级不许反：开关关着而手上还有活是正常组合（暂停只关开关、不收回已取在手上的那批），
 * 那时按 Esc 要的是「立刻停」。
 */
describe("Esc 的优先级：忙 > 闸关 > 清草稿", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
    created.detached.length = 0;
  });

  it("闸关着、手上没活：Esc 是「继续」（resume），草稿一句不丢", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 宿主报「输出开关关着」（中断之后就是这一格）
    created.session.outputPaused = true;
    created.notifier.onChange(true);
    await flush();

    stdin.write("还没发出去的话");
    await flush();
    stdin.write("\u001b"); // lone ESC 需 ~20ms（ink 的序列判定）
    await flush(40);

    expect(created.session.resumeOutput).toHaveBeenCalledTimes(1);
    // 这是「继续」，不是「停」—— 不能顺手掐一下
    expect(created.session.abort).not.toHaveBeenCalled();
    // 草稿留着：Esc 在这一档是开开关，不是清空键
    expect(inputLineOf(lastFrame() ?? "")).toContain("还没发出去的话");
    unmount();
  });

  it("闸关着但手上还有活：Esc 仍是中断（忙 > 闸关，优先级不许反）", async () => {
    const { stdin, unmount } = mount();
    await flush();
    // 开关关 + 忙：暂停（或上次中断）之后已经取在手上的那批还在跑，就是这个组合
    created.session.outputPaused = true;
    created.session.status = "working";
    created.notifier.onChange(true);
    await flush();

    stdin.write("\u001b");
    await flush(40);

    expect(created.session.abort).toHaveBeenCalledTimes(1);
    // 想的是「立刻停」，不能给它开开关
    expect(created.session.resumeOutput).not.toHaveBeenCalled();
    unmount();
  });

  it("闲着、闸开着：Esc 照旧清空草稿（老行为还在）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("要清掉的草稿");
    await flush();
    stdin.write("\u001b");
    await flush(40);

    expect(inputLineOf(lastFrame() ?? "")).not.toContain("要清掉的草稿");
    expect(created.session.resumeOutput).not.toHaveBeenCalled();
    expect(created.session.abort).not.toHaveBeenCalled();
    unmount();
  });

  it("闸关时快捷键提示换成「Esc 继续」那一档", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    // 开关开着：平时那一条
    expect(lastFrame() ?? "").toContain(t("input.hint.ready"));

    created.session.outputPaused = true;
    created.notifier.onChange(true);
    await flush();
    // 开关关着、手上没活：Esc 现在是继续，提示得说清（照旧是那条「键 + 动作」句式）
    expect(lastFrame() ?? "").toContain(t("input.hint.paused"));

    // 一忙起来 Esc 回到中断 → 提示回到平时那一条（不能一直挂着「继续」骗人）
    created.session.status = "working";
    created.notifier.onChange(true);
    await flush();
    expect(lastFrame() ?? "").not.toContain(t("input.hint.paused"));
    unmount();
  });

  it("resume 被拒（交接期间）：如实报「继续失败」，不静默也不重试", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    created.session.outputPaused = true;
    created.session.resumeOutput = vi.fn(async () => {
      throw new Error("正在交接");
    });
    created.notifier.onChange(true);
    await flush();

    stdin.write("\u001b");
    await waitFor(() => (lastFrame() ?? "").includes("继续失败"));

    expect(lastFrame() ?? "").toContain("正在交接");
    // 只按了一次就只试一次：重试是用户再按一下
    expect(created.session.resumeOutput).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("问题对象（到交接线时宿主提问）", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
  });

  /**
   * 宿主问过来的那道交接题（`Question`：题干是成品句、候选是「值 + 显示名」）。
   *
   * 这一版没有 `prompt` / `options` / `detail` 那几层：题干与候选名都是宿主渲染好的字符串。
   */
  const handoffQuestion = () => ({
    id: "q1",
    sessionId: "chat_test",
    message: "上下文已用 92%，要交接吗？",
    choices: [
      { value: "self", label: "原 agent 自交接" },
      { value: "summary", label: "独立摘要" },
      { value: "decline", label: "不交接" },
    ],
    blocking: true,
    // 时间一律 epoch 毫秒（宿主的口径）
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
  });

  it("面板照抄宿主的题目与三选一，回车选中即作答（交出候选的 value）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();

    const answering = created.options.onQuestion(handoffQuestion());
    // 等面板画出来、按键监听就位（监听在 mount 后的 effect 里装，抢在它之前敲字会丢）
    await waitFor(() => (lastFrame() ?? "").includes("原 agent 自交接"));
    await flush(40);
    const frame = lastFrame() ?? "";
    // 题目是宿主渲染好的那句，候选是它给的三条（顺序也不重排）
    expect(frame).toContain("上下文已用 92%，要交接吗？");
    expect(frame).toContain("原 agent 自交接");
    expect(frame).toContain("独立摘要");
    expect(frame).toContain("不交接");

    stdin.write("\r"); // 默认高亮第一项：「原 agent 自交接」
    await expect(answering).resolves.toBe("self");
    unmount();
  });

  it("Esc 放弃作答 → 交回 null（不替用户选一个）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();

    const answering = created.options.onQuestion(handoffQuestion());
    await waitFor(() => (lastFrame() ?? "").includes("原 agent 自交接"));
    await flush(40);
    stdin.write("\u001b"); // lone ESC 需 ~20ms（ink 的序列判定）
    await flush(40);
    await expect(answering).resolves.toBeNull();
    unmount();
  });

  it("选了「不交接」→ 留在原会话，屏幕上什么都不跳", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();

    const answering = created.options.onQuestion(handoffQuestion());
    await waitFor(() => (lastFrame() ?? "").includes("原 agent 自交接"));
    await flush(40);
    // 高亮从第一项往上走一格 = 环绕到最末项（「不交接」），再回车
    stdin.write("\u001b[A");
    await flush(40);
    stdin.write("\r");
    await expect(answering).resolves.toBe("decline");

    // 会话没换（交接是原地换记忆，PRD 4.5）：屏幕上不该冒出「搬到新会话」那类话
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("迁移完成");
    expect(created.session.sessionId).toBe("chat_test");
    unmount();
  });
});

describe("`@` 文件路径补全", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
  });

  it("候选来自 session.listWorkspaceFiles（问会话，不扫客户端磁盘）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 换成一份「只在服务端存在」的清单（本机根本不可能有这些文件）：
    // 它们能出现在候选里，就证明候选确实来自会话，而不是屏幕这边扫盘
    created.session.listWorkspaceFiles = vi.fn(async () => ({
      state: "ready" as const,
      entries: [
        { path: "服务端工作区/只有那里才有的文件.md", name: "只有那里才有的文件.md", kind: "file" },
      ],
    }));
    stdin.write("@");
    await flush();
    await flush();
    const frame = lastFrame() ?? "";
    expect(created.session.listWorkspaceFiles).toHaveBeenCalled();
    expect(frame).toContain("只有那里才有的文件.md");
    // 旧实现会去扫本机磁盘：换成会话给的清单后，这份假索引里的 InboxEntry 一条也不该出现
    expect(frame).not.toContain("README.md");
    unmount();
  });

  it("敲下 @ 后弹出候选菜单（先显示扫描中，再出结果）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    const frame = lastFrame() ?? "";
    // 候选整体来自会话，不是本机扫描
    expect(created.session.listWorkspaceFiles).toHaveBeenCalled();
    expect(frame).toContain("README.md");
    // 目录带尾斜杠：一眼能看出「选中它会继续往下钻」
    expect(frame).toContain("src/tui/");
    unmount();
  });

  it("Tab 把选中项补进草稿，且不发送", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@chat");
    await flush();
    stdin.write("\t");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("@src/tui/screens/chat.tsx");
    expect(created.session.send).not.toHaveBeenCalled();
    unmount();
  });

  it("菜单开着时回车 = 补全（不发送半截消息）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@chat");
    await flush();
    stdin.write("\r");
    await flush();
    expect(created.session.send).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").toContain("@src/tui/screens/chat.tsx");
    unmount();
  });

  it("↓ 换高亮项：第二条被补进去", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@");
    await flush();
    // 空查询下顺序：README.md → src/tui → src/tui/screens/chat.tsx
    stdin.write("\u001b[B");
    await flush();
    stdin.write("\t");
    await flush();
    expect(lastFrame() ?? "").toContain("@src/tui/");
    unmount();
  });

  it("Esc 只关菜单，草稿仍在", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("@chat");
    await flush();
    stdin.write("\u001b");
    await flush(30); // lone ESC 需 ~20ms（ink 序列判定）
    const frame = lastFrame() ?? "";
    expect(frame).toContain("@chat");
    expect(frame).not.toContain("screens/chat.tsx");
    unmount();
  });

  it("没有匹配时不弹菜单，回车照常发送", async () => {
    const { stdin, unmount } = mount();
    await flush();
    stdin.write("@zzz");
    await flush();
    stdin.write("\r");
    await flush();
    expect(created.session.send).toHaveBeenCalledWith("@zzz", [], []);
    unmount();
  });
});

describe("续接意图透传（resume）", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
  });

  it("resume 原样交给注册表（屏幕不判断有没有上一轮）", async () => {
    const { unmount } = mount({ resume: true });
    await flush();
    expect(created.options?.resume).toBe(true);
    unmount();
  });

  it("不给 resume 时选项里就是空的（不会凭空宣称要接着上次）", async () => {
    const { unmount } = mount();
    await flush();
    expect(created.options?.resume).toBeUndefined();
    unmount();
  });

  it("启动时进入的工作区原样交给注册表（会话层不自己猜 cwd）", async () => {
    const { unmount } = mount({ workspaceId: "ws-entered" });
    await flush();
    expect(created.options?.workspaceId).toBe("ws-entered");
    unmount();
  });
});

describe("日志上通知栏（CLI 自己的 warn / error）", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
  });

  it("屏幕挂上来时把通知栏注册成日志那一格的入口：warn / error 上屏，info 不上", async () => {
    const logNotices = new LogNotices({ logFile: null });
    const { lastFrame, unmount } = mount({ logNotices });
    await flush();

    logNotices.record({
      level: "info",
      source: "cli",
      message: "工具发现完成",
      at: "2026-01-01T00:00:00.000Z",
    });
    logNotices.record({
      level: "warn",
      source: "cli",
      message: "记不住 last-workspace.json",
      at: "2026-01-01T00:00:00.000Z",
    });
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("记不住 last-workspace.json");
    expect(frame).not.toContain("工具发现完成");
    unmount();
  });

  it("屏幕走了就注销（之后只攒不投，下一屏挂上来再补）", async () => {
    const logNotices = new LogNotices({ logFile: null });
    const first = mount({ logNotices });
    await flush();
    first.unmount();

    logNotices.record({
      level: "error",
      source: "cli",
      message: "卸载期间的那一条",
      at: "2026-01-01T00:00:00.000Z",
    });

    const second = mount({ logNotices });
    await flush();
    expect(second.lastFrame() ?? "").toContain("卸载期间的那一条");
    second.unmount();
  });
});

describe("发送那一刻：清掉日志转发来的通知", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
  });

  it("按下发送就清空通知栏：日志上浮的与业务提示一起走", async () => {
    const logNotices = new LogNotices({ logFile: null });
    const connection = fakeConnection();
    const { stdin, lastFrame, unmount } = mount({ logNotices, connection });
    await flush();

    // 一条日志上浮来的
    logNotices.record({
      level: "warn",
      source: "cli",
      message: "记不住 last-session.json",
      at: "2026-01-01T00:00:00.000Z",
    });
    // 宿主转来的日志（也带 `origin: "log"`）
    created.notifier.onNotice("宿主日志上浮的那条", "warn", "log");
    // 一条宿主发来的业务提示
    created.notifier.onNotice("宿主说的话", "info");
    await flush();
    expect(lastFrame() ?? "").toContain("记不住 last-session.json");
    expect(lastFrame() ?? "").toContain("宿主日志上浮的那条");
    expect(lastFrame() ?? "").toContain("宿主说的话");

    connection.apiCalls.length = 0;
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("记不住 last-session.json");
    expect(frame).not.toContain("宿主日志上浮的那条");
    expect(frame).not.toContain("宿主说的话");
    // 宿主上**这一段会话**的那一份也清：不带 sessionId 的清全部是另一档（Ctrl+G）
    const cleared = connection.apiCalls.filter((call) => call.method === "notice.deleteAll");
    expect(cleared).toEqual([{ method: "notice.deleteAll", params: { sessionId: "chat_test" } }]);
    unmount();
  });
});

describe("粘贴：Ctrl+V 图片优先、无图回退文本", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
    clipboardMock.image = { kind: "none" };
    clipboardMock.text = { kind: "unavailable" };
  });

  /** Ctrl+V（`\x16` → char "v" + ctrl） */
  const paste = async (stdin: any) => {
    stdin.write("\u0016");
    await flush();
  };
  const oneImage = { kind: "image", image: { base64: "QUJD", mime: "image/png" } };

  it("剪贴板没有图片时，粘贴的是文本", async () => {
    clipboardMock.text = { kind: "text", text: "粘贴进来的文字" };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("粘贴进来的文字");
    unmount();
  });

  /**
   * 不再预判（PRD 4.6「不在客户端预判」）：粘贴既不数张数、也不看这一张多大。
   *
   * 上限的真相在宿主：剪贴板里有什么就收什么，超了由宿主那一次 `invalid_params` 说。
   */
  it("粘贴不数张数：超过上限的张数照样进输入框", async () => {
    clipboardMock.image = oneImage;
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 连粘 6 张（宿主那一边是 4 张）：一张都不该被客户端拦下
    for (let i = 0; i < 6; i += 1) await paste(stdin);
    expect(lastFrame() ?? "").toContain("已附加 6 张图片");
    // 读剪贴板时不传字节上限：这一层不比大小
    expect(clipboardMock.maxBytes).toBe(Number.POSITIVE_INFINITY);
    unmount();
  });

  /**
   * 超限由宿主说：`session.send` 把宿主那一次 `invalid_params` 的原话交给通知栏，
   * 屏幕照原样上屏，不另编一句取代它。
   */
  it("超限由宿主拒：原话原样上屏", async () => {
    clipboardMock.image = oneImage;
    // 宿主 `asset.upload` 会说的话（一张最多 4MB）
    const hostSays = "一张最多 4MB（4194304 字节），这一张 6291456 字节；超出上限报错，不截断";
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    for (let i = 0; i < 5; i += 1) await paste(stdin);
    // 真会话的 `send` 就是这么做的：宿主拒绝时把话原样交给通知栏
    created.session!.send.mockImplementation(async () => {
      created.notifier!.onNotice(hostSays, "error");
    });
    stdin.write("看这几张");
    await flush();
    stdin.write("\r");
    await waitFor(() => created.session!.send.mock.calls.length === 1);
    expect(lastFrame() ?? "").toContain(hostSays);
    unmount();
  });

  it("剪贴板有图片时附到消息上，并显示附件行", async () => {
    clipboardMock.image = oneImage;
    clipboardMock.text = { kind: "text", text: "不该被粘贴的文字" };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("已附加 1 张图片");
    expect(frame).not.toContain("不该被粘贴的文字");
    unmount();
  });

  it("↑ 回到带图片的消息：文本与附件一起回来，重发仍带图", async () => {
    clipboardMock.image = oneImage;
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("看这张");
    await flush();
    await paste(stdin);
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    expect(created.session.send).toHaveBeenCalledWith("看这张", [oneImage.image], []);
    // 发送后附件行清空
    expect(lastFrame() ?? "").not.toContain("已附加");

    await waitUntilEditable(stdin, lastFrame);
    stdin.write("\u001b[A"); // ↑ 翻回上一条
    await waitFor(() => (lastFrame() ?? "").includes("已附加 1 张图片"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("看这张"); // 文本回来了
    expect(frame).toContain("已附加 1 张图片"); // 图片也回来了（旧实现只有文本）

    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 2);
    expect(created.session.send).toHaveBeenLastCalledWith("看这张", [oneImage.image], []);
    unmount();
  });

  it("Esc 先清附件、草稿保留（误粘的退路）", async () => {
    clipboardMock.image = oneImage;
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("看这张");
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("已附加 1 张图片");

    stdin.write("\u001b");
    await flush(30); // lone ESC 需 ~20ms（ink 序列判定）
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("已附加 1 张图片");
    expect(frame).toContain("看这张");
    unmount();
  });

  it("发送时把图片一并交给会话（文案仍是纯文本）", async () => {
    clipboardMock.image = oneImage;
    const { stdin, unmount } = mount();
    await flush();
    stdin.write("看图");
    await flush();
    await paste(stdin);
    stdin.write("\r");
    await flush();
    expect(created.session.send).toHaveBeenCalledWith("看图", [oneImage.image], []);
    unmount();
  });

  it("剪贴板文本超过上限：报错且不粘贴（不截断半截内容）", async () => {
    clipboardMock.text = { kind: "too-large", bytes: 300 * 1024 };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("超过");
    expect(frame).toContain("没有粘贴");
    unmount();
  });

  it("剪贴板既没图片也没文字时给提示，不插任何东西", async () => {
    clipboardMock.text = { kind: "text", text: "" };
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    await paste(stdin);
    expect(lastFrame() ?? "").toContain("剪贴板里没有内容");
    unmount();
  });
});

// ==================================================================
// 撤回回填：文字进草稿、Asset 挂回输入（PRD 3.9「带图的那条连图一起恢复」）
// ==================================================================

describe("撤回回填带图的那条", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
    clipboardMock.image = { kind: "none" };
    clipboardMock.text = { kind: "unavailable" };
  });

  it("文字与素材一起回来，输入行说清挂了几张；发送时只交 id（不再上传一遍）", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialInput: "看这两张",
      initialAssetIds: ["a-1", "a-2"],
    });
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("看这两张");
    expect(frame).toContain("已附加 2 张图片");

    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    // Asset 走第三格（已传上去的 id），第二格是这次新粘贴的字节 —— 一张都没有
    expect(created.session.send).toHaveBeenCalledWith("看这两张", [], ["a-1", "a-2"]);
    unmount();
  });

  /**
   * 撤回之后要说清两件事实（`cmd.back.done`）：删掉几条、那句话已回到输入框。
   *
   * 旧实现只是删完重挂载 —— 用户看到的只有消息忽然变短。那句话由命令层交给重挂载的
   * `notice` 带到新屏上（旧屏的通知栏跟着卸载了）。
   */
  it("撤回之后：新屏上说清删掉几条、那句话已回到输入框", async () => {
    const said = t("cmd.back.done", { n: 3 });
    const { lastFrame, unmount } = mount({ initialInput: "第二条", initialNotice: said });
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain(said);
    // 回填的那句话就在输入行上（两件事实各占它自己那一格）
    expect(frame).toContain("第二条");
    unmount();
  });

  it("不带图的那条照旧：素材那一格是空的", async () => {
    const { stdin, lastFrame, unmount } = mount({ initialInput: "只看文字" });
    await flush();

    expect(lastFrame() ?? "").not.toContain("已附加");
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    expect(created.session.send).toHaveBeenCalledWith("只看文字", [], []);
    unmount();
  });

  it("`↑` 回到走素材上传的那条：素材 id 也挂回输入，重发时只交 id", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 已经传上去的图：段上只剩 Asset id（本地没有字节可还原）
    created.session!.messages.push({
      id: "u-0",
      role: "user",
      content: [
        { type: "text", text: "看这两张" },
        { type: "image_url", image_url: { url: "" }, __asset_id: "a-1" },
        { type: "image_url", image_url: { url: "" }, __asset_id: "a-2" },
      ],
    });

    stdin.write("\u001b[A"); // ↑
    await waitFor(() => (lastFrame() ?? "").includes("已附加 2 张图片"));
    expect(lastFrame() ?? "").toContain("看这两张");

    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    expect(created.session.send).toHaveBeenCalledWith("看这两张", [], ["a-1", "a-2"]);
    unmount();
  });

  it("Esc 取消之后素材不再跟着下一次发送（草稿留住）", async () => {
    const { stdin, lastFrame, unmount } = mount({
      initialInput: "看这两张",
      initialAssetIds: ["a-1"],
    });
    await flush();
    expect(lastFrame() ?? "").toContain("已附加 1 张图片");

    stdin.write("\u001b");
    await flush(30); // lone ESC 需 ~20ms（ink 序列判定）
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("已附加");
    expect(frame).toContain("看这两张"); // 草稿没被一起清掉

    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);
    expect(created.session.send).toHaveBeenCalledWith("看这两张", [], []);
    unmount();
  });
});

describe("会话的生死不归屏幕", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
    created.detached.length = 0;
    created.newSegments = 0;
  });

  it("卸载屏幕只摘听众：**不** dispose 会话（它可能还在后台跑）", async () => {
    const { unmount } = mount();
    await flush();

    unmount();

    expect(created.session.dispose).not.toHaveBeenCalled();
    // 摘的是**这一屏的**听众（身份就是那个 notifier）
    expect(created.detached).toEqual([created.notifier]);
  });

  it("运行中敲 `/new`：旧会话既没被 dispose、也没被 abort（只是换去看另一段）", async () => {
    const { stdin, unmount } = mount();
    await flush();
    // 这一轮挂在半路：屏幕上一直是「在跑」
    created.session.send = vi.fn(() => new Promise<void>(() => {}));
    stdin.write("先干着");
    await flush();
    // 回车才是「投递」：少了这一下，这条用例从来没进到「运行中」（下面的等永远等不到，
    // 而它以前只是静静超时 —— 于是那两句「没 dispose / 没 abort」断言什么都证明不了）
    stdin.write("\r");
    await waitFor(() => created.session.send.mock.calls.length === 1);

    // 命令名与回车分两次写：一次写一整串会被 ink 当成「粘贴」，`key.return` 根本不会成立
    // （这也是它以前从来没执行过 `/new` 的原因之一）
    stdin.write("/new");
    await flush();
    stdin.write("\r");
    // 负向断言要先有证据：等注册表的新开动作真的被调到，否则「旧会话没被 dispose」
    // 也可能只是「/new 根本没执行」
    await waitFor(() => created.newSegments === 1);

    expect(created.session.dispose).not.toHaveBeenCalled();
    expect(created.session.abort).not.toHaveBeenCalled();
    unmount();
  });
});

// ==================== 别处删掉了这一屏那一段（`session.removed`）====================

/**
 * 注册表把「这一段没了」交给这一屏（`ChatSessionNotifier.onRemoved`），屏幕负责收尾：说一句、
 * 换到同项目里最近的那一段，没有就回连接屏。
 *
 * 收尾那一套（`moveAfterGone`）自己有用例；这一条只钉**那根线接上了**：收到那一下之后，屏幕
 * 真的去问「同项目里还有哪几段」（那是换屏与回连接屏两档都要先知道的事实）。
 */
describe("别处删掉了这一屏那一段：屏幕当场收尾", () => {
  beforeEach(() => {
    setLocale("zh");
    created.notifier = null;
    created.session = null;
    created.options = null;
    created.detached.length = 0;
  });

  it("收到「这一段没了」：去问同项目里的会话（问的就是那一段自己的项目）", async () => {
    const connection = fakeConnection();
    const { unmount } = mount({ connection });
    await flush();
    connection.apiCalls.length = 0;

    created.notifier.onRemoved({ sessionId: "chat_test", workspaceId: "ws_test" });

    await waitFor(() => connection.apiCalls.some((one) => one.method === "session.list"));
    // 问的是**这一段自己的**项目（`/ws` 选中的那个不算：这一段属于它建出来的那个项目）
    expect(connection.apiCalls.find((one) => one.method === "session.list")?.params).toEqual({
      workspaceId: "ws_test",
    });
    unmount();
  });
});

// ==================== 交接期间：拦住人（PRD 4.5 / 1.3）====================

describe("交接期间：不发、说清楚、只留中断", () => {
  it("回车不发出去，并说明「你的话会交给下一段」", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 宿主挂牌：这一段正在写交接文档（`session.state` 的 `handoff` 那一格 → 镜像 → getter）
    created.session.handoffSince = "2026-01-01T00:01:00.000Z";
    created.notifier.onChange(true);
    await flush();

    stdin.write("这句先别发");
    await flush();
    stdin.write("\r");
    await flush();

    // 宿主照收（PRD 4.5 只关输出开关）—— 所以拦在客户端：一条都不能进队列
    expect(created.session.send).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").toContain("正在交接");
    unmount();
  });

  it("交接期间不给打字：字符进不了草稿（草稿本身留着）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    stdin.write("先写一半");
    await flush();
    created.session.handoffSince = "2026-01-01T00:01:00.000Z";
    created.notifier.onChange(true);
    await flush();

    stdin.write("不许进来");
    await flush();
    const frame = lastFrame() ?? "";
    // 交接前那句还在（草稿没被清掉），交接后敲的字一个字都没进去
    expect(frame).toContain("先写一半");
    expect(frame).not.toContain("不许进来");
    unmount();
  });

  it("阶段行说「正在交接…」—— 独立交接那一路手上没活（idle）也要说", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    // 故意保持 idle：独立交接没有流可看，这一格本来就不会是 working
    created.session.status = "idle";
    created.session.handoffSince = "2026-01-01T00:01:00.000Z";
    created.notifier.onChange(true);
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("正在交接");
    // 阶段行紧贴在分隔线之上（与别的阶段同一处，不抢输入框的位置）
    const rows = frame.split("\n");
    const phaseRow = rows.findIndex((row) => row.includes("正在交接"));
    const dividerRow = rows.findIndex((row) => row.includes("───"));
    expect(phaseRow).toBeGreaterThanOrEqual(0);
    expect(phaseRow).toBe(dividerRow - 1);
    unmount();
  });
});

// ==================== 通知栏三档粒度里的第三档：清全部 ====================

/**
 * 「清」有三档（`prd/08-client.md` 的通知那一节）：清一条（补看那条路）、清一段会话的
 * （`Ctrl+X`）、清全部（`Ctrl+G`）。这一组钉的是第三档：**它自己不清任何东西，先问一次**，
 * 而那一问必须把「连全局、连别的会话一起没」说出来。
 */
describe("通知栏的清全部：先问一次，问完才动整个库", () => {
  // 这一组断言的是中文文案（那一问必须把「全局通知 / 别的会话」说出来）：显式锁语言
  beforeEach(() => setLocale("zh"));

  /** 宿主库里的全部通知：两条全局（`sessionId: null`）+ 这一条会话的一条 */
  const noticeRows = [
    {
      id: "n-1",
      level: "warning",
      code: "config.recovered",
      message: "配置文件坏了，已恢复出厂",
      sessionId: null,
      durationMs: null,
      createdAt: 1,
    },
    {
      id: "n-2",
      level: "info",
      code: "host.upgraded",
      message: "宿主升级了",
      sessionId: null,
      durationMs: null,
      createdAt: 2,
    },
    {
      id: "n-3",
      level: "info",
      code: "session.named",
      message: "这一段自动起名失败",
      sessionId: "chat_test",
      durationMs: null,
      createdAt: 3,
    },
  ];

  /** 等那一问上屏（确认项的文字就是它的判据），再让覆盖层的按键订阅写进 messages（它在 passive effect 里） */
  const askAndWait = async (
    stdin: { write: (data: string) => void },
    frame: () => string | undefined,
  ) => {
    stdin.write("\u0007"); // Ctrl+G（清全部）
    await waitFor(() => (frame() ?? "").includes(t("notice.deleteAllAllConfirm")));
    await flush(40);
  };

  it("确认之前一次写都没有，而且那一问点名了全局通知与别的会话", async () => {
    const connection = fakeConnection({ notices: noticeRows });
    const { stdin, lastFrame, unmount } = mount({ connection });
    await flush();
    connection.apiCalls.length = 0;

    await askAndWait(stdin, lastFrame);

    const frame = lastFrame() ?? "";
    // 问题里必须写出那两件事（不给人事后才发现别处也没了的机会）
    expect(frame).toContain("全局通知");
    expect(frame).toContain("别的会话");
    // 条数从清之前那次 `notice.list` 数：整个库 3 条
    expect(frame).toContain("清空全部 3 条通知");
    // 只数了一遍，一次写都没有
    expect(connection.apiCalls).toEqual([{ method: "notice.list", params: {} }]);
    unmount();
  });

  it("选「否」（Esc）：一个方法都不调", async () => {
    const connection = fakeConnection({ notices: noticeRows });
    const { stdin, lastFrame, unmount } = mount({ connection });
    await flush();
    connection.apiCalls.length = 0;

    await askAndWait(stdin, lastFrame);
    stdin.write("\u001b"); // Esc：取消
    await waitFor(() => !(lastFrame() ?? "").includes(t("notice.deleteAllAllConfirm")));

    // 数过一遍（那一问要用数），但清一次都没发
    expect(connection.apiCalls.map((call) => call.method)).toEqual(["notice.list"]);
    unmount();
  });

  it("确认：发的就是**不带 sessionId** 的那一次，并说清一共清了几条", async () => {
    const connection = fakeConnection({ notices: noticeRows });
    const { stdin, lastFrame, unmount } = mount({ connection });
    await flush();
    connection.apiCalls.length = 0;

    await askAndWait(stdin, lastFrame);
    stdin.write("\r"); // 默认高亮的是「清空全部」那一项
    await waitFor(() => connection.apiCalls.some((call) => call.method === "notice.deleteAll"));

    const cleared = connection.apiCalls.find((call) => call.method === "notice.deleteAll");
    // 不给 `sessionId` = 整个库（含全局与别的会话的）
    expect(cleared?.params).toEqual({});
    await waitFor(() => (lastFrame() ?? "").includes(t("notice.deleteAllAllDone", { n: 3 })));
    unmount();
  });
});

// ==================== 图片：终端里给得出事实，而且打得开 ====================

/**
 * 终端不可能内联渲染图片，所以图片在转录里只能是个占位 —— 但占位要说得出手里已有的事实，
 * 并且要有一个动作把选中的那张交给**本机默认程序**打开（`asset.get` → 临时文件 → 打开）。
 */
describe("图片：占位说事实，Ctrl+O 用本机默认程序打开", () => {
  beforeEach(() => {
    setLocale("zh");
    // 本机那份 Asset 事实是进程级状态：这一组从「刚启动」开始，也不把状态留给下一份用例
    forgetAssetFacts();
  });

  /** 一条带 Asset 的图片消息（今天的客户端写出来的就是这一种：段上只有本地标记） */
  const imageMessage = (extra: Record<string, unknown> = {}) => ({
    id: "u-img",
    createdAt: 1,
    role: "user" as const,
    content: [
      { type: "text" as const, text: "看这张" },
      { type: "image_url" as const, image_url: { url: "" }, __asset_id: "a-1", ...extra },
    ],
  });

  /** 把一条消息推进假会话并等它上屏 */
  const showMessage = async (message: unknown) => {
    created.session.messages.push(message);
    created.notifier.onChange(true);
  };

  it("占位行带上了尺寸与文件名（有就给，没有就写不知道多大）", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    // 一张手里有尺寸与文件名的（段上带着这两样）与一张只有 Asset id 的
    await showMessage(imageMessage({ width: 800, height: 600, name: "shot.png" }));
    await showMessage({
      id: "u-img-2",
      createdAt: 2,
      role: "user",
      content: [{ type: "image_url", image_url: { url: "" }, __asset_id: "a-2" }],
    });
    await flush();

    const frame = lastFrame() ?? "";
    // 每条事实各自一行（不塞成一句话）
    expect(frame).toContain("尺寸：800 × 600");
    expect(frame).toContain("文件名：shot.png");
    // 只有 id 的那一张：说不知道多大，而不是编一个
    expect(frame).toContain("尺寸：不知道多大");
    unmount();
  });

  it("上传那一刻记下的事实：占位行给得出真实宽高与文件名", async () => {
    const { lastFrame, unmount } = mount();
    await flush();
    // 这一段图是本进程刚传上去的：段上只有 `__asset_id`，事实落在本机那份里
    rememberAssetFacts([
      {
        id: "a-1",
        sha256: "sha-a-1",
        mime: "image/png",
        name: "shot.png",
        createdAt: 1,
        width: 1280,
        height: 720,
      },
    ]);
    await showMessage(imageMessage());
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("尺寸：1280 × 720");
    expect(frame).toContain("文件名：shot.png");
    unmount();
  });

  it("Ctrl+O 之后真的取了一次 `asset.get`，并把落地的路径交给打开函数", async () => {
    const connection = fakeConnection({
      assetGet: () => ({ mime: "image/png", base64: "QUJD" }),
    });
    const openPath = vi.fn(async () => ({ kind: "opened" as const }));
    const writeTempImage = vi.fn(async () => "/tmp/aizen-image-1.png");
    const { stdin, lastFrame, unmount } = mount({ connection, openPath, writeTempImage });
    await flush();
    await showMessage(imageMessage());
    await flush();

    stdin.write("\u000f"); // Ctrl+O
    await waitFor(() => (lastFrame() ?? "").includes(t("notice.imagePickTitle")));
    await flush(40);
    stdin.write("\r"); // 选中第一张
    await waitFor(() => openPath.mock.calls.length === 1);

    // 取的就是那一张的 Asset id，取回来的字节落成临时文件，再交给打开函数
    expect(connection.apiCalls.filter((call) => call.method === "asset.get")).toEqual([
      { method: "asset.get", params: { assetId: "a-1" } },
    ]);
    expect(writeTempImage).toHaveBeenCalledWith("QUJD", "image/png");
    expect(openPath).toHaveBeenCalledWith("/tmp/aizen-image-1.png");
    await waitFor(() =>
      (lastFrame() ?? "").includes(t("notice.imageOpened", { path: "/tmp/aizen-image-1.png" })),
    );
    unmount();
  });

  it("素材已经不在了：说清是「那张图没了」，不假装打开成功", async () => {
    const connection = fakeConnection({
      assetGet: () => {
        throw new Error("找不到 id 为 a-1 的素材");
      },
    });
    const openPath = vi.fn(async () => ({ kind: "opened" as const }));
    const writeTempImage = vi.fn(async () => "/tmp/aizen-image-1.png");
    const { stdin, lastFrame, unmount } = mount({ connection, openPath, writeTempImage });
    await flush();
    await showMessage(imageMessage());
    await flush();

    stdin.write("\u000f");
    await waitFor(() => (lastFrame() ?? "").includes(t("notice.imagePickTitle")));
    await flush(40);
    stdin.write("\r");
    await waitFor(() =>
      (lastFrame() ?? "").includes(t("notice.imageGone", { error: "找不到 id 为 a-1 的素材" })),
    );

    // 没东西可打开：后面两步一次都没走
    expect(writeTempImage).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
    unmount();
  });

  it("本机没有可用的打开命令：说清是哪一种，并把文件路径带出来", async () => {
    const connection = fakeConnection({ assetGet: () => ({ mime: "image/png", base64: "QUJD" }) });
    const openPath = vi.fn(async () => ({ kind: "no-command" as const, command: "xdg-open" }));
    const writeTempImage = vi.fn(async () => "/tmp/aizen-image-1.png");
    const { stdin, lastFrame, unmount } = mount({ connection, openPath, writeTempImage });
    await flush();
    await showMessage(imageMessage());
    await flush();

    stdin.write("\u000f");
    await waitFor(() => (lastFrame() ?? "").includes(t("notice.imagePickTitle")));
    await flush(40);
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("没有可用的打开命令"));

    // 字节已经取回来了：路径要告诉用户（他自己拖进看图器就行）
    expect(lastFrame() ?? "").toContain("/tmp/aizen-image-1.png");
    unmount();
  });

  it("这一段里没有打得开的图片：说一句（不弹一个点了会失败的选择器）", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await flush();
    // 内联 base64 的那一种：本地就有字节，不在 `asset.get` 这条路上
    await showMessage({
      id: "u-inline",
      createdAt: 1,
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }],
    });
    await flush();

    stdin.write("\u000f");
    await waitFor(() => (lastFrame() ?? "").includes(t("notice.imagePickEmpty")));
    expect(lastFrame() ?? "").not.toContain(t("notice.imagePickTitle"));
    unmount();
  });
});
