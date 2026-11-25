/**
 * 会话层的对外契约 —— 「能读的一段会话、能发话、能作答、能撤回」。
 *
 * 屏幕（`tui/screens/chat.tsx`）与命令层（`commands/handlers.ts`）只认这一面：这是「换源不换屏」
 * 的落点。实现只有 `../session.ts` 一个（**纯客户端**：Agent 在宿主里跑，这里只持有一个会话 id
 * 与它的事实）。
 *
 * ## 形状从哪来（这一刀之后）
 *
 * 消息本体仍然是 core 的 `AgentNS.Message`；**会话行**是宿主 `session.open` 出参里的 `session`
 * （`MirrorSessionRow`：`modelId: string|null`、`thinkingLevel: string|null`，时间一律 epoch
 * 毫秒）。旧契约里那些「一份形状说五六件事」的块 —— `ModelState`（带名字与来源）、
 * `ThinkingState`（带档位表与参数）、`SessionState`（四件事 + 名册 + 交接态） —— 宿主这一版
 * 都不给了。
 *
 * 于是 CLI 自己拼两个**派生**的视图（不是第二份真相，每次读都是现算）：
 *
 *   · {@link ModelState}：`modelId` 来自会话行；`name` / `vision` 来自 `api.config.get()` 的
 *     模型表；`source` = 会话行上那个 id 与 AgentDefinition 绑的那个是否同一个；
 *   · {@link ThinkingState}：`levels` 是生效模型的 `reasoningPreset` 在 `presets` 里那张表的
 *     键，`selected` 是会话行上的 `thinkingLevel`。
 *
 * 两样都是「契约里没有、但界面要」的表现（`/model` 的提示、状态栏那一格），算法只有
 * `../session.ts` 一处。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type {
  HostClient,
  LegacyCall,
  MirrorSessionRow,
  Unsubscribe,
} from "../server-client/index.js";
import type { StatusBlock } from "../status-blocks.js";
import type { ClipboardImage } from "../clipboard.js";
import type { RateSample } from "../session-rate.js";

// ---------------------------------------------------------------------------
// 契约形状
// ---------------------------------------------------------------------------

/** 一个工作区（`workspace.list` 的一行 + 目录事实） */
export interface WorkspaceSnapshot {
  id: string;
  name: string;
  /**
   * 目录事实。`exists` 是 `null` = **宿主这一版不报这一格**（它只报 `cwd`）。
   *
   * 留着这一格是因为界面上那句「那个目录还在不在」还得有一处可读：`null` 时不说，只有真的
   * 知道 `false` 时才说「目录已不在」—— 拿 `null` 当 `true` 就是编一个没验过的好消息。
   */
  folder: { cwd: string; exists: boolean | null };
}

/** 一条会话行（宿主 `session.open` 的 `session`，字段一个不改） */
export type SessionSnapshot = MirrorSessionRow;
export type { MirrorSessionRow };

/** 这段会话现在用的模型（派生视图，见文件头） */
export interface ModelState {
  /** 会话行上的生效模型；`null` = 这一段现在指不到模型 */
  modelId: string | null;
  /** 模型表里的显示名（模型不在配置里时回落成 id） */
  name: string;
  /** 能不能看图（`ModelDefinition.vision`；缺省 false） */
  vision: boolean;
  /** `agent` = 会话行上那个就是 AgentDefinition 绑的那个；`session` = 这一段自己定的 */
  source: "agent" | "session";
}

/** 这段会话的 AgentDefinition（id 是身份，名字与可用性来自定义） */
export interface AgentState {
  agentId: string;
  name: string | null;
  /** `null` = 定义读不出来（问不到），`false` = 定义没了 */
  available: boolean | null;
}

/** 目录事实（这一段跑在哪个目录、那个目录还在不在） */
export interface FolderFact {
  cwd: string;
  /** `null` = 宿主这一版不报这一格（与 `WorkspaceSnapshot.folder.exists` 同一个口径） */
  exists: boolean | null;
}

