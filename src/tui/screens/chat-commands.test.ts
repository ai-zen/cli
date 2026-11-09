// 命令层回归：会话内容被「物理剔除」后，转录显示起点必须跟着重置。
//
// `/migrate` 走 `prune` 策略，把 `agent.messages` 砍到「系统提示 + 交接断点」（1~2 条）。
// 若 `transcriptFrom` 仍停在旧值，`messages.slice(transcriptFrom)` 恒为空 —— 迁移成功、
// 上下文里有内容，但屏幕一片空白。这类「状态与显示起点脱节」的 bug 只有真机才看得见，
// 所以在这里用最小 host 假件把它钉住。
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig, Model, ReasoningPresets } from "@ai-zen/agents-sdk";
import { runCommand, type ChatCommandHost } from "./chat-commands.js";
import type { ChatSessionLike } from "../chat-session.js";
import type { AgentStore } from "../../agents-store.js";
import type { ConfigPort } from "../../server-client/config-port.js";
import { useTempAiZenDir } from "../../test-support/temp-dir.js";
import { setLocale, t } from "../../i18n/index.js";
import { computeChatLayout } from "./layout.js";
import { usableFrameRows } from "../text.js";

/**
 * 独立的临时 `AI_ZEN_DIR`。
 *
 * 命令层自己不碰存档了（存档在服务端），但部分命令会走到配置面的写入路径（假件的 `save`
 * 之类），而 `AI_ZEN_DIR` 是进程级的 —— 不隔离就会摸到开发机上的真实配置根。
 */
const zen = useTempAiZenDir("aiz-cmd-test-");
beforeEach(() => {
  zen.pin();
  // 断言的是中文文案（消息词典），锁死语言，不受环境 LANG 影响
  setLocale("zh");
});
afterAll(() => zen.cleanup());

/** 只造 runCommand 实际会碰到的字段，其余用 noop 顶住 */
function createHost(
  overrides: Record<string, unknown> = {},
  portOverrides: Partial<ConfigPort> = {},
) {
  const notices: Array<{ text: string; tone?: "info" | "error" }> = [];
  /** 「盘上已有哪几段」—— 内存假件，见下方 `exists` / `listSaved` 的注释 */
  const saved = new Set<string>();
  const session = {
    messages: [{ role: AgentNS.Role.User, content: "hi" }],
    agentId: "default",
    modelId: "m1",
    migrate: vi.fn(async () => "/tmp/handoff.md"),
    reset: vi.fn(async () => "chat_archived"),
    reload: vi.fn(async () => {}),
    save: vi.fn(async () => "chat_saved"),
    saveAs: vi.fn(async (id: string) => id),
    // 存档查询是**会话**的能力（真相在服务端）。命令层只用这两个方法的返回值，
    // 所以这里给一个内存假件 —— `saved` 就是「盘上已有哪几段」。
    // 真存档的行为（写入 / `list` 按 mtime 倒序 / 老存档搬迁）由服务端用例覆盖，客户端不重复覆盖。
    exists: vi.fn(async (id: string) => saved.has(id)),
    listSaved: vi.fn(async () => [...saved].map((id) => ({ id }))),
    ...overrides,
  };
  const config = fakeConfigPort(portOverrides);
  const host = {
    session: session as unknown as ChatSessionLike,
    config,
    notice: (text: string, tone?: "info" | "error") => notices.push({ text, tone }),
    clearTranscript: vi.fn(),
    rows: 24,
    exit: vi.fn(),
    suspendTerminal: async (fn: () => void | Promise<void>) => {
      await fn();
    },
    openWizard: vi.fn(async () => {}),
    openKeyEditor: vi.fn(async () => {}),
    doExit: vi.fn(async () => {}),
    setPickerState: vi.fn(),
    setConfirmState: vi.fn(),
    setInputText: vi.fn(),
    setEffortView: vi.fn(),
    refreshLocale: vi.fn(),
  } as unknown as ChatCommandHost;
  return { host, notices, session, config, arrangeSaved: (id: string) => saved.add(id) };
}

