// 向导宿主的单元测试 —— 测「读快照 → 接管 → 关闭后让改动生效」这条生命周期
//
// 依赖全部注入（通知 / 是否有会话 / 重启 / 重载），契约那一面只有一个假的 `api`（tRPC 客户端
// 按路径分派），于是这段逻辑第一次可以在没有真终端、没有真连接的情况下被断言。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Text, useInput } from "ink";
import { setLocale } from "../../i18n/index.js";
import type { HostClient } from "../../server-client/index.js";

const { calls } = vi.hoisted(() => {
  const calls: {
    notify: [string, string?][];
    restarted: number;
    reloaded: number;
    /** 契约调用流水：`method` + 入参（验「读哪几份快照」「带没带 workspaceId」） */
    methods: { method: string; params: unknown }[];
  } = { notify: [], restarted: 0, reloaded: 0, methods: [] };
  return { calls };
});

// 不用 `vi.mock` 整模块替换：进程内共享模块（`isolate: false`）时它会泄漏到其他测试文件，
// 让它们读到这里的假配置。

import { useWizardHost } from "./use-wizard-host.js";

/** 一份最小可用配置：模型 gpt-6 绑在端点 e1 上（`config.get` 出参里的 `config`） */
const fakeConfig = () => ({
  endpoints: [{ id: "e1", name: "E1", baseUrl: "https://example.test/v1", apiKey: "sk-test" }],
  models: [
    {
      id: "gpt-6",
      name: "GPT 6",
      endpointId: "e1",
      tokenThresholds: { handoff: 1000, guard: 2000 },
    },
  ],
  imageModels: [],
  defaultAgent: "default",
});

/** 同一份出参里的档位表 */
const fakePresets = () => ({});

