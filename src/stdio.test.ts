/**
 * 纯 stdio 模式的两层测试。
 *
 * 上半层是纯函数（`mergePrompt` / `extractText`）：它们决定「喂进去的东西」与「吐出来的文本」，
 * 改一处就是改用户可见行为。
 *
 * 下半层用**假连接**：这一模式的四条对外契约都能直接断言，不必起真宿主 ——
 *
 *   · stdout 只含答案，其余一律走 stderr；
 *   · 默认（不带 `--save`）走 `session.transient`：连会话都不建，用户列表一条都不多；
 *   · `--save` 走真会话，但**不挪**「本机上次打开的那段」；
 *   · 模型报错：stdout 为空、错误走 stderr、退出码 1。
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { AgentNS } from "@ai-zen/agents-core";
import { resolveCliEnv } from "./env.js";
import type { ConnectHostOptions } from "./connection.js";
import { localError } from "./server-client/index.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";
import { QUIET_LOG } from "./test-support/log.js";
import {
  fakeConnection as sharedFake,
  type FakeConnection,
  type FakeOpen,
} from "./test-support/fake-connection.js";
import { mergePrompt, extractText, runStdio } from "./stdio.js";
import { rememberWorkspace, type WorkspaceHost } from "./workspace.js";
import type { HostConnection, MirrorSessionRow } from "./session/types.js";

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

// ==================== 假连接 ====================

/**
 * 一条假连接：procedure 按 `reply` 回，`session.open` / `resync` 按 `open` 回。
 *
 * 一次性调用只用到 `session.transient`（默认）或 `session.create` + `agent.wake` +
 * `agent.send` + `session.open` 跟读（`--save`），所以这里不需要真的折叠消息 —— 但镜像与订阅
 * 是连接契约的一部分，假件也得有
 * （共享那份 `test-support/fake-connection.ts` 里就是一个真的 `SessionMirror`）。
 */
const fakeConnection = (options: {
  reply: (method: string, params: unknown) => unknown;
  open?: (sessionId: string) => FakeOpen | Error;
}) => sharedFake(options);

/** 一条会话行（宿主 `session.open` 出参里的 `session`） */
const sessionRow: MirrorSessionRow = {
  id: "sess-1",
  workspaceId: "ws-1",
  name: "新会话",
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
};

/** `session.open` 的一份出参（`live` 给了就是有执行体） */
function openView(overrides: Partial<FakeOpen> = {}): FakeOpen {
  return {
    session: sessionRow,
    live: { state: "idle", inputPaused: false, outputPaused: false, handingOff: false },
    messages: [],
    inbox: [],
    ...overrides,
  };
}

function answer(content: string, status = AgentNS.MessageStatus.Completed): AgentNS.Message {
  return { id: "a-1", createdAt: 2, role: AgentNS.Role.Assistant, content, status };
}

const zen = useTempAiZenDir("aiz-stdio-");
afterAll(() => zen.cleanup());

beforeEach(() => {
  zen.pin();
  rmSync(join(zen.dir, "cli"), { recursive: true, force: true });
});

/** 本机宿主（当前目录这条糖能用） */
const LOCAL_HOST: WorkspaceHost = { local: true, key: "local" };
/** 一台远端宿主（地址就是记忆的键） */
const REMOTE_HOST: WorkspaceHost = { local: false, key: "ws://10.0.0.5:8790" };

