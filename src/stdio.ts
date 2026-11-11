/**
 * 纯 stdio 模式运行器 —— 一次性调用，但**跑在服务端**。
 *
 * 约定：
 *   - 不进入交互循环、不显示横幅、不等待任何按键；
 *   - 仅把**最终 assistant 文本**写入 stdout（零 ANSI、零 emoji 前缀、零 spinner）；
 *   - 日志 / 进度 / 通知一律走 stderr；
 *   - 成功退出码 0，失败非 0。
 *
 * ## 为什么这里不自己跑 Agent
 *
 * 自己造一套运行时（`new Scope(...)`、`agent.use(...)` 装插件、自己解析 model / endpoint /
 * apiKey、自己往 `workspaces/` 写存档）等于把同一件事实现两遍：同一个工作区在 TUI 与
 * `ai "…"` 各有一套 MCP 连接，而服务端每加一样能力（每轮落盘、交接提问、工具刷新档位）
 * 这条路径都得再实现一遍 —— 漏一处就是个安静的缺口（参数传空、钩子没装，界面上一切正常）。
 *
 * 所以它只是**一条瘦客户端**：`ensureServer`（没有服务端就拉一个）→ 开会话（`persist:false`）
 * → 发一轮 → 等 `session-turn-end` → 取最后一条 assistant → 关会话。Agent 在哪跑、插件怎么装、
 * 存档写在哪，全都只有服务端那一份答案。
 *
 * 三条被**刻意保持**的旧行为（都是文档与用例锁着的）：
 *
 *   1. **不落盘**：`persist:false` → 这一轮不进 `workspaces/<id>/sessions/`，也不挪「本工作区
 *      上一轮会话」指针。一次性管道调用不该篡改用户的对话列表，更不该让下次 `ai` 续接到它；
 *   2. **`--save` 只归档、不动指针**：`session.save { setAsLast:false }` —— 写档，但不把
 *      「本工作区上一轮会话」挪过去。这条走的是**会话自己的 channel**
 *      （`RemoteChatSession.save` → `SessionChannel.save`），**不是** `RemoteSessions` 门面：
 *      门面是「按 id 说话」的无状态薄封装，不知道「当前这一段是哪个 id」，而「不挪指针」
 *      恰恰只能由会话自己去说（见 `runStdio` 里那一处的注释）；
 *   3. **stdout 只有答案**：其余一切（含服务端推来的通知）走 stderr。
 *
 * ## 一个不能碰的时序
 *
 * 本文件被 `index.ts` **静态** import，而 `index.ts` 里 `process.env.NODE_ENV ||= "production"`
 * 那一行要等模块体求值才执行（ESM 的静态 import 在它之前求值）。所以这条 import 链上
 * **不许出现 React / Ink**：DEV 版 reconciler 的 `performance.measure()` 缓冲无界增长，长会话
 * 会把堆顶爆（见 index.ts 顶部那段）。
 *
 * 光靠一句注释（「现在的依赖里恰好没有 React」）守不住这条约束，所以它是个**结构事实**：
 * 会话层在 `session.ts` 而不是 `tui/`，于是 `dist/stdio.js` 的 import 图里一个 `tui/`
 * 路径都没有。判据是产物图（`node scripts/check-imports.mjs dist/stdio.js --forbid tui/`），
 * 不是路径 grep —— grep 改个 import 写法就绿了。
 *
 * ## 提问没人答
 *
 * 服务端的自动迁移到阈值会发 `session-question` 并**等**答复。这里不给 `requestMode`
 * （没有人能问），于是 `RemoteChatSession.answerQuestion` 直接回服务端给的 `fallback`
 * —— 交接类问题的兜底是 `null`（本次不交接），那一轮继续跑完，不会挂到超时。
 */

import { AgentNS } from "@ai-zen/agents-core";
import { setLogger } from "@ai-zen/agents-sdk";
import type { CliEnv } from "./env.js";
import {
  createConfigPort,
  createServerConnection,
  type ConfigPort,
  type ServerConnection,
} from "./server-client/index.js";
import type { ChatSessionNotifier } from "./session/types.js";
import { RemoteChatSession } from "./session.js";

export interface StdioRunOptions {
  /** 位置参数拼接而成的指令（可空，此时全部内容来自 stdin） */
  instruction: string;
  /** 是否保存对话存档（默认 false，不落盘） */
  save: boolean;
  /**
   * 本进程的事实（配置根 / 显式地址与凭证）—— 由根（`CliApp`）递进来。
   *
   * **必填**：本文件不读 `process.env`。一个「不传就去全局拿」的缺省会让「这件事是怎么连上
   * 那台机器的」重新变成要读实现才知道的事。
   */
  env: CliEnv;
}

