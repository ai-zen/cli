/**
 * 对话会话的对外契约 —— 「能渲染、能发话、能存档的一段会话」。
 *
 * 屏幕（`tui/screens/chat.tsx`）与命令层（`commands/handlers.ts`）只认这一面，不认实现：
 * 这是「传输自由」在界面层的落点 —— 换源时屏幕上的东西一行不动，屏幕不知道 Agent 跑在哪。
 *
 * ## 为什么它在 `session/types.ts` 而不在 `session.ts`
 *
 * 契约与实现迟早要分开走：屏幕只要「能读的消息 / 能下的命令」，而实现（连接、重连、
 * 流式拼接、子 Agent 栏目）都只属于它自己。分开之后，「谁在 import 实现」是一眼可数的：
 * 今天只有 `stdio.ts` 与屏幕。
 *
 * ## 这里为什么只剩契约
 *
 * 契约是活的，实现是死的：每改一次契约，本进程内的实现就要跟着交一份实现，而它并没有
 * 调用方（存档在服务端、插件装配在装配层、`send()` 的语义由协议定）。所以本文件只留
 * 形状，实现只有 `../session.ts` 一个（纯客户端，Agent 在服务端跑）。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { AutoMigrateTriggerInfo, HandoffMode } from "@ai-zen/agents-sdk";
// 协议形状从 `@ai-zen/agents-protocol` 取，门面形状从 `@ai-zen/agents-client` 取
//
// 两者不是两条依赖路线（client 把 protocol 原样转出，选哪个都能编译）：分开写是为了让
// 「这个类型属于**线上契约**」在 import 那一行就看得见 —— `PhaseInfo` / `ModelLevel` /
// `ModelParams` / `WorkspaceFileEntry` 都是两端约定的数据，不是某个实现的内部类型；
// 而 `ServerConnection` 是门面（客户端怎么连服务端），它只属于 `agents-client`。
import type {
  ModelLevel,
  ModelParams,
  PhaseInfo,
  WorkspaceFileEntry,
} from "@ai-zen/agents-server/protocol";
import type { ServerConnection } from "@ai-zen/agents-client";
import type { ClipboardImage } from "../clipboard.js";
import type { ConfigPort } from "../server-client/index.js";
import type { RateSample } from "../session-rate.js";

export interface ChatSessionLike {
  /** 用哪个 Agent（会话的父级是工作区，Agent 决定能力与模型） */
  readonly agentId: string;
  /**
   * 当前模型 id —— **三级解析之后**的那个值（`会话级覆盖 > Agent 定义 > 全局兜底`）。
   *
   * 解析发生在服务端（唯一实现：SDK 的 `resolveModel`），这里只是快照的一手透传：客户端
   * 自己再推一遍 `??` 链就会出现「状态栏写着 A、请求实际发给 B」。空串 = 服务端没给
   * （正常不会发生：三级都拿不到模型时那段会话根本装不起来）。
   */
  readonly modelId: string;
  /**
   * 上面那个 `modelId` 来自哪一级。
   *
   * `/model` 的选择器靠它标「当前生效的是哪一档」—— 档位只能在解析发生的地方算出来，
   * 客户端不去猜。
   */
  readonly modelLevel: ModelLevel;
  /** 当前会话 id（`/save`、状态栏与「上一轮会话」指针用；会话只有 id，没有第二个名字） */
  readonly currentId: string;
  /** 对话消息（屏幕的唯一数据源） */
  readonly messages: AgentNS.Message[];
  /** 本轮内出现过的子 Agent（只活当前一轮） */
  readonly subAgents: readonly SubAgentView[];
  /** 最近一轮用量；未知时 `undefined`（客户端别自己编一个） */
  readonly lastUsage?: AgentNS.Usage;
  /** 本次会话累计用量 */
  readonly totalUsage: AgentNS.Usage;
  /** 生成阶段；空闲 `null` */
  readonly phase: PhaseInfo | null;
  /** 生成速率快照（状态栏与 spinner 用） */
  readonly rateSample: RateSample;

  /**
   * 发一轮（**受理即返回**：拿到 `turnId` 就回来，过程走事件）。
   *
   * 与 {@link waitForTurn} 分两半是协议的形状，不是风格：`session-turn-end` 可能**先于**这条调用的
   * 回执落地（事件是推的），合成一个 promise 就得在实现里再记一份「已收尾的轮次」才能不挂死。
   *
   * 同步拒绝（服务端忙 / 连接已断）不进事件通道：那是「这轮没发出去」，实现自己报给通知栏，
   * promise 照常 resolve（让调用方以为「本轮失败」更糟）。
   */
  send(input: string, images?: readonly ClipboardImage[]): Promise<void>;
  /**
   * 等**最近发出去的那一轮**结束（界面用它包 `busy` 与输入禁用）。
   *
   * 为什么它是会话契约的一部分而不是让界面自己等：`session-turn-end` 的到达时机与「重连后发现服务端
   * 已经空闲」是同一个判据的两条路（后者意味着那一轮在断线期间跑完了），而“哪一轮在飞”只有
   * 会话层知道。界面自己等就只能等一个它编出来的条件。
   *
   * 连不回来时实现会把错误报进通知栏（与 `send` 的同步拒绝同一个出口），**不**向调用方抛：
   * 宿主那些 `await` 周围都没有 try/catch，未处理的 rejection 会直接终止进程。
   */
  waitForTurn(): Promise<void>;
  /** 中止本轮（Ctrl+C）：只取消这一轮，不退出 */
  abort(): void;
  /** `/new`：先归档当前对话（有内容才存），再开一段新的；返回被归档的 id */
  reset(): Promise<string | null>;
  /** 按磁盘上的新配置重建（保留消息） */
  reload(): Promise<void>;
  /**
   * 换 Agent：同一段对话换个 Agent 继续（**保留消息**）。
   *
   * 为什么不走「重挂载对话屏」：会话与 Agent 身份都在服务端手里，客户端只持有一个 id。
   * 重挂载只能换个 `agentId` 参数，而服务端对活着的会话是无视这个参数的（`attach` 只接上）
   * —— 于是界面说「已切换」，实际跑的仍是旧 Agent。
   */
  setAgent(agentId: string): Promise<void>;
  /**
   * 换**这一段会话**的模型（`session.model.set`）：只改本段的覆盖，**不动 Agent 定义**。
   *
   * 为什么它在会话契约里而不是配置面：这三档（会话 / 定义 / 全局兜底）的写路径一直都有，
   * 但「会话级」那一条的**作用对象是一段会话**。挂在 `ConfigPort` 上读起来像配置，代价是
   * 同一个动作在门面（`RemoteSessions.modelSet`）与端口里各有一份拼参的地方。判据只有一条：
   * 作用对象是不是某一段会话。
   */
  setModel(modelId: string): Promise<void>;
  /**
   * 改**这一段会话**的模型参数（`session.modelParams.set`）；`null` = 清掉这一层的覆盖。
   *
   * 与 {@link setModel} 分开：两者是同一级的两份事实，但「换模型」会连带清掉参数
   * （新模型不一定接受旧参数），而改参数不该动模型。
   */
  setModelParams(params: ModelParams | null): Promise<void>;
  /** `/migrate`：交接 + 开新会话；返回交接文档路径 */
  migrate(mode?: HandoffMode): Promise<string>;
  /** `/handoff`：只产出交接文档，不动会话；返回文档路径 */
  handoff(mode?: HandoffMode): Promise<string>;
  /** `/back`：从 index 起删掉，返回被删首条用户消息的原文（预填输入框） */
  rollbackTo(index: number): Promise<string>;
  /** 落盘当前会话（并更新「上一轮会话」指针） */
  save(): Promise<string>;
  /** 另存为指定 id；返回实际生效的 id */
  saveAs(id: string): Promise<string>;
  /** 本工作区已存档的会话（`/load` 的列表；不解析内容） */
  listSaved(): Promise<Array<{ id: string }>>;
  /** 某个 id 是否已有存档（`/save <名字>` 的重名判断） */
  exists(id: string): Promise<boolean>;
  /**
   * 本工作区的文件清单（`@` 补全用）。
   *
   * 为什么它在会话契约里：清单必须来自**会话真正跑在哪个目录**——那目录属于服务端，
   * `workspace.files` 扫的就是那边的磁盘。屏幕只负责过滤与插入。
   */
  listWorkspaceFiles(): Promise<WorkspaceFileEntry[]>;
  /** 释放资源（卸监听 / 断连接） */
  dispose(): void;
}

