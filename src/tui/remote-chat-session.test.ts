/**
 * `RemoteChatSession` 的端到端测试：真 socket + 真 Daemon + 真存档（临时目录）+ 假 Agent。
 *
 * 这是「TUI 换源」的护栏：屏幕要的那几个事实（消息、阶段、模型、用量、id）全都必须
 * 只能从服务端拿到，而 `send()` 的语义要**与进程内模式一致**（一轮跑完才 resolve）。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createSessionHandlers,
  FileSessionStore,
  SessionManager,
  type AgentLike,
} from "@ai-zen/agents-server";
import { SocketServerClient } from "../server-client/socket-server-client.js";
import { setLocale } from "../i18n/index.js";
import { useTempAiZenDir } from "../test-support/temp-dir.js";
import { RemoteChatSession } from "./remote-chat-session.js";
import type { ChatSessionNotifier } from "./chat-session.js";

class FakeAgent implements AgentLike {
  messages: any[] = [];
  lastUsage: unknown = undefined;
  /** 交接要用的那几面（真件是 SDK 的 `SdkAgent`）；无 write 工具 → 走摘要模式 */
  definition = { messages: [] as any[], modelId: "test-model" };
  tools: Array<{ function?: { name?: string } }> = [];
  model = "test-model";
  modelConfig: Record<string, unknown> = {};
  client: unknown = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: DOC } }] }) } },
  };
  scope = { cwd: "/work/proj" };
  use(_plugin: unknown): void {}
  sent: string[] = [];
  aborted = 0;

  private readonly handlers = new Map<string, Set<(payload: any) => void>>();
  readonly events = {
    on: (event: string, handler: (payload: any) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (payload: any) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };

  send(input: string): Promise<unknown> {
    this.sent.push(input);
    return Promise.resolve();
  }
  abort(): void {
    this.aborted++;
  }
  /** 手动驱动 SDK 时序：测试就是服务端那一侧的「模型」 */
  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

/** 交接文档正文（SDK 有 400 字节阈值） */
const DOC = `# 交接\n\n${"- 桩\n".repeat(80)}`;

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let agent: FakeAgent;
let client: SocketServerClient | null = null;
let session: RemoteChatSession | null = null;
let notices: Array<{ text: string; tone: "info" | "error" }>;
let changes: number;

/**
 * 拼图片内容块要读配置（端点 / 视觉能力），绝不能读真实 `~/.ai-zen`。
 * 进程内共享模块下只有 `pin()` 能让路径真的生效（见 test-support/temp-dir.ts）。
 */
const zen = useTempAiZenDir("aiz-remote-chat-");

const notifier: ChatSessionNotifier = {
  onChange: () => {
    changes += 1;
  },
  onNotice: (text, tone) => notices.push({ text, tone }),
};

beforeEach(() => {
  setLocale("zh");
  zen.pin();
  // 图片链路要按实发模型名反查端点：`test-model` 与 FakeAgent 的 model 同名
  writeFileSync(
    join(zen.dir, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      // `vision: true` 才走真图片内容块（否则 SDK 会把它降级成文本提示，测不到链路）
      models: [{ id: "test-model", name: "Test", endpointId: "e", custom: true, vision: true }],
      defaultAgent: "default",
      version: 4,
    }),
  );
  dir = mkdtempSync(join(tmpdir(), "aiz-remote-chat-"));
  agent = new FakeAgent();
  notices = [];
  changes = 0;
  let counter = 0;
  manager = new SessionManager({
    createAgent: async () => agent,
    nextSessionId: () => `chat_${++counter}`,
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
    handoff: { aiZenDir: join(dir, "ai-zen"), homeDir: dir },
  });
});

afterEach(async () => {
  session?.dispose();
  session = null;
  client?.close();
  client = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  zen.cleanup();
});

/**
 * 等到条件成立（或超时）。
 *
 * 真 socket 上的事件没有确定性时机：`send` 的受理与事件的到达都依赖事件循环，
 * 固定 `sleep(20)` 在机器一忙时就翻车。这里只等到**该发生的事发生**，不猜时长。
 */
