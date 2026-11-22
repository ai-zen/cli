/**
 * 旧 wire 形状的**存档** —— 只为让还没搬的域继续编译，每搬一个域删掉它那一组。
 *
 * ## 这一包是什么、从哪来的
 *
 * 宿主在隔壁仓的 `8e94b03`（「旧 `src` 整包退成 `src-bad`，新 `src` 从空出口开始」）里把
 * 整个 `packages/host/src/wire/` 一次性退场了：`methods.ts`（方法表）、`states.ts`（行的形状）、
 * `schema/*.ts`（入参形状）都不再存在，换成了 tRPC 的 procedure 面。
 *
 * 下面这些类型是**当时那份 wire 的形状**，逐组照抄过来。抄而不是改，是因为它们现在还有消费者：
 * 会话 / 工作区 / 问题 / 通知 / 附件 / 交接 / 搜索这几域还没搬，而它们的代码仍按旧形状说话。
 * 于是这一份东西的寿命是**确定的**：哪个域搬完，就删掉它那一组（口径⑤：这一刀不主动删组）。
 *
 * ## 三条不许破的规矩
 *
 * 1. **不许拿 `any` 糊**：每个字段都是照抄回来的具体形状。用 `any` 的话，「宿主把这一格改了」
 *    在客户端就变成了静默的 `undefined`，而这正是留这一份要防的那件事。
 * 2. **只有形状，没有实现**：这里不导出任何取值函数、不发请求、不认识连接。要调今天的宿主，
 *    走 `server-client/methods.ts` 的 `call`（旧路）或 `api.*`（直连）。
 * 3. **名字与旧 wire 逐字一致**（`MethodMap` / `MethodName` / `MethodParams` / `MethodResult` /
 *    `METHOD_NAMES` / 各视图名）：消费者是按那些名字写的，改名等于把「抄回来」变成「重写一遍」。
 *
 * ## 分组 = 旧 `schema/` 的文件
 *
 * 每组前面一句话说它服务哪个**还没搬**的域（口径⑤）。会话域这一刀已经搬完，所以 `session` /
 * `message` / `question` / `notice` / `workspace` / `host` 这几组留下来只为一件事：旧方法表
 * （`MethodMap`）得是完整的一张，否则 `MethodName` 会缺项、`call` 的分支也就不再是穷举的。
 *
 * `completion` 那一组是**第一个整组走完的**：`@` 补全改走 `api.workspace.files`，形状删掉之后
 * `MethodName` 也不再认 `completion.files` —— 那个名字只剩在 `LEGACY_METHODS` 的注记里
 * （`server-client/methods.ts` 的 `RetiredMethodName`）。这一组是「搬一条就删一条」的样板。
 *
 * ## 今天还剩谁（配置域搬完之后）
 *
 * 表里只剩 **43 条**（原 68 条 − `config.*` 8 − `agent.*` 8 − `model.*` 8 − `host.reload` 1）。
 * 它们服务的是**还没搬**的那几域：宿主的版本 / 升级 / 收摊 / 换语言（`host.*`）、工作区的
 * 列 / 建 / 改 / 删（`/ws` 与连接屏）、会话与消息的旧路（会话层已直连 `api.session.*`，
 * 这几组留着只为 `MethodMap` 完整与 `call` 的穷举分支）、问题 / 通知、附件三段式（`asset.*`）、
 * 交接（`handoff.*`）、搜索（`search.*`，搜索屏还没搬）。
 */

import type { AgentNS } from "@ai-zen/agents-core";

// ---------------------------------------------------------------------------
// 通用（旧 `wire/methods.ts` 的公共段）
// ---------------------------------------------------------------------------

/** 无入参的方法用这个类型；调用时 `params` 可以省 */
export type NoParams = Record<string, never>;

/** 客户端自报的身份（旧 `hello` 的 `client` 字段） */
export interface ClientInfo {
  name: string;
  version: string;
  platform?: string;
}

