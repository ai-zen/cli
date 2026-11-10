/**
 * 纯 stdio 模式的两层测试。
 *
 * 上半层是纯函数（`mergePrompt` / `extractText`）：它们决定「喂进去的东西」与「吐出来的
 * 文本」，改一处就是改用户可见行为。
 *
 * 下半层是**真 socket + 真守护进程 + 真存档（临时目录）+ 假 Agent**：stdout 只含答案、
 * 默认不落盘、`--save` 写档但不挪指针、结束后会话被关掉 —— 这四条是这一模式对外的
 * 全部契约，靠假服务端是断言不出来的（落盘与回收都发生在服务端那一侧）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigService,
  Daemon,
  createConfigHandlers,
  createSessionHandlers,
  FileSessionStore,
  SessionManager,
  type AgentLike,
  type ModelLevel,
  // 与服务端同一个算法（`defaultWorkspacePath: dir` 就是按它算 id 的）：这条用例要在**跑之前**
  // 就把指针摆好，而那时临时目录里还没有 `workspaces/` 可以让本地那个按目录反查的助手去数。
  workspaceIdFor as serverWorkspaceIdFor,
} from "@ai-zen/agents-server";
import { AgentNS } from "@ai-zen/agents-core";
import { ServerConnection, SocketServerClient } from "./server-client/index.js";
import type { ClientInfo } from "./server-client/index.js";
import { mergePrompt, extractText, runStdio } from "./stdio.js";

describe("mergePrompt", () => {
  it("仅有指令", () => {
    expect(mergePrompt("你好", "")).toBe("你好");
  });

  it("仅有 stdin 内容", () => {
    expect(mergePrompt("", "一段文本\n")).toBe("一段文本");
  });

  it("指令 + 内容 → 指令在前、空行分隔", () => {
    expect(mergePrompt("总结要点", "第一行\n第二行\n")).toBe("总结要点\n\n第一行\n第二行");
  });

  it("仅空白 stdin 视为无内容", () => {
    expect(mergePrompt("你好", "\n\n")).toBe("你好");
  });

  it("两者皆空 → 空串", () => {
    expect(mergePrompt("", "")).toBe("");
    expect(mergePrompt("   ", "\n")).toBe("");
  });
});

describe("extractText", () => {
  it("字符串内容原样返回", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("undefined / null → 空串", () => {
    expect(extractText(undefined)).toBe("");
  });

  it("多文本块拼接", () => {
    expect(
      extractText([
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
  });

  it("非文本块降级为占位文本（仍为纯文本）", () => {
    const text = extractText([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
    ]);
    expect(text).toContain("看图");
    expect(text).toContain("https://x/y.png");
    expect(text).not.toMatch(/\x1b/);
  });
});

// ==================== 端到端：一次性调用走服务端 ====================

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

/**
 * 假 Agent：`send()` 当场把这一轮的消息写好，再按 SDK 的顺序发事件
 * （`open` → 正文 → `finally`），于是服务端的收尾、落盘、`session-turn-end` 全都真跑一遍。
 */
class FakeAgent implements AgentLike {
  messages: any[] = [{ role: "system", content: "你是助手" }];
  // 协议把用量从 `unknown` 收成了具名类型（D12）：假件必须照实声明，否则它证明不了
  // 「客户端读的是 `Usage`」这件事 —— 那正是 `unknown` 时代漏掉的东西。
  lastUsage: AgentNS.Usage | undefined = undefined;
  /** 三级解析的档位（真件由 SDK 的 `createAgent` 给；假件照抄这一位） */
  modelLevel: ModelLevel = "agent";
  definition = { messages: [] as any[] };
  tools: Array<{ function?: { name?: string } }> = [];
  model = "m";
  modelConfig: Record<string, unknown> = {};
  client: unknown = {};
  scope = { cwd: "/work/proj" };
  /** 这一轮要产出的 assistant 消息（用例改它来模拟成功 / 失败） */
  reply: { content: string; status?: string } = { content: "答复" };

  use(_plugin: unknown): void {}

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

  send(content: unknown): Promise<unknown> {
    this.messages = [
      ...this.messages,
      { role: "user", content },
      { role: "assistant", content: this.reply.content, status: this.reply.status },
    ];
    // 同步发事件：`SessionManager.send()` 是「立刻回 turnId、过程走事件」，收尾靠 `finally`
    this.fire("open");
    this.fire("finally");
    return Promise.resolve(this.messages);
  }

  abort(): void {}

  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let connection: SocketServerClient | null = null;
let agent: FakeAgent;
let workspaceId: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aiz-stdio-"));
  agent = new FakeAgent();
  manager = new SessionManager({
    createAgent: async () => agent,
    nextSessionId: () => "chat_stdio",
    storeFor: (id) => new FileSessionStore({ rootDir: join(dir, "workspaces", id) }),
  });
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: {
      ...createSessionHandlers({
        manager,
        workspacesRoot: join(dir, "workspaces"),
        defaultWorkspacePath: dir,
      }),
      // stdio 也从服务端读「用哪个 Agent」（`config.get`），所以配置面要接上
      ...createConfigHandlers({
        config: new ConfigService({
          configFile: join(dir, "config.json"),
          agentsDir: join(dir, "agents"),
          subAgentsDir: join(dir, "sub-agents"),
          globalMcpFile: join(dir, "mcp.json"),
          workspacesRoot: join(dir, "workspaces"),
        }),
      }),
    },
  });
  await daemon.start();
  connection = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
  workspaceId = "";
});