/** 思考强度的派生视图（档位表 + 当前档 + 来源，见文件头） */
export interface ThinkingState {
  /** 生效模型引用的策略名（模型上没配就是 `null`） */
  preset: string | null;
  /** 可选档位名；空数组 = 这个模型没有档位 */
  levels: string[];
  /** 会话行上的 `thinkingLevel`；`null` = 跟随 AgentDefinition */
  selected: string | null;
  /** 这个值从哪来 */
  source: "following_default" | "manual" | "custom" | "not_adjustable";
  /** 档位展开后的请求参数（宿主这一版不报，恒为空对象） */
  params: Record<string, unknown>;
}

/** 忙闲那一格（`working` / `idle`） */
export type SessionActivity = "working" | "idle";

/** 一条还在队里的话（`session.open` 的 `inbox` 折成界面要的那一行） */
export interface InboxItem {
  messageId: string;
  source: AgentNS.MessageSource;
  createdAt: string;
  /**
   * 这一条进来的优先级（core 的 `InboxEntry.priority`，原样上屏）：`high` 在内循环的工具边界就会
   * 被取走，`low` 要等手上这一批跑完。界面上据此说清「为什么它还没被取走」—— 两个值都是协议用词，
   * 不进翻译表。
   */
  priority: AgentNS.InboxEntry["priority"];
  /** 一行摘要（客户端现拼，见 `server-client/mirror.ts`） */
  preview: string;
}

/** 名册上的一行（客户端现推，见 `server-client/mirror.ts` 的 `rosterOf`） */
export interface SubAgentFact {
  toolCallId: string;
  name: string;
  state: AgentNS.AgentState | "ended";
}

/** 附件上限：宿主这一版不报，恒 `null`（本地兜底常量在 `clipboard.ts`） */
export type AttachmentLimits = { maxAssetBytes: number; maxAssetsPerMessage: number } | null;

/**
 * 一条文件清单 InboxEntry（`@` 补全用）。
 *
 * 宿主 `workspace.files` 只给相对路径，所以 `kind` 现在恒 `"file"`（目录不进那份清单，见
 * `session.ts` 的 `toFileEntry`）；这一格留着是因为屏幕与 `mention.ts` 都按它决定要不要补尾斜杠。
 */
export interface FileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

/**
 * `@` 补全要的两样：清单 + 「它有定论了没有」。
 *
 * 宿主这一版是 `workspace.files` 一次列完（没有「第一次还在扫」那一段），所以实现只回 `ready` /
 * `unavailable`。`scanning` 这一档留在类型里、屏幕照旧按它分支：哪天宿主又改成先回「扫着」
 * 再回清单，屏幕这边不必再改一次。
 */
export interface WorkspaceFiles {
  state: "ready" | "scanning" | "unavailable";
  entries: FileEntry[];
}

/**
 * 一次用户输入：core 的内容形状 + 已上传的 Asset id。
 *
 * 它是 CLI 内部的**载体**（不是出网形状）：`session.send` 把 `assetIds` 折成带 `__asset_id` 的
 * 内容段（`user-content.ts` 的 `contentOfInput`）；`session.rewind`（撤回）回填的也是这一份 ——
 * 那条消息里带的图从段上的标记拆回 `assetIds`，于是「文字进草稿、Asset 挂回输入」是同一件事的
 * 两半。
 */
export interface MessageInput {
  content: AgentNS.MessageContent;
  /** 已上传、待折成内容段的 Asset id（顺序即用户的摆放顺序） */
  assetIds?: string[];
}

/** 通知语气（宿主 `Notice.level` 的四档） */
export type NoticeLevel = "info" | "success" | "warning" | "error";

/** 上屏用的三档语气：`info` / `warn` / `error` */
export type NoticeTone = "info" | "warn" | "error";

/**
 * 通知是谁让它出现的。
 *
 * 宿主这一版的通知行上**没有**这一格了（只剩 `level` / `code` / `message` / `sessionId`），
 * 所以 CLI 自己按「谁问来的」分：`log` 只有一个来源 —— 日志上浮那条路（`log-notices.ts`），
 * 其余一律 `app`。
 */
export type NoticeOrigin = "log" | "app";

/** 一条通知（宿主 `notice.list` 的一行，字段原样） */
export interface NoticeView {
  id: string;
  level: NoticeLevel;
  code: string;
  message: string;
  durationMs: number | null;
  sessionId: string | null;
  createdAt: number;
}