async function waitUntil(what: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 起服务端 + 连一条连接，然后开一段远程会话 */
async function open(input: { agentId?: string; sessionId?: string } = {}): Promise<RemoteChatSession> {
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: createSessionHandlers({
      manager: manager!,
      workspacesRoot: join(dir, "workspaces"),
      // 这几个用例总带 path，默认工作区用不上；给一个合法值即可
      defaultWorkspacePath: dir,
    }),
  });
  await daemon.start();
  client = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: { name: "@ai-zen/cli", version: "0.0.0-test" },
  });
  const workspace = join(dir, "proj");
  session = await RemoteChatSession.openWith(client, { path: workspace, ...input }, notifier);
  return session;
}

describe("RemoteChatSession：开一段会话", () => {
  it("快照就是屏幕的全部事实：消息 / 阶段 / 模型 / id 都从服务端来", async () => {
    agent.messages = [{ role: "user", content: "上次聊到这儿" }];
    const opened = await open();

    expect(opened.currentId).toBe("chat_1");
    expect(opened.modelId).toBe("test-model");
    expect(opened.phase).toBeNull();
    expect(opened.messages).toEqual([{ role: "user", content: "上次聊到这儿" }]);
    // 子 Agent 栏目还没有协议承载：恒为空，界面因此不出现这一栏
    expect(opened.subAgents).toEqual([]);
  });
});