/** `agentDefinition.list` 的清单（定义本身） */
const fakeDefinitions = () => [
  {
    id: "default",
    name: "Default",
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

/** `mcp.list` 的清单（每条带它写在哪一层） */
const fakeServers = () => [
  { scope: "user", server: { id: "pty", transport: "stdio", command: "npx" } },
];

/** 可替换的 `config.get` 实现：用例按需让它返回另一份配置或抛错 */
let configImpl: () => Promise<unknown> = async () => ({
  config: fakeConfig(),
  presets: fakePresets(),
});

/** 可替换的 `session.list` / `workspace.list` 实现（「删 AgentDefinition」的代价里那个数从这里数） */
let workspacesImpl: () => Promise<unknown> = async () => [{ id: "ws-1", cwd: "/work/demo" }];
let sessionsImpl: () => Promise<unknown> = async () => [];

/**
 * 假连接：只认这三条读 procedure，其余一律炸（用不到的调用不该悄悄发生）。
 *
 * 路径按 `Proxy` 拼成 procedure 名（`api.config.get.query` → `"config.get"`），与生产代码里
 * 那一条调用逐字对得上。
 */
const fakeApi = new Proxy(Object.create(null) as object, {
  get(_target, property: string) {
    return make(["", property]);
  },
}) as unknown as HostClient["api"];

function make(path: string[]): unknown {
  return new Proxy(Object.create(null) as object, {
    get(_target, property: string) {
      if (property === "query" || property === "mutate") {
        const method = path.slice(1).join(".");
        return async (params: unknown = {}) => {
          calls.methods.push({ method, params });
          switch (method) {
            case "config.get":
              return await configImpl();
            case "config.agents.list":
              return fakeDefinitions();
            case "config.mcp.list":
              return { servers: fakeServers() };
            // 「删 AgentDefinition」的代价里那个数：`workspace.list` → 逐个 `session.list`
            case "workspace.list":
              return await workspacesImpl();
            case "session.list":
              return await sessionsImpl();
            default:
              throw new Error(`用例没有准备 ${method}`);
          }
        };
      }
      return make([...path, property]);
    },
  });
}

/**
 * 等到 `check()` 成立就返回；超时抛错，错误里说清等的是什么。
 *
 * **别用「睡够 4ms」代替它**：那是赌「够久」，而这里要的是「真的发生了」。上限 1000ms 是
 * **失败上限**，不是等待时长。
 */
const until = async (check: () => boolean, what: string, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等不到：${what}（上限 ${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * 让出几拍宏任务 —— 让这一拍里**排在后面**的活先跑完。让的是执行顺序，不是一个时长。
 *
 * 为什么敲键之前要它：帧是在 commit 里画的，而 `useInput` 的订阅落在 passive effect 里，
 * 同一拍里排在画帧**之后**（React 的 Scheduler 在 Node 下走 `setImmediate`）。所以「探针已经
 * 画出来了」还不等于「按键有人接」：这一刻塞进去的键会被直接**丢掉**，不是延后处理，是永远不到。
 */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** 探针：把 hook 的状态写成一行，按键触发各个入口 */
function Probe({ hasSession }: { hasSession: boolean }) {
  const w = useWizardHost({
    api: fakeApi,
    modelId: "gpt-6",
    workspaceId: "ws-1",
    notify: (text, tone) => calls.notify.push([text, tone]),
    hasSession: () => hasSession,
    restart: () => {
      calls.restarted += 1;
    },
    reloadSession: () => {
      calls.reloaded += 1;
    },
  });
  useInput((char) => {
    if (char === "o") void w.openWizard({ kind: "menu" });
    if (char === "k") void w.openKeyEditor();
    // 改了两项 → 会话该重读自己的事实
    if (char === "c") {
      w.closeWizard({ dirty: true, summary: ["模型名 → NewName", "思考档位 → high"] });
    }
    // 没有改动落下
    if (char === "n") {
      w.closeWizard({ dirty: false, summary: [] });
    }
  });
  return (
    <Text>
      {[
        `step=${w.wizardStep ? w.wizardStep.kind : "null"}`,
        `config=${w.wizardConfig ? "loaded" : "null"}`,
        `presets=${w.wizardPresets ? "loaded" : "null"}`,
        `agents=${w.wizardAgents ? w.wizardAgents.agents.length : "null"}`,
        `servers=${w.wizardServers ? w.wizardServers.length : "null"}`,
        // 每个 AgentDefinition 挂着几段会话（数不出来就是 null —— 那时代价只说人话）
        `counts=${w.wizardSessionsByAgent ? JSON.stringify(w.wizardSessionsByAgent) : "null"}`,
      ].join(" ")}
    </Text>
  );
}

async function probe(hasSession = true) {
  const { stdin, lastFrame, unmount } = render(<Probe hasSession={hasSession} />);
  const frame = () => (lastFrame() ?? "").trim();
  const idle = "step=null config=null presets=null agents=null servers=null counts=null";
  await until(() => frame() === idle, "探针画出来");
  // 画出来 ≠ 有人接键：`useInput` 的订阅在这之后一拍才写进 messages
  await settle();
  const press = async (char: string) => {
    await settle();
    stdin.write(char);
    await settle();
  };
  return { press, frame, idle, unmount };
}

/** 三份快照读齐、向导接管整屏之后的那一帧（「先读齐再接管」的可观测形态） */
const MENU = "step=menu config=loaded presets=loaded agents=1 servers=1 counts={}";

describe("useWizardHost", () => {
  beforeEach(() => {
    setLocale("zh");
    calls.notify = [];
    calls.restarted = 0;
    calls.reloaded = 0;
    calls.methods = [];
    configImpl = async () => ({ config: fakeConfig(), presets: fakePresets() });
    workspacesImpl = async () => [{ id: "ws-1", cwd: "/work/demo" }];
    sessionsImpl = async () => [];
  });

  it("打开向导：先读齐三份快照再接管", async () => {
    const p = await probe();
    expect(p.frame()).toBe(p.idle);
    await p.press("o");
    // 等的是「三份快照读齐、整屏接管」这个可观测结果
    await until(() => p.frame() === MENU, "向导接管（三份快照读齐）");
    // 读的正是那几条 procedure，一条不多（顺序不定：会话计数与三份快照并行读）
    expect(calls.methods.map((item) => item.method).sort()).toEqual([
      "config.agents.list",
      "config.get",
      "config.mcp.list",
      "session.list",
      "workspace.list",
    ]);
    p.unmount();
  });

  it("读 MCP 清单时带上这段会话的项目 id（`mcp.list` 只认它）", async () => {
    const p = await probe();
    await p.press("o");
    await until(() => p.frame() === MENU, "向导接管（三份快照读齐）");
    const list = calls.methods.find((item) => item.method === "config.mcp.list");
    expect(list?.params).toEqual({ workspaceId: "ws-1" });
    p.unmount();
  });

  it("读配置失败时只报错，不进向导", async () => {
    configImpl = async () => {
      throw new Error("EACCES");
    };
    const p = await probe();
    await p.press("o");
    // 等的是通知真的发出去（一次异步结果），不是「睡一下大概报过了」
    await until(() => calls.notify.length > 0, "读取失败的通知发出去了");
    expect(p.frame()).toBe(p.idle);
    expect(calls.notify).toEqual([["配置读取失败：EACCES", "error"]]);
    p.unmount();
  });

  it("`/key`：当前模型没绑端点时提示，不进向导", async () => {
    configImpl = async () => ({
      config: {
        ...fakeConfig(),
        models: [
          {
            id: "gpt-6",
            name: "GPT 6",
            endpointId: "missing",
            tokenThresholds: { handoff: 1, guard: 2 },
          },
        ],
        endpoints: [],
      },
      presets: fakePresets(),
    });
    const p = await probe();
    await p.press("k");
    await until(() => calls.notify.length > 0, "「没绑端点」的提示发出去了");
    expect(p.frame()).toBe(p.idle);
    expect(calls.notify[0]?.[1]).toBe("error");
    expect(calls.notify[0]?.[0]).toContain("未绑定可用端点");
    p.unmount();
  });

  it("打开向导时顺手数清每个助手挂着几段会话（删助手的代价要这个数）", async () => {
    sessionsImpl = async () => [
      { agentId: "default" },
      { agentId: "default" },
      { agentId: "reviewer" },
    ];
    const p = await probe();
    await p.press("o");
    await until(
      () => p.frame().includes('counts={"default":2,"reviewer":1}'),
      "向导接管时那一份会话计数",
    );
    p.unmount();
  });

  it("数不出来就是 null（代价那一句到时候只说人话，不编数字）", async () => {
    workspacesImpl = async () => {
      throw new Error("EACCES");
    };
    const p = await probe();
    await p.press("o");
    // 计数失败不该把整屏挡在外面：向导照常接管，只是那一格是 null
    await until(
      () => p.frame().includes("step=menu") && p.frame().includes("counts=null"),
      "向导照常接管",
    );
    p.unmount();
  });

  it("`/key`：有端点时直达该端点的密钥编辑步骤", async () => {
    const p = await probe();
    await p.press("k");
    await until(() => p.frame().includes("step=edit"), "直达密钥编辑步骤");
    expect(p.frame()).toContain("config=loaded");
    // 快照读法只有一份：直达与整屏接管读的是同样那几份（少一份就渲染不出整块屏）
    expect(calls.methods.map((item) => item.method).sort()).toEqual([
      "config.agents.list",
      "config.get",
      "config.mcp.list",
    ]);
    p.unmount();
  });

  it("关闭时把同一批摘要合成一条通知（只占一个队列槽位），且清空向导状态", async () => {
    const p = await probe();
    await p.press("o");
    await until(() => p.frame() === MENU, "向导接管（三份快照读齐）");
    await p.press("c");
    // 等的是通知真的发出去了（一次异步结果），不是「睡一下大概发过了」
    await until(() => calls.notify.length > 0, "变更摘要的通知发出去了");
    expect(p.frame()).toBe(p.idle);
    expect(calls.notify).toHaveLength(1);
    const [text] = calls.notify[0]!;
    expect(text).toContain("配置已更新");
    expect(text).toContain("模型名 → NewName");
    expect(text).toContain("思考档位 → high");
    // 子项缩进恰好「一个汉字宽度」（2 个半角空格），且不带 · 之类的项目符号
    const itemLines = text.split("\n").slice(1);
    expect(itemLines).toHaveLength(2);
    for (const line of itemLines) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.startsWith("   ")).toBe(false);
      expect(line).not.toContain("·");
    }
    p.unmount();
  });

  it("有改动且会话已建好 → 让会话重读自己的事实（不重启）", async () => {
    const p = await probe();
    await p.press("o");
    await until(() => p.frame() === MENU, "向导接管（三份快照读齐）");
    await p.press("c");
    await until(() => calls.reloaded === 1, "会话重读了自己的事实");
    expect(calls.restarted).toBe(0);
    p.unmount();
  });

  it("没有改动落下 → 只显示摘要，不重载也不重启", async () => {
    const p = await probe();
    await p.press("o");
    await until(() => p.frame() === MENU, "向导接管（三份快照读齐）");
    await p.press("n");
    // 这一条断言的是「什么都没发生」（负向）。它不能只靠「没事件」成立：
    // 先等向导真的被关掉 —— 而关掉只可能由刚才那个 `n` 触发，于是键被吐掉就不会误绿。
    await until(() => p.frame() === p.idle, "向导关掉了");
    expect(calls.notify).toHaveLength(0);
    expect(calls.reloaded).toBe(0);
    expect(calls.restarted).toBe(0);
    p.unmount();
  });

  it("会话还没建好就改了配置 → 重启", async () => {
    const p = await probe(false);
    await p.press("o");
    await until(() => p.frame() === MENU, "向导接管（三份快照读齐）");
    await p.press("c");
    await until(() => calls.restarted === 1, "重启了");
    expect(calls.reloaded).toBe(0);
    p.unmount();
  });
});