/** 一次删除的代价（PRD D11「删前明说代价」） */
export interface RemovalConsequences {
  sessions: number;
  messages: number;
  assets: number;
}

/** 与传输有关的固定上限（旧 `hello` 回执里的 `limits`） */
export interface TransferLimits {
  maxAssetBytes: number;
  maxAssetsPerMessage: number;
}

/** 一种语言（`config.get` 的 `defaults.language` 用） */
export type Language = "en" | "zh";

/** 宿主存「码 + 参数」、读出时按连接语言渲染的那一层 */
export interface LocalizedText {
  code: string;
  messageKey: string;
  params: Record<string, unknown>;
  message: string;
}

/** 失败 / 降级这类「有事发生了」的事实 */
export interface ProblemFact extends LocalizedText {
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// 行的形状（旧 `wire/states.ts`）—— 服务配置 / 助手 / 模型 / MCP 几域
// ---------------------------------------------------------------------------

/** 忙闲（只读的观测值） */
export type SessionActivity = "working" | "idle";

/** 一段会话此刻的四件事，各占一格（PRD 4.4） */
export interface SessionPresence {
  status: SessionActivity;
  inputPaused: boolean;
  outputPaused: boolean;
  alive: boolean;
}

/** 一条还没落成消息的排队条目 */
export interface InboxItem {
  messageId: string;
  source: AgentNS.MessageSource;
  createdAt: string;
  preview: string;
}

/** subagent 名册的一行 */
export interface SubAgentFact {
  toolCallId: string;
  name: string;
  state: AgentNS.AgentState | "ended";
}

/** 一段会话此刻的读数（四件事 + 队里压着什么 + 名册 + 交接态） */
export interface SessionState extends SessionPresence {
  sessionId: string;
  inbox: InboxItem[];
  subAgents: SubAgentFact[];
  handoff: { since: string } | null;
  at: string;
}

/** 思考强度的取值来源 */
export type ThinkingSource = "following_default" | "manual" | "custom" | "not_adjustable";

/** 思考强度的状态（档位表 + 当前档 + 来源 + 展开后的参数） */
export interface ThinkingState {
  preset: string | null;
  levels: string[];
  selected: string | null;
  source: ThinkingSource;
  params: Record<string, unknown>;
}

/** 一段会话现在用的模型来自哪里 */
export type ModelSource = "agent" | "session";

/** 模型块的事实（状态栏那一格） */
export interface ModelState {
  modelId: string;
  name: string;
  vision: boolean;
  source: ModelSource;
}

/** 通知的四档语气 */
export type NoticeLevel = "info" | "success" | "warning" | "error";

/** 通知的来源：`app` 是应用自己要说的，`log` 是日志记录上浮来的 */
export type NoticeOrigin = "log" | "app";

/** 一条通知（旧 `notice.*` 的形状：`duration` + `text` + `origin`） */
export interface NoticeView {
  id: string;
  level: NoticeLevel;
  duration: number | null;
  text: LocalizedText;
  sessionId: string | null;
  createdAt: string;
  origin: NoticeOrigin;
}

/** 「不能立刻交接」的拒因（四个词，全仓唯一一套） */
export type HandoffRefusalReason = "no_agent" | "working" | "output_paused" | "handoff_in_progress";

/** 问题的种类 */
export type QuestionKind = "handoff" | "confirmation";

/** 问题的生命周期状态 */
export type QuestionState = "pending" | "answered";

/** 一个候选答案 */
export interface QuestionOption {
  value: string;
  label: LocalizedText;
  detail: LocalizedText | null;
}

/** 已有的回答 */
export interface QuestionAnswer {
  value: string;
  answeredAt: string;
  answeredBy: string | null;
}

/** 问题对象（旧 `question.*` 的形状） */
export interface QuestionView {
  id: string;
  sessionId: string;
  kind: QuestionKind;
  state: QuestionState;
  prompt: LocalizedText;
  options: QuestionOption[];
  answer: QuestionAnswer | null;
  blocking: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 目录的事实：路径 + 还在不在 */
export interface FolderFact {
  cwd: string;
  exists: boolean;
}

/** 一次用户输入（core 的内容形状 + 已上传的素材 id） */
export interface MessageInput {
  content: AgentNS.MessageContent;
  assetIds?: string[];
}

/** 附件真正发出去时用的路径 */
export type AttachmentDelivery = "file_reference" | "inline" | "text_fallback" | "dropped";

/** 一个附件的结局 */
export interface AttachmentOutcome {
  assetId: string;
  deliveredAs: AttachmentDelivery;
  section: AgentNS.MessageContentSection | null;
  problem: ProblemFact | null;
}

/** 一次压缩是谁促成的（会话行上的一格） */
export type CompactionMode = "auto" | "manual";

// ---------------------------------------------------------------------------
// 旧 `schema/host.ts` —— 服务「重载 / 换语言 / 退出」三条还没搬的宿主动作
// ---------------------------------------------------------------------------

/** `host.hello` 入参（旧握手帧） */
export interface HostHelloParams {
  token: string;
  language?: string;
  clientInfo: ClientInfo;
}

/** `host.hello` 出参 */
export interface HostHelloResult {
  language: Language;
  hostVersion: string;
  protocolVersion: string;
  startedAt: string;
  limits: TransferLimits;
}

/** `host.version` 入参 */
export type HostVersionParams = NoParams;

/** `host.version` 出参 */
export interface HostVersionResult {
  version: string;
  protocolVersion: string;
  startedAt: string;
  pid: number;
}

/** `host.upgrade` 入参 */
export interface HostUpgradeParams {
  targetVersion?: string;
}

/** `host.upgrade` 的三种结论 */
export type HostUpgradeState = "already_latest" | "restart_scheduled" | "not_available";

/** `host.upgrade` 出参 */
export interface HostUpgradeResult {
  state: HostUpgradeState;
  currentVersion: string;
  diskVersion: string | null;
  targetVersion: string | null;
}

/** `host.shutdown` 入参 */
export interface HostShutdownParams {
  reason?: string;
}

/** `host.shutdown` 出参 */
export interface HostShutdownResult {
  accepted: boolean;
}

/** `host.setLanguage` 入参 */
export interface HostSetLanguageParams {
  language: string;
}

/** `host.setLanguage` 出参 */
export interface HostSetLanguageResult {
  language: Language;
}

// ---------------------------------------------------------------------------
// 旧 `schema/workspace.ts` —— 服务 `/ws` 与连接屏（会话层已改用 `api.workspace.*`）
// ---------------------------------------------------------------------------

/** 一个 Workspace（PRD D9 / D12） */
export interface WorkspaceView {
  id: string;
  name: string;
  folder: FolderFact;
  createdAt: string;
  sessionCount: number;
}

/** `workspace.list` 入参 */
export interface WorkspaceListParams {
  includeMissingFolders?: boolean;
}

/** `workspace.list` 出参 */
export interface WorkspaceListResult {
  workspaces: WorkspaceView[];
}

/** `workspace.create` 入参 */
export interface WorkspaceCreateParams {
  cwd: string;
  name?: string;
}

/** `workspace.create` 出参 */
export interface WorkspaceCreateResult {
  workspace: WorkspaceView;
}

/** `workspace.get` 入参 */
export interface WorkspaceGetParams {
  workspaceId: string;
}

/** `workspace.get` 出参 */
export interface WorkspaceGetResult {
  workspace: WorkspaceView;
}

/** `workspace.rename` 入参 */
export interface WorkspaceRenameParams {
  workspaceId: string;
  name: string;
}

/** `workspace.rename` 出参 */
export interface WorkspaceRenameResult {
  workspace: WorkspaceView;
}

/** `workspace.remove` 入参 */
export interface WorkspaceRemoveParams {
  workspaceId: string;
  dryRun?: boolean;
}

/** `workspace.remove` 出参 */
export interface WorkspaceRemoveResult {
  removed: boolean;
  consequences: RemovalConsequences;
}

// ---------------------------------------------------------------------------
// 旧 `schema/session.ts` —— 留在表里只为 `MethodMap` 完整（会话层已直连 `api.session.*`）
// ---------------------------------------------------------------------------

/** 会话在列表里的样子（PRD F-C5 / D13） */
export interface SessionSummary extends SessionPresence {
  id: string;
  workspaceId: string;
  name: string;
  nameIsAuto: boolean;
  pinned: boolean;
  agentId: string;
  modelId: string;
  handoffThreshold: number | null;
  guardThreshold: number | null;
  autoHandoff: boolean;
  lineage: string | null;
  createdBy: "user" | "agent";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  inboxPending: number;
  hasPendingQuestion: boolean;
  compactedAt?: string;
  compactionMode?: CompactionMode;
}

/** 这段会话的助手事实（PRD F-I6） */
export interface SessionAgentState {
  agentId: string;
  name: string | null;
  available: boolean | null;
}

/** 一段会话的完整样子 */
export interface SessionView extends SessionSummary {
  agent: SessionAgentState;
  model: ModelState;
  thinking: ThinkingState;
  folder: FolderFact;
}

/** `session.list` 入参 */
export interface SessionListParams {
  workspaceId?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

/** `session.list` 出参 */
export interface SessionListResult {
  sessions: SessionSummary[];
  total: number;
}

/** `session.create` 入参 */
export interface SessionCreateParams {
  workspaceId: string;
  agentId: string;
  modelId?: string;
}

/** `session.create` 出参 */
export interface SessionCreateResult {
  session: SessionView;
}

/** `session.get` 入参 */
export interface SessionGetParams {
  sessionId: string;
}

/** `session.get` 出参 */
export interface SessionGetResult {
  session: SessionView;
}

/** `session.state` 入参 */
export interface SessionStateParams {
  sessionId: string;
}

/** `session.state` 出参 */
export interface SessionStateResult {
  state: SessionState;
}

/** `session.rename` 入参 */
export interface SessionRenameParams {
  sessionId: string;
  name: string;
}

/** `session.rename` 出参 */
export interface SessionRenameResult {
  session: SessionView;
}

/** `session.pin` 入参 */
export interface SessionPinParams {
  sessionId: string;
  pinned: boolean;
}

/** `session.pin` 出参 */
export interface SessionPinResult {
  session: SessionView;
}

/** `session.delete` 入参 */
export interface SessionDeleteParams {
  sessionId: string;
  dryRun?: boolean;
}

/** `session.delete` 出参 */
export interface SessionDeleteResult {
  removed: boolean;
  consequences: RemovalConsequences;
}

/** `session.send` 入参 */
export interface SessionSendParams {
  sessionId: string;
  input: MessageInput;
}

/** `session.send` 出参 */
export interface SessionSendResult {
  userMessageId: string;
  attachments: AttachmentOutcome[];
}

/** `session.start` 入参 */
export interface SessionStartParams {
  sessionId: string;
}

/** `session.start` 出参 */
export interface SessionStartResult {
  started: boolean;
}

/** `session.abort` 入参 */
export interface SessionAbortParams {
  sessionId: string;
  reason?: string;
}

/** `session.abort` 出参 */
export interface SessionAbortResult {
  signalled: boolean;
}

/** `session.pause` 入参 */
export interface SessionPauseParams {
  sessionId: string;
}

/** `session.pause` 出参 */
export interface SessionPauseResult {
  paused: boolean;
}

/** `session.resume` 入参 */
export interface SessionResumeParams {
  sessionId: string;
}

/** `session.resume` 出参 */
export interface SessionResumeResult {
  paused: boolean;
}

/** `session.kill` 入参 */
export interface SessionKillParams {
  sessionId: string;
}

/** `session.kill` 出参 */
export interface SessionKillResult {
  killed: boolean;
}

/** `session.clearInbox` 入参 */
export interface SessionClearInboxParams {
  sessionId: string;
}

/** `session.clearInbox` 出参 */
export interface SessionClearInboxResult {
  cleared: number;
}

/** `session.revert` 入参 */
export interface SessionRevertParams {
  sessionId: string;
  beforeMessageId: string;
}

/** `session.revert` 出参 */
export interface SessionRevertResult {
  removedMessageIds: string[];
  restoredInput: MessageInput;
}

/** `session.setModel` 入参 */
export interface SessionSetModelParams {
  sessionId: string;
  modelId: string | null;
}

/** `session.setModel` 出参 */
export interface SessionSetModelResult {
  session: SessionView;
  model: ModelState;
}

/** `session.setThinking` 入参 */
export interface SessionSetThinkingParams {
  sessionId: string;
  level: string | null;
}

/** `session.setThinking` 出参 */
export interface SessionSetThinkingResult {
  thinking: ThinkingState;
}

/** `session.setThresholds` 入参 */
export interface SessionSetThresholdsParams {
  sessionId: string;
  handoffThreshold?: number | null;
  guardThreshold?: number | null;
}

/** `session.setThresholds` 出参 */
export interface SessionSetThresholdsResult {
  session: SessionView;
}

/** `session.transient` 入参 */
export interface SessionTransientParams {
  cwd: string;
  input: MessageInput;
  agentId?: string;
  modelId?: string;
}

/** `session.transient` 出参 */
export interface SessionTransientResult {
  message: AgentNS.Message;
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// 旧 `schema/message.ts` —— 留在表里只为 `MethodMap` 完整
// ---------------------------------------------------------------------------

/** `message.list` 入参 */
export interface MessageListParams {
  sessionId: string;
  after?: string;
  toolCallId?: string;
  around?: string;
  includeHidden?: boolean;
}

/** `message.list` 出参 */
export interface MessageListResult {
  sessionId: string;
  anchor: string | null;
  messages: AgentNS.Message[];
}

// ---------------------------------------------------------------------------
// 旧 `schema/question.ts` —— 留在表里只为 `MethodMap` 完整
// ---------------------------------------------------------------------------

/** `question.list` 入参 */
export interface QuestionListParams {
  sessionId: string;
}

/** `question.list` 出参 */
export interface QuestionListResult {
  questions: QuestionView[];
}

/** `question.answer` 入参 */
export interface QuestionAnswerParams {
  questionId: string;
  value: string;
}

/** `question.answer` 出参里的后续动作 */
export interface QuestionEffects {
  handoffStarted: boolean;
  handoffDeferredReason: HandoffRefusalReason | null;
}

/** `question.answer` 出参 */
export interface QuestionAnswerResult {
  question: QuestionView;
  effects: QuestionEffects;
}

// ---------------------------------------------------------------------------
// 旧 `schema/notice.ts` —— 留在表里只为 `MethodMap` 完整
// ---------------------------------------------------------------------------

/** `notice.list` 入参 */
export interface NoticeListParams {
  sessionId?: string;
  level?: NoticeLevel;
}

/** `notice.list` 出参 */
export interface NoticeListResult {
  notices: NoticeView[];
}

/** `notice.dismiss` 入参 */
export interface NoticeDismissParams {
  noticeId: string;
}

/** `notice.dismiss` 出参 */
export interface NoticeDismissResult {
  dismissed: boolean;
}

/** `notice.clear` 入参 */
export interface NoticeClearParams {
  sessionId?: string;
}

/** `notice.clear` 出参 */
export interface NoticeClearResult {
  cleared: number;
}

// ---------------------------------------------------------------------------
// 旧 `schema/config.ts` / `schema/agent.ts` / `schema/model.ts` —— **三组已整组删掉**
//
// 配置域这一刀搬完了：`config.get` 回的是 SDK 的 `AppConfig` + 档位表，写各归各的门
// （`config.setDefaults` / `setGlobal` / `endpoint.*` / `model.*` / `imageModel.*` /
// `presets.set`），助手定义走 `agentDefinition.*`，MCP 走 `mcp.*`。于是旧那三组形状
// （`ConfigView` / `EndpointView` / `ModelView` / `ImageModelView` / `DiscoveryView` /
// `DiscoveryLayerView` / `DiscoveryEntryView` / `McpServerEntryInput` / `AgentView` /
// `AgentInput` / 那一串 `*Params` / `*Result` / `ConfigApplyReport` …）一个消费者都不剩。
//
// 与 `completion` 那一组同一个样板：形状删掉之后 `MethodName` 也不再认那 24 个旧方法名
// （8 个 `config.*` + 8 个 `agent.*` + 8 个 `model.*`），它们只剩在 `LEGACY_METHODS` 的注记里
// ——`server-client/methods.ts` 的 `RetiredMethodName` 那一串就是它们的墓碑。
//
// `host.reload` 跟着一起退场：它的出参就是 `{ config: ConfigView, applied: ConfigApplyReport }`，
// 两个形状都没了，而 `call("host.reload")` 在源码里一个调用点都没有（`/reload` 走会话层的
// `reload()`，宿主那边是 `agent.reload`/重装，不存在这条 procedure）。

// ---------------------------------------------------------------------------
// 旧 `schema/asset.ts` —— 三段式上传已由 `@ai-zen/agents-client` 的 `asset.upload` 取代
// ---------------------------------------------------------------------------

/** 附件的用途（PRD D5） */
export type AssetPurpose = "message_image";

/** `asset.begin` 入参 */
export interface AssetBeginParams {
  purpose: AssetPurpose;
  mime: string;
  bytes: number;
  name?: string;
  sha256?: string;
  sessionId: string;
}

/** `asset.begin` 出参 */
export interface AssetBeginResult {
  deduped: boolean;
  uploadId: string | null;
  maxBytes: number;
  receivedBytes: number;
  asset: AssetRef | null;
}

/** `asset.end` 入参 */
export interface AssetEndParams {
  uploadId: string;
  sha256: string;
}

/** `asset.end` 出参 */
export interface AssetEndResult {
  asset: AssetRef;
}

/** 素材引用 */
export interface AssetRef {
  assetId: string;
  mime: string;
  bytes: number;
  name: string | null;
  width: number | null;
  height: number | null;
}

/** `asset.get` 取哪一档 */
export type AssetVariant = "original" | "thumb";

/** `asset.get` 入参 */
export interface AssetGetParams {
  assetId: string;
  variant?: AssetVariant;
}

/** `asset.get` 出参 */
export interface AssetGetResult {
  asset: AssetRef;
  variant: AssetVariant;
  data: string;
}

// ---------------------------------------------------------------------------
// 旧 `schema/completion.ts` —— **整组已删**
//
// `@` 补全的清单今天走 `api.workspace.files`（会话层直连，`session.ts` 的
// `listWorkspaceFiles`），旧那一路（`FileEntryView` / `CompletionState` /
// `CompletionFilesParams` / `CompletionFilesResult`）没有任何消费者了：那一组只有会话层的
// `completion.files` 在用，而它已经改走 procedure。`LEGACY_METHODS` 里还留着那个方法名
// 一行的注记（“已由 `api.workspace.files` 取代”），但形状不再抄一份。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 旧 `schema/handoff.ts` —— `then`（交接之后做什么）已退场，`handoff.start` 这条旧路还留着
// ---------------------------------------------------------------------------

/** 交接执行者 */
export type HandoffMode = "self" | "summary";

/** 交接之后做什么 */
export type HandoffThen = "document_only" | "new_session";

/** 交接文档（PRD F-D6 / D19） */
export interface HandoffDocument {
  path: string;
  bytes: number;
  writtenAt: string;
  mode: HandoffMode;
}

/** 一份交接文档的元信息 */
export interface HandoffDocumentInfo {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: string;
}

/** `handoff.start` 入参 */
export interface HandoffStartParams {
  sessionId: string;
  mode: HandoffMode;
  then: HandoffThen;
}

/** `handoff.start` 出参 */
export interface HandoffStartResult {
  started: true;
  path?: never;
}

/** `handoff.listDocuments` 入参 */
export interface HandoffListDocumentsParams {
  workspaceId: string;
}

/** `handoff.listDocuments` 出参 */
export interface HandoffListDocumentsResult {
  documents: HandoffDocumentInfo[];
}

// ---------------------------------------------------------------------------
// 旧 `schema/search.ts` —— 搜索屏还没搬（下一刀之外）
// ---------------------------------------------------------------------------

/** `search.sessions` 入参 */
export interface SearchSessionsParams {
  query: string;
  workspaceId?: string;
  limit?: number;
}

/** 按名搜到的一段会话 */
export interface SessionHit {
  session: SessionSummary;
  matchedName: string;
}

/** `search.sessions` 出参 */
export interface SearchSessionsResult {
  hits: SessionHit[];
}

/** `search.messages` 入参 */
export interface SearchMessagesParams {
  query: string;
  workspaceId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

/** 一条消息命中 */
export interface MessageHit {
  sessionId: string;
  sessionName: string;
  messageId: string;
  role: AgentNS.Role;
  snippet: string;
  createdAt: string;
}

/** `search.messages` 出参 */
export interface SearchMessagesResult {
  hits: MessageHit[];
  total: number;
}

// ---------------------------------------------------------------------------
// 方法表（旧 `wire/methods.ts` 的 `MethodMap`，68 条）
// ---------------------------------------------------------------------------

/** 方法名 → `{ params, result }`（旧 wire 的完整一张表） */
export interface MethodMap {
  // ---- host.* ----
  "host.hello": { params: HostHelloParams; result: HostHelloResult };
  "host.version": { params: HostVersionParams; result: HostVersionResult };
  "host.upgrade": { params: HostUpgradeParams; result: HostUpgradeResult };
  "host.shutdown": { params: HostShutdownParams; result: HostShutdownResult };
  "host.setLanguage": { params: HostSetLanguageParams; result: HostSetLanguageResult };