describe("RemoteChatSession：send 的语义与进程内一致", () => {
  it("一轮跑完才 resolve（界面靠它管 busy），收尾用服务端快照纠正本地", async () => {
    const opened = await open();
    let finished = false;

    const pending = opened.send("你好").then(() => {
      finished = true;
    });
    // 回执已到、但这一轮还在跑：此时不该 resolve
    await waitUntil(() => agent.sent.length === 1);
    expect(finished).toBe(false);

    // 服务端这一侧：追加用户消息 → 流式两片 → 收尾
    agent.messages.push({ role: "user", content: "你好" });
    agent.fire("chunk-parsed", { choices: [{ delta: { content: "答" } }] });
    // 生成中就能读到临时拼出来的正文（屏幕要能滚起来）
    await waitUntil(() => JSON.stringify(opened.messages).includes("答"));
    expect(opened.phase).not.toBeNull();
    expect(finished).toBe(false);

    agent.messages.push({ role: "assistant", content: "答完了", reasoning_content: "想一想" } as never);
    agent.fire("finally");
    await pending;

    expect(finished).toBe(true);
    // 收尾后是服务端那份权威消息（连 reasoning_content 都在），不是本地拼的近似
    expect(opened.messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "答完了", reasoning_content: "想一想" },
    ]);
    expect(opened.phase).toBeNull();
  });

  it("带图提交：图片真的发出去了（内容块里有文本段 + 内联图片）", async () => {
    const opened = await open();
    const pending = opened.send("看看这张图", [{ base64: "AAA", mime: "image/png" }]);
    await waitUntil(() => agent.sent.length === 1);

    // 文本段排在最前（图在文前会把指令切断），图片是内联 data URL
    expect(agent.sent[0]).toEqual([
      { type: "text", text: "看看这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);

    agent.messages.push({ role: "user", content: "看看这张图" });
    agent.fire("finally");
    await pending;
  });

  it("图片装不进一帧：只发文字并明确告知（超限帧会让服务端直接断连接）", async () => {
    const opened = await open();
    // 两张各 ~5MB：单张都过得了 SDK 的内联上限（8MiB），合起来超过单帧上限
    const big = "A".repeat(5_000_000);
    const pending = opened.send("看这两张", [
      { base64: big, mime: "image/png" },
      { base64: big, mime: "image/png" },
    ]);
    await waitUntil(() => agent.sent.length === 1);

    expect(agent.sent[0]).toBe("看这两张"); // 退成纯文本，不整条不发
    expect(notices.map((notice) => notice.text).join("")) .toContain("超过单帧上限");
    expect(notices.at(-1)?.tone).toBe("error");

    agent.fire("finally");
    await pending;
  });

  it("abort 转发给服务端（由服务端掐本轮与进行中的交接）", async () => {
    const opened = await open();
    const pending = opened.send("长任务");
    await waitUntil(() => agent.sent.length === 1);

    opened.abort();
    await waitUntil(() => agent.aborted === 1);

    agent.fire("finally");
    await pending;
  });
});

describe("RemoteChatSession：存档与换 id 的方法", () => {
  it("save / saveAs / exists / listSaved 全都问服务端", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "留档" }];

    expect(await opened.save()).toBe("chat_1");
    expect(await opened.exists("chat_1")).toBe(true);
    expect(await opened.exists("chat_404")).toBe(false);

    expect(await opened.saveAs("chat_debug_login")).toBe("chat_debug_login");
    expect(opened.currentId).toBe("chat_debug_login");
    expect((await opened.listSaved()).map((ref) => ref.id)).toEqual(["chat_debug_login"]);

    // 换 id 之后服务端那条链路也认新 id：再存一次不该报 unknown-session
    expect(await opened.save()).toBe("chat_debug_login");
  });

  it("rollbackTo：服务端删消息并落盘，返回被删的首条用户消息（工作目录备注由客户端剥）", async () => {
    agent.messages = [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "答" },
      { role: "user", content: "第二个问题\n\n[system-injected: cwd]\nCurrent working directory: /work/proj" },
    ];
    const opened = await open();

    const text = await opened.rollbackTo(2);

    expect(text).toBe("第二个问题");
    expect(opened.messages).toHaveLength(2);

    // 落盘也是服务端做的：重新要一次快照，撤回的消息不会「复活」
    await opened.reload();
    expect(opened.messages).toHaveLength(2);
  });

  it("migrate：跟着新 id 走，消息被剔成「模板 + 交接断点」", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "旧任务" }];

    const path = await opened.migrate();

    expect(path.endsWith(".md")).toBe(true);
    expect(opened.currentId).not.toBe("chat_1"); // 换 id 了
    expect(JSON.stringify(opened.messages)).toContain(".md"); // 断点里带着文档路径
    expect(JSON.stringify(opened.messages)).not.toContain("旧任务"); // 历史被剔除
    // 新 id 上还能继续存/取（事件过滤也跟着新 id）
    expect(await opened.save()).toBe(opened.currentId);
  });

  it("reset：先把当前对话归档（有内容才存），再开一段新会话", async () => {
    agent.messages = [{ role: "user", content: "要归档的" }];
    const opened = await open();

    expect(await opened.reset()).toBe("chat_1");
    expect(opened.currentId).toBe("chat_2");
    expect(opened.messages).toEqual([]);
  });

  it("handoff：不换 id，进度以本地文案进通知栏（服务端不产句子）", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "任务" }];

    const path = await opened.handoff();

    expect(opened.currentId).toBe("chat_1");
    const text = notices.map((notice) => notice.text).join("\n");
    expect(text).toContain("正在编写任务交接文档"); // handoffWriting
    expect(text).toContain(path); // handoffPath
    // 枚举被翻译过：界面里不该出现裸的 self
    expect(text).not.toContain("（self）");
  });
});

describe("RemoteChatSession：服务端在一轮内部换 id（自动迁移）", () => {
  it("跟着换 id 并重取消息，send 才能等到新 id 上的 turn.end", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = opened.send("继续");
    await waitUntil(() => agent.sent.length === 1);

    // 服务端这一侧：自动迁移（存档 + prune + 换 id）后这一轮才收尾
    const migrated = await (manager as any).autoMigrate(opened.currentId);
    void migrated;
    agent.messages = [{ role: "user", content: "交接断点：/tmp/x.md" }];
    agent.fire("finally");
    await pending;

    // id 变了，消息是迁移之后那份（客户端不能还挂着旧历史）
    expect(opened.currentId).not.toBe("chat_1");
    expect(JSON.stringify(opened.messages)).not.toContain("旧任务");
    expect(opened.phase).toBeNull();
  });
});
