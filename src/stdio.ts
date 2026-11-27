/**
 * 纯 stdio 模式运行器：一次性调用，但跑在宿主里。
 *
 * 约定：不进入交互循环、不显示横幅、不等待任何按键；只把最终的 assistant 文本写入 stdout（零 ANSI、
 * 零 emoji 前缀、零 spinner）；日志、进度、通知一律走 stderr；成功退出码 0，失败非 0。
 *
 * 两条路。默认（不带 `--save`）走 `runtime.agent.runOnce`：一次性管道调用不属于任何会话，无 id、不落
 * 库、不进列表，本机这条连项目行都不建；远端那条要给那个项目的 `cwd`，因为一次性会话需要一个目录去装
 * 配 Scope，而那台机器上的目录只有项目行知道，没有项目就先让用户去 `ai` 里挑一个。带 `--save` 则走
 * `session.create` + `agent.wake` + `agent.send`，再 `session.open` 跟读：用户明说要留下这一段，那就
 * 得是一段真会话。
 *
 * 三条刻意保持的旧行为：默认不落盘（`runOnce` 跑完即弃，会话列表一条都不会多）；`--save` 不挪「上次
 * 打开」（写完 stderr 那一行 id，但会话层「上次打开的那段」记忆不动）；stdout 只有答案。
 *
 * 一次性调用没有人可以问，所以这条路上都不给 `onQuestion`：宿主的题会一直挂着，它不替用户选一个选项
 * —— 交接去哪是产品决定，不是客户端的。
 *
 * 一个不能碰的时序：本文件被 `index.ts` 静态 import，而 `index.ts` 里
 * `process.env.NODE_ENV ||= "production"` 那一行要等模块体求值才执行。所以这条 import 链上不许出现
 * React / Ink（判据是产物图：`node scripts/check-imports.mjs dist/stdio.js --forbid tui/`）。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { LogSink } from "@ai-zen/agents-logger";
import { connectHost, readConnectPlan } from "./connection.js";
import type { ConnectHostOptions, ConnectedHost } from "./connection.js";
import type { CliEnv } from "./env.js";
import { RemoteChatSession } from "./session.js";
import type { ChatSessionNotifier, HostConnection } from "./session/types.js";
import { toCoreMessages } from "./server-client/index.js";
import { enterWorkspace, workspaceHost, type WorkspaceHost } from "./workspace.js";

export interface StdioRunOptions {
  instruction: string;
  save: boolean;
  env: CliEnv;
  logger: LogSink;
}

/**
 * 注入点（生产全用缺省值，测试喂一条假的连接与几个字符串出口）。
 *
 * `writeOut` / `writeErr` / `readInput` 单独留口子而不是让测试去 patch `process.*`：「stdout 只含答
 * 案」是本模式的全部契约，它必须能被直接断言。
 */
export interface StdioRunDeps {
  connection?: HostConnection;
  readInput?: () => Promise<string>;
  writeOut?: (text: string) => void;
  writeErr?: (line: string) => void;
  connect?: (options: ConnectHostOptions) => Promise<ConnectedHost>;
  host?: WorkspaceHost;
}

function logStderr(line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}

/**
 * 读取全部 stdin 文本。
 *
 * stdin 为 TTY（没有管道）时返回空串：那是这次没管道内容，不是失败。读出错则原样抛。
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8").replace(/\r\n/g, "\n");
}

/**
 * 合并「指令 + stdin 内容」（参数是指令、stdin 是内容 —— 两者都有的场景必须合并）。
 * - 两者都有：` 指令\n\n 内容 `
 * - 仅其一：取该者
 */
export function mergePrompt(instruction: string, stdin: string): string {
  const inst = instruction.trim();
  const body = stdin.replace(/\r?\n$/, "");
  if (inst && body.trim()) return `${inst}\n\n${body}`;
  if (inst) return inst;
  return body;
}

export function extractText(content: AgentNS.MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const section of content) {
    if (section.type === "text") parts.push(section.text);
    else if (section.type === "image_url") parts.push(`[Image: ${section.image_url.url}]`);
    else if (section.type === "file")
      parts.push(`[File: ${section.file_id ?? section.filename ?? "inline file"}]`);
  }
  return parts.join("\n");
}