/** 交接执行者 / 交接之后做什么：宿主这一版只剩 `{ sessionId }`，两个选择器已退场（口径⑧） */
export type HandoffMode = "self" | "summary";
export type HandoffThen = "document_only" | "new_session";

/**
 * 这一趟交接是哪一档（宿主 `handoff.start` 的 `kind`）：
 *
 *   · `document`：只写交接文档 —— 记忆、存档会话、Agent 的身份都不动；
 *   · `swap`：写完文档就把记忆换成新的一份，旧记忆成为一段已存档会话。
 */
export type HandoffKind = "document" | "swap";

/**
 * `scope.reload` 的回执：宿主那一遍刷了几份 Scope、哪几份没刷成。
 *
 * 数字与失败项都是宿主给的，客户端一个都不自己算：「刷了几份」只有宿主知道（容器活在它那侧）。
 */
export interface ScopeReloadReport {
  /** 过这一遍时已经造好的容器有几份（没人用过的目录不在其中） */
  total: number;
  /** 按新配置重读成功的那几份 */
  refreshed: number;
  /** 没刷成的那几份：它们留在原地用旧配置 */
  failed: readonly { cwd: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// 与连接层之间的那条窄接缝
// ---------------------------------------------------------------------------

/**
 * 「一条到宿主的连接」在本层眼里的样子。
 *
 * 四样是连接层的（{@link HostClient} 原样），另外几格是 **CLI 自己的**：
 *
 *   · `language`：本地文案用哪种语言（连接层只说「宿主按哪种语言渲染」）；
 *   · `call`：**旧路**（未搬的域走它，一律抛 `unsupported`，见 `server-client/methods.ts`）；
 *   · `open` / `resync` / `closeMirror`：一段会话的镜像（由 CLI 自己维护：`session.open` 一次
 *     取全，之后按 `HostEvent` 增量）。
 *
 * 会话层不再有 `onClose` / `onSync` / `sendBinary` / `hello`：断线与补拉由 `subscribe` 那条
 * 流 + 调用方自己编排（`session.ts` 的 `reconnectUntilConnected` 与 `resync`）。
 */
export interface HostConnection {
  /** tRPC 客户端：`connection.api.session.open.query({ sessionId })` */
  readonly api: HostClient["api"];
  /** 订阅宿主那一条事件流；返回退订函数（幂等） */
  subscribe(onEvent: (event: HostEvent) => void, onError?: (error: unknown) => void): Unsubscribe;
  /** 等到一次调通（断线之后的「再敲一次门」） */
  reconnect(): Promise<void>;
  /** 关掉这条连接；幂等 */
  close(): Promise<void>;
  /** 这条连接声明的语言（本地文案用它） */
  readonly language: string | undefined;
  /** 旧路：只有 `session.create` / `session.send` 能真的转成 `api.*`，其余抛 `unsupported` */
  call: LegacyCall;
  /** 打开一段会话的镜像（`session.open` 一次取全） */
  open(sessionId: string): Promise<SessionMirrorLike>;
  /** 把镜像补回现在（再打一次 `session.open`，把四格整份换掉） */
  resync(sessionId: string): Promise<SessionMirrorLike>;
  /** 不再跟着这段会话 */
  closeMirror(sessionId: string): void;
}

/**
 * 镜像在本层眼里的样子。
 *
 * 结构上就是 `server-client/mirror.ts` 的 `SessionMirror`（生产实现只有它一个），写成接口是为了
 * 让用例能给一个替身而不必认识那个类。
 */
export interface SessionMirrorLike {
  readonly sessionId: string;
  readonly session: SessionSnapshot;
  readonly messages: readonly AgentNS.Message[];
  readonly roster: SubAgentFact[];
  readonly snapshot: () => MirrorSnapshotLike;
  subAgent(toolCallId: string): readonly AgentNS.Message[];
  apply(event: HostEvent): void;
}

/** 镜像快照（`session.ts` 每次读都现取一份） */
export interface MirrorSnapshotLike {
  sessionId: string;
  session: SessionSnapshot;
  messages: AgentNS.Message[];
  subAgents: { toolCallId: string; messages: AgentNS.Message[] }[];
  status: SessionActivity | null;
  inputPaused: boolean | null;
  outputPaused: boolean | null;
  alive: boolean | null;
  handingOff: boolean;
  inbox: InboxItem[];
}

/** 宿主那一条事件流的一片（形状只有宿主那一份，这里只取类型） */
export type HostEvent = import("../server-client/index.js").HostEvent;

// ---------------------------------------------------------------------------
// 会话契约
// ---------------------------------------------------------------------------

/**
 * 一段会话能做的事。
 *
 * 全部字段与方法都能在宿主的 procedure 面里找到对应（`session.*` / `agent.*`），客户端不在这里
 * 算规则；两处例外写在各自的注释里（阶段那句话、生成速率）—— 它们都是从契约事实**现推**的
 * 表现，不是存下来的第二份状态。
 */
export interface ChatSessionLike {
  /** 这段会话的 AgentDefinition（创建时定死，PRD L7） */
  readonly agentId: string;
  /** 这段会话的 id（`session.*` 与交接都按它说话） */
  readonly sessionId: string;
  /** 这段会话属于哪个项目 */
  readonly workspaceId: string;
  /** 当前选中的工作区（`/ws` 切过就是新那个，否则就是这一段会话的那个） */
  readonly currentWorkspaceId: string;
  /** 会话名（宿主给的；自动名与改过的名都在这一个字段上） */
  readonly name: string;
  /** 会话跑在哪个目录、那个目录还在不在（PRD D12） */
  readonly folder: FolderFact;
  /** 附件上限：宿主这一版不报，恒 `null`（本地兜底在 `clipboard.ts`） */
  readonly attachmentLimits: AttachmentLimits;
  /** 这段会话的消息（唯一数据源，顺序即宿主给的顺序） */
  readonly messages: AgentNS.Message[];
  /** 名册上那些 subagent（客户端现推，见 `server-client/mirror.ts`） */
  readonly subAgents: readonly SubAgentFact[];

  /** 四件事的各一格（PRD 4.4）：忙闲 / 输入开关 / 输出开关 / 死活 */
  readonly status: SessionActivity | null;
  readonly inputPaused: boolean | null;
  readonly outputPaused: boolean | null;
  readonly alive: boolean | null;
  /** 在交接态就是开始时刻；不在就是 `null` */
  readonly handoffSince: string | null;

  /** 状态栏的块（按建议的摆放顺序）。每次读都**现拼**（`status-blocks.ts`） */
  readonly blocks: readonly StatusBlock[];
  /** 这段会话现在用的模型（派生视图） */
  readonly model: ModelState;
  /** 当前生效的模型 id（= `model.modelId`） */
  readonly modelId: string | null;
  /** 思考强度的现状（派生视图） */
  readonly thinking: ThinkingState;
  /** 宿主给的那份会话行 */
  readonly view: SessionSnapshot;
  /** 队里还没被取走的 InboxEntry（顺序即取走顺序） */
  readonly inbox: readonly InboxItem[];
  /** 排队**条数** —— 派生自 {@link inbox}（= `inbox.length`），不是第二份真相 */
  readonly inboxPending: number;
  /** 挂在这段会话上的问题 */
  readonly questions: readonly QuestionView[];
  /** 生成速率快照（状态栏与 spinner 用；CLI 自己的估算口径） */
  readonly rateSample: RateSample;

  /**
   * 发一句（**只投递**，受理即返回，PRD 4.2 / PLAN §5.1）。
   *
   * `images` 是这一次**还没上传**的剪贴板图片（发送时先传再发）；`assetIds` 是**已经传上去
   * 过的**Asset（撤回回填的那几张，见 {@link revert}）—— 后者不再传一遍：同一张图全机只存一份，
   * 传第二遍既浪费也不是同一份（PRD 1.8）。
   */
  send(
    input: string,
    images?: readonly ClipboardImage[],
    assetIds?: readonly string[],
  ): Promise<void>;
  /** 复活：**确保这段会话有 agent**（`agent.wake`，PRD 1.2 / PLAN §5.1） */
  wake(): Promise<void>;
  /** 暂停：**只关输出开关**（`agent.pause`，PRD 4.4） */
  pauseOutput(): Promise<void>;
  /** 继续：**只开输出开关、不投任何东西**（`agent.resume`，PRD 4.4） */
  resumeOutput(): Promise<void>;
  /** 等**这一句**有了下文（界面用它包忙碌态，stdio 用它等答案） */
  waitForReply(): Promise<void>;
  /** 中止在途的请求与工具，并把输出开关关上（`agent.abort`，PRD 4.4） */
  abort(): void;
  /**
   * 换到另一个工作区（`/ws` 选中之后调）。**这一段会话不动**
   */
  selectWorkspace(workspaceId: string): void;
  /**
   * 让宿主重新发现能力（`scope.reload`），再把手里那几份事实重取一遍。
   *
   * 回来的那一份是宿主给的回执：刷了几份 Scope、有没有没刷成的 —— 调用方据此说一句人话。
   */
  reload(): Promise<ScopeReloadReport>;
  /** 换**这一段会话**的模型（`session.updateModel`） */
  updateModel(modelId: string | null): Promise<void>;
  /** 改这一段的**名字**（`session.rename`） */
  rename(name: string): Promise<void>;
  /** 改**这一段会话**的思考档位（`null` = 跟随 AgentDefinition，`session.updateThinkingLevel`） */
  updateThinkingLevel(level: string | null): Promise<void>;
  /** 置顶 / 取消置顶这一段（`session.pin`） */
  pin(pinned: boolean): Promise<void>;
  /**
   * 撤回到某条用户消息**之前**（`session.rewind`），返回回填给输入框的内容。
   *
   * 回来的 `assetIds` 是那条消息里挂着的 Asset（段上的本地标记拆出来的，按原顺序）——
   * 输入框把它们一起摆回去，用户提交前看得见自己撤回来了哪几张。
   */
  rewind(beforeMessageId: string): Promise<MessageInput>;
  /** 交接（`handoff.start`）：**只回「开始了」**；`mode` 给了才是调用方挑的执行者 */
  handoff(options?: HandoffOptions): Promise<void>;
  /** `@` 补全的文件清单（`workspace.files`；`query` 交给宿主先筛） */
  listWorkspaceFiles(query?: string): Promise<WorkspaceFiles>;
  /** 清空这段会话的 inbox（宿主这一版没有这条 procedure，恒回 0） */
  clearInbox(): Promise<number>;
  /** 某个 subagent 自己的消息（镜像那一栏；镜像里没有时回空数组） */
  listSubAgentMessages(toolCallId: string): Promise<AgentNS.Message[]>;
  /** 渲染期现取 subagent 的消息（**不发请求**） */
  subAgentMessages(toolCallId: string): AgentNS.Message[];
  /** 释放资源（卸订阅 / 不再往界面上推） */
  dispose(): void;
}

/**
 * 一段会话上挂着的一道题 = **一张表单**（宿主那侧的形状照抄 MCP elicitation 的 `requestedSchema`：
 * 扁平对象，属性只能是字符串/数字/布尔/单选枚举，数组只允许「多选枚举」）。
 *
 * 候选不再是宿主替我们挑好的 `choices`：面板读 `requestedSchema`，自己决定每一格怎么画。
 */
export interface QuestionView {
  id: string;
  sessionId: string;
  /** 题干（宿主已按当前语言渲染好的那句） */
  message: string;
  requestedSchema: FormSchemaView;
  blocking: boolean;
  createdAt: number;
}

/** 表单里一格（与 `@ai-zen/agents-host` 的 `FormField` 同形，这里只列面板用得到的那几格） */
export type FormFieldView =
  | {
      type: "string";
      title?: string;
      description?: string;
      default?: string;
      format?: "email" | "uri" | "date" | "date-time";
      minLength?: number;
      maxLength?: number;
      enum?: readonly string[];
      enumNames?: readonly string[];
    }
  | {
      type: "number" | "integer";
      title?: string;
      description?: string;
      default?: number;
      minimum?: number;
      maximum?: number;
    }
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | {
      type: "array";
      title?: string;
      description?: string;
      items: { type: "string"; enum: readonly string[]; enumNames?: readonly string[] };
      default?: readonly string[];
      minItems?: number;
      maxItems?: number;
    };

/** 一张表：扁平对象 + 哪几格必须填 */
export interface FormSchemaView {
  type: "object";
  properties: Readonly<Record<string, FormFieldView>>;
  required?: readonly string[];
}

/**
 * 一次作答的三态（与 MCP 的 `action` 一一对应）：`accept` 带数据、`decline` 是显式拒绝、
 * `cancel` 是关掉没作答（Esc / Ctrl+C）。
 */
export interface FormAnswerView {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** `handoff()` 的入参：`sessionId` 由会话层自己带，调用方只说「谁去写」 */
export interface HandoffOptions {
  /**
   * 执行者：`self` = 这段会话自己的 agent 接着写，`summary` = 另起一个一次性 Agent 去写。
   *
   * 不给时不发这一格，执行者由宿主的缺省定（`handoff.start` 收的是可选 `mode`）。
   */
  mode?: HandoffMode;
  /**
   * 这一档：`document` 只写文档，`swap` 写文档并立刻换手。
   *
   * 不给时不发这一格，那一侧缺省是 `swap`（与这一格加进来之前一致）。两条命令都显式给：
   * `/handoff` 要的是那一份文档，`/migrate` 要的是换手，各自说清，不靠对面的缺省。
   */
  kind?: HandoffKind;
  /** 已退场（口径⑧）：宿主不再收「交接之后做什么」 */
  then?: HandoffThen;
}

/**
 * 「按这些选项开一段会话」—— 注册表（`sessions-registry.ts`）唯一要的构造入口。
 *
 * 单独成为一个类型而不是让注册表直接 import `createRemoteChatSession`：用例要能塞一个假会话，
 * 而 `vi.mock` 在进程内共享模块（`isolate: false`）时是全局生效的，会波及别的测试文件。
 */
export type CreateChatSession = (
  options: ChatSessionOptions,
  notifier: ChatSessionNotifier,
) => Promise<ChatSessionLike>;

/**
 * 一段**已经被宿主删掉**的会话（`session.removed` 那一格的事实 + 找下一段要的那个项目）。
 *
 * 只有两格：那一段已经不存在了，再带一份整行就是发一份读不回来的东西。项目那一格是给
 * 「同项目里还有没有别的会话」用的（`session.list` 的入参要它）。
 */
export interface RemovedSession {
  sessionId: string;
  /** 这一段属于哪个项目（这一段没了，项目本身还在） */
  workspaceId: string;
}

/** 会话 → 界面的三路信号 */
export interface ChatSessionNotifier {
  /** 转录可能已变化（内容以 `session.messages` 为准）；`immediate=true` 表示应立即上屏 */
  onChange(immediate: boolean): void;
  /** 系统级提示，走独立栏位，绝不进 messages */
  onNotice(text: string, tone: NoticeTone, origin?: NoticeOrigin): void;
  /**
   * 这一段会话**已经被宿主删掉了**（`session.removed`，PRD 4.1 的死活：删掉是硬删）。
   *
   * 只有正看着这一段的那一屏会收到这一下：后台那几段没人看，注册表把它们从登记里摘掉就够了
   * （`sessions-registry.ts` 的 `drop`）。收到它的一屏不能再往这一段里发话 —— 换到哪一段去
   * 由屏幕自己收尾（`commands/handlers.ts` 的 `moveAfterGone` 与 `/delete` 共用一套）。
   *
   * 可省：不关心这一下的听众（用例里的替身）不必写它。
   */
  onRemoved?(removed: RemovedSession): void;
}

/** 开一段会话的入参 */
export interface ChatSessionOptions {
  /** 用哪个 AgentDefinition 开新会话（已有 `sessionId` 时以那段会话的为准，PRD L7） */
  agentId?: string;
  /** 按 id 打开一段已存在的会话（`/load` 选中的那段） */
  sessionId?: string;
  /** 已进入的工作区 id（会话层只认它） */
  workspaceId?: string;
  /** 接着上次聊（PRD F-A6）：这个项目上次打开的那段会话 */
  resume?: boolean;
  /** 要不要把这次打开的那段记成「上次打开的那段」（缺省 `true`） */
  remember?: boolean;
  /** 宿主问过来一个问题时，界面怎么作答（返回候选里的 `value`；`null` = 界面放弃作答） */
  onQuestion?: (question: QuestionView) => Promise<FormAnswerView | null>;
  /** 进程级的那一条连接：会话**不建连接**，只借它说话 */
  connection: HostConnection;
}
