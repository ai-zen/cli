/**
 * 斜杠命令执行器 —— 表驱动。
 *
 * 命令的**元数据**（名字 / 别名 / 说明 / 接的方法 / 是否阻塞输入）在 `commands/registry.ts`；
 * **Agent**在本文件末尾的 `HANDLERS` 表里。两者以 `Record<CommandName, CommandHandler>` 绑定，
 * 于是「新增命令忘了写处理器」是编译错误（`switch` 那套形状下，漏一个分支只会在运行时落到
 * 「未知命令」）。
 *
 * ## 命令层只做三件事
 *
 * 「解析用户输入 → 调一个方法 → 把结果说成人话」。规则一条都不在这里算：
 *
 * | 看起来像规则的 | 谁给 |
 * |---|---|
 * | 模型/AgentDefinition 能不能用、不能用为什么 | `ModelView.available` / `AgentView.available` + `unavailableReason` |
 * | 生效模型、思考档位现状与可选档 | `ModelState` / `ThinkingState`（AgentDefinition 视图里是同一个形状） |
 * | 会话列表怎么排 | `session.list`（置顶 + 创建时间倒序由宿主排好） |
 * | 撤回会删掉什么 | `session.revert` 的入参是**消息 id**，不由客户端数下标 |
 * | 交接降级没降级 | `handoff.start` 的 `degraded` / `usedMode` / `problem` |
 *
 * ## 两个口子：会话契约 + 一条连接
 *
 * 会话域（发话、撤回、换模型、交接、重载）走 {@link ChatSessionLike} —— 它负责把
 * 本机那份现场跟宿主对齐；配置 / AgentDefinition / 宿主域只读或只写一次，走 {@link ChatCommandHost.call}
 * 直接说契约方法（`config.*` / `agent.*` / `model.*` / `host.*`）。命令层**不**吃盘、不持有
 * 第二份配置：界面说「改好了」与宿主真正用的那份必须是同一份。
 *
 * 「换会话」（`/new` 开新的、`/sessions` 选中别的）不在这一对里：会话归**进程**所有
 * （PRD D4），命令层只能说「换成哪一段」，生死由注册表管着。
 *
 * ## 为什么它在 `src/commands/` 而不在 `tui/screens/`
 *
 * 命令层不是渲染：它不吃键盘、不画帧，只「根据命令名做一件事」。判据是**产物图**而不是
 * 路径 grep：`node scripts/check-imports.mjs dist/commands/index.js --forbid ink --forbid react
 * --forbid ./tui/`。
 */
