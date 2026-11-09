/**
 * 对话会话的对外契约 —— 「能渲染、能发话、能存档的一段会话」。
 *
 * 屏幕（`screens/chat.tsx`）与命令层（`screens/chat-commands.ts`）只认这一面，不认实现：
 * 这是「传输自由」在界面层的落点 —— 换源时屏幕上的东西一行不动，屏幕不知道 Agent 跑在哪。
 *
 * ## 这里为什么只剩契约
 *
 * 曾经这里还有一个 `ChatSession`：在本进程里直接跑 Agent 的实现。会话执行搬到服务端之后
 * 它就**没有调用方**了（存档在服务端、插件装配在装配层、`send()` 的语义由协议定），
 * 但它仍然要向每一次契约改动「交一份实现」—— 本仓改造期间就为它白写过两次
 * （`listWorkspaceFiles`、`resume`）。契约是活的、实现是死的，于是把死的那份删掉，连同它
 * 拖着、只有它在用的三个模块（`session-persist-plugin` / `auto-migrate-confirm` /
 * `handoff-service`）。要找那份实现，看 git 历史（删除前它在 2026-11 的提交里）。
 *
 * 现在唯一的实现是 `remote-chat-session.ts`（纯客户端，Agent 在服务端跑）。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { AutoMigrateTriggerInfo, HandoffMode } from "@ai-zen/agents-sdk";
import type { PhaseInfo } from "@ai-zen/agents-server";
import type { ClipboardImage } from "../clipboard.js";
import type { PathEntry } from "./mention.js";
import type { RateSample } from "./token-rate.js";
import { stripCwdNote } from "./text.js";

export interface ChatSessionLike {
  /** 用哪个 Agent（会话的父级是工作区，Agent 决定能力与模型） */
  readonly agentId: string;
  /** 当前模型 id（真相源是 `AgentDefinition.modelId`；空串 = 定义里没绑模型） */
  readonly modelId: string;
  /** 当前会话 id / 名称（`/save`、状态栏与「上一轮会话」指针用） */
  readonly currentId: string;
  readonly currentName: string;
  /** 对话消息（屏幕的唯一数据源） */
  readonly messages: AgentNS.Message[];
  /** 本轮内出现过的子 Agent（只活当前一轮；两个实现都给） */
  readonly subAgents: readonly SubAgentView[];
  /** 最近一轮用量；未知时 `undefined`（客户端别自己编一个） */
  readonly lastUsage?: AgentNS.Usage;
  /** 本次会话累计用量 */
  readonly totalUsage: AgentNS.Usage;
  /** 生成阶段；空闲 `null` */
  readonly phase: PhaseInfo | null;
  /** 生成速率快照（状态栏与 spinner 用） */
  readonly rateSample: RateSample;

  send(input: string, images?: readonly ClipboardImage[]): Promise<void>;
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
   * 为什么它在会话契约里：清单必须来自**会话真正跑在哪个目录**——那目录属于服务端。
   * 远程实现问服务端（`workspace.files`），进程内实现扫本机；屏幕只负责过滤与插入。
   */
  listWorkspaceFiles(): Promise<PathEntry[]>;
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
   * （`CoreAgent.messages`）。远程时对话在服务端，客户端能拿到的是数据而不是对象。
   * 契约写成数据，进程内 / 远程两个实现才共用同一份接口，屏幕也只需要「读消息」。
   */
  messages: AgentNS.Message[];
  /** 执行状态（渲染期读，故设为可变字段） */
  status: SubAgentStatus;
}

export interface ChatSessionOptions {
  agentId?: string;
  messages?: AgentNS.Message[];
  sessionId?: string;
  sessionName?: string;
  /**
   * 续接该工作区的「上一轮会话」（有就接着，没有就开新的）。
   *
   * 为什么是**意图**而不是数据：这件事的答案（哪一段是上一轮）原本只存在于本地存档里，
   * 客户端自己去读就是又一份会漂的真相。远程实现问服务端（`session.last`），进程内实现
   * 读本地指针；屏幕层只说「我要接着上次」，不说接哪一段。
   *
   * 给了明确的 `sessionId` 时以它为准（`/load` 选中的那段）。
   */
  resume?: boolean;
  /**
   * 自动迁移时的执行者选择（由 Ink 层弹出选择器实现）。
   * 返回 `null` 表示跳过本次迁移；未提供时按默认执行者（原 agent 自交接）直接迁移。
   */
  requestMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
}

/** 去掉 CwdTrackerPlugin 追加在用户消息末尾的工作目录提示（转发自 ./text.js） */
export { stripCwdNote };