/**
 * 注入点（生产全用缺省值，测试喂一条本机 socket 与几个字符串出口）。
 *
 * `writeOut` / `writeErr` / `readInput` 单独留口子而不是让测试去 patch `process.*`：
 * 「stdout 只含答案」是本模式的全部契约，它必须能被直接断言，而不是靠抓进程输出。
 */
export interface StdioRunDeps {
  /**
   * 那**一条**连接。缺省由本入口自己用 `options.env` 造一个（`createServerConnection(env)`）：
   * stdio 是独立入口，没有别的上层可以靠。
   */
  connection?: ServerConnection;
  /** 读 stdin；缺省 {@link readStdin}（TTY 时返回空串） */
  readInput?: () => Promise<string>;
  /** 结果出口；缺省 `process.stdout.write` */
  writeOut?: (text: string) => void;
  /** 日志出口；缺省 `process.stderr.write` */
  writeErr?: (line: string) => void;
  /**
   * 配置面（只为读「用哪个 Agent」）。缺省由那条 `connection` 派生 —— 客户端不再读本机
   * `config.json`：那份在这一侧可能根本不存在，也可能与 Agent 实际用的不是一份。
   */
  config?: ConfigPort;
}

/** 向 stderr 写一行（stdlib 日志统一出口） */
function logStderr(line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}

/**
 * 读取全部 stdin 文本。
 * stdin 为 TTY（无管道）或读取失败时返回空串。
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString("utf-8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

/**
 * 合并「指令 + stdin 内容」（参数是指令、stdin 是内容 —— 两者都有的场景必须合并）。
 * - 两者都有：`指令\n\n内容`
 * - 仅其一：取该者
 */
export function mergePrompt(instruction: string, stdin: string): string {
  const inst = instruction.trim();
  const body = stdin.replace(/\r?\n$/, "");
  if (inst && body.trim()) return `${inst}\n\n${body}`;
  if (inst) return inst;
  return body;
}

/** 从内容块中提取纯文本；非文本块（图片/文件）以占位文本表示 */
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

/**
 * 关掉这次一次性调用的会话（幂等，吞掉所有失败）。
 *
 * 单独成函数是因为它只在 `finally` 里用，而那里不能抛：`finally` 里抛出去会把
 * 已经在返回路上的退出码顶成未处理错误（用户看到一行栈，而不是模型答案）。
 * 会话已经被服务端回收掉（`unknown-session`）是常态——那时目的已经达成了。
 */
async function closeQuietly(session: RemoteChatSession | null): Promise<void> {
  try {
    await session?.close();
  } catch {
    // 见上：不在就不在，没什么要说的
  }
}