  // ---- workspace.* ----
  "workspace.list": { params: WorkspaceListParams; result: WorkspaceListResult };
  "workspace.create": { params: WorkspaceCreateParams; result: WorkspaceCreateResult };
  "workspace.get": { params: WorkspaceGetParams; result: WorkspaceGetResult };
  "workspace.rename": { params: WorkspaceRenameParams; result: WorkspaceRenameResult };
  "workspace.remove": { params: WorkspaceRemoveParams; result: WorkspaceRemoveResult };

  // ---- session.* ----
  "session.list": { params: SessionListParams; result: SessionListResult };
  "session.create": { params: SessionCreateParams; result: SessionCreateResult };
  "session.get": { params: SessionGetParams; result: SessionGetResult };
  "session.state": { params: SessionStateParams; result: SessionStateResult };
  "session.rename": { params: SessionRenameParams; result: SessionRenameResult };
  "session.pin": { params: SessionPinParams; result: SessionPinResult };
  "session.delete": { params: SessionDeleteParams; result: SessionDeleteResult };
  "session.send": { params: SessionSendParams; result: SessionSendResult };
  "session.start": { params: SessionStartParams; result: SessionStartResult };
  "session.abort": { params: SessionAbortParams; result: SessionAbortResult };
  "session.pause": { params: SessionPauseParams; result: SessionPauseResult };
  "session.resume": { params: SessionResumeParams; result: SessionResumeResult };
  "session.kill": { params: SessionKillParams; result: SessionKillResult };
  "session.clearInbox": { params: SessionClearInboxParams; result: SessionClearInboxResult };
  "session.revert": { params: SessionRevertParams; result: SessionRevertResult };
  "session.setModel": { params: SessionSetModelParams; result: SessionSetModelResult };
  "session.setThinking": { params: SessionSetThinkingParams; result: SessionSetThinkingResult };
  "session.setThresholds": {
    params: SessionSetThresholdsParams;
    result: SessionSetThresholdsResult;
  };
  "session.transient": { params: SessionTransientParams; result: SessionTransientResult };