/** 会话 → UI 的对外信号 */
export interface ChatSessionNotifier {
  /** 转录可能已变化（内容以 `agent.messages` 为准）；`immediate=true` 表示应立即上屏 */
  onChange(immediate: boolean): void;
  /** 系统级提示（notice / error），走独立栏位，绝不进 messages */
  onNotice(text: string, tone: "info" | "error"): void;
}

/**
 * 子 Agent 的执行状态。
 *
 * 内联在 Agent 栏目的标签上（`●` / `✓` / `✖`），**不往通知栏推**：通知栏为进度多出
 * 一行，整帧高度就会跟着跳（多行通知踩过同一坑）。
 */
export type SubAgentStatus = "running" | "done" | "failed";

/**
 * 子 Agent 视图：委派期间收集，供对话屏的 Agent 栏目切换查看。
 *
 * 为何能一直可读：core 的 `AgentTool` / `AgentToolLazy` 在 `exec()` 里 `new Agent(...)` /
 * `buildAgent()` 出子 Agent，委派结束后**实例不销毁**（`onSubAgentEnd` 只是钩子），
 * 所以 `agent.messages` 始终是本子 Agent 的完整对话。这里只要持有引用，栏目就能回看。
 *
 * 生命周期：**只活在当前这一轮的内循环里**。栏目能做的事只有「切换看」，而子 Agent
 * 是内循环中工具调用的产物；一旦本轮内循环全部结束（`send()` 即将返回），主 Agent 已经
 * 给出最终答案，子 Agent 只剩历史价值，留着只会白占一行。
 * 因此清空发生在 `send()` 的 `finally`（异常 / 中止同样清）；`reset()` / `reload()` /
 * `migrate()` 换了 Agent 或会话也一并清空一一它们只换 `agent`，不重建本类实例。
 */