function isUsableAnswer(message: AgentNS.Message | undefined): message is AgentNS.Message {
  return message !== undefined && message.status !== AgentNS.MessageStatus.Error;
}

function lastAnswer(messages: readonly AgentNS.Message[]): AgentNS.Message | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === AgentNS.Role.Assistant) return message;
  }
  return undefined;
}

/**
 * 等到这一段闲下来、且最后一条 AgentDefinition 消息不再还在写。
 *
 * 事件是主要来路（每一条都重新看一眼），定时重查是兜底。与 `session.ts` 的 `waitForReply` 同一个口
 * 径：没有「一轮」这个概念，判据只有忙闲与消息状态。
 */
async function waitForAnswer(
  connection: HostConnection,
  sessionId: string,
  waitMs = 500,
): Promise<readonly AgentNS.Message[]> {
  for (;;) {
    const snapshot = await connection.resync(sessionId);
    const status = snapshot.snapshot().status;
    const answer = lastAnswer(snapshot.messages);
    const writing =
      answer !== undefined &&
      (answer.status === AgentNS.MessageStatus.Pending ||
        answer.status === AgentNS.MessageStatus.Writing);
    if (status === "idle" && answer !== undefined && !writing) return snapshot.messages;
    await new Promise<void>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        off();
        resolve();
      }, waitMs);
      const off = connection.subscribe((event) => {
        if (done) return;
        if (!("sessionId" in event) || event.sessionId !== sessionId) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }
}