afterEach(async () => {
  connection?.close();
  connection = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 跑一次 `ai "…"`：注入真 socket，把 stdout / stderr 抓成字符串 */
async function run(options: {
  instruction: string;
  save?: boolean;
  stdin?: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runStdio(
    { instruction: options.instruction, save: options.save ?? false },
    {
      // 一次性调用的入口自己造连接（生产是 `createServerConnection()`）；用例把它指到
      // 自己起的那个 Daemon 上 —— 注入一条现成连接（生命周期归用例）。
      connection: new ServerConnection({ client: connection! }),
      readInput: async () => options.stdin ?? "",
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (line) => {
        stderr += line + "\n";
      },
    },
  );
  // 工作区目录是服务端按路径建出来的（`workspaces/<id>`）：跑完才知道 id
  workspaceId = workspaceIdFor(dir);
  return { code, stdout, stderr };
}

/**
 * 存档目录（`<aiZenDir>/workspaces/<workspaceId>/sessions`）—— 用完才知道 id，现查。
 *
 * 去掉 `.meta.json`（列表清单）：每段会话在盘上是两个文件，用例关心的是“有几段会话”。
 */
function savedSessions(): string[] {
  const workspaces = join(dir, "workspaces");
  if (!existsSync(workspaces)) return [];
  return readdirSync(workspaces).flatMap((id) => {
    const sessions = join(workspaces, id, "sessions");
    if (!existsSync(sessions)) return [];
    return readdirSync(sessions).filter((file) => !file.endsWith(".meta.json"));
  });
}

function pointerFiles(): string[] {
  const workspaces = join(dir, "workspaces");
  if (!existsSync(workspaces)) return [];
  return readdirSync(workspaces)
    .map((id) => join(workspaces, id, "last-session.json"))
    .filter(existsSync);
}

describe("runStdio：一次性调用（真 socket + 真存档）", () => {
  it("答案只写 stdout，退出码 0，stderr 干净", async () => {
    const result = await run({ instruction: "你好" });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("答复\n");
    expect(result.stderr).toBe("");
  });

  it("默认不落盘：不写存档，也不挪「上一轮会话」指针", async () => {
    const result = await run({ instruction: "脚本里问一句" });
    expect(result.code).toBe(0);

    // 这条就是「一次性管道调用不该篡改用户的对话列表」的全部证据
    expect(savedSessions()).toEqual([]);
    expect(pointerFiles()).toEqual([]);
  });

  it("--save 写档但不挪指针（下次 `ai` 不会续接到一条管道结果上）", async () => {
    const result = await run({ instruction: "留一份", save: true });

    expect(result.code).toBe(0);
    expect(savedSessions()).toHaveLength(1);
    expect(pointerFiles()).toEqual([]);
    expect(result.stderr).toContain("Saved conversation: chat_stdio");
    // 存档写完之后答案照旧只出现在 stdout
    expect(result.stdout).toBe("答复\n");
  });

  it("`--save` 不挪**已存在的**指针（不是「碰巧还没指针」）", async () => {
    // 目录要在跑之前就摆好：要断言的是「已经存在的指针没被顶掉」，而不是「没新建文件」。
    // 工作区是哪个：服务端是**本地**（loopback）时，会话跑在客户端递上去的 cwd 里，
    // 所以 id 由 `process.cwd()` 算 —— 与会话层用例里那条「本地取 cwd」是同一条规则。
    const root = join(dir, "workspaces", serverWorkspaceIdFor(process.cwd()));
    mkdirSync(root, { recursive: true });
    const pointer = join(root, "last-session.json");
    writeFileSync(
      pointer,
      JSON.stringify({ version: 1, id: "chat_prev", updatedAt: "2024-01-01T00:00:00.000Z" }),
      "utf-8",
    );

    const result = await run({ instruction: "留一份", save: true });

    expect(result.code).toBe(0);
    // 自己的档写了（`chat_stdio`），但「本工作区上一轮会话」仍然指着上一轮那段
    expect(savedSessions()).toHaveLength(1);
    expect(JSON.parse(readFileSync(pointer, "utf-8")).id).toBe("chat_prev");
  });

  it("模型报错：stdout 为空、错误走 stderr、退出码 1", async () => {
    agent.reply = { content: "", status: "error" };

    const result = await run({ instruction: "你好" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ai: ");
  });

  it("调用完就关会话：服务端不留活会话（每个 `ai` 不泄漏一段）", async () => {
    // 关会话发生在 finally 里：直接看服务端有没有收到这次 `session.close`
    const closed: string[] = [];
    const close = manager!.close.bind(manager!);
    manager!.close = (sessionId: string) => {
      closed.push(sessionId);
      return close(sessionId);
    };

    await run({ instruction: "你好" });

    await waitFor(() => closed.length === 1);
    expect(closed).toEqual(["chat_stdio"]);
    expect(workspaceId).not.toBe("");
    // 活在内存里的一段不剩（列表是合并视图：盘上的存档仍会列出来，所以只看活会话）
    expect(await manager!.list(workspaceId, { includeSaved: false })).toEqual([]);
  });

  it("无输入：不连服务端也能判定（退出码 2，stdout 为空）", async () => {
    const result = await run({ instruction: "   " });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no input");
  });
});

/** 工作区 id（`workspace.resolve` 里那套规则；测试直接按目录名反查） */
function workspaceIdFor(root: string): string {
  const workspaces = join(root, "workspaces");
  const ids = existsSync(workspaces) ? readdirSync(workspaces) : [];
  // 只有一个工作区的用例里，这就是「会话跑在哪个工作区」
  return ids[0] ?? "";
}

/** 轮询到条件成立（不固定 sleep） */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