import { AgentNS } from "@ai-zen/agents-core";
import type { LogSink } from "@ai-zen/agents-logger";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentListOf, toDefinition } from "../agents-store.js";
import { checkAgentSwitch, listAgentChoices } from "../agent-switch.js";
import { STAGE_TEXT } from "../host-stage.js";
import { SUPPORTED_LOCALES, getLocale, normalizeLocale, t } from "../i18n/index.js";
import { persistLocale } from "../i18n/preferences.js";
import { parseMcpScope, pickStartScope } from "../mcp-command.js";
import { readDistTags, runNpm as defaultRunNpm, type RunNpm } from "../npm.js";
import {
  agentThinkingOf,
  effortLabel,
  effortLabelText,
  isAdjustable,
  modelParamsWithLevel,
  presetOf,
  thinkingView,
} from "../reasoning-effort.js";
import type { LiveSession } from "../sessions-registry.js";
import type {
  ChatSessionLike,
  HandoffMode,
  HostConnection,
  MessageInput,
  NoticeTone,
  ScopeReloadReport,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "../session/types.js";
import { openInSystemEditor, systemEditorCommand } from "../system-editor.js";
import { truncate } from "../text.js";
import { compareVersions, pickNewest } from "../version-compare.js";
import {
  listWorkspaces,
  rememberWorkspace,
  useOrRegisterWorkspace,
  workspaceHint,
  type WorkspaceHost,
} from "../workspace.js";
import {
  canonicalCommandName,
  getCommandHints,
  parseCommandArgs,
  type CommandName,
} from "./registry.js";
import { type SelectItem, type WizardEntryStep } from "./types.js";

/**
 * 宿主（屏幕）提供给命令层的能力 —— **只留命令层真正用得上的那些**。
 *
 * 类型面里不许出现 `react`：那不只是「少一个 import」，而是这条边界唯一的硬判据 ——
 * 一旦命令层能伸手拿到 setter，它就能把「弹个选择器」写成「改一块渲染状态」，而那条代码
 * 在无头宿主（测试 / 将来的脚本模式）里根本跑不起来。
 */
export interface ChatCommandHost {
  session: ChatSessionLike;
  /**
   * 这次连的是哪台宿主（是不是本机 + 记忆键）。
   *
   * `/ws` 靠它回答两件事：新建时能不能默认当前目录（只有本机），以及「上次进入的是哪个」该
   * 记在哪一格（两台宿主不许串味）。判据来自连接层，命令层不自己推。
   */
  workspaceHost: WorkspaceHost;
  /**
   * 日志出口（根造、组装根递进来）。
   *
   * 命令层只有两处会用到它：`/ws` 把「上次进入的那个」记进本机记忆、`/lang` 写入偏好 —— 两者
   * 都是**缓存**，写不进去不该拦住命令，但也不许一声不吭。
   */
  logger: LogSink;
  /**
   * 调一个**旧方法**（`call`：只有 `session.create` / `session.send` 能真的转成 `api.*`，
   * 其余抛 `unsupported`）。
   *
   * 还没搬的域（配置 / AgentDefinition / 模型 / MCP）仍然按旧名说话，形状直接取旧方法表
   * （`call<M extends MethodName>`），于是入参出参与那时的宿主逐字一致。
   */
  call: HostConnection["call"];
  /**
   * **会话域与工作区域直连的那一面**（口径③）：
   *
   * 会话层不走 `call`，命令层要的那几条也一样 —— `workspace.list|create`、`config.get`
   * （`/model` 要模型表、`/new` 要默认 AgentDefinition）都从这里直接问 procedure。
   */
  api: HostConnection["api"];
  /** 通知通道：命令反馈（切换结果 / 交接路径 …）走独立栏位，不进 messages */
  notice: (text: string, tone?: NoticeTone) => void;
  /** 清屏（保留上下文）：把转录显示起点推到最新 */
  clearTranscript: () => void;
  /**
   * 选择器**能放几条**候选。
   *
   * 为什么不是「终端原始行数」：那样命令层就得用布局公式（`usableFrameRows` / `pickerLines` /
   * `STATUS_BAR_LINES`）自己换算 —— 那是把一个渲染概念拖进命令层，也是 ink 进的另一条门。
   * 换算在渲染层（`tui/screens/layout.ts` 的 `pickerCapacity`），命令层只拿结果。
   */
  rows: number;
  /** 结束这一屏并把去向交给上层（`restart` 重挂载 / `load` 换一段会话） */
  exit: (value?: CommandExitValue) => void;
  suspendTerminal: (fn: () => void | Promise<void>) => Promise<void>;
  openWizard: (step: WizardEntryStep) => Promise<void>;
  openKeyEditor: () => Promise<void>;
  doExit: () => void;
  /** 弹选择器并等用户作答（取消 / Esc 为 `null`）；覆盖层怎么画由宿主决定 */
  pick: (title: string, items: SelectItem<string>[]) => Promise<string | null>;
  /**
   * 跑一次 npm（`/upgrade` 查发布标签走它：`npm view <pkg> dist-tags`）。
   *
   * **谁会走到**：生产里 TUI 不写这一格（`tui/screens/chat.tsx` 那个 `ChatCommandHost` 字面量
   * 没有它）—— `cmdUpgrade` 于是用 `npm.ts` 的缺省实现真跑；用例换成假的
   * （`commands/handlers-update.test.ts`），于是「查版本」在 CI 里不连 registry。与
   * `tui/screens/layout.ts` 的 `rows` 同一条理由：命令层不自己吞一个环境依赖，只拿它当参数。
   */
  runNpm?: RunNpm;
  /**
   * `/new`：同一个 AgentDefinition、当前选中的工作区另开一段会话，返回新会话的 id。
   *
   * 为什么不是 `session.reset()`：那样会把**这一段的会话对象**挪到新会话上去，旧那一段的
   * 订阅当场就没了 —— 而它可能还在跑（PRD D4：切会话不打断）。开新会话因此归注册表。
   */
  newSession: () => Promise<string>;
  /**
   * 把一段会话从**本进程的登记**里摘掉（连同它的订阅）。`/delete` 删完之后的那一手。
   *
   * 为什么归注册表而不归命令层：一段会话开来就归它管，`dispose` 也只在它那儿发生。命令层只说
   * 「这一段已经不在了」，怎么摘（先摘登记、再解订阅）是登记表的事 —— 绕过它去动内部字段，
   * 下一次就会有人从另一个人口重复一份同样的清理。
   *
   * 传进来的 id 不在登记里（别的客户端删的）：空操作，不报错。
   */
  dropSession: (sessionId: string) => void;
  /**
   * 「这一次删除是我自己叫宿主删的」——`/delete` 与 `/ws delete` 在真删**之前**报个名，回一个
   * 「收尾完了」。
   *
   * 报名的用处：宿主在 mutation 里就把 `session.removed` 推到那条流上，它到得比回执**早**，
   * 注册表若照样演一遍「屏幕正看着的那一段被删了」，这一屏会先被惊动一次（说一句话、换一次屏），
   * 紧接着命令自己的收尾又来一遍 —— 同一件事说两遍，两句话还不一样。
   *
   * 所以：这期间回来的那条事件只摘登记，不惊动屏幕；收尾（说什么话、换到哪一段、回不回连接屏）
   * 由发起删除的那条命令自己做。失败也要把「收尾完了」调掉，否则这一段以后被别处删掉时就不出声了。
   */
  expectOwnRemoval: () => () => void;
  /**
   * 本进程挂着的会话（`/sessions` 的两处数据之一）。
   *
   * 给的是**一份快照**而不是一个查询函数：命令层只在按下回车那一瞬要它（宿主那一半另有一次
   * 往返，本来就不是同一时刻），而刷新节奏由下一回 `/sessions` 自己定 —— 存一份「会自己变」
   * 的引用反而要管它何时过期。
   */
  liveSessions: readonly LiveSession[];
  setInputText: (text: string) => void;
  /** 更新状态栏的思考强度展示（`/think` 写入后由上层重取）；文案与置灰一起给，避免漂移 */
  setEffortView: (view: { text: string; dimmed: boolean } | null) => void;
  /**
   * 触发一次界面重渲染（`/lang` 切换语言后用）。
   *
   * `t()` 是模块级函数，语言一变，已渲染的文案不会自己更新 —— 必须让 React
   * 重新执行一遍渲染函数才能取到新语言。这里只递增一个计数，不携带任何状态。
   */
  refreshLocale: () => void;
}

/**
 * 「结束这一屏」的去向（渲染层的重挂载循环读它）。
 *
 * 形状就是 `tui/index.tsx` 里那个重挂载分支认的几样：`restart` 同参数重挂载、
 * `load` 换一段会话。写在这里是因为**产出它的是命令层**（`/back`、`/load`），
 * 而 `any` 会让「少传一个 sessionId」变成运行时才发现的接错会话。
 */
export interface CommandExitValue {
  /** 重挂载这一屏（`/back` 之后消息变短，显示起点必须归零） */
  restart?: boolean;
  /** 换成另一段会话（`/load`） */
  load?: { sessionId?: string };
  messages?: AgentNS.Message[];
  sessionId?: string;
  /** 重挂载后预填到输入框的文字（`/back` 把被撤回的那句话放回来） */
  initialInput?: string;
  /**
   * 重挂载后挂回输入的 Asset id（`/back` 撤回的那条消息里带的图，按原顺序）。
   *
   * 与 `initialInput` 是同一次回填的两半：文字进草稿、Asset 挂回输入，用户提交前看得见
   * 自己撤回来了哪几张（PRD 3.9「带图的那条连图一起恢复」）。
   */
  initialAssetIds?: string[];
  /**
   * 重挂载之后在新屏上说一次的系统提示（`/new` 的「已开始新会话」）。
   *
   * 旧实例已经卸载，通知栏跟着没了：不这样带一句话过去，`/new` 之后屏幕上一点声音都没有。
   */
  notice?: string;
  /**
   * 回连接屏，并在那块屏上显示这句话（`/shutdown` 关掉宿主之后走这一条）。
   *
   * 与 `restart` / `load` 是**并列的三种去向**：那两条还在这一屏的重挂载循环里，这一条
   * 走得更远 —— 连宿主都没了，得回到「连哪台」那一步。
   */
  backToConnect?: string;
}

/**
 * 执行者参数（`/migrate self`）的解析结果。
 *
 * 分成「合法值」与「非法原值」两个字段，而不是一个 boolean + 一个 `string | undefined`：
 * 调用方一看到 `invalid` 有值就能直接回显，不需要靠类型收窄去猜。
 */
export interface HandoffSelection {
  /** 显式指定且合法的执行者（`self` / `summary`）；未指定为 `undefined` */
  mode: HandoffMode | undefined;
  /** 显式指定但不合法的原值（报错回显用） */
  invalid: string | undefined;
}

/** 单个命令的执行上下文：宿主能力 + 已解析的参数 */
export interface CommandContext extends ChatCommandHost {
  /** 命中命令的**主名**（别名已归一：`/effort` → `think`、`/quit` → `exit`） */
  name: CommandName;
  /** 原始输入（含 `/`），用于「未知命令」等场景回显 */
  raw: string;
  /** 首个 token 之后的参数（`/migrate summary` → `["summary"]`） */
  args: string[];
  /** 通知（默认 info 语气） */
  push: (text: string, tone?: NoticeTone) => void;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

/** 抛出值 → 一句人话（宿主给的 `message` 本来就能上屏，非 `Error` 的兜一下） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析 `/handoff` `/migrate` 的执行者参数（`self` / `summary`，大小写不敏感）。
 *
 * 单独成函数而不是挂在 `CommandContext` 上：20 条命令里只有这两条用得到。
 */
function parseHandoffSelection(args: readonly string[]): HandoffSelection {
  const raw = args[0]?.toLowerCase();
  const mode: HandoffMode | undefined = raw === "self" || raw === "summary" ? raw : undefined;
  return { mode, invalid: raw !== undefined && mode === undefined ? raw : undefined };
}

/** 「跳过本次」的哨兵值（区别于 `self` / `summary` 两个执行者） */
const HANDOFF_SKIP = "__skip__";

/**
 * 交接执行者三选一（`/handoff` 那一屏）。
 *
 * `label` 贴近用户措辞，`hint` 交代取舍：保真 vs 省算力。`summary` 那一句必须说清「另起一个
 * **一次性 Agent**」—— 两个选项的差别不在写得好不好，而在**谁去写**（这段会话自己的 agent
 * 接着写，还是起一个只干这一件事、干完就散的 Agent）。
 *
 * 只有 `/handoff` 一处用它，所以它就住在这一层；渲染层不认这几条（`pick()` 只收标签与值）。
 */
function handoffModeItems(): SelectItem<string>[] {
  return [
    { label: t("handoff.modeSelf"), value: "self", hint: t("handoff.modeSelfHint") },
    { label: t("handoff.modeSummary"), value: "summary", hint: t("handoff.modeSummaryHint") },
    { label: t("handoff.modeSkip"), value: HANDOFF_SKIP, hint: t("handoff.modeSkipHint") },
  ];
}

/**
 * 选择器答案 → 交接执行者。
 *
 * `null`（Esc / 覆盖层被关掉）、`HANDOFF_SKIP`（选了「跳过本次」）与任何意外值都归到 `null`：
 * 调用方只需分辨「交接 / 不交接」两件事，而 `handoff.start` 只有 `self` / `summary` 两个合法值。
 */
function toHandoffMode(value: string | null): HandoffMode | null {
  return value === "self" || value === "summary" ? value : null;
}

/**
 * 这条失败是不是「用户选择了不交接」。
 *
 * 认业务码而不是 `instanceof`：跨进程没有类的同一性，宿主发的是 `handoff_declined`
 * （PRD F-D7：取消不等于失败，不重试、不留半个文档），客户端按码分支。
 */
function isHandoffDeclined(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "handoff_declined";
}

/**
 * 一段消息内容里的文字（撤回列表的标签、回填输入框都用它）。
 *
 * 只取 `text` 段：图片 / 文件段没有可放回输入框的文字形态。Asset 那半在 `MessageInput.assetIds`
 * 里（`session.revert` 从段上的本地标记拆出来），与文字一起回填。
 */
function textOf(content: AgentNS.MessageContent | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const section of content) if (section.type === "text") parts.push(section.text);
  return parts.join("\n");
}

/**
 * 内容段上的本地 Asset 标记（指向数据根下的一份 Asset）。
 *
 * 写它的是 `user-content.ts` 的 `contentOfInput`（宿主的 `ASSET_ID_KEY` 是同一个词）；
 * 这里只读，不改它的含义 —— 数「这一段引用到了几份 Asset」靠的就是这个标记。
 */
const ASSET_ID_KEY = "__asset_id";

/**
 * 这一段消息引用到了几份 Asset（按 id 去重：同一张图被引用两次只算一份）。
 *
 * 数的是**快照里的事实**：`session.open` 回的那一份消息，而不是本地镜像的旧样子 ——
 * 别的地方（另一台终端）刚发的那张图也算在代价里。参数的形状故意写得宽（只要「有一格
 * `content`」）：`session.open` 出来的消息行是宿主那一份，不把本层绑在 core 的完整 `Message` 上。
 */
function referencedAssetCount(messages: readonly { content?: unknown }[]): number {
  const ids = new Set<string>();
  for (const message of messages) {
    const content = message.content;
    // 纯文本消息（`content` 是字符串）里没有 Asset 段：没东西可数
    if (!Array.isArray(content)) continue;
    for (const section of content as Record<string, unknown>[]) {
      const assetId = section[ASSET_ID_KEY];
      if (typeof assetId === "string") ids.add(assetId);
    }
  }
  return ids.size;
}

// ==================== 各命令 ====================

/**
 * `/new` —— 同一个 AgentDefinition、**当前选中的工作区**另开一段会话（PRD D4：**不打断**当前那一段）。
 *
 * 四件事分开说清：
 *
 *   · 新会话由注册表开（`newSession`）：它知道这一段用的 AgentDefinition 与 `/ws` 选过的工作区，
 *     而开完之后那一段**立刻**在注册表里（下一步切过去只是接成它的听众）；
 *   · 旧那一段什么都不动：它留在注册表里继续跑，订阅也在（宿主本来就不随客户端换屏停跑）；
 *   · 切过去走 `load` 那一支重挂载：换一段会话要换一整套事实（消息、模型、思考档、目录），
 *     这不是「改一个字段」；
 *   · 「已开始新会话」随着 `notice` 带到新屏 —— 旧屏的通知栏已经跟着卸载了。
 */
const cmdNew: CommandHandler = async ({ newSession, exit }) => {
  const sessionId = await newSession();
  exit({ load: { sessionId }, notice: t("cmd.new.started") });
};

/**
 * `--all`：把每个工作区的会话合成一份（`/load --all`、`/sessions --all` 的那一条路）。
 *
 * 宿主没有「全库列会话」这条口：`session.list` 的 `workspaceId` 是**必填**的，而 prd
 * `10-observation.md` 明写不为取数的便利加接口。所以这一趟由客户端编排 —— 先
 * `workspace.list` 取项目，再逐个 `session.list`（顺序与重排见 {@link sessionsWithWorkspace}）。
 */
async function listSessionsEverywhere(api: HostConnection["api"]): Promise<SessionSnapshot[]> {
  return (await sessionsWithWorkspace(api)).map((item) => item.session);
}

/** 一段会话 + 它属于哪个项目（跨项目列表里每一行都要说得出这一格） */
interface SessionWithWorkspace {
  session: SessionSnapshot;
  /** 项目名（`workspace.list` 那一行上的；列表上印的是这个，不是 id） */
  workspaceName: string;
}

/**
 * 每个项目各取一次会话，合并后重排 —— `/sessions --all` 与「一段会话没了之后去哪儿」共用这一趟。
 *
 * 排序用宿主那一条规矩（置顶优先，再按创建时间倒序）：单个项目里它已经排好了，拼起来的这一份
 * 没人替你排。多带一格 `workspaceName`，因为跨项目列时同名会话分不开（那是 `workspace.list`
 * 上的一手事实，不是推的）。
 */
async function sessionsWithWorkspace(api: HostConnection["api"]): Promise<SessionWithWorkspace[]> {
  const workspaces = await api.workspace.list.query();
  const perWorkspace = await Promise.all(
    workspaces.map(async (workspace) => ({
      workspace,
      sessions: await api.session.list.query({ workspaceId: workspace.id }),
    })),
  );
  return perWorkspace
    .flatMap(({ workspace, sessions }) =>
      sessions.map((session) => ({ session, workspaceName: workspace.name })),
    )
    .sort(
      (a, b) =>
        Number(b.session.pinned) - Number(a.session.pinned) ||
        b.session.createdAt - a.session.createdAt,
    );
}

/** {@link moveAfterGone} 要的那一面（命令宿主与屏幕都拿得出这三样） */
export type GoneHost = Pick<ChatCommandHost, "api" | "notice" | "exit">;

/** 一段（或一批）会话没了之后往哪儿去 */
export interface AfterGone {
  /** 已经没了的那几段：找下一段时跳过它们（宿主那份列表可能还带着，尤其是并发删的那几段） */
  gone: readonly string[];
  /**
   * 在哪儿找下一段：同一项目里（`/delete`、别处删掉了这一屏那段），还是这整台宿主上
   * （`/ws delete` —— 那个项目整个没了，只能在别的项目里找）。
   */
  scope: { workspaceId: string } | "anywhere";
  /** 上屏的那一句：已经没了这件事本身（「已删掉这一段会话…」/「这一段会话已经被删掉了」） */
  notice: string;
  /** 一个去处都没有时补的那一句（一定会点到 `/new`） */
  emptyHint: string;
  /**
   * 一个去处都没有时往哪去：
   *
   *   · `connect` —— 回连接屏（这一屏正看着的那一段已经没了，没有会话可看）；
   *   · `stay` —— 留在这一屏（`/delete` 收尾的口径：删掉了就删掉了，没地方可换只是下一句说明）。
   */
  whenEmpty: "connect" | "stay";
}

/**
 * 一段（或一批）会话没了之后怎么收尾 —— **`/delete`、`/ws delete`、以及「别处删掉了这一屏
 * 那一段」那条事件共用这一套**（PRD 1.6「二次确认要能先给代价、再真做」，1.5「删项目＝连带删
 * 它名下的会话」；10-observation「一条事件流 + 一次能读回快照的调用」合起来够还原）。
 *
 * 三件事按这个顺序：
 *
 *   1. 找下一段：同一项目里最近的那一段（`session.list` —— 顺序是宿主排好的：置顶优先 +
 *      创建时间倒序，这里只取第一条）；`/ws delete` 那一路整个项目都没了，所以在别的项目里找
 *      （{@link listSessionsEverywhere}，那是客户端编排的一趟，宿主没有「全库列会话」这条口）；
 *   2. 有就去那儿：`exit({ load })`，两句一起带到新屏（旧屏的通知栏跟着卸载，说的话只能在
 *      新屏上说）；
 *   3. 没有就说明白：`connect` 回连接屏、`stay` 留在这一屏，两档都点到 `/new`。
 *
 * **不替用户开新会话**：开一段是 `/new` 那一条命令的事，不是删东西的副作用。
 *
 * 摘登记不在这里：那一段已经不在了，`/delete` / `/ws delete` 各自在调它之前先
 * `dropSession`（先摘、再换屏），别处删掉的那一条由注册表自己摘（`onRemoved`）。
 */
export async function moveAfterGone(host: GoneHost, after: AfterGone): Promise<void> {
  const rows =
    after.scope === "anywhere"
      ? await listSessionsEverywhere(host.api)
      : await host.api.session.list.query({ workspaceId: after.scope.workspaceId });
  const gone = new Set(after.gone);
  const next = rows.find((row) => !gone.has(row.id));

  if (next === undefined) {
    if (after.whenEmpty === "stay") {
      host.notice(after.notice);
      host.notice(after.emptyHint);
      return;
    }
    // 回连接屏：那一屏上只摆一句话，两句都得带上，否则用户不知道「为什么回到这儿」
    host.exit({ backToConnect: `${after.notice}\n${after.emptyHint}` });
    return;
  }
  host.exit({
    load: { sessionId: next.id },
    notice: `${after.notice}\n${t("cmd.delete.switched", { name: next.name })}`,
  });
}

/**
 * `/load [-a|--all]` —— 换一段已有的会话（列表来自 `session.list`）。
 *
 * 当前项目那一路的顺序、置顶、过滤全由宿主排好（会话行就是侧栏那一行）；命令层只把它摊成
 * 选择器，选中之后交给上层重挂载 —— 换会话等于换一整套状态（消息、模型、思考档、工作目录），
 * 不是「改一个字段」。`--all` 那一路跨项目合并时要在客户端重排一次（见下）。
 *
 * 换过去**不会**打断正在跑的那一段：会话归进程所有（PRD D4），旧那一段留在注册表里继续跑，
 * 只是没人看它而已（切回去它还在那里，状态是新的）。
 *
 * ## `--all`：不只列当前这个工作区
 *
 * 宿主这一版的 `session.list` 只按工作区列（入参 `workspaceId` 必填），所以跨项目那一趟是
 * 客户端编排的（{@link listSessionsEverywhere}）：不必先 `/ws` 换过去再 `/load`，旧版那种
 * 「一把列全」在这一条上补回来。
 *
 * 跨工作区之后每一条得说清自己属于哪个项目，否则同名会话分不开：会话行上有 `workspaceId`，
 * 直接印在 hint 上（显示名字要另一次 `workspace.list`，换来的只是一个更好看的标签；id 也是
 * 用户自己在 `/ws` 里见过的东西）。
 */
const cmdLoad: CommandHandler = async ({ session, api, push, args, rows, exit, pick }) => {
  // 只认这两个写法：其余参数一直是被忽略的（`/load` 从来没有按名字过滤）
  const allWorkspaces = args.some((arg) => arg === "--all" || arg === "-a");
  const sessions = allWorkspaces
    ? await listSessionsEverywhere(api)
    : await api.session.list.query({ workspaceId: session.workspaceId });
  if (sessions.length === 0) {
    push(t("cmd.load.none"), "error");
    return;
  }
  const allItems: SelectItem<string>[] = sessions.map((item) => ({
    label: `${item.name}${item.id === session.sessionId ? t("common.current") : ""}`,
    value: item.id,
    hint: allWorkspaces
      ? t("cmd.load.hintAll", { workspace: item.workspaceId, id: item.id })
      : item.id,
  }));
  // 覆盖层不能高于终端：仅展示宿主排好的前几条
  const maxItems = Math.max(1, rows);
  const tooMany = allItems.length > maxItems;
  const title = allWorkspaces
    ? t(tooMany ? "cmd.load.tooManyAll" : "cmd.load.titleAll", { n: maxItems })
    : t(tooMany ? "cmd.load.tooMany" : "cmd.load.titleReplacing", { n: maxItems });
  const choice = await pick(title, allItems.slice(0, maxItems));
  if (choice == null) {
    push(t("cmd.load.cancelled"));
    return;
  }
  exit({ load: { sessionId: choice } });
};

/**
 * 列表里的一行：宿主那一份会话行，加上**本进程对它说得出的那一点活值**。
 *
 * 会话行本身（名字、id、模型、两个时刻、置顶、属于哪个项目）从 `session.list` 来 —— 那是宿主
 * 的事实。活值（忙闲 / 死活 / 在忙什么 / 排队条数）只有**这一进程订阅着**的那几段说得出来
 * （注册表的 `LiveSession`），所以这一格是 `null` 或那一份，没有第三种。
 */
interface SessionListRow {
  session: SessionSnapshot;
  /** 这一段属于哪个项目（只在跨项目列时印；同一个项目里的每一行都重复说一遍是废字） */
  workspaceName: string | null;
  live: LiveSession | null;
}

/**
 * `/sessions`（别名 `/ps`）—— 列会话，选中即切（PRD D4）。
 *
 * ## 行从哪儿来
 *
 * `session.list`：带 `workspaceId` 列**当前项目**的会话（宿主按项目排好：置顶优先 + 创建时间
 * 倒序）。`--all` / `-a` 时把每个项目都取一遍再合并 —— 宿主没有「全库列会话」这条口（PRD
 * 10-observation 明写不为取数的便利加接口），所以跨项目那一趟由客户端编排
 * （{@link sessionsWithWorkspace}），合并之后自己按宿主那条规矩重排一次。
 *
 * 不筛「活着的」那几段：死掉的那一段也是用户自己的会话，它也在这张表里、也能切过去（切过去
 * 只是看，要发话才会重新叫起来）。从前这条命令只列活着的，因为它读的是旧方法的 `alive` 字段。
 *
 * ## 每一行印什么
 *
 * 全是**给得出来的事实**：置顶标记、忙闲/死活（只有本进程订阅着的那几段，见下）、id（短）、
 * 模型 id、更新时刻、属于哪个项目（跨项目时）。
 *
 * **状态那一格只说本进程说得出的**：本进程挂着的那几段有忙闲、在忙什么与排队条数
 * （`liveSessions`，那份带订阅）；别的会话在这一边没有订阅 —— 那一格就**什么都不说**，绝不把
 * 「不知道」写成「处理中」（与 `server-client/mirror.ts` 那条口径同源）。
 *
 * 选中只表达「换成哪一段」（`exit({ load })`）：这一层不碰任何会话的生死，也不往正在跑的那段
 * 里插话 —— 切过去只影响「接下来这屏看什么」（PRD D4）。
 */
const cmdSessions: CommandHandler = async ({
  session,
  api,
  liveSessions,
  push,
  rows,
  pick,
  exit,
  args,
}) => {
  const currentId = session.sessionId;
  // 只认这两个写法（与 `/load` 同一套：其余参数一直是被忽略的）
  const allWorkspaces = args.some((arg) => arg === "--all" || arg === "-a");
  const live = new Map(liveSessions.map((item) => [item.sessionId, item]));
  const listed: SessionListRow[] = allWorkspaces
    ? (await sessionsWithWorkspace(api)).map((item) => ({
        session: item.session,
        workspaceName: item.workspaceName,
        live: live.get(item.session.id) ?? null,
      }))
    : (await api.session.list.query({ workspaceId: session.workspaceId })).map((row) => ({
        session: row,
        workspaceName: null,
        live: live.get(row.id) ?? null,
      }));

  if (listed.length === 0) {
    // 一条都没有：给一句能照着做的话（不是「没有数据」那种只能干看着的句子）
    push(t(allWorkspaces ? "cmd.sessions.noneAll" : "cmd.sessions.none"));
    return;
  }
  if (listed.length === 1 && listed[0]!.session.id === currentId) {
    // 只有当前这一段：弹一个只有一行的选择器等于让用户确认一件已经成立的事
    push(t("cmd.sessions.onlyOne"));
    return;
  }

  const items: SelectItem<string>[] = listed.map((row) => ({
    label: `${row.session.name}${row.session.id === currentId ? t("common.current") : ""}`,
    value: row.session.id,
    hint: sessionHint(row),
  }));
  // 覆盖层不能高于终端：只摆前几条（顺序是上面那一条算的，不在这里重排）
  const maxItems = Math.max(1, rows);
  const title =
    items.length > maxItems ? t("cmd.sessions.tooMany", { n: maxItems }) : t("cmd.sessions.title");
  const choice = await pick(title, items.slice(0, maxItems));
  if (choice == null) {
    // Esc / 覆盖层被关掉：一条会话的生死都不动，这一屏也不换
    push(t("cmd.sessions.cancelled"));
    return;
  }
  if (choice === currentId) {
    push(t("cmd.sessions.already"));
    return;
  }
  exit({ load: { sessionId: choice } });
};

/**
 * 列表里那一行：**说得出的都说，说不出的不猜**。
 *
 * 几件事各说各的（PRD 4.4 的四件事不压成一格）：置顶、忙闲/死活（只有本进程订阅着的那一段
 * 才有这一格：「在忙什么」也说得出，没有 agent 的直说「没有 agent」）、id（短）、模型、
 * 更新时刻、属于哪个项目（跨项目时）。
 *
 * 时刻用的是**这一段最后一次变动的时刻**（`updatedAt`）：列表上要回答的是「哪一段最近动过」，
 * 那是宿主排序用手边的那一格。
 */
function sessionHint(row: SessionListRow): string {
  const parts: string[] = [];
  if (row.session.pinned) parts.push(t("cmd.sessions.pinned"));
  if (row.live !== null) parts.push(...activityHint(row.live));
  parts.push(shortId(row.session.id));
  parts.push(
    row.session.modelId === null
      ? t("cmd.sessions.noModel")
      : t("cmd.sessions.model", { id: row.session.modelId }),
  );
  parts.push(t("cmd.sessions.updated", { time: clockOf(row.session.updatedAt) }));
  if (row.workspaceName !== null) {
    parts.push(t("cmd.sessions.workspace", { name: row.workspaceName }));
  }
  return parts.join(" · ");
}

/**
 * 状态那一格（**只有本进程订阅着的那一段才走这里**）：忙闲 / 死活、「在忙什么」、排队条数。
 *
 * 读数还没到（`status === null`）时忙闲那一位**不占格**：不知道就不说，别拿「空闲」顶上。
 * 没有 agent 的那一段直说「没有 agent」（它要发话才会起来）。
 */
function activityHint(live: LiveSession): string[] {
  const parts: string[] = [];
  if (live.alive === false) parts.push(t("cmd.sessions.dead"));
  else if (live.status === "working") parts.push(live.phaseText ?? t("cmd.sessions.working"));
  else if (live.status === "idle") parts.push(t("cmd.sessions.idle"));
  if (live.inboxPending > 0) parts.push(t("cmd.sessions.inboxPending", { n: live.inboxPending }));
  return parts;
}

/**
 * 会话 id 的短样子：前 8 个字符，**不加省略号** —— 用户要拿它当 `/kill` 的前缀敲下去，末尾多一个
 * `…` 就复制不动了。id 短于 8 个字符时原样给（用例里的 `sess-1` 就是这种）。
 */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * epoch 毫秒 → 本地 `HH:MM`（**只用于人说「几点更新的」**，不参与任何比较或排序）。
 *
 * 读不出来就是 `-`：宁可不说话，也不要编一个看着像真的时刻。
 */
function clockOf(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 切到某个工作区：下一个新开的会话落在它里面，并把「这次进入的是哪个」记进本机记忆。
 *
 * **不重建会话**：这一段会话属于它建出来的那个工作区（宿主那边的目录、`@` 补全的清单都是那段
 * 会话自己的事实）。换过去的只是「下一个新会话往哪开」。
 */
async function enterWorkspaceBy(
  ctx: Pick<CommandContext, "session" | "workspaceHost" | "push" | "logger">,
  workspace: WorkspaceSnapshot,
): Promise<void> {
  ctx.session.selectWorkspace(workspace.id);
  await rememberWorkspace(ctx.workspaceHost, workspace.id, ctx.logger);
  ctx.push(t("cmd.ws.switched", { name: workspace.name, path: workspace.folder.cwd }));
}

/**
 * `/ws delete <项目名或 ID>` —— 删掉一个项目，**连带它名下的会话**（PRD 1.5「删项目＝连带删它
 * 名下的会话（删前说清代价）；目录本身永不碰」），一次确认（PRD 1.6「二次确认要能先给代价、
 * 再真做」）。
 *
 * ## 认哪个项目
 *
 * 参数认 ID，也认名字。两个都对不上就**指路**（`/ws` 里列着现有的那些），不猜「最近的那个」：
 * 这是个不可撤销的动作，猜错一次就是把别人的会话删了。名字撞车时不做第二道判断 —— 确认那一
 * 句里带着 `cwd`，那才是「要删的到底是哪个目录」的一手事实，用户在那里看得见。
 *
 * ## 代价先说清
 *
 * 代价是**名下有几段会话**（`session.list` 数出来，不是自己记的），而且它连同那些会话一起没；
 * 另说一件事：`cwd` 那个目录一个字都不动。删掉的是库里的项目行与它名下的会话行，盘上的目录
 * 与文件不归宿主管 —— 这两件事混着说，用户会以为删项目等于删文件。
 *
 * ## 删完之后
 *
 * 上屏的数字用**回执里的** `sessions.length`（宿主删之前数的那一份）：自己数的那一份可能已经
 * 过期（另一台终端刚建了一段）。
 *
 * 当前这一段属于那个项目时，它已经跟着没了：按「会话没了」那一套收尾（{@link moveAfterGone}，
 * 与 `/delete`、以及别处删掉时那条事件共用）。那个项目没了，所以在**别的项目里**找最近的一段；
 * 哪儿都没有就回连接屏，并说清可以用 `/new` 开一段（`/delete` 那一套的「没地方可换」）。
 */
async function cmdWsDelete(
  ctx: Pick<
    ChatCommandHost,
    "api" | "session" | "notice" | "pick" | "exit" | "dropSession" | "expectOwnRemoval"
  > & {
    /** 用户写的那个名字或 ID（`/ws delete ` 之后的全算，带空格的项目名也认） */
    typed: string;
  },
): Promise<void> {
  const { api, session, notice, pick, exit, dropSession, expectOwnRemoval, typed } = ctx;

  // ① 认项目：ID 优先，其次名字
  if (typed === "") {
    notice(t("cmd.ws.deleteUsage"), "error");
    return;
  }
  const workspaces = await listWorkspaces({ api });
  const target =
    workspaces.find((workspace) => workspace.id === typed) ??
    workspaces.find((workspace) => workspace.name === typed);
  if (target === undefined) {
    notice(t("cmd.ws.deleteUnknown", { arg: typed }), "error");
    return;
  }

  // ② 代价：名下有几段会话（`session.list` 按项目列，宿主已经把顺序排好，这里只数条数）
  const sessions = await api.session.list.query({ workspaceId: target.id });

  // ③ 一次确认：连带删掉什么、目录动不动的两件事都写在问的那一句里
  const choice = await pick(
    t("cmd.ws.deleteTitle", {
      name: target.name,
      path: target.folder.cwd,
      sessions: sessions.length,
    }),
    [
      { label: t("cmd.ws.deleteConfirm"), value: "yes" },
      { label: t("cmd.ws.deleteCancel"), value: "no" },
    ],
  );
  // 选了「否」（Esc / 覆盖层被关掉也是这一支）：一条写都没有，那个项目与它名下的会话都还在
  if (choice !== "yes") {
    notice(t("cmd.ws.deleteCancelled"));
    return;
  }

  // ④ 真删：先报名、**整段收尾做完之后再结账**（这一场里回来的 `session.removed` 由本命令收尾，
  // 见 `expectOwnRemoval`）
  const doneOwnRemoval = expectOwnRemoval();
  try {
    let removed: { sessions: string[] };
    try {
      removed = await api.workspace.delete.mutate({ workspaceId: target.id });
    } catch (error: unknown) {
      notice(t("cmd.ws.deleteFailed", { error: messageOf(error) }), "error");
      return;
    }

    // ⑤ 先摘登记（连带解订阅），再换屏：那些会话已经不在了，本进程不能再挂着它们
    for (const sessionId of removed.sessions) dropSession(sessionId);

    // 上屏的数字用回执里的：宿主删之前数的那一份
    const done = t("cmd.ws.deleteDone", {
      name: target.name,
      sessions: removed.sessions.length,
      path: target.folder.cwd,
    });

    // ⑥ 当前这一段不在那个项目里：这一屏一个字都不用动，把那句话说清就行
    if (session.workspaceId !== target.id) {
      notice(done);
      return;
    }
    // 它跟着项目一起没了：换到别的项目里最近的一段，哪儿都没有就回连接屏
    await moveAfterGone(
      { api, notice, exit },
      {
        gone: removed.sessions,
        scope: "anywhere",
        notice: done,
        emptyHint: t("cmd.ws.deleteNoSessionLeft"),
        whenEmpty: "connect",
      },
    );
  } finally {
    // 删没删成、换没换成，账都要结：失败时那些会话还在，它们以后被别处删掉时该照常出声
    doneOwnRemoval();
  }
}

/**
 * `/ws` —— 工作区是实体入口（PRD D30）：列 / 选 / 建 / 删。
 *
 * | 写法 | 做什么 |
 * |---|---|
 * | `/ws` | 列出现有工作区（每项的目录与「那个目录还在不在」都由宿主给），选中就切过去 |
 * | `/ws new` | 登记当前目录 —— **只有本机**能这么省（远端那个目录我们猜不到） |
 * | `/ws new <绝对路径>` | 登记宿主上的那个目录（远端就靠这一条） |
 * | `/ws delete <项目名或 ID>` | 删掉那个项目（连带它名下的会话，见 {@link cmdWsDelete}） |
 *
 * 名称一律不传：宿主会按目录名起一个可改的名字（PRD D9），客户端不替它编。
 */
const cmdWs: CommandHandler = async ({
  session,
  workspaceHost,
  args,
  push,
  rows,
  pick,
  logger,
  api,
  exit,
  dropSession,
  expectOwnRemoval,
}) => {
  // 「问一句」的那一面：`workspace.ts` 收的是一个带 `api` 的对象（不是裸函数）
  const connection = { api };
  const sub = args[0]?.toLowerCase();

  if (sub === "delete") {
    await cmdWsDelete({
      api,
      session,
      notice: push,
      pick,
      exit,
      dropSession,
      expectOwnRemoval,
      typed: args.slice(1).join(" ").trim(),
    });
    return;
  }

  if (sub === "new") {
    // 路径后面的部分全算路径（宿主上的绝对路径里出现空格很正常）
    const typed = args.slice(1).join(" ").trim();
    if (typed === "" && !workspaceHost.local) {
      // 远端宿主上的目录只有用户知道：这里不默认、也不拿本机目录凑一个
      push(t("cmd.ws.newNeedsPath"), "error");
      return;
    }
    try {
      // 本机不带路径 = 当前目录这条糖；有就复用（cwd 唯一，宿主不让登记两次）
      const workspace = await useOrRegisterWorkspace(
        connection,
        typed === "" ? process.cwd() : typed,
      );
      await enterWorkspaceBy({ session, workspaceHost, push, logger }, workspace);
    } catch (error: unknown) {
      push(t("cmd.ws.createFailed", { error: messageOf(error) }), "error");
    }
    return;
  }

  if (sub !== undefined) {
    push(t("cmd.ws.unknownArg", { arg: args[0]! }), "error");
    return;
  }

  const workspaces = await listWorkspaces(connection);
  if (workspaces.length === 0) {
    push(t("cmd.ws.none"), "error");
    push(t(workspaceHost.local ? "cmd.ws.newHintLocal" : "cmd.ws.newHintRemote"));
    return;
  }
  // 覆盖层不能高于终端：只摆前几条（顺序是宿主的，不在这里重排）
  const maxItems = Math.max(1, rows);
  const items: SelectItem<string>[] = workspaces.slice(0, maxItems).map((workspace) => ({
    label: `${workspace.name}${workspace.id === session.currentWorkspaceId ? t("common.current") : ""}`,
    value: workspace.id,
    hint: workspaceHint(workspace),
  }));
  const title =
    workspaces.length > maxItems ? t("cmd.ws.tooMany", { n: maxItems }) : t("cmd.ws.title");
  const choice = await pick(title, items);
  if (choice == null) {
    push(t("cmd.ws.cancelled"));
    return;
  }
  const chosen = workspaces.find((workspace) => workspace.id === choice);
  // 选中值就是上面那几条的 `value`：取不到只可能是覆盖层回了一个别的 id
  if (!chosen) return;
  await enterWorkspaceBy({ session, workspaceHost, push, logger }, chosen);
};

/**
 * `/pin [on|off]` —— 置顶 / 取消置顶**当前这段会话**（`session.pin`）。
 *
 * 顺序不在这里算：列表怎么排（置顶优先 + 创建时间倒序）是宿主 `session.list` 的事，
 * 这一条只写 `pinned` 一个字段；上屏那句话用的是**宿主回来的**那一行上的 `pinned`，不是我们
 * 自己打算写的那个值 —— 两个值不一样时，屏幕上该相信的是库里的。
 *
 * 不带参数时得先知道现状才能「反着来」：现状从 `session.open` 里读（那一条同时给出会话行、
 * Agent、消息与排队区，读的是宿主此刻的事实）。写了 `on` / `off` 就只跑一个往返。
 */
const cmdPin: CommandHandler = async ({ session, api, push, args }) => {
  const raw = args[0]?.toLowerCase();
  if (raw !== undefined && raw !== "on" && raw !== "off") {
    push(t("cmd.pin.unknown", { value: raw }), "error");
    return;
  }
  let pinned = raw === "on";
  if (raw === undefined) {
    // 现状只有宿主知道，读了才谈得上「反着来」
    const current = await api.session.open.query({ sessionId: session.sessionId });
    pinned = !current.session.pinned;
  }
  // 回执是**改完之后**的那一行：名字与置顶都用它
  const { session: updated } = await api.session.pin.mutate({
    sessionId: session.sessionId,
    pinned,
  });
  push(t(updated.pinned ? "cmd.pin.done" : "cmd.pin.undone", { name: updated.name }));
};

/**
 * `/back`（别名 `/revert`）—— 撤回到某条用户消息**之前**（`session.revert`）。
 *
 * 撤哪一条按**消息 id** 认：消息列表在撤回那一刻可能已经变了（另一台设备插了一条），
 * 数下标会撤错。撤完宿主把内容回填给输入框（`restoredInput`），这里把它交给重挂载 ——
 * 消息变短了，转录的显示起点必须跟着归零，否则 `slice(transcriptFrom)` 恒为空、屏幕一片空白。
 *
 * 两件事实要带到新屏上去（`exit.notice`）：**删掉了几条**、**那句话已经回到输入框**。
 * 旧实现只有「删完重挂载」——用户看到的只是消息忽然变短，删了几条、话去哪儿了都靠猜。
 * 条数是撤前撤后两次长度之差（不是数选中的那条后面有几条：宿主删的是哪一段，得它删完才算数）。
 */
const cmdBack: CommandHandler = async ({ session, push, rows, exit, pick }) => {
  const users = session.messages.filter((message) => message.role === AgentNS.Role.User);
  if (users.length === 0) {
    push(t("cmd.back.empty"), "error");
    return;
  }
  // 最近的在最前；仅展示最近的有限条，避免覆盖层高于终端
  const allItems: SelectItem<string>[] = users
    .map((message) => ({
      label: truncate(textOf(message.content), 60) || message.id,
      value: message.id,
    }))
    .reverse();
  const maxItems = Math.max(1, rows);
  const title =
    allItems.length > maxItems ? t("cmd.back.tooMany", { n: maxItems }) : t("cmd.back.title");
  const choice = await pick(title, allItems.slice(0, maxItems));
  if (choice == null) {
    push(t("cmd.back.cancelled"));
    return;
  }
  // 撤前撤后两次长度之差：宿主删掉的是哪一段（含选中那条它自己），得它删完才算数
  const before = session.messages.length;
  const restored: MessageInput = await session.rewind(choice);
  const removed = before - session.messages.length;
  exit({
    restart: true,
    sessionId: session.sessionId,
    messages: session.messages,
    initialInput: textOf(restored.content),
    // 带图的那条：Asset 跟着回填一起交回输入框（顺序即原消息里的，去不去重由会话层说了算）
    initialAssetIds: restored.assetIds ?? [],
    // 旧屏的通知栏跟着卸载了：这两件事实只能带到新屏上说（见 `CommandExitValue.notice`）
    notice: t("cmd.back.done", { n: removed }),
  });
};

/**
 * `/rename`（别名 `/save`）—— 给这一段起一个自己认得出的名字（`session.rename`，PRD 1.5）。
 *
 * 名字是会话行上的独立一格：id 不动，别人手里的引用不用改，侧栏按它显示。改完之后它就不再
 * 被自动起名覆盖（宿主把 `nameIsAuto` 翻成 false）。
 *
 * 不给名字就把现在的名字说出来 —— 终端没有行内输入框，改名要一个字，走参数是唯一的路
 * （要写长文本是 `/editor` 那一类事，不是一个名字）。
 */
const cmdRename: CommandHandler = async ({ session, args, push }) => {
  const name = args.join(" ").trim();
  if (!name) {
    push(t("cmd.rename.usage", { name: session.name }));
    return;
  }
  await session.rename(name);
  push(t("cmd.rename.done", { name }));
};

/** `/editor` —— 用本机编辑器写长消息（PRD F-C11：本机能力，换台设备本就该不同） */
const cmdEditor: CommandHandler = async ({ push, suspendTerminal, setInputText }) => {
  const file = join(tmpdir(), `aizen-input-${Date.now()}.md`);
  try {
    await writeFile(file, "", "utf-8");
    await suspendTerminal(() => openInSystemEditor(systemEditorCommand(), file));
    const text = (await readFile(file, "utf-8")).trim();
    if (text) setInputText(text);
  } catch (error: unknown) {
    push(t("cmd.editor.failed", { error: messageOf(error) }), "error");
  } finally {
    try {
      await unlink(file);
    } catch {
      /* 忽略 */
    }
  }
};

/**
 * `/clear` —— **只清屏**（PRD F-C9）：把转录的显示起点推到最新，上下文一个字不动。
 *
 * 排队区不归它管。从前这一条同时做两件（清屏 + 清 inbox），于是两件事在屏幕上分不开，也没法
 * 只要其中一件；现在队列那半归 `/free`（`agent.clearInbox`），一条命令一件事。
 */
const cmdClear: CommandHandler = async ({ clearTranscript }) => {
  clearTranscript();
};

/**
 * `/free` —— 清空排队区（`agent.clearInbox`）：跑中排着的话、交接期间别人投进来的话。
 *
 * 清了 N 条就说一句「清掉 N 条」；**0 条什么都不说** —— 本来就没排队，这一下没有可报的事实
 * （口碑从前 `/clear` 那半搬过来）。失败不在本函数里 `catch`：它没有「另一半已经生效」要护，
 * 交给 `runCommand` 那个唯一出口说清是哪条命令、宿主原话是什么。
 */
const cmdFree: CommandHandler = async ({ session, push }) => {
  const cleared = await session.clearInbox();
  if (cleared > 0) push(t("cmd.free.inboxCleared", { n: cleared }));
};

const cmdConfig: CommandHandler = async ({ openWizard }) => {
  await openWizard({ kind: "menu" });
};

/**
 * `/model` 能改的三个作用级别 —— 与模型的三级解析一一对应：
 * 会话行（`session.updateModel`）> AgentDefinition（`agentDefinition.update` 的 `modelId`）> 全局兜底
 * （`config.defaults.update` 的 `defaultModel`）。
 */
export type ModelScope = "session" | "agent" | "global";

/** `/model` 解析出来的动作：改哪一档 + 改成什么（没给 id = 弹选择器） */
export interface ModelSelection {
  scope: ModelScope;
  /** 直切的模型 id；`undefined` = 弹选择器 */
  modelId: string | undefined;
}

/** 作用级别参数（只有这三种写法，大小写不敏感） */
const MODEL_SCOPE_FLAGS: Record<string, ModelScope> = {
  "-a": "agent",
  "--agent": "agent",
  "-g": "global",
  "--global": "global",
};

/**
 * 解析 `/model` 的参数。
 *
 * ```text
 * /model                 → 会话级选择器
 * /model <id>            → 会话级直切（**这一段**用它）
 * /model -a|--agent <id> → AgentDefinition（`agentDefinition.update`，影响以后的会话）
 * /model -g|--global <id>→ 全局兜底（`config.defaults.defaultModel`）
 * /model -a|-g           → 对应档位的选择器（三档共用同一个选择器）
 * ```
 *
 * 为什么缺省落到**会话级**：`/model` 最常表达的是「这次换个模型」。写进 AgentDefinition 会连带改掉
 * 所有用这个 AgentDefinition 的会话（另一个终端里正聊着的会话会莫名换模型），代价远大于收益 ——
 * 要改定义就显式说 `-a`。
 */
function parseModelSelection(args: readonly string[]): ModelSelection {
  const flag = args[0]?.toLowerCase();
  const scope = flag ? MODEL_SCOPE_FLAGS[flag] : undefined;
  // 首个 token 不是作用级别参数 → 它就是模型 id（`/model <id>`），落在会话级
  if (!scope) return { scope: "session", modelId: args[0] };
  return { scope, modelId: args[1] };
}

/**
 * 模型现在**来自哪一档**：只有两句事实 —— 「这一段选的」与「跟随 AgentDefinition」。
 *
 * 这一刀（口径⑤）收窄了它：新契约的会话行上只有 `modelId` 一个字段，AgentDefinition 那条路是
 * `agentDefinition.get`（下一刀搬），而「全局兜底」那一档在会话可见的事实里根本读不出来 ——
 * 所以说「这一段选的 / 跟随 AgentDefinition」两句，比原先那句「解析来源」更诚实。
 *
 * `ChatSessionLike.model.source` 就是那两格（`session/types.ts` 的 `ModelState`）。
 */
function modelSourceOf(ctx: Pick<CommandContext, "session">): ModelScope {
  return ctx.session.model.source === "session" ? "session" : "agent";
}

/**
 * 忙时改「这一段」的模型 / 思考档位之前的**那一次确认**（PRD 4.7 表格的「确认」那一列）。
 *
 * ## 这一问不改结论
 *
 * 判词是「**只允许空闲时候换**」（`PLAN.md` §5.5）：宿主的 `session.updateModel` /
 * `session.setThinking` 开头就是 `assertNoWorkInHand`，手上有活就回 `busy`（`reason: "working"`），
 * **一个字节都不写库**；忙时打标记、变闲再兑现那一套宿主里没有。客户端这边能做、也只能做的是
 * 把这件事**发请求之前**说清 —— 让用户自己决定要不要现在试，而不是等他扑上一条
 * 「切换模型失败：…」才明白为什么（那正是这条命令以前的表现）。
 *
 * 选「现在试」就照旧发：宿主照旧拒，`catch` 里把它的原话如实报上去 —— **绝不假装成功**，也
 * 不绕开它的拒绝（客户端自己写库 / 先杀掉 agent 再换，都是拿运气换那一句「已切换」）。
 *
 * ## 为什么只在会话级问
 *
 * 会被拒的只有写会话行那两扇门。写 AgentDefinition（`agentDefinition.update`）与全局兜底不会被拒：它们的生效路是 `host.reload` 的「刷 Scope + invalidate」，忙着的那段由宿主在
 * 它变闲之后才换掉 agent（`app.ts` 的 `refreshScopesFor`）—— 手里那批不会被抽掉，也没人会拒。
 * 拿「这次请求会被拒」去吓那里的人一遍，就是纯误报。
 *
 * @returns `false` = 用户选了「等它闲下来」，调用方就此打住
 */
async function allowBusySwitch(ctx: Pick<CommandContext, "session" | "pick">): Promise<boolean> {
  // `null` = 读数还没回来：不知道忙不忙就照着不忙走（不拿「还没读到」当「在忙」吓人一跳）
  if (ctx.session.status !== "working") return true;
  const choice = await ctx.pick(t("cmd.busySwitch.title"), [
    { label: t("cmd.busySwitch.confirm"), value: "yes" },
    { label: t("cmd.busySwitch.cancel"), value: "no" },
  ]);
  return choice === "yes";
}

const cmdModel: CommandHandler = async ({ session, api, push, args, pick }) => {
  // 模型表就是配置里的那一格（新契约没有单独的 `model.list`：`config.get` 一次给全）
  const { config } = await api.config.get.query();
  const models = config.models;
  if (models.length === 0) {
    push(t("cmd.model.noModels"), "error");
    return;
  }

  const selection = parseModelSelection(args);
  const scopeName = t(`cmd.model.scope.${selection.scope}`);
  let chosen = selection.modelId;
  if (chosen !== undefined && !models.some((model) => model.id === chosen)) {
    push(
      t("cmd.model.unknown", { id: chosen, options: models.map((model) => model.id).join(" / ") }),
      "error",
    );
    return;
  }
  if (chosen === undefined) {
    // 只有要弹选择器时才多读一次「生效的是哪一档」：那一个数只用在标题上
    const level = t(`cmd.model.scope.${modelSourceOf({ session })}`);

    // 两级：先选供应商（端点），再选那一家底下的模型。
    // 为什么不是平铺：一家订阅式端点就能带进来三四十个模型，平铺之后既难找也看不出「这是哪家的」。
    const current = models.find((model) => model.id === session.modelId);
    const byEndpoint = new Map<string, typeof models>();
    for (const model of models) {
      const bucket = byEndpoint.get(model.endpointId);
      if (bucket === undefined) byEndpoint.set(model.endpointId, [model]);
      else bucket.push(model);
    }
    // 端点顺序按配置里的端点表（用户在 /config 里排的顺序就是他期望的顺序）；
    // 只出现在模型表里的端点（配置被手改过）接在后面，不吞掉
    const endpointIds = [
      ...config.endpoints.map((endpoint) => endpoint.id).filter((id) => byEndpoint.has(id)),
      ...[...byEndpoint.keys()].filter((id) => !config.endpoints.some((e) => e.id === id)),
    ];
    const endpointName = new Map(config.endpoints.map((endpoint) => [endpoint.id, endpoint.name]));

    const endpointItems: SelectItem<string>[] = endpointIds.map((id) => ({
      label:
        id === current?.endpointId
          ? `${endpointName.get(id) ?? id}${t("common.current")}`
          : (endpointName.get(id) ?? id),
      value: id,
      hint: t("cmd.model.endpointHint", { count: byEndpoint.get(id)?.length ?? 0 }),
    }));
    const pickedEndpoint = await pick(
      t("cmd.model.endpointTitle", { scope: scopeName, level }),
      endpointItems,
    );
    if (pickedEndpoint == null) {
      push(t("cmd.model.cancelled"));
      return;
    }

    // 第二级：这一家底下的模型，标题带上端点名（进到里面也得知道自己在哪一家）
    const items: SelectItem<string>[] = (byEndpoint.get(pickedEndpoint) ?? []).map((model) => ({
      label: model.id === session.modelId ? `${model.name}${t("common.current")}` : model.name,
      value: model.id,
      // 恒列出全部模型：新契约里没有 `available` 这一格（能不能跑要解析端点密钥，那是宿主的判断），
      // 所以提示就是它的 id，不编一条「不可用」
      hint: model.id,
    }));
    const picked = await pick(
      t("cmd.model.title", {
        scope: scopeName,
        level,
        endpoint: endpointName.get(pickedEndpoint) ?? pickedEndpoint,
      }),
      items,
    );
    if (picked == null) {
      push(t("cmd.model.cancelled"));
      return;
    }
    chosen = picked;
  }

  /**
   * 这一档现在是什么（只用于「已经是它了」的短路）。三档各读各的事实：
   *   - 会话级：会话行上的生效模型 —— 用户看到的就是它；
   *   - AgentDefinition：定义上的 `modelId`（多一次往返，值得：`/model -a` 是低频命令，而拿生效
   *     模型去比会把「定义已经是它、只是本会话覆盖了别的」误报成「已切换」）；
   *   - 全局兜底：`config.defaultModel`（`config.get` 已经读回来了，不再多发一趟）。
   */
  const currentOfScope = async (): Promise<string | null | undefined> => {
    if (selection.scope === "session") return session.modelId;
    if (selection.scope === "global") return config.defaultModel;
    const { definition } = await api.config.agents.get.query({ agentId: session.agentId });
    return definition.modelId;
  };
  if (chosen === (await currentOfScope())) {
    // 提示里报的是**模型现在真正来自哪一档**（不是「你本来想改哪一档」）：会话级短路时
    // 这个模型往往来自下一档（如定义上就是这个），说成「已经是会话级模型」就是在撒谎。
    const alreadyScope =
      selection.scope === "session"
        ? t(`cmd.model.scope.${modelSourceOf({ session })}`)
        : scopeName;
    push(t("cmd.model.already", { scope: alreadyScope, id: chosen }));
    return;
  }

  const target = models.find((model) => model.id === chosen)!;
  // 会话级那一扇门忙的时候会被宿主拒（`assertNoWorkInHand`）：发之前先问一次（见 `allowBusySwitch`）
  if (selection.scope === "session" && !(await allowBusySwitch({ session, pick }))) {
    push(t("cmd.busySwitch.cancelled"));
    return;
  }
  try {
    // 三条写路径各写各的那一档，参数与校验都在宿主：
    //   session → 会话行（只影响这一段，顺带把思考档清回「跟随 AgentDefinition 默认」）
    //   agent   → AgentDefinition（影响所有用它的会话，顺带清掉定义上的思考参数）
    //   global  → `config.defaultModel`（只在 AgentDefinition 没绑模型时兜底）
    if (selection.scope === "session") {
      await session.updateModel(chosen);
      push(t("cmd.model.done", { scope: scopeName, name: target.name, id: chosen }));
      return;
    }
    if (selection.scope === "agent") {
      await api.config.agents.update.mutate({
        agentId: session.agentId,
        change: { modelId: chosen },
      });
      // 定义变了要按新定义把这段会话重建一次：写定义只动文件，不动活着的会话，
      // 而状态栏上的模型 / 思考参数都还是旧的那份
      await session.reload();
      push(
        t("modelSwitch.summary", {
          name: target.name,
          id: chosen,
          agent: session.agentId,
          hint: t("modelSwitch.resetHint"),
        }),
      );
      return;
    }
    await api.config.defaults.update.mutate({ defaultModel: chosen });
    await session.reload();
    push(t("cmd.model.done", { scope: scopeName, name: target.name, id: chosen }));
  } catch (error: unknown) {
    push(t("cmd.model.failed", { error: messageOf(error) }), "error");
  }
};

/**
 * `/think` 的两个作用级别：会话行（`session.updateThinkingLevel`）与 AgentDefinition
 * （`agentDefinition.update` 的 `modelParams`）。
 */
type ThinkScope = "session" | "agent";

/**
 * AgentDefinition 级「清掉 AgentDefinition 上的思考参数」那一项的哨兵值。
 *
 * 选择器的 `value` 是 `string`，而「清掉」在协议里是 `level: null` —— 契约里没有一个叫
 * 「清掉」的档位名，所以这一项要用一个不可能与档位名相撞的值来标记（同 `HANDOFF_SKIP` 的
 * 做法：哨兵值由命令层自己解释，不塞进协议类型里）。档位名来自宿主那侧的策略表，
 * 双下划线包起来的这种形状不会出现在表里。
 */
const THINK_CLEAR = "__clear__";

/**
 * `/think [level]` / `/think -a|--agent [level]` —— 改思考强度。
 *
 * 两档的「现状」来源不同：
 *   · 会话级 = 会话层的派生视图 `session.thinking`（会话行上的档位名 + 生效模型的档位表）；
 *   · AgentDefinition 级 = 定义上的 `modelParams` **拿档位表反查**（`reasoningEffort.agentThinkingOf`）——
 *     定义里存的是展开后的参数，不是档位名。
 * 两档都是同一个形状（`ThinkingState`），这一层只认 `levels` / `selected` / `source` 三个字段。
 *
 * ## 两档各有一个「这一层不再写档位」
 *
 * 意思一样（这一层没有覆盖了），写法与后果不同，所以是两个动作、两句文案：
 *   · 会话级 = `session.updateThinkingLevel(null)`：会话行上那个档位名清空，这一段回到**跟随 AgentDefinition**
 *     上那份参数（PRD 4.7「有上游默认、会话可覆盖」）；
 *   · AgentDefinition 级 = `agentDefinition.update({ change: { modelParams } })`：把定义上属于思考策略的那些
 *     参数**剔掉**（`modelParamsWithLevel` 给的是剔干净的那一份），
 *     以后的会话、这一段重建之后的 agent 都回到模型的默认参数。
 * AgentDefinition 级没有「再上一层」可跟，所以它不叫「跟随」而直说「清掉」。
 *
 * ## 标题必须说清作用级别
 *
 * 两档用**同一个选择器**，InboxEntry 也几乎一样（都是一串档位 + 一条「不再写这一层」）—— 标题于是成了
 * 唯一说得出「改的是哪一层」的地方。不说的后果：`/think` 与 `/think -a` 弹出来一模一样，用户
 * 选完才发现改的是 AgentDefinition（影响以后所有新会话），而不是这一段（PRD 4.7：思考深度有上游默认、
 * 会话可覆盖）。`/model` 一直是这么办的，这里补齐。
 */
const cmdThink: CommandHandler = async ({ session, api, push, args, pick, setEffortView }) => {
  const flag = args[0]?.toLowerCase();
  const scope: ThinkScope = flag === "-a" || flag === "--agent" ? "agent" : "session";
  const direct = scope === "agent" ? args[1] : args[0];

  /**
   * AgentDefinition 级要的两样事实：定义本身（`agentDefinition.get`）与档位表（`config.get` 的 `presets`）。
   *
   * 定义上存的是**展开后的参数**（`modelParams`），所以「现在是哪一档」只能拿表反查
   * （`reasoningEffort.agentThinkingOf`）。会话级不用这两趟：会话行上的档位由宿主展开，
   * 会话层的派生视图已经拼好了（`session.thinking`）。
   */
  const snapshot = scope === "agent" ? await api.config.get.query() : null;
  const definition =
    scope === "agent"
      ? toDefinition((await api.config.agents.get.query({ agentId: session.agentId })).definition)
      : null;
  const thinking =
    snapshot && definition
      ? agentThinkingOf(definition, snapshot.config, snapshot.presets)
      : session.thinking;
  // 生效模型的 id：`null` = 这一段现在指不到模型（宿主这一版会把「没有可用模型」的会话留在
  // 这一格上），那时如实说「没有模型」，不编一个 id 出来
  const modelId =
    definition && snapshot
      ? (definition.modelId ?? snapshot.config.defaultModel ?? session.modelId)
      : session.modelId;
  const modelLabel = modelId ?? t("status.noModel");

  if (!isAdjustable(thinking)) {
    push(t("cmd.think.notAdjustable", { id: modelLabel }), "error");
    return;
  }
  // `default`（跟随 AgentDefinition）只有会话行上有意义：AgentDefinition 本身就是默认，它没有「再上一层」
  const unknownLevel =
    direct !== undefined &&
    !thinking.levels.includes(direct) &&
    !(scope === "session" && direct === "default");
  if (unknownLevel) {
    push(t("cmd.think.unknown", { level: direct, options: thinking.levels.join(" / ") }), "error");
    return;
  }

  // 「当前」= 这一层真正写着的那一档；`following_default` 时没有任何一档被选中
  const current = thinking.source === "manual" ? thinking.selected : null;
  // 「清掉 / 跟随默认」那一项现在的状态（有它才好在标签上标「当前」、也才好判「没变」）：
  //   · 会话级看这段会话自己选没选 —— `custom` 是手写在**AgentDefinition**上的，会话行仍然空着，
  //     所以那时这一段本来就已经是「跟随」；
  //   · AgentDefinition 级看定义上还带不带思考参数 —— `custom` 正是「带着却凑不成任何一档」，
  //     那时「清掉」是一次真改动（`current` 却是 `null`，不能拿它比）。
  const cleared = scope === "session" ? current === null : thinking.source === "following_default";
  let answer = direct;
  if (answer === undefined) {
    const items: SelectItem<string>[] = [
      {
        // 同一个标签「跟随模型默认」：会话级是「回到 AgentDefinition 上那份」，AgentDefinition 级是「定义上不再
        // 写思考参数」。两句话说的是这件事在这一层各自的意思，所以 hint 分开写。
        label: `${t("cmd.think.followDefault")}${cleared ? t("common.current") : ""}`,
        value: scope === "session" ? "default" : THINK_CLEAR,
        hint: scope === "session" ? t("cmd.think.clearHintSession") : t("cmd.think.clearHintAgent"),
      },
      ...thinking.levels.map((value) => ({
        label: `${effortLabel(value)}${value === current ? t("common.current") : ""}`,
        value,
        hint: value,
      })),
    ];
    const levelText = thinkingView(thinking).text;
    // 作用级别印在标题上：会话级是「这一段」，AgentDefinition 级是「这个 AgentDefinition（影响以后新开的会话）」
    const title =
      scope === "agent"
        ? t("cmd.think.titleAgent", { level: levelText })
        : t("cmd.think.titleSession", { level: levelText });
    const picked = await pick(title, items);
    if (picked == null) {
      push(t("cmd.think.cancelled"));
      return;
    }
    answer = picked;
  }

  // `default`（会话级回到跟随）与哨兵值（AgentDefinition 级清掉定义上的参数）都落到 `null`：两者在协议里
  // 就是同一个「这一层不要档位了」
  const next = answer === "default" || answer === THINK_CLEAR ? null : answer;
  // 「清掉」那一档不能跟 `current` 比：`custom` 时 `current` 也是 `null`，可定义上确实带着参数
  if (next === null ? cleared : current === next) {
    push(t("cmd.think.unchanged"));
    return;
  }

  // 会话那一格忙时会被宿主拒（`assertNoWorkInHand`）：发之前先问一次（见 `allowBusySwitch`）
  if (scope === "session" && !(await allowBusySwitch({ session, pick }))) {
    push(t("cmd.busySwitch.cancelled"));
    return;
  }

  try {
    if (scope === "session") {
      await session.updateThinkingLevel(next);
      // 状态栏先跟上：`session.setThinking` 回来的那份就是新的现状
      setEffortView(thinkingView(session.thinking));
      push(t("effort.summarySession", { label: effortLabelText(next), model: modelLabel }));
      return;
    }
    // AgentDefinition 级：写定义 —— 档位展开成参数写进 `AgentDefinition.modelParams`，`null` 是把思考那几个
    // 键剔掉（与思考无关的参数比如 temperature 原样留着，见 `modelParamsWithLevel`）。写完这段
    // 会话要按新定义重建一次，状态栏与下一次请求的参数才是新的。
    const updated = (
      await api.config.agents.update.mutate({
        agentId: session.agentId,
        change: {
          modelParams: modelParamsWithLevel(
            definition?.modelParams,
            snapshot!.presets,
            presetOf(snapshot!.presets, thinking.preset),
            next,
          ),
        },
      })
    ).definition;
    setEffortView(
      thinkingView(agentThinkingOf(toDefinition(updated), snapshot!.config, snapshot!.presets)),
    );
    await session.reload();
    push(
      t("effort.summary", { label: effortLabelText(next), id: session.agentId, model: modelLabel }),
    );
  } catch (error: unknown) {
    push(t("cmd.think.failed", { error: messageOf(error) }), "error");
  }
};

/**
 * `/agent` —— 选「以后的会话用哪个 AgentDefinition」。
 *
 * AgentDefinition 在会话创建时定死（PRD L7：契约里没有 `session.setAgent`），所以这一条写的只能是
 * 默认 AgentDefinition（`config.defaults.update` 的 `defaultAgent`）。
 *
 * 「这个 AgentDefinition 现在能不能用」这一格**没有**了：旧契约的 `AgentView.available` /
 * `unavailableReason` 随那一组形状一起退场，新契约回的是定义本身（`AgentDefinition`）。
 * 要判「跑不跑得起来」得解析模型、查端点密钥 —— 那是宿主的判断，客户端算一遍就是第二份会漂的
 * 规则。所以这里只答两件事：这个 AgentDefinition 指着哪个模型、默认 AgentDefinition 现在是谁。
 */
const cmdAgent: CommandHandler = async ({ session, api, push, args, pick }) => {
  const [{ config }, definitions] = await Promise.all([
    api.config.get.query(),
    api.config.agents.list.query(),
  ]);
  const list = agentListOf(definitions, config);
  const choices = listAgentChoices(config, list);
  if (choices.length === 0) {
    push(t("cmd.agent.noAgents"), "error");
    return;
  }

  // 支持 `/agent <id>` 直选，无参时弹选择器（与 /model 同一套做法）
  let chosen = args[0];
  if (chosen !== undefined && !choices.some((choice) => choice.id === chosen)) {
    push(
      t("cmd.agent.unknown", {
        id: chosen,
        options: choices.map((choice) => choice.id).join(" / "),
      }),
      "error",
    );
    return;
  }
  if (chosen === undefined) {
    const items: SelectItem<string>[] = choices.map((choice) => ({
      label: `${choice.name}${choice.id === session.agentId ? t("common.current") : ""}`,
      value: choice.id,
      // 提示给「以后的会话会用哪个模型」（定义上绑的，没绑就是全局兜底那一档）
      hint: choice.modelName,
    }));
    const picked = await pick(t("cmd.agent.title"), items);
    if (picked == null) {
      push(t("cmd.agent.cancelled"));
      return;
    }
    chosen = picked;
  }

  const check = checkAgentSwitch({ config, list, targetAgentId: chosen });
  if (!check.ok) {
    push(
      t("cmd.agent.unavailableReason", { name: check.name, reason: check.reason ?? "" }),
      "error",
    );
    return;
  }

  try {
    // 「默认 AgentDefinition」是配置里的**一个字段**，走 `config.defaults.update` 那条窄方法
    await api.config.defaults.update.mutate({ defaultAgent: chosen });
    if (chosen === session.agentId) {
      push(t("cmd.agent.alreadyOn", { summary: check.summary }));
      return;
    }
    push(check.summary);
  } catch (error: unknown) {
    push(t("cmd.agent.failed", { error: messageOf(error) }), "error");
  }
};

/**
 * `/reload` —— 让宿主重新发现能力（MCP 服务器、工具、skill、subagent），再把这一段手里的事实重取一次。
 *
 * 真的刷新动作在宿主那一侧（`scope.reload`）：Scope 按目录活在宿主进程里，客户端连容器都摸不到。
 * 回执里的数字原样上屏 —— `0/2 刷成了 ` 与 `2/2 刷成了 ` 是两件事，一声「已重新加载」分不开它们。
 */
const cmdReload: CommandHandler = async ({ session, push }) => {
  try {
    const report = await session.reload();
    push(reloadReceipt(report));
  } catch (error: unknown) {
    push(t("cmd.reload.failed", { error: messageOf(error) }), "error");
  }
};

/**
 * 把宿主给的回执说成一句人话：刷了几份、有没有没刷成的。
 *
 * 三句分开写而不是拼接："一份都没有"与"全都刷成了"用同一个句式会读成矛盾（比如 0 份里刷成 0 份），
 * 而没刷成的那几份还得把目录名字列出来 —— 只给一个数字，用户不知道该去看哪个目录。
 */
function reloadReceipt(report: ScopeReloadReport): string {
  if (report.total === 0) return t("cmd.reload.none");
  if (report.failed.length === 0) {
    return t("cmd.reload.done", { total: report.total, refreshed: report.refreshed });
  }
  return t("cmd.reload.doneSome", {
    total: report.total,
    refreshed: report.refreshed,
    failed: report.failed.length,
    cwds: report.failed.map((item) => item.cwd).join("、"),
  });
}

/**
 * `/mcp` —— 打开配置中心里已有的 MCP 屏（增删改 / 启停 / 切作用域都在那一屏）
 *
 * 命令层只负责「进对那一屏」：哪一层是 `user`、哪一层是 `workspace` 由 `mcp.list` 每条自带的
 * `scope` 说了算，编辑本身在屏里按名字一条一条走 `mcp.save` / `mcp.remove`。
 */
const cmdMcp: CommandHandler = async ({ session, push, args, openWizard, api }) => {
  const rawScope = args[0];
  const explicit = parseMcpScope(rawScope);
  if (rawScope && !explicit) {
    push(t("cmd.mcp.unknownScope", { scope: rawScope }), "error");
    return;
  }
  // 默认进哪个作用域要看「哪一层现在有东西」——那是 `mcp.list` 里的事实（每条带 `scope`），
  // 不由客户端猜文件路径。显式给了作用域就不读（省一个往返，也让那份清单只服务它真正要回答的
  // 问题）。
  let scope = explicit;
  if (scope === null) {
    const { servers } = await api.config.mcp.list.query({ workspaceId: session.workspaceId });
    scope = pickStartScope(servers);
  }
  await openWizard({ kind: "mcp", scope });
};

const cmdLang: CommandHandler = async ({ push, args, refreshLocale, api, logger }) => {
  // `/lang` 无参在中文 / 英文之间切；`/lang zh`、`/lang en` 直接指定。
  // 语言是用户的属性、不是连接的属性：宿主那一份挂在宿主应用上、值来自配置，所以这里改的是
  // 配置里的那一格（`config.update`），宿主随后按它渲染自己那侧的句子。客户端自己那一份
  // 管界面文案：`persistLocale` 记本机偏好，`refreshLocale` 让已经画出来的东西立刻换过来。
  const wanted = args[0]?.toLowerCase();
  // 候选集就是 `SUPPORTED_LOCALES`（一处真相）：这句“不认识这个语言”与清单判的是同一份
  // 集合，新增一门语言只改 `i18n` 那一处，不必回来动这里。
  const picked = SUPPORTED_LOCALES.find((locale) => locale === wanted);
  if (wanted && !picked) {
    push(t("cmd.lang.unknown", { lang: wanted }), "error");
    return;
  }
  const target = picked ?? (getLocale() === "zh" ? "en" : "zh");
  // 回执是改完之后的整份配置：本机偏好落的是它回来的那一格，不拿这里打算写的那一格顶上
  const { config } = await api.config.update.mutate({ language: target });
  const applied = normalizeLocale(config.language);
  // 回执里没有语言这一格 = 没有事实可落，界面保持原样（也不说“已切换”）
  if (!applied) return;
  await persistLocale(applied, logger);
  refreshLocale();
  push(t("notice.languageChanged"));
};

/** 宿主包名（查 dist-tag 按它说）。*/
const HOST_PACKAGE = "@ai-zen/agents-host";

/**
 * `/upgrade` —— 客户端那一半：挑好版本，告诉宿主，然后等它回来。
 *
 * ## 三段分工（`trd/host-infrastructure.md`），客户端只管第 ① 段
 *
 * | 段 | 谁 | 干什么 |
 * |---|---|---|
 * | ① 挑版本 | 客户端 | 各 dist-tag 里取 semver 最高 |
 * | ② 验 + 记 + 请重拉 | 宿主 | 两条判据验「这一版拿得到」→ 写 pin → 以升级为理由退出 |
 * | ③ 拉起 | 启动方式 | 读 pin，`npx -y <pkg>@<pin> serve` |
 *
 * 所以这条命令只剩五步：
 *
 * | 步 | 干什么 | 去哪要事实 |
 * |---|---|---|
 * | ① 查 | `npm view <pkg> dist-tags --json --prefer-online` | registry |
 * | ② 挑 | 全部 tag 里 semver 最高的（`pickNewest`）—— 只认 `latest` 会漏掉「alpha 比正式版新」 | registry |
 * | ③ 判 | 不比**正在跑的**那一版新就停：不告诉、不重启 | `host.version` |
 * | ④ 确认 | 两档确认（是 / 否），把目标版本、宿主做哪一半、会踢掉谁一次说清 | 这一步之前问到的事实 |
 * | ⑤ 交 | `host.upgrade.mutate({ version })` → 回来 `restarting` 之后回连接屏 | 宿主 |
 *
 * ## 确认为什么落在交之前（PRD 3.8「逐步骤显示进度；装完确认再重启」）
 *
 * 上一版（客户端自己预下 `npx -y <pkg>@<版本> version`）看得见「装完」那一刻，确认就摆在那之后。
 * 现在装包与拉起都归启动方式（上表第 ③ 段，客户端看不见那一刻），所以确认只能落在调
 * `host.upgrade` 之前，而且只许问此刻真知道的事 —— 那一句要说清三件：
 *
 *   ① 目标是哪一版（与正在跑的哪一版对比）；
 *   ② 宿主会先验这一版拿得到再退出，装包与拉起由启动方式做；
 *   ③ **这一台机器上连着的其他客户端也会断开** —— 一台机器一个宿主，它退出等于把它们全踢了
 *      （与 `/shutdown` 同一个事实，同一个确认形状）。
 *
 * 进度那几句不另造一套词：第 ① 步复用 `host-stage.ts` 的 `STAGE_TEXT`（与拉起宿主那块下载屏
 * 同一批文案）。选了「否」就一个方法都不调、什么都不写，只说一句「没有升级」。
 *
 * ## 为什么客户端不再预下、不再记版本
 *
 * 从前那套（`npx -y <pkg>@<版本> version` 预下 → 记 `<数据根>/cli/host-version.json` →
 * `host.shutdown`）是客户端在替宿主做第 ② 段：它验的是「本机 npx 缓存里有没有这一版」，
 * 而 pin 与退出信号分在两处（`host-version.json` 与一次普通关闭），正常关闭之后启动方式会
 * 照着老 pin 把服务又拉起来。现在 pin 归宿主（`<数据根>/run/next-version.json`），读 pin 是
 * 启动方式的事（连接层下一波补）；客户端连试运行都不做了 —— 「这一版拿得到吗」由宿主那两条
 * 判据当场答（`not_available` 就是拿不到），客户端自己预下一遍只是把同一个问题问两次。
 *
 * ## 宿主不在了，所以不傻等
 *
 * 回执是 `{ version, restarting: true }`：那之后宿主自己收尾、以升级专用的退出码退出，由启动
 * 方式按 pin 重新拉起。这条连接一定会断，留在这一屏只会看到一串重连失败 —— 于是回连接屏，
 * 并说清「宿主正在按新版本重拉」（与 `/shutdown` 同一个出口）。
 *
 * ## 拿不到就报错，不兜底
 *
 * 查不到 registry、宿主回 `not_available`（这一版 registry 上没有），都是「把原话说上去，然后
 * 停」：不重试，也不退回构建时的范围假装成功 —— 那会让用户以为升了，实际跑的还是旧代码。
 * 宿主拒绝时它**还在跑**（它把「这一版不存在」挡在了弄死服务之前），所以这一屏照旧连着，
 * 不回连接屏。
 */
const cmdUpgrade: CommandHandler = async ({ api, push, exit, runNpm, pick }) => {
  const npm = runNpm ?? defaultRunNpm;

  // ① 查 + ② 挑：registry 上的全部标签，挑 semver 最大的那个（alpha 新就选 alpha）
  push(t(STAGE_TEXT.resolving));
  const tags = await readDistTags(npm, HOST_PACKAGE);
  const target = tags === undefined ? undefined : pickNewest(Object.values(tags));
  if (target === undefined) {
    // 查不到 / 一个 tag 都解析不出来都是「不知道最高的是哪一版」，没有可拿去问宿主的目标
    push(t("cmd.upgrade.tagsFailed", { pkg: HOST_PACKAGE }), "error");
    return;
  }

  // ③ 判：跟**正在跑的**那一版比。`host.version` 是宿主自己报的运行版本 —— 不拿 `CLI_VERSION`
  // 代替：客户端与宿主各升各的，CLI 是 0.2.0 而宿主还在 0.1.0 是常态（它由启动方式按 pin 拉起）
  const current = (await api.host.version.query()).version;
  const order = compareVersions(target, current);
  if (order !== null && order <= 0) {
    // 不比当前新就不告诉宿主：本地跑的开发版（或超前于 registry 的构建）不能被「升级」降级
    push(t("cmd.upgrade.newest", { version: current }));
    return;
  }
  push(t("cmd.upgrade.found", { current, target }));

  // ④ 确认：两档，与 `/shutdown` 同一个交互形状。标题把三件事一次说清（见文件上方「确认为什么
  // 落在交之前」）：目标是哪一版、宿主做哪一半、会踢掉谁。装包与拉起那半句用的是
  // `host-stage.ts` 那批阶段文案（`STAGE_TEXT`），不在这里另造一套进度词。
  const choice = await pick(
    t("cmd.upgrade.confirmTitle", {
      current,
      target,
      installing: t(STAGE_TEXT.installing),
      starting: t(STAGE_TEXT.starting),
    }),
    [
      { label: t("cmd.upgrade.confirm"), value: "yes" },
      { label: t("cmd.upgrade.cancel"), value: "no" },
    ],
  );
  // 选了「否」（Esc / 覆盖层被关掉也是这一支）：一个方法都不调，宿主一点都不知道
  if (choice !== "yes") {
    push(t("cmd.upgrade.cancelled", { current }));
    return;
  }

  // ⑤ 交：宿主验「这一版拿得到」、写 pin、然后以升级为理由退出 —— 这一步可能要去问 registry，
  // 所以先把「在等它什么」说清
  push(t("cmd.upgrade.handoff", { version: target }));
  let accepted: { version: string };
  try {
    accepted = await api.host.upgrade.mutate({ version: target });
  } catch (error: unknown) {
    // 宿主说这一版拿不到就报它的原话，不自己编一句取代它；它没重启，服务还在跑
    push(t("cmd.upgrade.rejected", { version: target, error: messageOf(error), current }), "error");
    return;
  }
  // 回执里的版本就是它写下 pin 的那一版（不是我们递进去的那个字符串）：句子用它的
  exit({ backToConnect: t("cmd.upgrade.backToConnect", { version: accepted.version }) });
};

const cmdKey: CommandHandler = async ({ openKeyEditor }) => {
  await openKeyEditor();
};

/**
 * `/handoff` —— 只写一份交接文档：不换记忆、不建存档会话、不换 Agent。
 *
 * `/migrate` —— 写文档并立刻换手：记忆换成新的一份，旧记忆成为一段已存档会话。
 *
 * 两条命令走的是同一条 `handoff.start`，靠入参 `kind` 分档（`document` / `swap`）：命令名字是
 * 两个动作、两个后果，混成一档它们就是同一条命令的两个名字。
 *
 * ## 谁去写：`/handoff` 问一次，`/migrate` 不问
 *
 * 旧版（`cli@1.0.2` 的 `auto-migrate-confirm.ts`）两条命令都先问「自交接 / 独立摘要 / 跳过本次」。
 * 这一版把三选一补回到 `/handoff`：执行者是 `handoff.start` 的 `mode`（宿主的可选入参）。
 * `/migrate` 只答应显式写出来的 `mode`，不再多问一遍 —— 换手那一档要的是「现在就把班交出去」，
 * 多一道选择只多一次确认。
 *
 * ## 回执只有「开始了」
 *
 * 交接是要跑一阵的事，而 `handoff.start` 是一个 RPC：它只回「开始了」。文档路径不在回执里
 * —— 它要等写完才有；写到哪、成没成，走宿主的通知，界面不必自己猜。
 *
 * 两条都不换屏、不换会话：换手是原地换记忆，id 不变、侧栏位置不变，旧记忆变成另一段
 * ` 已存档_<原名>` 会话出现在列表里；只写文档那一档连记忆都不动。所以这里既不迁移屏、也不改显示
 * 起点。
 */
const cmdHandoff: CommandHandler = async ({ session, push, args, pick }) => {
  const handoff = parseHandoffSelection(args);
  if (handoff.invalid !== undefined) {
    push(t("cmd.handoff.unknownMode", { who: handoff.invalid }), "error");
    return;
  }
  if (!session.messages.some((message) => message.role === AgentNS.Role.User)) {
    push(t("cmd.handoff.empty"), "error");
    return;
  }
  /*
   * 执行者三选一（旧版 `auto-migrate-confirm.ts` 那一屏，这一版补回）：`self` 这段会话自己写、
   * `summary` 另起一个一次性 Agent 写、`HANDOFF_SKIP` 什么都不做。
   *
   * 显式写了 `/handoff self|summary` 就不再问 —— 选择器只是「没指定时」的那一问。
   *
   * ## 非交互那一路为什么不问
   *
   * `runCommand` 的**唯一**调用方是 TUI 的 `chat.tsx`（`--no-tui` / stdio 那条路只发一句话，
   * 不解析斜杠命令），所以这一屏一定有人在那儿按。真要让 stdio 也能触发 `/handoff`，就让它说
   * `/handoff self` —— 那就是「不问、直接按 `self` 发」的落点：**不替用户挑执行者**，因为
   * `summary` 会另起一个 Agent 去写，那不是「没人可问」能替人决定的事。
   */
  const answer = handoff.mode ?? (await pick(t("cmd.handoff.title"), handoffModeItems()));
  // 跳过本次：一次 procedure 都不调，只说一句
  if (answer === HANDOFF_SKIP) {
    push(t("cmd.handoff.skipped"));
    return;
  }
  const mode = toHandoffMode(answer);
  if (mode === null) {
    // Esc / 覆盖层被关掉：当作取消（宿主那边什么都没发生）
    push(t("cmd.handoff.cancelled"));
    return;
  }
  try {
    // 只写文档那一档：执行者随入参交给宿主，`kind` 说清“不要换手”
    await session.handoff({ kind: "document", mode });
    // 文档路径由宿主那一条通知给（它才知道写到哪），这里只说「开始了」
    push(t("cmd.handoff.started"));
  } catch (error: unknown) {
    // 用户选了「不交接」：不是失败，也不该报错堆栈（宿主没有留下任何东西）
    if (isHandoffDeclined(error)) {
      push(t("cmd.handoff.cancelled"));
      return;
    }
    push(t("cmd.handoff.failed", { error: messageOf(error) }), "error");
  }
};

const cmdMigrate: CommandHandler = async ({ session, push, args }) => {
  const handoff = parseHandoffSelection(args);
  if (handoff.invalid !== undefined) {
    push(t("cmd.handoff.unknownMode", { who: handoff.invalid }), "error");
    return;
  }
  if (!session.messages.some((message) => message.role === AgentNS.Role.User)) {
    push(t("cmd.migrate.empty"), "error");
    return;
  }
  /*
   * 与 `/handoff` 同一条 procedure，但走的是换手那一档，且不问执行者：三选一那一屏只有 `/handoff`
   * 那一处。显式写了 `/migrate self|summary` 就照它发，没写就交给宿主的缺省。
   */
  try {
    // 换手那一档：写完文档，这段会话的记忆换成新的一份、旧记忆成为一段已存档会话
    await session.handoff(
      handoff.mode === undefined ? { kind: "swap" } : { kind: "swap", mode: handoff.mode },
    );
    // 原地换手：会话 id 不变、屏幕不换。旧记忆变成的那一段在列表里按创建时间排着
    push(t("cmd.migrate.started"));
  } catch (error: unknown) {
    if (isHandoffDeclined(error)) {
      push(t("cmd.migrate.cancelled"));
      return;
    }
    push(t("cmd.migrate.failed", { error: messageOf(error) }), "error");
  }
};

/**
 * `/help` —— 命令清单，说明就是命令表里的 `cmd.*.desc`。
 *
 * 句子在客户端的原因：命令是客户端概念，宿主只有方法名，它不知道 `/back` `/pin` 是
 * 什么（更没有"侧栏"这种客户端才有的位置），所以这句说明只能由客户端说。硬让宿主去说，
 * 斜杠菜单与 `/help` 就会各有一套措辞，改一个字还要等宿主发版。一句话只有一个出处：命令表。
 *
 * 顺带的好处：`/help` 不再需要一次网络往返，宿主连不上也能看（它就是"不知道该怎么办"
 * 时最该能用的那条命令）。
 */
const cmdHelp: CommandHandler = async ({ push }) => {
  const lines = [t("cmd.help.title")];
  for (const hint of getCommandHints()) {
    lines.push(`  ${hint.label}  ${hint.description}`);
  }
  push(lines.join("\n"));
};

const cmdExit: CommandHandler = async ({ doExit }) => {
  await doExit();
};

/**
 * `/delete` —— 删掉**当前这一段会话**（`session.delete`，硬删）。
 *
 * ## 为什么必须先把代价摆出来
 *
 * PRD 1.2 把「用户删掉这段会话」列在「能让一段会话死的三条路」里，4.1 要求「删前警告并把代价
 * 说清」：删了就是硬删，消息与 Asset 一起没，那个消息数本来就是「你这段会话攒下来的全部」。
 * 所以先问一次（两档，与 `/shutdown` 同一个交互形状），问的那一句里两个数一个不少：
 *
 *   · 消息条数 = `session.open` 那份快照里 `messages` 的长度；
 *   · Asset 份数 = 那些消息的内容段上带 `__asset_id` 的标记去重计数（`referencedAssetCount`）。
 *
 * 两个数都从**宿主此刻的那一份快照**里数，不从本地镜像猜：另一台终端刚发的那张图也算在
 * 代价里。**不为它新增任何 procedure**：`session.open` 与 `session.delete` 都是现成的。
 *
 * ## 删完不能停在一段已经不存在的会话上
 *
 * 上屏的数字用**回执里的**（宿主删之前数的那一份：`messages` 与跟着删掉的 `assets`），不是
 * 自己算的那一份 —— 两个数可能不一样（Asset 是按引用归零才算删掉的）。
 *
 * 删成功之后先做一件事：把这一段从**本进程的会话登记**里摘掉（`dropSession`，连带它那份订阅
 * 解掉）。不摘的话，后续「切回去」会指向一段已经不存在的东西，而它的订阅也留在那儿白推。
 * **先摘登记、再换屏**：反过来的话，换屏那一刻旧那一段还在被人投事件。
 *
 * 然后必须换到另一段去，否则这一屏就停在一段已经不存在的会话上（下一次发话必然失败）。换到
 * 哪一段、没地方可换时说什么，全在 {@link moveAfterGone} 里（与 `/ws delete`、以及「别处删掉
 * 了这一屏那一段」那条事件共用一套）：这里只说「删掉的是什么」。
 *
 * 这一次删除是**自己叫的**（`expectOwnRemoval`）：宿主在 mutation 里就会推 `session.removed`，
 * 那一下到得比回执早。不报个名的话，注册表会把同一件事再演一遍 —— 屏幕先被惊动一次，紧接着
 * 这里的收尾又来一次，两句话不一样、两次都换屏。
 *
 * 宿主说找不到（`not_found`）时原话上屏、屏幕不换：那一段已经不在了，但这一屏还连得上宿主，
 * 该怎么走由用户决定。
 */
const cmdDelete: CommandHandler = async ({
  session,
  api,
  push,
  pick,
  exit,
  dropSession,
  expectOwnRemoval,
}) => {
  // ① 代价：从 `session.open` 那一份快照里数（两个数都不自己猜）
  const snapshot = await api.session.open.query({ sessionId: session.sessionId });
  const messages = snapshot.messages.length;
  const assets = referencedAssetCount(snapshot.messages);

  // ② 确认：两档（是 / 否），与 `/shutdown` 同一个交互形状；没有 `--force` 之类的旁路
  const choice = await pick(t("cmd.delete.title", { name: session.name, messages, assets }), [
    { label: t("cmd.delete.confirm"), value: "yes" },
    { label: t("cmd.delete.cancel"), value: "no" },
  ]);
  // 选了「否」（Esc / 覆盖层被关掉也是这一支）：一个方法都不调，这一段什么都没变
  if (choice !== "yes") {
    push(t("cmd.delete.cancelled"));
    return;
  }

  // ③ 硬删：上屏的数字用回执里的（宿主删之前数的那一份）。
  // 先报名、**整段收尾做完之后再结账**：这一场里回来的 `session.removed` 全由本命令自己收尾
  const doneOwnRemoval = expectOwnRemoval();
  try {
    let removed: { messages: number; assets: number };
    try {
      removed = await api.session.delete.mutate({ sessionId: session.sessionId });
    } catch (error: unknown) {
      push(t("cmd.delete.failed", { error: messageOf(error) }), "error");
      return;
    }
    const done = t("cmd.delete.done", { messages: removed.messages, assets: removed.assets });

    // ④ 先摘登记（连带解订阅），再换屏：这一段已经不在了，本进程不能再挂着它
    dropSession(session.sessionId);

    // ⑤ 换到同一个项目里最近的那一段；那个项目里没有别的会话就说清用 /new 开一段
    await moveAfterGone(
      { api, notice: push, exit },
      {
        gone: [session.sessionId],
        scope: { workspaceId: session.workspaceId },
        notice: done,
        emptyHint: t("cmd.delete.noOtherSession"),
        // 删掉了就删掉了：没地方可换只是下一句说明，这一屏留着让人自己决定
        whenEmpty: "stay",
      },
    );
  } finally {
    // 删没删成、换没换成，账都要结：删失败时那一段还在，它以后被别处删掉时该照常出声
    doneOwnRemoval();
  }
};

/**
 * `/kill [id|名字]` —— 杀死一段会话的**Agent**（`agent.kill`）。
 *
 * ## 它杀的是什么
 *
 * PRD 1.2「死的路只有三条：用户按杀死、用户删掉这段会话、进程退出」，其中**只有按杀死**会
 * 让用户没注意到的东西（没消费的 InboxEntry）悄悄消失；4.1「中断不是杀死」那张表把这三件事说死了：
 * 杀死之后没有 agent 了、在途请求被掐断、没消费的 InboxEntry 作废（库里也删）、记忆照旧在。
 *
 * 所以杀完**不换屏、不摘登记、不删历史**：那一段会话还在（`session.list` 里还在，打开还能看），
 * 只是这一段现在没有 agent 了 —— 下一次发话会重新叫起来（`session.ts` 的 `send`）。
 *
 * ## 认哪一段
 *
 * 不带参数 = 当前这一段；带参数 = 认 id（前缀也算）或名字。都认不出来就**指路**（`/sessions`
 * 里列着现有的那些），不猜「最近的那一段」：这是个不可撤销的动作，猜错一次就是把别人的会话
 * 收了。前缀或名字对上好几段时也不做第二道判断 —— 把对得上的那几个 id 列出来，让人写长一点。
 *
 * ## 代价先说清
 *
 * 排队区里还有几条没被取走的话会作废（数量从**镜像**的排队区来：本进程挂着的那几段现读
 * `inboxPending`；没挂着的那一段现问一次 `session.open`，那份快照里也带着排队区）。
 * 代价那句同时说清另外两件事：历史与这段会话本身保留；下一次发话会重新叫起来。一次确认
 * （两档，与 `/delete`、`/shutdown` 同一个交互形状）。
 *
 * ## 已经死了的那一段
 *
 * 宿主那边的 `agent.kill` 对没有 Agent 的一段是**空操作**（运行时里没有这一条登记就没有可收的
 * 东西）：队列里那几条一行也不会被作废（作废是内核 `kill()` 报的那条事实带来的）。所以那时
 * 「N 条会作废」就是一句假话 —— 直接说清现状，并指到真正能清排队区的那条命令（`/free`）。
 */
const cmdKill: CommandHandler = async ({ session, api, liveSessions, push, args, pick }) => {
  // ① 认哪一段：不带参数就是当前这一段；带了就认 id（前缀也算）或名字
  const typed = args.join(" ").trim();
  let target: KillCandidate;
  if (typed === "") {
    target = { id: session.sessionId, name: session.name };
  } else {
    const matched = matchSession(await killCandidates({ session, api, liveSessions }), typed);
    if ("problem" in matched) {
      push(matched.problem, "error");
      return;
    }
    target = matched.session;
  }

  // ② 代价：这一段的死活与排队条数（镜像里那两格，现读）
  const facts = await killFacts({ session, api, liveSessions }, target.id);
  if (facts.alive === false) {
    // 早没有 Agent 了：`agent.kill` 是空操作，什么都不会被作废（见本命令的注释）
    push(t("cmd.kill.alreadyDead", { name: target.name }));
    return;
  }

  // ③ 确认：两档（是 / 否），与 `/delete` `/shutdown` 同一个交互形状；没有 `--force` 之类的旁路
  const choice = await pick(t("cmd.kill.title", { name: target.name, pending: facts.pending }), [
    { label: t("cmd.kill.confirm"), value: "yes" },
    { label: t("cmd.kill.cancel"), value: "no" },
  ]);
  // 选了「否」（Esc / 覆盖层被关掉也是这一支）：一个方法都没调，那一段什么都没变
  if (choice !== "yes") {
    push(t("cmd.kill.cancelled"));
    return;
  }

  // ④ 真杀：只有 `agent.kill` 这一条。不换屏、不摘登记、不清历史 —— 杀的不是这一段会话
  try {
    await api.runtime.agent.kill.mutate({ sessionId: target.id });
  } catch (error: unknown) {
    push(t("cmd.kill.failed", { error: messageOf(error) }), "error");
    return;
  }
  push(t("cmd.kill.done", { name: target.name }));
};

/** `/kill` 认人时手边那几格：候选只要 id 与名字，代价只要死活与排队条数 */
type KillCtx = Pick<ChatCommandHost, "session" | "api" | "liveSessions">;

/** 一段会话的 id 与名字（`/kill` 认人只用这两格） */
interface KillCandidate {
  id: string;
  name: string;
}

/**
 * `/kill <id|名字>` 的候选：当前项目的会话 ∪ 本进程挂着的会话。
 *
 * 为什么两边都要：`/sessions --all` 能列到别的项目去，切过来过的那一段就在注册表里，用户想
 * 杀它时手边能敲的就是那个 id。同一段两边都出现时按 id 只留一份。
 */
async function killCandidates(ctx: KillCtx): Promise<KillCandidate[]> {
  const rows = await ctx.api.session.list.query({ workspaceId: ctx.session.workspaceId });
  const found = new Map<string, KillCandidate>(
    rows.map((row) => [row.id, { id: row.id, name: row.name }]),
  );
  for (const live of ctx.liveSessions) {
    if (!found.has(live.sessionId))
      found.set(live.sessionId, { id: live.sessionId, name: live.name });
  }
  return [...found.values()];
}

/**
 * 从候选里认出一段：**id 完全对得上 > id 前缀 > 名字**，各只认唯一的那一个。
 *
 * 对得上好几段时**不猜**（那是拿一个不可撤销的动作赌一把）：把它们那几个短 id 列出来，让人
 * 写长一点。一个都对不上就指路到 `/sessions` —— 那里列着现有的那些。
 */
function matchSession(
  candidates: readonly KillCandidate[],
  typed: string,
): { session: KillCandidate } | { problem: string } {
  const exact = candidates.filter((item) => item.id === typed);
  if (exact.length === 1) return { session: exact[0]! };
  const prefixed = candidates.filter((item) => item.id.startsWith(typed));
  if (prefixed.length === 1) return { session: prefixed[0]! };
  const named = candidates.filter((item) => item.name === typed);
  if (named.length === 1) return { session: named[0]! };

  const many = prefixed.length > 1 ? prefixed : named.length > 1 ? named : null;
  if (many !== null) {
    return {
      problem: t("cmd.kill.ambiguous", {
        arg: typed,
        n: many.length,
        ids: many.map((item) => shortId(item.id)).join(t("common.listSeparator")),
      }),
    };
  }
  return { problem: t("cmd.kill.unknown", { arg: typed }) };
}

/** 这一段此刻的死活与排队条数（`/kill` 的那两句代价都从这两格来） */
interface KillFacts {
  /** `null` = 还没读到（不当成「死」） */
  alive: boolean | null;
  pending: number;
}

/**
 * 代价的两格从**镜像**来，不自己数：
 *
 *   · 当前这一段：直接读会话层（`alive` / `inboxPending` 都是镜像里的现读值）；
 *   · 本进程挂着但不是当前这一段：注册表那一行里也是它的活值；
 *   · 本进程根本没挂着（别的终端开的）：这一边没有订阅，只能现问一次 `session.open` ——
 *     那份快照里的 `live` 与 `inbox` 就是它的死活与排队区，拿到了不存，只用于这一次确认。
 */
async function killFacts(ctx: KillCtx, sessionId: string): Promise<KillFacts> {
  if (sessionId === ctx.session.sessionId) {
    return { alive: ctx.session.alive, pending: ctx.session.inboxPending };
  }
  const live = ctx.liveSessions.find((row) => row.sessionId === sessionId);
  if (live !== undefined) return { alive: live.alive, pending: live.inboxPending };
  const snapshot = await ctx.api.session.open.query({ sessionId });
  return { alive: snapshot.live !== null, pending: snapshot.inbox.length };
}

/**
 * `/shutdown` —— 关掉宿主（`host.shutdown`）。
 *
 * ## 为什么必须问一句
 *
 * 一台机器一个宿主，可能多台客户端共用（桌面端从不 kill 宿主）。所以这一下会踢掉别人的
 * 连接，而按下去的人可能只想着「我这个窗口不用了」—— 确认框上把这件事说清，别让人事后
 * 才发现在另一台终端里聊到一半的会话断了。确认只在客户端做：关哪个宿主由这条连接决定，
 * 宿主不为此再接一个 `confirm` 参数（那只是把同一件事在两处各判一遍）。
 *
 * ## 回执只有一格：受理
 *
 * `host.shutdown` 没有入参，出参是字面量 `{ accepted: true }` —— 答复先写回，之后宿主自己
 * 收尾退出（连接会被断掉）。所以这里没有「没受理」可判，也没有第三种状态：拿到那一格就是
 * 受理了，后面只剩「这一屏没了」这件事。
 *
 * ## 关掉之后 CLI 去哪
 *
 * 那条连接一定会断，傻等重连没有意义（宿主已经不在）。所以这一屏到此为止：把结论交给
 * 上层（`backToConnect`），由它摆回连接屏并说明「宿主已关闭」—— 用户可以重新拉起一台，
 * 也可以改连别处，而不是被直接退出程序。
 */
const cmdShutdown: CommandHandler = async ({ api, push, pick, exit }) => {
  const choice = await pick(t("cmd.shutdown.title"), [
    { label: t("cmd.shutdown.confirm"), value: "yes" },
    { label: t("cmd.shutdown.cancel"), value: "no" },
  ]);
  if (choice !== "yes") {
    push(t("cmd.shutdown.cancelled"));
    return;
  }
  // 无入参：关的是这条连接连着的那个宿主；答复先回来，收尾与退出排在它后面
  await api.host.shutdown.mutate();
  exit({ backToConnect: t("cmd.shutdown.done") });
};

/**
 * 命令处理器表 —— 键是**主名**，类型保证与 `COMMAND_REGISTRY` 一一对应。
 * 别名（`/effort`、`/quit`）由 `canonicalCommandName()` 归一后落到同一处理器。
 */
const HANDLERS: Record<CommandName, CommandHandler> = {
  new: cmdNew,
  load: cmdLoad,
  sessions: cmdSessions,
  ws: cmdWs,
  pin: cmdPin,
  back: cmdBack,
  rename: cmdRename,
  editor: cmdEditor,
  clear: cmdClear,
  free: cmdFree,
  config: cmdConfig,
  model: cmdModel,
  think: cmdThink,
  agent: cmdAgent,
  mcp: cmdMcp,
  key: cmdKey,
  reload: cmdReload,
  upgrade: cmdUpgrade,
  lang: cmdLang,
  handoff: cmdHandoff,
  migrate: cmdMigrate,
  help: cmdHelp,
  /** 杀死 Agent（与删除分开：那一段会话还在，只是没有 agent 了） */
  kill: cmdKill,
  delete: cmdDelete,
  shutdown: cmdShutdown,
  exit: cmdExit,
};

/**
 * 执行一条斜杠命令。
 *
 * 执行上下文就是宿主 + 解析出来的名字/参数/通知出口：`pick` 是宿主自己实现的异步口 ——
 * 命令层不持有渲染状态，进出都由宿主自己实现。
 *
 * ## 失败只有一个出口（这里的 `catch`）
 *
 * 大部分处理器自己 `catch`：它们要说的是**对症**的一句话（`/model` 的写入失败、`/migrate` 的
 * 用户取消）。但「自己记得 catch」不能当判据 —— 宿主那边 `await runCommand(...)` 周围没有
 * `catch`（`chat.tsx` 的 `runSubmit` 只有 `finally`），漏出去的 rejection 会落到
 * `tui/index.tsx` 的 `unhandledRejection` 上，那里是 `process.exit(1)`：**一次宿主拒绝就
 * 等于用户按了退出**，而 `/load` `/new` `/back` 全是网络往返。
 *
 * 所以兜底收在这一处，而不是逐条命令记：处理器写过自己的话就走它自己的，没写过的在这里得到
 * 一句「哪条命令 + 宿主原话」。它不重试、不降级、不改状态 —— 命令失败时状态本来就没动，
 * 界面下一次重画就是真值。
 *
 * @param name 命令名（含别名，大小写不敏感；由 `parseCommandInput()` 从输入里取出）
 * @param raw  原始输入（含 `/`），用于参数解析与错误回显
 */
export async function runCommand(name: string, raw: string, host: ChatCommandHost): Promise<void> {
  const canonical = canonicalCommandName(name);
  if (!canonical) {
    host.notice(t("cmd.unknown", { cmd: raw }), "error");
    return;
  }
  const context: CommandContext = {
    ...host,
    name: canonical,
    raw,
    // 参数切分与命令名解析同源（registry 的 parseCommandArgs），命令层不再自己切一遍
    args: parseCommandArgs(raw),
    push: (text, tone = "info") => host.notice(text, tone),
  };
  try {
    await HANDLERS[canonical](context);
  } catch (error: unknown) {
    // 见上「失败只有一个出口」：这里接的是「没自己 catch」的那几条，不是重复报告
    host.notice(t("cmd.failed", { name: canonical, error: messageOf(error) }), "error");
  }
}