  // ---- message.* ----
  "message.list": { params: MessageListParams; result: MessageListResult };

  // ---- question.* ----
  "question.list": { params: QuestionListParams; result: QuestionListResult };
  "question.answer": { params: QuestionAnswerParams; result: QuestionAnswerResult };

  // ---- notice.* ----
  "notice.list": { params: NoticeListParams; result: NoticeListResult };
  "notice.dismiss": { params: NoticeDismissParams; result: NoticeDismissResult };
  "notice.clear": { params: NoticeClearParams; result: NoticeClearResult };

  // ---- asset.* ----
  "asset.begin": { params: AssetBeginParams; result: AssetBeginResult };
  "asset.end": { params: AssetEndParams; result: AssetEndResult };
  "asset.get": { params: AssetGetParams; result: AssetGetResult };

  // ---- completion.* ----
  // 这一组整组没了（旧 `schema/completion.ts`）：`@` 补全今天走 `api.workspace.files`，旧方法
  // 名也不再是 `MethodName` 的一员。`LEGACY_METHODS` 里那一行注记还在（告诉下一刀它去过哪）。

  // ---- handoff.* ----
  "handoff.start": { params: HandoffStartParams; result: HandoffStartResult };
  "handoff.listDocuments": {
    params: HandoffListDocumentsParams;
    result: HandoffListDocumentsResult;
  };