/** 运行一次纯 stdio 对话，返回进程退出码 */ export async function runStdio(
  options: StdioRunOptions,
  deps: StdioRunDeps = {},
): Promise<number> {
  const { instruction, save } = options;
  const writeErr = deps.writeErr ?? logStderr;
  const writeOut = deps.writeOut ?? writeStdout;

  const prompt = mergePrompt(instruction, await (deps.readInput ?? readStdin)());
  if (!prompt.trim()) {
    writeErr("ai: no input (pass an argument or pipe text in)");
    return 2;
  }

  /**
   * 保持 stdout 纯净：SDK 全局日志走 `setLogger` 改道，但 SDK（及第三方依赖）内部仍有
   * **直接调用 console.log** 的地方，不经我们的 logger；管道模式下那会把日志混进模型输出，
   * 所以这里连 `console.log` 一起改道（`finally` 里还原）。
   */
  const originalLog = console.log;
  setLogger({ info: writeErr, warn: writeErr, error: writeErr });
  console.log = (...args: unknown[]) => writeErr(args.map((a) => String(a)).join(" "));

  /** 这个入口自己造的那条连接（除非调用方递了一条） */
  const connection = deps.connection ?? createServerConnection(options.env);
  let session: RemoteChatSession | null = null;
  try {
    /**
     * 用哪个 Agent 也问服务端（`AppConfig.defaultAgent`，缺省 `default`）。
     *
     * 这里只读**这一个字段**是有意的：model → endpoint → apiKey 的解析属于服务端装配方
     * （`SessionAgentFactory` + SDK 的 `createAgent`），配置有毛病时 `session.create`
     * 会把 SDK 的原话带回来，客户端只负责转达。
     *
     * 配置面与对话走**同一条**连接（`createConfigPort(connection)`）：本入口只有一条
     * 连接可用，再建一条就是「一个进程两条连接」那个病。
     */
    const configPort = deps.config ?? createConfigPort(connection);
    const agentId = (await configPort.readConfig()).defaultAgent ?? "default";

    /**
     * 通知就是这一模式的「通知栏」，落在 stderr 上。
     *
     * 进度类（`info`）照原样打出去 —— 一次性调用也可能碰上「正在写交接文档」这种事，
     * 静默十秒比多一行 stderr 更糟。错误类先记着，由收尾那一步统一成 `ai: …` 一行 ——
     * 同一条错误不会打两遍。
     */
    let failure: string | null = null;
    const notifier: ChatSessionNotifier = {
      // 没有界面可刷：屏幕不渲染，正文只在收尾时从服务端那份快照里取
      onChange: () => {},
      onNotice: (text, tone) => {
        if (tone === "info") writeErr(text);
        else failure = text;
      },
    };

    session = await RemoteChatSession.open(connection, { agentId, persist: false }, notifier);

    /**
     * 一轮 = `send()`（受理即回，拿到 `turnId`）+ `waitForTurn()`（等它真的结束）：
     * 两半分开是协议的形状（`session-turn-end` 可能先于回执落地），TUI 包 `busy` 用的是同一对。
     *
     * 等完之后消息**已经是服务端那份快照**：包里的收尾先换快照、后置「已收尾」标记
     * （否则一轮很短时这里会读到空数组，打出「模型没回答」）。
     */
    await session.send(prompt);
    await session.waitForTurn();

    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === AgentNS.Role.Assistant);

    if (!lastAssistant || lastAssistant.status === AgentNS.MessageStatus.Error) {
      writeErr(`ai: ${failure ?? "the model returned an error"}`);
      return 1;
    }

    if (save) {
      // 归档这次一次性调用：写档，但**不**挪「本工作区上一轮会话」指针 ——
      // 否则连跑几条 `cat … | ai --save` 之后，下次 `ai` 会续接到最后一条管道结果上。
      //
      // 走 `session.save`（即 channel）而不是现取 `RemoteSessions` 门面：门面是「按 id 说话」
      // 的无状态薄封装，它不知道「当前这一段是哪个 id」，而应用里那份「当前 id」会漂
      // （重连换了连接、存档换了键）。包里补上了 `setAsLast` 透传之后，绕法作废。
      const saved = await session.save({ setAsLast: false });
      writeErr(`Saved conversation: ${saved}`);
    }

    // 结果：仅此一处写入 stdout
    const text = extractText(lastAssistant.content);
    if (text) writeOut(text.endsWith("\n") ? text : text + "\n");
    return 0;
  } catch (error: any) {
    writeErr(`ai: ${error?.message ?? error}`);
    return 1;
  } finally {
    /**
     * 收干净的第一步是 **`session.close()`**（此刻本轮已收尾、会话空闲，服务端收到就当场回收）。
     *
     * 这一帧是「一次性调用不往常驻服务端留垃圾」的全部保障。会话寿命只有一条规则：
     * **连接上有持有者 → 活着；持有者没了 → 宽限期后回收；`session.close` → 立刻回收。**
     * 不发这一帧的后果不是「差不多」：每跑一次 `ai "…"`，守护进程里就多一段活会话（连同
     * 它的 Agent、MCP 连接、全量消息）待到宽限期 —— 在 shell 里高频调用是**真泄漏**。
     *
     * 顺序必须是「先 close、后断连接」：反过来这一帧就发不出去了（连接已关，调用直接拒），
     * 只能退化成等宽限期 —— 而那正是这一帧要避开的。
     *
     * 失败不抛：进程马上就要退出，能说的事都已经说过 —— 写不进去就是没人要。会话要么刚
     * 落过盘（`--save`）、要么本来就 `persist:false`，所以发不出去只是推迟回收，不会丢东西。
     */
    await closeQuietly(session);
    session?.dispose();
    /**
     * 连接**一定要**断（本入口自己造的那条，没有别的使用方）。
     *
     * `RemoteChatSession.open()` 中途失败（配置有毛病时 `session.create` 会抛）那条路上根本
     * 没造出 `session`，于是没东西会关这条 socket —— 而一条活 socket 把进程钉在事件循环里：
     * 一次 `ai "…"` 永远退不出，在脚本里就是「命令卡死」（只能用 Ctrl+C）。
     *
     * 关之前 `closeQuietly` 已经 **await** 了 `session.close()`：顺序反过来这一帧就发不
     * 出去（连接已关，调用直接拒），只能退化成等宽限期 —— 而那正是那一帧要避开的。
     */
    connection.close();

    setLogger({
      info: originalLog,
      warn: console.warn,
      error: console.error,
    });
    console.log = originalLog;
  }
}