// ==================== 假配置面 ====================
//
// 命令层的配置读写全走注入的 `ConfigPort`，于是给一个**假端口**就够：不读盘、
// 不 `vi.mock`（模块级 mock 是全局注册的，会波及同进程里别的用例），只记录
// 「被调用了什么、返回了什么」—— 既能钉住「数据来自端口」，也能钉住「不该写的没写」。

/** 一个模型（`tokenThresholds` 是类型必填，用例不关心具体数值） */
function model(id: string, name: string, endpointId: string): Model {
  return {
    id,
    name,
    endpointId,
    tokenThresholds: { handoff: 1000, guard: 2000 },
    // 指向下面那张策略表，`/think` 才有档位可选
    reasoningPreset: "effort",
  };
}

/** `/think` 用的策略表：两档，够判断「可选项是从端口来的」 */
const PRESETS: ReasoningPresets = {
  effort: { levels: { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" } } },
};

const BASE_CONFIG: AppConfig = {
  endpoints: [
    { id: "ep-main", name: "主端点", baseUrl: "https://example.test/v1", apiKey: "sk-test" },
    // 故意不带 Key：`/model` 的预检要在这里拦住
    { id: "ep-nokey", name: "没配 Key 的端点", baseUrl: "https://example.test/v1", apiKey: "" },
  ],
  // 会话当前在 m1 上（见 createHost）；m2 与它同端点，m3 落在缺 Key 的端点上
  models: [
    model("m1", "模型一", "ep-main"),
    model("m2", "模型二", "ep-main"),
    model("m3", "模型三", "ep-nokey"),
  ],
};

/** 一个 Agent 定义（`/think` 靠 `modelParams` 反查当前档位） */
function agentDefinition(
  id: string,
  modelId: string,
  modelParams?: Record<string, unknown>,
): AgentDefinition {
  return {
    id,
    name: id,
    messages: [],
    modelId,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...(modelParams ? { modelParams } : {}),
  };
}

function fakeAgentStore(agents: AgentDefinition[], subAgents: AgentDefinition[] = []): AgentStore {
  return { agents, subAgents, save: async () => {}, remove: async () => {} };
}

/** 假配置端口：每个方法都是 `vi.fn`，用例可断言调用与入参 */
function fakeConfigPort(overrides: Partial<ConfigPort> = {}): ConfigPort {
  return {
    readConfig: vi.fn(async () => BASE_CONFIG),
    readConfigFile: vi.fn(async () => ({ config: BASE_CONFIG, path: "/srv/.ai-zen/config.json" })),
    saveConfig: vi.fn(async () => {}),
    readReasoningPresets: vi.fn(async () => PRESETS),
    // 空 MCP 配置：`/mcp` 无参时的默认作用域落在 global
    readMcpConfig: vi.fn(async () => ({
      ok: true as const,
      config: { mcpServers: {} },
      // 服务端那份文件的真实路径：屏上要印它（不是客户端本机的 mcp.json）
      path: "/srv/.ai-zen/mcp.json",
    })),
    writeMcpConfig: vi.fn(async () => {}),
    readAgentStore: vi.fn(async () => fakeAgentStore([agentDefinition("default", "m1")])),
    setModel: vi.fn(async () => {}),
    setDefaultAgent: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("/migrate：prune 后必须重置转录显示起点", () => {
  it("迁移成功后调用 clearTranscript（否则 messages 变短、屏幕一片空白）", async () => {
    const { host, notices } = createHost();
    await runCommand("migrate", "/migrate self", host);
    expect(host.clearTranscript).toHaveBeenCalledTimes(1);
    expect(notices.map((n) => n.text).join("\n")).toContain("/tmp/handoff.md");
  });

  it("迁移失败时不重置（保留现场给用户看）", async () => {
    const { host } = createHost({
      migrate: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await runCommand("migrate", "/migrate self", host);
    expect(host.clearTranscript).not.toHaveBeenCalled();
  });

  it("显式执行者参数非法时完全不调 migrate", async () => {
    const { host, session } = createHost();
    await runCommand("migrate", "/migrate nobody", host);
    expect(session.migrate).not.toHaveBeenCalled();
    expect(host.clearTranscript).not.toHaveBeenCalled();
  });
});

describe("/new：归档后重置转录显示起点", () => {
  it("session.reset 之后调用 clearTranscript", async () => {
    const { host } = createHost();
    await runCommand("new", "/new", host);
    expect(host.clearTranscript).toHaveBeenCalledTimes(1);
  });
});

/**
 * 回归（PLAN L8）：`/back` 撤回后只 `exit({ restart: true })` 重挂界面，没落盘 ——
 * 存档文件里仍留着被撤回的消息，下次 `/load` 或重启就「复活」。
 */
describe("/back：撤回后必须落盘", () => {
  it("撤回后的消息写回文件（被撤回的那条不再存在）", async () => {
    const messages: any[] = [
      { role: AgentNS.Role.User, content: "第一条" },
      { role: AgentNS.Role.Assistant, content: "答一" },
      { role: AgentNS.Role.User, content: "第二条" },
    ];
    // 记下「被写回去的那份」：撤回之后写回的内容必须不含被撤的那条
    let savedMessages: any[] | null = null;

    const session = {
      messages,
      currentId: "chat_back",
      agentId: "default",
      modelId: "m1",
      rollbackTo: vi.fn((index: number) => {
        const removed = messages.splice(index);
        return removed.find((m) => m.role === AgentNS.Role.User)?.content ?? "";
      }),
      save: vi.fn(async () => {
        savedMessages = messages.map((message) => ({ ...message }));
        return "chat_back";
      }),
    };
    const { host } = createHost({ ...session });
    // 选择器直接作答：选「第二条」（它的 messages 下标为 2，列表里是最近在前，但 value 就是下标）
    (host as any).setPickerState = (next: any) => {
      const state = typeof next === "function" ? next(null) : next;
      if (state) state.resolve("2");
    };

    await runCommand("back", "/back", host);

    expect(session.rollbackTo).toHaveBeenCalledWith(2);
    expect(session.save).toHaveBeenCalledTimes(1);
    // 重挂载必须带上**此刻**的会话 id：宿主手上那个是首次挂载时的，过期后会接回另一段对话
    expect(host.exit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "chat_back" }));
    // 先撤回、再落盘（顺序反了就会把完整对话又写回去）
    expect(session.rollbackTo.mock.invocationCallOrder[0]!).toBeLessThan(
      session.save.mock.invocationCallOrder[0]!,
    );

    expect(savedMessages!.map((m: any) => m.content)).toEqual(["第一条", "答一"]);
  });
});

/**
 * `/save <名字>`（PLAN §4）：不带参数维持时间戳 id；带名字则另存为指定文件名，
 * 重名要二次确认（静默覆盖会让另一份对话凭空消失），确认后旧文件不留残影。
 */
describe("/save：支持指定名字 + 重名二次确认", () => {
  /** 接管确认框：记下问句并立即作答 */
  const captureConfirm = (host: ChatCommandHost, answer: boolean) => {
    const seen = { question: "" };
    (host as any).setConfirmState = (next: any) => {
      const state = typeof next === "function" ? next(null) : next;
      if (!state) return;
      seen.question = state.question;
      state.resolve(answer);
    };
    return seen;
  };
  const texts = (notices: Array<{ text: string }>) => notices.map((n) => n.text).join("\n");

  it("无参数：照旧存成时间戳 id，不弹确认", async () => {
    const { host, session, notices } = createHost();
    await runCommand("save", "/save", host);
    expect(session.save).toHaveBeenCalledTimes(1);
    expect(host.setConfirmState).not.toHaveBeenCalled();
    expect(texts(notices)).toContain("chat_saved");
  });

  it("带名字：存成指定文件名", async () => {
    const { host, session, notices } = createHost({ saveAs: vi.fn(async (id: string) => id) });
    await runCommand("save", "/save 我的对话", host);
    expect(session.saveAs).toHaveBeenCalledWith("我的对话");
    expect(session.save).not.toHaveBeenCalled();
    expect(texts(notices)).toContain("我的对话");
  });

  it("名字已存在且不是当前 id：先问一遍；取消则完全不写", async () => {
    const { host, session, notices, arrangeSaved } = createHost({
      currentId: "chat_now",
      saveAs: vi.fn(async (id: string) => id),
    });
    arrangeSaved("旧对话");
    const asked = captureConfirm(host, false);

    await runCommand("save", "/save 旧对话", host);

    expect(asked.question).toContain("旧对话");
    expect(session.saveAs).not.toHaveBeenCalled();
    expect(texts(notices)).toContain("已取消保存");
  });

  it("确认之后才覆盖", async () => {
    const { host, session, arrangeSaved } = createHost({
      currentId: "chat_now",
      saveAs: vi.fn(async (id: string) => id),
    });
    arrangeSaved("旧对话");
    captureConfirm(host, true);

    await runCommand("save", "/save 旧对话", host);

    expect(session.saveAs).toHaveBeenCalledWith("旧对话");
  });

  it("名字想逃出会话目录：把 SDK 的拒绝原样报成错误，不说「已保存」", async () => {
    const { host, notices } = createHost({
      saveAs: vi.fn(async () => {
        throw new Error('Invalid entity id: "../逃逸"');
      }),
    });

    await runCommand("save", "/save ../逃逸", host);

    expect(notices.at(-1)).toEqual({
      text: expect.stringContaining("Invalid entity id"),
      tone: "error",
    });
  });

  it("目标名就是当前 id：自己盖自己，不弹确认", async () => {
    const { host, session, arrangeSaved } = createHost({
      currentId: "chat_now",
      saveAs: vi.fn(async (id: string) => id),
    });
    arrangeSaved("chat_now");

    await runCommand("save", "/save chat_now", host);

    expect(host.setConfirmState).not.toHaveBeenCalled();
    expect(session.saveAs).toHaveBeenCalledWith("chat_now");
  });
});

/**
 * 回归（PLAN L15）：picker 的条数上限少扣了 2 行。命令层用的是**原始终端行数**
 * （`rows`），而布局里 `usableFrameRows(rows) = rows - 1`；覆盖层占
 * `pickerLines(n) + STATUS_BAR_LINES`。旧的 `rows - 8` 让 n_max 多出 2 条，
 * 于是选择器会把状态栏顶出屏幕。
 */
describe("picker 条数上限（不超出一帧）", () => {
  const ROWS = 24;
  /** 用布局自己的公式量一遍：这个条数放不放得下 */
  const fits = (pickerItems: number): boolean =>
    computeChatLayout({
      columns: 80,
      rows: ROWS,
      transcript: [],
      input: "",
      busy: false,
      hintCount: 0,
      overlay: "picker",
      pickerItems,
    }).bottomLines <= usableFrameRows(ROWS);

  /** 接管选择器：只记条数 / 标签并立即作答（不真弹覆盖层），返回记录值 */
  const capturePick = (host: ChatCommandHost, answer: string | null) => {
    const seen = { count: 0, labels: [] as string[] };
    (host as any).setPickerState = (next: any) => {
      const state = typeof next === "function" ? next(null) : next;
      if (!state) return;
      seen.count = state.items.length;
      seen.labels = state.items.map((item: any) => item.label);
      state.resolve(answer);
    };
    return seen;
  };

  it("/load：条数上限正好装进一帧（rows − 10）", async () => {
    const { host, arrangeSaved } = createHost();
    for (let i = 0; i < 20; i += 1) {
      arrangeSaved(`chat_${String(i).padStart(2, "0")}`);
    }
    (host as any).rows = ROWS;
    const seen = capturePick(host, null);

    await runCommand("load", "/load", host);

    expect(seen.count).toBe(ROWS - 10);
    expect(fits(seen.count)).toBe(true);
    // 对照：多一条就装不下（证明上界算对了，不是碰巧）
    expect(fits(seen.count + 1)).toBe(false);
    // 列表只显示会话文件名（id），不再解析首条消息当摘要
    expect(seen.labels.every((label) => /^chat_\d{2}$/.test(label))).toBe(true);
    expect(seen.labels.some((label) => label.includes("条"))).toBe(false);
  });

  it("/back：条数上限同/load", async () => {
    const messages = Array.from({ length: 20 }, (_v, i) => ({
      role: AgentNS.Role.User,
      content: `第 ${i} 条`,
    }));
    const { host } = createHost({ messages, rollbackTo: vi.fn(() => "") });
    (host as any).rows = ROWS;
    const seen = capturePick(host, null);

    await runCommand("back", "/back", host);

    expect(seen.count).toBe(ROWS - 10);
    expect(fits(seen.count)).toBe(true);
  });
});

/**
 * 配置读写搬到服务端（`ConfigPort`）：命令层不再吃盘。
 *
 * `/model` 的关键回归是**生效方式**：写配置之后靠 `session.reload()`（服务端按磁盘上
 * 的新配置重建 Agent、保留消息），不再是 `exit({ restart: true })` 重挂载整个对话屏 ——
 * 重挂载会把整屏刷一遍、还会丢掉用户正在写的输入草稿。
 */
describe("/model：服务端写 + 会话重载（不再重启屏幕）", () => {
  const texts = (notices: Array<{ text: string }>) => notices.map((n) => n.text).join("\n");

  it("成功：setModel(agentId, 目标) → reload，且不 exit({restart:true})", async () => {
    const reload = vi.fn(async () => {});
    const setModel = vi.fn(async () => {});
    const { host, notices } = createHost({ reload }, { setModel });

    await runCommand("model", "/model m2", host);

    // 会话当前在 m1 上（见 createHost），目标是 m2
    expect(setModel).toHaveBeenCalledWith("default", "m2");
    expect(reload).toHaveBeenCalledTimes(1);
    // 不再重挂载屏幕：模型变了不需要重建整个界面
    expect(host.exit).not.toHaveBeenCalled();
    // 先写配置、再让服务端按它重建 Agent（顺序反了就是重建出旧模型）
    expect(setModel.mock.invocationCallOrder[0]!).toBeLessThan(reload.mock.invocationCallOrder[0]!);
    // 成功提示复用已有的 modelSwitch.summary，不新造 i18n 键
    expect(notices.at(-1)).toEqual({
      text: t("modelSwitch.summary", {
        name: "模型二",
        id: "m2",
        agent: "default",
        hint: t("modelSwitch.resetHint"),
      }),
      tone: "info",
    });
  });

  it("目标端点缺 Key：不写配置、不 reload，只报错", async () => {
    const reload = vi.fn(async () => {});
    const setModel = vi.fn(async () => {});
    const { host, notices } = createHost({ reload }, { setModel });

    // m3 挂在没配 Key 的端点上
    await runCommand("model", "/model m3", host);

    expect(setModel).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(host.exit).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.tone).toBe("error");
    expect(texts(notices)).toContain("没配 Key 的端点");
  });
});

/**
 * `/think` `/mcp` 的数据来源：全部经 `deps.config`，不再调本地读盘函数。
 *
 * 断言方式是「假端口记录了调用 + 结果被端口给的内容左右」——只看调用次数会漏掉
 * 「读了端口、用的却是本地数据」这种半吊子改造。
 */
describe("配置来源是 deps.config（假端口），不是本地读盘", () => {
  const texts = (notices: Array<{ text: string }>) => notices.map((n) => n.text).join("\n");

  it("/think：模型 / 策略表 / Agent 定义都从端口读", async () => {
    const { host, config, notices } = createHost();

    // 「未知强度」分支把三样都读一遍就返回，**不写盘**（用例不碰 ~/.ai-zen）
    await runCommand("think", "/think turbo", host);

    expect(config.readConfig).toHaveBeenCalled();
    expect(config.readReasoningPresets).toHaveBeenCalled();
    expect(config.readAgentStore).toHaveBeenCalled();
    // 报错里列出的可选档位来自端口给的策略表（low / high），而不是内置表
    expect(texts(notices)).toBe(t("cmd.think.unknown", { level: "turbo", options: "low / high" }));
  });

  it("/think：端口给的 Agent 定义已在目标档位 → 判「未变化」，不写", async () => {
    const { host, notices } = createHost(
      {},
      {
        readAgentStore: vi.fn(async () =>
          fakeAgentStore([agentDefinition("default", "m1", { reasoning_effort: "high" })]),
        ),
      },
    );

    await runCommand("think", "/think high", host);

    expect(texts(notices)).toBe(t("cmd.think.unchanged"));
  });

  it("/mcp：默认作用域读的是端口的两个作用域（项目作用域不传路径）", async () => {
    const { host, config } = createHost();

    await runCommand("mcp", "/mcp", host);

    // 两个作用域都经端口读，且**不带路径**：工作区是服务端的事实，由端口自己解析
    expect(vi.mocked(config.readMcpConfig).mock.calls.map((call) => call[0])).toEqual([
      "global",
      "project",
    ]);
    // 两份都为空 → 默认进 global
    expect(host.openWizard).toHaveBeenCalledWith({ kind: "mcp", scope: "global" });
  });
});

/**
 * `/agent`：换 Agent 是**会话层**的事（`session.setAgent`），不再重挂载对话屏。
 *
 * 回归点：这条命令曾经走 `exit({ restart: true, agentId })`，而远程模式下服务端对活着的
 * 会话直接返回、忽略 `agentId` —— 界面提示「已切换」，实际下一轮仍由旧 Agent 跑。
 */
describe("/agent：走 session.setAgent，不重挂载", () => {
  it("调 setAgent(chosen) 且不 exit；「默认 Agent」走窄方法而不是整份写回", async () => {
    const setAgent = vi.fn(async () => {});
    const store = fakeAgentStore([
      agentDefinition("default", "m1"),
      agentDefinition("coder", "m1"),
    ]);
    const { host, config } = createHost(
      { agentId: "default", setAgent },
      { readAgentStore: vi.fn(async () => store) },
    );

    await runCommand("agent", "/agent coder", host);

    expect(setAgent).toHaveBeenCalledWith("coder");
    // 只改配置里的一个字段：整份 `config.save` 会把并发修改抹掉
    expect(config.setDefaultAgent).toHaveBeenCalledWith("coder");
    expect(config.saveConfig).not.toHaveBeenCalled();
    // 换 Agent 不换屏：重挂载会把整屏刷一遍、丢掉正在写的草稿，而这次不需要
    expect(host.exit).not.toHaveBeenCalled();
  });

  it("会话已经在这个 Agent 上：只写「默认 Agent」记号，不重建", async () => {
    const setAgent = vi.fn(async () => {});
    const setDefaultAgent = vi.fn(async () => {});
    const store = fakeAgentStore([
      agentDefinition("default", "m1"),
      agentDefinition("coder", "m1"),
    ]);
    const { host } = createHost(
      { agentId: "coder", setAgent },
      { readAgentStore: vi.fn(async () => store), setDefaultAgent },
    );

    await runCommand("agent", "/agent coder", host);

    expect(setDefaultAgent).toHaveBeenCalledWith("coder");
    expect(setAgent).not.toHaveBeenCalled();
    expect(host.exit).not.toHaveBeenCalled();
  });
});