export interface SubAgentView {
  /** 稳定 id（React key / 选中态标识） */
  id: string;
  /** 出现序号（从 1 起）：栏目标签直接叫「子AGENT1」，序号就是展示的一部分 */
  index: number;
  /**
   * 这个子 Agent 到目前为止的完整对话。
   *
   * 这里**刻意不是子 Agent 实例**：实例只存在于「Agent 跑在这个进程里」那种形态
   * （core 的 `Agent.messages`），而现在 Agent 跑在服务端，客户端能拿到的是数据而不是对象。
   * 契约写成数据，屏幕也只需要「读消息」。
   */
  messages: AgentNS.Message[];
  /** 执行状态（渲染期读，故设为可变字段） */
  status: SubAgentStatus;
}

export interface ChatSessionOptions {
  agentId?: string;
  sessionId?: string;
  /**
   * 进程级的那一条连接：会话**不建连接**，只借它说话。
   *
   * 它必须由组装根给（TUI 是 `tui/index.tsx` 那个模块级实例，stdio 是这个入口自己造的
   * 那一个）。会话层自己建一条的后果不是报错，而是「启动预检一条、对话一条」—— 两条
   * driver、两套事件订阅，而且断线时两次重连各接一次。
   */
  connection: ServerConnection;
  /**
   * 配置面：拼图片内容块要按**服务端**的端点 / 视觉能力判断。
   *
   * 屏幕层已经持有一个（懒连接的远程端口，与 `connection` 是同一条连接），递下来省一次
   * 派生；不给则实现自己由 `connection` 派生一个（`createConfigPort(connection)`）。
   */
  config?: ConfigPort;
  /**
   * 续接该工作区的「上一轮会话」（有就接着，没有就开新的）。
   *
   * 为什么是**意图**而不是数据：这件事的答案（哪一段是上一轮）只在服务端（指针 + 存档），
   * 客户端自己去读就是又一份会漂的真相。屏幕层只说「我要接着上次」，不说接哪一段。
   *
   * 给了明确的 `sessionId` 时以它为准（`/load` 选中的那段）。
   */
  resume?: boolean;
  /**
   * 明确指定工作目录。**一般不要给**：本地由服务端的「是不是 loopback」判据决定（是就递客户端
   * cwd，不是就不说），给了也只是「我希望是这里」，最终仍由服务端规范化。
   */
  path?: string;
  /**
   * 这段要不要进工作区存档（缺省 `true`）。
   *
   * 只有 stdio 的一次性调用传 `false`：`ai "…"` 那一轮不属于工作区的历史，不该在
   * `sessions/` 里留痕，也不该把「上一轮会话」指针挪过去。
   */
  persist?: boolean;
  /**
   * 自动迁移时的执行者选择（由 Ink 层弹出选择器实现）。
   * 返回 `null` 表示跳过本次迁移；未提供时按默认执行者（原 agent 自交接）直接迁移。
   */
  requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
}