/** 运行一次纯 stdio 会话，返回进程退出码 */
export async function runStdio(options: StdioRunOptions, deps: StdioRunDeps = {}): Promise<number> {
  const { instruction, save } = options;
  const writeErr = deps.writeErr ?? logStderr;
  const writeOut = deps.writeOut ?? writeStdout;

  /**
   * 这一台是怎么选的：显式地址 / 环境变量优先，其次落盘那份 `<aiZenDir>/cli/connection.json`。
   *
   * 两样都没有等于没配过，直接失败，不替用户拉起一个本地宿主。判定放在读 stdin 之前：
   * `cat 大文件 | ai "…"` 这种情况下没必要先把管道读完再报错。
   */
  const settings = deps.connection ? null : await readConnectPlan(options.env);
  if (!deps.connection && !settings) {
    writeErr(
      "ai: no host configured yet — run `ai` once to pick one, or pass --server <url>" +
        " (AI_ZEN_SERVER_URL works too)",
    );
    return 2;
  }

  /** 保持 stdout 纯净：第三方依赖内部仍有直接调 `console.log` 的地方，这里一起改道 */
  const originalLog = console.log;
  console.log = (...args: unknown[]) => writeErr(args.map((a) => String(a)).join(" "));

  /** 这一条连接是谁造的：自己造的自己关（调用方递进来的归调用方） */
  let client: HostConnection | null = deps.connection ?? null;
  let session: RemoteChatSession | null = null;
  try {
    const prompt = mergePrompt(instruction, await (deps.readInput ?? readStdin)());
    if (!prompt.trim()) {
      writeErr("ai: no input (pass an argument or pipe text in)");
      return 2;
    }

    if (!client) {
      const connect = deps.connect ?? connectHost;
      client = (await connect({ env: options.env, settings: settings! })).client;
    }

    /** 这台宿主是不是本机：`mode: "local"` 或地址回环（判据在 `workspace.ts`） */
    const host = deps.host ?? (settings ? workspaceHost(settings) : null);
    if (host === null) {
      writeErr("ai: the injected connection did not say which host it is (pass `host`)");
      return 2;
    }

    /** 用哪个 AgentDefinition：宿主配置里的默认 AgentDefinition（缺省项归宿主，客户端不猜） */
    const agentId = await defaultAgentId(client);

    if (!save) {
      /**
       * 默认这条路连会话都不建：`runtime.agent.runOnce` 就是「投一句、跑到头、跑完即散」。
       *
       * 本机可以直接给当前目录（不登记项目：一次管道调用不该往宿主的项目列表里塞东西）；
       * 远端只能用「上次进入的那个项目」的目录 —— 那台机器上的目录只有用户知道。
       */
      const cwd = host.local ? process.cwd() : await remoteCwd(client, host, options.logger);
      if (cwd === null) {
        writeErr(
          "ai: no workspace on that host yet — run `ai` once and pick one with /ws" +
            " (or create one with /ws new <absolute path on the host>)",
        );
        return 2;
      }

      const { messages } = await client.api.runtime.agent.runOnce.mutate({
        cwd,
        agentId,
        content: prompt,
      });
      const answer = lastAnswer(toCoreMessages(messages));
      if (!isUsableAnswer(answer)) {
        writeErr("ai: the model returned an error");
        return 1;
      }
      const text = extractText(answer.content);
      if (text) writeOut(text.endsWith("\n") ? text : text + "\n");
      return 0;
    }

    /**
     * `--save`：用户明说要留下这一段，所以走真会话 —— `session.create` 写一行、`agent.wake` 把
     * Agent 造出来、`agent.send` 把这一句投进去；回来的 id 再交给会话层跟读。
     */
    const entered = await enterWorkspace({
      connection: { api: client.api },
      host,
      cwd: process.cwd(),
      logger: options.logger,
    });
    if (entered === null) {
      writeErr(
        "ai: no workspace on that host yet — run `ai` once and pick one with /ws" +
          " (or create one with /ws new <absolute path on the host>)",
      );
      return 2;
    }

    const { session: created } = await client.api.session.create.mutate({
      workspaceId: entered.id,
      agentId,
    });
    const sessionId = created.id;

    // 建行不造 Agent：先叫起来，投递才有对象可投（宿主对没有 Agent 的会话只回 not_found）
    await client.api.runtime.agent.wake.mutate({ sessionId });
    await client.api.runtime.agent.send.mutate({
      workspaceId: entered.id,
      agentId,
      sessionId,
      content: prompt,
      messageId: `cli-${Date.now().toString(36)}`,
    });

    /** 会话层跟读这一段：消息、忙闲、失败事实都由它维护；`remember: false` 不挪续接目标 */
    const notifier: ChatSessionNotifier = {
      // 没有界面可刷：屏幕不渲染，正文只在收尾时从消息里取
      onChange: () => {},
      onNotice: (text) => writeErr(text),
    };
    session = await RemoteChatSession.open(
      client,
      { sessionId, remember: false },
      notifier,
      options.logger,
    );
    const messages = await waitForAnswer(client, sessionId);

    const answer = lastAnswer(messages);
    if (!isUsableAnswer(answer)) {
      writeErr("ai: the model returned an error");
      return 1;
    }

    writeErr(`Saved session: ${sessionId}`);

    // 结果：仅此一处写入 stdout
    const text = extractText(answer.content);
    if (text) writeOut(text.endsWith("\n") ? text : text + "\n");
    return 0;
  } catch (error) {
    writeErr(`ai: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    /**
     * 收尾两步的顺序不能反：先卸会话、后断连接。
     *
     * 连接一定要断（自己造的那条）：一条活 socket 会把进程钉在事件循环里。
     */
    session?.dispose();
    if (!deps.connection && client) await client.close();
    console.log = originalLog;
  }
}

/** 宿主配置里的默认 AgentDefinition */
async function defaultAgentId(connection: HostConnection): Promise<string> {
  const { config } = await connection.api.config.get.query();
  const agentId = config.defaultAgent;
  if (!agentId) {
    throw new Error("宿主配置里没有默认助手（`config.defaultAgent`）：先配置一个助手再跑");
  }
  return agentId;
}

/** 远端那一侧：上次进入的那个项目的 `cwd`；没有就 `null`（由调用方指路，绝不猜目录） */
async function remoteCwd(
  connection: HostConnection,
  host: WorkspaceHost,
  logger: LogSink,
): Promise<string | null> {
  const entered = await enterWorkspace({
    connection: { api: connection.api },
    host,
    cwd: process.cwd(),
    logger,
  });
  return entered?.folder.cwd ?? null;
}