/** 跑一次 `ai "…"`：递一条假连接，把 stdout / stderr 抓成字符串 */
async function run(
  connection: HostConnection | undefined,
  options: {
    instruction: string;
    save?: boolean;
    stdin?: string;
    /** 这次连的是哪台宿主；缺省本机 */
    host?: WorkspaceHost;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runStdio(
    {
      instruction: options.instruction,
      save: options.save ?? false,
      // 递了现成连接时 `env` 里的地址/凭证用不到，但它仍然必填
      env: resolveCliEnv({ env: process.env }),
      logger: QUIET_LOG,
    },
    {
      ...(connection ? { connection } : {}),
      // 注入了连接时，宿主身份也得一起给：本机与远端「落在哪个目录」是两条不同的路
      host: options.host ?? LOCAL_HOST,
      readInput: async () => options.stdin ?? "",
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (line) => {
        stderr += line + "\n";
      },
    },
  );
  return { code, stdout, stderr };
}

describe("runStdio：一次性调用（默认走临时会话）", () => {
  it("答案只写 stdout，退出码 0，stderr 干净；连会话都不建", async () => {
    const connection = fakeConnection({
      reply: (method) => {
        if (method === "config.get") {
          return { config: { models: [], defaultAgent: "default" }, presets: {} };
        }
        if (method === "session.transient") return { messages: [answer("答复")] };
        return undefined;
      },
    });

    const result = await run(connection, { instruction: "你好" });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("答复\n");
    expect(result.stderr).toBe("");
    // 「一次性管道调用不该篡改用户的会话列表」的全部证据：一条会话行都没建
    expect(connection.calls.map((call) => call.method)).not.toContain("agent.send");
    // 本机：当前目录这条糖（**不登记项目**），内容原样递上去
    expect(connection.calls.find((call) => call.method === "workspace.create")).toBeUndefined();
    expect(
      connection.calls.find((call) => call.method === "session.transient")?.params,
    ).toMatchObject({ cwd: process.cwd(), agentId: "default", content: "你好" });
    // 调用方递进来的连接归调用方（本入口只关自己造的那条）
    expect(connection.closed).toBe(false);
  });

  it("stdin 与参数合并后一次发出去", async () => {
    const connection = fakeConnection({
      reply: (method) => {
        if (method === "config.get") {
          return { config: { models: [], defaultAgent: "default" }, presets: {} };
        }
        if (method === "session.transient") return { messages: [answer("好")] };
        return undefined;
      },
    });

    await run(connection, { instruction: "总结下面", stdin: "第一行\n第二行\n" });

    expect(
      connection.calls.find((call) => call.method === "session.transient")?.params,
    ).toMatchObject({ content: "总结下面\n\n第一行\n第二行" });
  });

  it("宿主说这一轮不好（那条消息是 `error`）：错误走 stderr、退出码 1、stdout 为空", async () => {
    const connection = fakeConnection({
      reply: (method) => {
        if (method === "config.get") {
          return { config: { models: [], defaultAgent: "default" }, presets: {} };
        }
        if (method === "session.transient") {
          return { messages: [answer("", AgentNS.MessageStatus.Error)] };
        }
        return undefined;
      },
    });

    const result = await run(connection, { instruction: "你好" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ai: the model returned an error");
  });

  it("连不上宿主：一句话 + 退出码 1（不抛栈）", async () => {
    const connection = fakeConnection({
      reply: () => new Error("与宿主的连接断了"),
    });

    const result = await run(connection, { instruction: "你好" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ai: 与宿主的连接断了");
  });
});

describe("runStdio：--save 走真会话", () => {
  /**
   * 一段真会话要的几条回执：列项目 → 建行（`session.create`）→ 叫起来（`agent.wake`）→
   * 投一句（`agent.send`）→ 跟读（`session.open` 一次取全）。
   *
   * 宿主的行为：`agent.send` **受理即回**，这一句的落地与答复随后从事件上来（这里下一拍就走完）。
   */
  function savingConnection(messages: AgentNS.Message[]) {
    let connection!: FakeConnection;
    connection = fakeConnection({
      reply: (method) => {
        switch (method) {
          case "workspace.list":
            // 一次性调用按 `process.cwd()` 找项目：已有这个目录就直接用它
            return [{ id: "ws-1", name: "proj", cwd: process.cwd(), createdAt: 0 }];
          case "config.get":
            // 没点名助手时用宿主配置里的默认助手
            return { config: { models: [], defaultAgent: "default" }, presets: {} };
          case "agentDefinition.get":
            return { definition: { name: "默认助手" } };
          case "session.create":
            // 只建行：回来的那一行就是这一段
            return { session: sessionRow };
          case "agent.send":
            setTimeout(() => {
              const landed: AgentNS.Message[] = [
                { id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "留一份" },
                ...messages,
              ];
              for (const message of landed) {
                connection.emit({ type: "message.added", sessionId: "sess-1", message });
              }
            }, 0);
            return { sessionId: "sess-1", messageId: "u-1" };
          case "notice.list":
            return [];
          default:
            return undefined;
        }
      },
      open: () =>
        openView({
          messages: [
            { id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "留一份" },
            ...messages,
          ],
        }),
    });
    return connection;
  }

  it("答案照旧只出现在 stdout，另在 stderr 报一句会话 id", async () => {
    const connection = savingConnection([answer("答复")]);

    const result = await run(connection, { instruction: "留一份", save: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("答复\n");
    expect(result.stderr).toContain("Saved session: sess-1");
    // 建行打的是 `session.create`（只写一行），建出来的那一段交给会话层跟读
    const create = connection.calls.find((call) => call.method === "session.create");
    expect(create?.params).toEqual({ workspaceId: "ws-1", agentId: "default" });
    // 投的那一句是真的那一句（不是空正文），落在那一段上
    const send = connection.calls.filter((call) => call.method === "agent.send").at(-1);
    expect(send?.params).toMatchObject({ sessionId: "sess-1", content: "留一份" });
    // 建行不造执行体：先叫起来再投，两件事的次序就是这个
    const methods = connection.methods();
    expect(methods.indexOf("agent.wake")).toBeLessThan(methods.indexOf("agent.send"));
    // 没用一次性那条路
    expect(methods).not.toContain("session.transient");
  });

  it("不挪「本机上次打开的那段会话」（下次 `ai` 不会续接到一条管道结果上）", async () => {
    const connection = savingConnection([answer("答复")]);

    await run(connection, { instruction: "留一份", save: true });

    // 记忆文件压根没被写（`remember: false`）
    const memory = join(zen.dir, "cli", "last-session.json");
    expect(() => rmSync(memory, { force: false })).toThrow();
  });

  it("模型报错：stdout 为空、错误走 stderr、退出码 1", async () => {
    const connection = savingConnection([answer("", AgentNS.MessageStatus.Error)]);

    const result = await run(connection, { instruction: "你好", save: true });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ai: ");
  });
});

describe("runStdio：远端宿主（D30：不许拿本机 cwd 去猜）", () => {
  /**
   * 一台**远端**宿主的回执：项目按 id 给，目录是**它那台机器**上的（`/srv/repo`）。
   *
   * 这里刻意不提供 `workspace.create`：一次性调用在远端上不该往宿主的项目表里登记任何东西。
   */
  function remoteConnection(
    options: {
      folder?: string;
      messages?: AgentNS.Message[];
      /** 那台机器上有哪些项目（缺省一个：`ws-remote`）；给 `[]` = 没记过 */
      workspaces?: { id: string; name: string; cwd: string }[];
      /** `session.transient` 回的那几条（缺省不回 = 那条路不该走到） */
      transient?: AgentNS.Message[];
    } = {},
  ) {
    const folder = options.folder ?? "/srv/repo";
    const messages = options.messages ?? [];
    const workspaces = options.workspaces ?? [{ id: "ws-remote", name: "repo", cwd: folder }];
    let connection!: FakeConnection;
    connection = fakeConnection({
      reply: (method) => {
        switch (method) {
          case "workspace.list":
            return workspaces.map((item) => ({ ...item, createdAt: 0 }));
          case "config.get":
            return { config: { models: [], defaultAgent: "default" }, presets: {} };
          case "agentDefinition.get":
            return { definition: { name: "默认助手" } };
          case "session.transient":
            return { messages: options.transient ?? [] };
          case "session.create":
            // 建出来的那一段落在那台机器的项目里（只建行，不造执行体）
            return { session: { ...sessionRow, workspaceId: "ws-remote" } };
          case "agent.send":
            setTimeout(() => {
              const landed: AgentNS.Message[] = [
                { id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "留一份" },
                ...messages,
              ];
              for (const message of landed) {
                connection.emit({ type: "message.added", sessionId: "sess-1", message });
              }
            }, 0);
            return { sessionId: "sess-1", messageId: "u-1" };
          case "notice.list":
            return [];
          default:
            return undefined;
        }
      },
      open: () =>
        openView({
          session: { ...sessionRow, workspaceId: "ws-remote" },
          messages: [
            { id: "u-1", createdAt: 1, role: AgentNS.Role.User, content: "留一份" },
            ...messages,
          ],
        }),
    });
    return connection;
  }

  it("没进入过工作区：拒绝并指路 /ws，`workspace.create` 一条都不发", async () => {
    // 远端 + 没记过 = 没有可用的项目
    const connection = remoteConnection({ workspaces: [] });

    const result = await run(connection, { instruction: "你好", host: REMOTE_HOST });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("/ws");
    // 这条就是 D30 要消灭的行为：把本机的 `process.cwd()` 当成宿主上的目录登记进去
    expect(connection.calls.map((call) => call.method)).not.toContain("workspace.create");
    expect(connection.calls.map((call) => call.method)).not.toContain("session.transient");
  });

  it("记着上次进入的那个：临时会话跑在**它那台机器**的目录里", async () => {
    await rememberWorkspace(REMOTE_HOST, "ws-remote", QUIET_LOG);
    const connection = remoteConnection({ folder: "/srv/repo", transient: [answer("答复")] });

    const result = await run(connection, { instruction: "你好", host: REMOTE_HOST });

    expect(result.code).toBe(0);
    expect(
      connection.calls.find((call) => call.method === "session.transient")?.params,
    ).toMatchObject({ cwd: "/srv/repo" });
    // 从来没把本机目录递上去
    expect(
      connection.calls.find((call) => call.method === "session.transient")?.params,
    ).not.toMatchObject({ cwd: process.cwd() });
  });

  it("--save：用那个工作区的 id 开真会话", async () => {
    await rememberWorkspace(REMOTE_HOST, "ws-remote", QUIET_LOG);
    const connection = remoteConnection({ messages: [answer("答复")] });

    const result = await run(connection, { instruction: "留一份", save: true, host: REMOTE_HOST });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Saved session: sess-1");
    // 建行用的是那个工作区的 id（不是本机目录）
    expect(connection.calls.find((call) => call.method === "session.create")?.params).toEqual({
      workspaceId: "ws-remote",
      agentId: "default",
    });
    expect(connection.calls.find((call) => call.method === "agent.send")?.params).toMatchObject({
      workspaceId: "ws-remote",
      agentId: "default",
    });
  });

  it("记着的那个已经没了（宿主那台机器上没这个项目）：按「没记过」处理，不报错也不猜", async () => {
    await rememberWorkspace(REMOTE_HOST, "ws-gone", QUIET_LOG);
    const connection = remoteConnection({ workspaces: [] });

    const result = await run(connection, { instruction: "你好", host: REMOTE_HOST });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("/ws");
    // 列了一次项目就停手（没有拿本机目录去登记，也没跑一次性会话）
    expect(connection.calls.map((call) => call.method)).toContain("workspace.list");
    expect(connection.calls.map((call) => call.method)).not.toContain("workspace.create");
    expect(connection.calls.map((call) => call.method)).not.toContain("session.transient");
  });
});

describe("没配过宿主：一次性调用直接失败，不偷偷拉起本地宿主", () => {
  it("退出码 2 + 一句指路的话，且没读 stdin", async () => {
    const bare = mkdtempSync(join(tmpdir(), "aiz-stdio-unset-"));
    let readStdin = 0;
    let stderr = "";
    try {
      const code = await runStdio(
        {
          instruction: "你好",
          save: false,
          env: resolveCliEnv({ env: { AI_ZEN_DIR: bare } }),
          logger: QUIET_LOG,
        },
        {
          readInput: async () => {
            readStdin += 1;
            return "";
          },
          writeOut: () => {},
          writeErr: (line) => {
            stderr += line + "\n";
          },
        },
      );

      expect(code).toBe(2);
      expect(stderr).toContain("no host configured");
      // 指路：要么进交互界面选一次，要么当场用 --server 说清楚
      expect(stderr).toContain("run `ai` once");
      expect(stderr).toContain("--server");
      // 判定发生在消费管道之前：`cat 大文件 | ai "…"` 不必先把管道读完再报错
      expect(readStdin).toBe(0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("有参数没内容：退出码 2（不去连宿主）", async () => {
    const connection = fakeConnection({ reply: () => undefined });

    const result = await run(connection, { instruction: "   " });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no input");
    expect(connection.calls).toEqual([]);
  });
});

describe("读 stdin 失败 ≠ 没给输入", () => {
  it("读 stdin 抛错：原因原样写 stderr、退出码 1（不再说「没给输入」）", async () => {
    const connection = fakeConnection({ reply: () => undefined });
    let stdout = "";
    let stderr = "";

    const code = await runStdio(
      {
        instruction: "你好",
        save: false,
        env: resolveCliEnv({ env: process.env }),
        logger: QUIET_LOG,
      },
      {
        connection,
        host: LOCAL_HOST,
        readInput: async () => {
          throw new Error("EIO: i/o error, read");
        },
        writeOut: (text) => {
          stdout += text;
        },
        writeErr: (line) => {
          stderr += line + "\n";
        },
      },
    );

    // 读失败是失败：真因 + 退出码 1
    expect(code).toBe(1);
    expect(stderr).toContain("ai: EIO: i/o error, read");
    // 「你没给输入」是一句假话 —— 用户明明管道了东西，是读的时候失败了
    expect(stderr).not.toContain("no input");
    expect(stdout).toBe("");
    // 读都没读成，不去连宿主
    expect(connection.calls).toEqual([]);
  });

  it("真没输入（空的 stdin、也没有参数）：仍是退出码 2 + 「没给输入」", async () => {
    const connection = fakeConnection({ reply: () => undefined });

    const result = await run(connection, { instruction: "" });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no input");
    expect(connection.calls).toEqual([]);
  });
});

describe("runStdio：本机拉起宿主失败（一次性调用没有屏）", () => {
  /**
   * 盘上那份是「本机」：`ai "…"` 会去拉起宿主（npx 现下现起）。拉不起来时一次性调用**没有**
   * 重试与折回的地方 —— 只有一行原因 + 非 0 退出码，脚本才好分支。
   */
  function seedLocalPlan(): void {
    mkdirSync(join(zen.dir, "cli"), { recursive: true });
    writeFileSync(
      join(zen.dir, "cli", "connection.json"),
      JSON.stringify({ mode: "local" }),
      "utf-8",
    );
  }

  it("失败 → 原因写 stderr、退出码非 0、stdout 为空；阶段不递下去（进度直接丢）", async () => {
    seedLocalPlan();
    const seen: ConnectHostOptions[] = [];
    let stdout = "";
    let stderr = "";

    const code = await runStdio(
      {
        instruction: "你好",
        save: false,
        env: resolveCliEnv({ env: process.env }),
        logger: QUIET_LOG,
      },
      {
        connect: async (options) => {
          seen.push(options);
          throw localError("host_launch_failed", {
            language: "en",
            params: { reason: "npm error 404 not found", log: "/x/logs/cli/launch.log" },
          });
        },
        readInput: async () => "",
        writeOut: (text) => {
          stdout += text;
        },
        writeErr: (line) => {
          stderr += line + "\n";
        },
      },
    );

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("npm error 404 not found");
    // 这条路上没有屏：不递 `onStage`，也就没有「进度要不要显示」这个问题
    expect(seen).toHaveLength(1);
    expect(seen[0]!.onStage).toBeUndefined();
    expect(seen[0]!.settings).toEqual({ mode: "local" });
  });
});