  // ---- search.* ----
  "search.sessions": { params: SearchSessionsParams; result: SearchSessionsResult };
  "search.messages": { params: SearchMessagesParams; result: SearchMessagesResult };
}

/** 方法名 */
export type MethodName = keyof MethodMap;

/** 取某个方法的入参类型 */
export type MethodParams<M extends MethodName> = MethodMap[M]["params"];

/** 取某个方法的出参类型 */
export type MethodResult<M extends MethodName> = MethodMap[M]["result"];

/**
 * 全部方法名（43 条，顺序照旧 wire 的方法表）。
 *
 * `satisfies` 让「表里漏了一个方法」在编译期就被抓到：漏掉的名字会留在
 * `Exclude<MethodName, (typeof METHOD_NAMES)[number]>` 那个差集里，而不是被抹成 `never`。
 */
export const METHOD_NAMES = [
  "host.hello",
  "host.version",
  "host.upgrade",
  "host.shutdown",
  "host.setLanguage",
  "workspace.list",
  "workspace.create",
  "workspace.get",
  "workspace.rename",
  "workspace.remove",
  "session.list",
  "session.create",
  "session.get",
  "session.state",
  "session.rename",
  "session.pin",
  "session.delete",
  "session.send",
  "session.start",
  "session.abort",
  "session.pause",
  "session.resume",
  "session.kill",
  "session.clearInbox",
  "session.revert",
  "session.setModel",
  "session.setThinking",
  "session.setThresholds",
  "session.transient",
  "message.list",
  "question.list",
  "question.answer",
  "notice.list",
  "notice.dismiss",
  "notice.clear",
  "asset.begin",
  "asset.end",
  "asset.get",
  "handoff.start",
  "handoff.listDocuments",
  "search.sessions",
  "search.messages",
] as const satisfies readonly MethodName[];

/** 运行时判断一个字符串是不是已知的旧方法名 */
export function isMethodName(value: unknown): value is MethodName {
  return typeof value === "string" && (METHOD_NAMES as readonly string[]).includes(value);
}
