/**
 * 斜杠命令执行器 —— 表驱动。
 *
 * 命令的**元数据**（名字 / 别名 / 说明 / 是否阻塞输入）在 `commands/registry.ts`；**执行体**
 * 在本文件末尾的 `HANDLERS` 表里。两者以 `Record<CommandName, CommandHandler>` 绑定，于是
 *「新增命令忘了写处理器」是编译错误（switch 那套形状下，漏一个分支只会在运行时落到
 *「未知命令」）。
 *
 * ## 为什么它在 `src/commands/` 而不在 `tui/screens/`
 *
 * 命令层不是渲染：它不吃键盘、不画帧，只「根据命令名做一件事」。放进 `tui/` 会让这条边界
 * **只靠运气成立** —— 只要这条链上恰好没有人把某个 ink 组件用在值位置，`dist/commands/index.js`
 * 的依赖图里就没有 ink。四条越界一并堵住：
 *   · `truncate` 吃 `text.js`（`screens/render.js` 第一行就是 ink，从那儿拿就把 ink 拖进命令层）；
 *   · `STATUS_BAR_LINES` / `pickerLines` / `usableFrameRows` 是**终端行数**概念，留在渲染层：
 *     命令层只需要知道「选择器能放几条」，那个数由 `ChatCommandHost.rows` 给；
 *   · `WizardStep` / `SelectItem` 改成**结构上的共享词汇**（`./types.js`），不再靠一条指向
 *     `tui/config-wizard/index.js` 的 `import type`（那条今天靠 tsc 擦掉才绿，明天用在值位置
 *     就静默进了 ink）；
 *   · 原始 React setter（`setPickerState` / `setConfirmState`）改成 `pick()` / `confirm()`
 *     两个 Promise —— 命令层不再持有「怎么上屏」这件事。
 *
 * 判据是**产物图**而不是路径 grep：`node scripts/check-imports.mjs dist/commands/index.js
 * --forbid ink --forbid react --forbid ./tui/`。
 */
import { AgentNS } from "@ai-zen/agents-core";
import type { AgentDefinition, HandoffMode } from "@ai-zen/agents-sdk";
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatSessionLike } from "../session/types.js";
import { openInSystemEditor, systemEditorCommand } from "../system-editor.js";
import { stripCwdNote, truncate } from "../text.js";
import {
  canonicalCommandName,
  matchCommandHints,
  parseCommandArgs,
  type CommandName,
} from "./registry.js";
// 配置的读与写统一走**配置面**（`ConfigPort`），它永远开向服务端。命令层不再自己吃盘 ——
// 否则「界面说改好了」和「服务端 Agent 实际用的那份配置」会各说各话（客户端搬到另一台
// 机器上时错得很安静）。
import type { ConfigPort } from "../server-client/index.js";
// 留下的是**纯数据整形**：把读取结果转成配置 / 列表，不吃盘，故不经端口
import { mcpConfigOrEmpty } from "../config.js";
import { checkAgentSwitch, listAgentChoices } from "../agent-switch.js";
import type { AgentStore } from "../agents-store.js";
import { parseMcpScope, pickStartScope } from "../mcp-command.js";
import {
  effortChoices,
  effortLabel,
  effortLabelText,
  effortParams,
  describeEffort,
  describeEffortView,
  setAgentEffort,
} from "../reasoning-effort.js";
import { matchLevel, presetFor } from "../reasoning-presets.js";
import { getLocale, t } from "../i18n/index.js";
import { persistLocale } from "../i18n/preferences.js";
import { CLI_VERSION } from "../version.js";
import { compareVersions, pickNewest } from "../version-compare.js";
import { handoffModeItems, toHandoffMode, type SelectItem, type WizardEntryStep } from "./types.js";

/**
 * 宿主（屏幕）提供给命令层的能力 —— **只留命令层真正用得上的那些**。
 *
 * 类型面里不许出现 `react`：那不只是「少一个 import」，而是这条边界唯一的硬判据 ——
 * 一旦命令层能伸手拿到 setter，它就能把「弹个选择器」写成“改一块渲染状态”，而那条代码
 * 在无头宿主（测试 / 将来的脚本模式）里根本跑不起来。
 */
export interface ChatCommandHost {
  session: ChatSessionLike;
  /**
   * 配置面：读配置 / 读思考策略表 / 读写 MCP 配置 / 读 Agent 定义 / 换模型。
   *
   * 命令层只认这一处「配置从哪来」，由宿主决定是本地实现还是远端实现；
   * 于是命令代码一份，两种部署下是同一种读写。
   */
  config: ConfigPort;
  /**
   * 起子进程的实现（`/update` 用）。缺省用 `node:child_process` 的 `spawn`。
   *
   * 做成可注入是为了让测试不必 `vi.mock("node:child_process")` —— 模块级 mock 是
   * 全局注册的，进程内共享模块时会波及所有用到子进程的模块。
   */
  spawn?: typeof spawn;
  /** 通知通道：命令反馈（保存 / 清除 / 迁移结果 …）走独立栏位，不进 messages */
  notice: (text: string, tone?: "info" | "error") => void;
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
  exit: (arg?: any) => void;
  suspendTerminal: (fn: () => void | Promise<void>) => Promise<void>;
  openWizard: (step: WizardEntryStep) => Promise<void>;
  openKeyEditor: () => Promise<void>;
  doExit: () => void;
  /**
   * **真·重启进程**（`/update` 装完新版本后调用）。
   *
   * 与 `exit({ restart: true })` 不是一回事：后者只是同进程重挂载界面，内存里还是
   * 旧的模块图，对「磁盘上的代码变了」这种升级等于没装。怎么重启（重新 exec 自己）
   * 由宿主决定，命令层只负责决定**什么时候**重启。
   */
  restartProcess: () => Promise<void>;
  /** 弹选择器并等用户作答（取消 / Esc 为 `null`）；覆盖层怎么画由宿主决定 */
  pick: (title: string, items: SelectItem<string>[]) => Promise<string | null>;
  /** 弹确认框并等用户作答（与 `pick` 同一套覆盖层，只是答案为 是/否） */
  confirm: (question: string) => Promise<boolean>;
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
  push: (text: string, tone?: "info" | "error") => void;
  /**
   * 弹选择器并等用户作答（取消为 `null`），由各命令自己决定取消后说什么。
   */
  pick: (title: string, items: SelectItem<string>[]) => Promise<string | null>;
  /** 弹确认框并等用户作答（与 `pick` 同一套覆盖层机制，只是答案为 是/否） */
  confirm: (question: string) => Promise<boolean>;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

/**
 * 解析命令后的执行者参数（`/migrate self`、`/handoff summary`）。
 * 缺省返回 undefined（走服务默认值）；非法值也返回 undefined，由调用方报错。
 */
function parseHandoffMode(raw?: string): HandoffMode | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "self" || value === "summary" ? value : undefined;
}

/**
 * 解析 `/handoff` `/migrate` 的执行者参数。
 *
 * 单独成函数而不是挂在 `CommandContext` 上：16 个命令里只有这两个用得到，
 * 挂在上下文中会让另外 14 个命令（`/save` `/help` `/clear` …）每次也白算一遍。
 */
function parseHandoffSelection(args: readonly string[]): HandoffSelection {
  const raw = args[0]?.toLowerCase();
  const mode = parseHandoffMode(raw);
  return { mode, invalid: raw !== undefined && mode === undefined ? raw : undefined };
}

// ==================== 各命令 ====================

/**
 * `/save [名字]`
 *
 *   无参 → 时间戳 id（维持原行为）
 *   带名 → 另存为该文件名；重名且不是当前会话时**先二次确认**（静默覆盖会让另一份
 *          对话凭空消失，而文件名是用户唯一能看到的身份）
 *
 * 名字的合法性（路径穿越等）不在这里校验：会话仓储的 `path()` 是唯一落盘口，
 * `/save ../x` 会被那一层拦住，此处不另写一套。
 */
const cmdSave: CommandHandler = async ({ session, push, args, confirm }) => {
  const name = args[0]?.trim();
  try {
    if (!name) {
      const id = await session.save();
      push(t("cmd.save.done", { id }));
      return;
    }
    if (name !== session.currentId && (await session.exists(name))) {
      if (!(await confirm(t("cmd.save.overwrite", { id: name })))) {
        push(t("cmd.save.cancelled"));
        return;
      }
    }
    const id = await session.saveAs(name);
    push(t("cmd.save.done", { id }));
  } catch (error: any) {
    push(t("cmd.save.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdLoad: CommandHandler = async ({ session, push, rows, exit, pick }) => {
  // 条数上限 = 宿主说「选择器能放几条」（见 `ChatCommandHost.rows`：终端行数换算在渲染层）
  const maxItems = Math.max(1, rows);
  const list = await session.listSaved();
  if (list.length === 0) {
    push(t("cmd.load.none"), "error");
    return;
  }
  // 列表只显示会话文件名（id）：不再解析首条消息当摘要（读盘开销已从 /load 消失）
  const allItems: SelectItem<string>[] = list.map((c) => ({ label: c.id, value: c.id }));
  // 覆盖层不能高于终端：仅展示最近的有限条
  const items = allItems.slice(0, maxItems);
  const title =
    allItems.length > maxItems
      ? t("cmd.load.tooMany", { n: maxItems })
      : t("cmd.load.titleReplacing");
  const choice = await pick(title, items);
  if (choice == null) {
    push(t("cmd.load.cancelled"));
    return;
  }
  // 整体切换会话（含模型 / Agent）——交由上层重挂载对话屏。
  // 只给 id：服务端从存档里自己装消息、自己认 Agent（列表不解析存档内容）。
  exit({ load: { sessionId: choice } });
};

const cmdNew: CommandHandler = async ({ session, clearTranscript, push }) => {
  // reset 会先归档当前对话（有内容才存），返回存档 id（无内容为 null）
  const archivedId = await session.reset();
  clearTranscript();
  push(archivedId ? t("cmd.new.archived", { id: archivedId }) : t("cmd.new.started"));
};

const cmdBack: CommandHandler = async ({ session, push, rows, exit, pick }) => {
  const allItems: SelectItem<string>[] = [];
  session.messages.forEach((message, index) => {
    if (message.role !== AgentNS.Role.User) return;
    const content = typeof message.content === "string" ? message.content : "";
    allItems.push({ label: truncate(stripCwdNote(content), 60), value: String(index) });
  });
  if (allItems.length === 0) {
    push(t("cmd.back.empty"), "error");
    return;
  }
  // 最近的在最前；仅展示最近的有限条，避免覆盖层高于终端（上界同 /load）
  const maxItems = Math.max(1, rows);
  const items = allItems.reverse().slice(0, maxItems);
  const title =
    allItems.length > maxItems ? t("cmd.back.tooMany", { n: maxItems }) : t("cmd.back.title");
  const choice = await pick(title, items);
  if (choice == null) {
    push(t("cmd.back.cancelled"));
    return;
  }
  const text = await session.rollbackTo(Number(choice));
  // 撤回也要落盘：否则存档里仍留着被撤回的消息，下次 `/load` 或重启就「复活」。
  // `save()` 会顺带更新 last-session 指针 —— 刚撤回的会话就是本目录的上一轮，符合预期。
  // （服务端实现的 `rollbackTo` 自己已经写过一次，多这一次无害）
  await session.save();
  // 重挂载要保持原来的交互（清屏、滚动归零、预填输入），但**必须带上此刻的会话 id**：
  // 宿主手上那个 id 是首次挂载时的，`/new`、自动迁移、`/save <名字>` 都会让它过期 ——
  // 带旧 id 重挂载会接回另一段对话（撤回白撤），或直接撞 `session-missing`。
  exit({
    restart: true,
    sessionId: session.currentId,
    messages: session.messages,
    initialInput: text,
  });
};

const cmdEditor: CommandHandler = async ({ push, suspendTerminal, setInputText }) => {
  const file = join(tmpdir(), `aizen-input-${Date.now()}.md`);
  try {
    await writeFile(file, "", "utf-8");
    await suspendTerminal(() => openInSystemEditor(systemEditorCommand(), file));
    const text = (await readFile(file, "utf-8")).trim();
    if (text) setInputText(text);
  } catch (error: any) {
    push(t("cmd.editor.failed", { error: error?.message ?? error }), "error");
  } finally {
    try {
      await unlink(file);
    } catch {
      /* 忽略 */
    }
  }
};

const cmdClear: CommandHandler = async ({ clearTranscript }) => {
  // 清屏但保留上下文：仅把转录显示起点推到最新
  clearTranscript();
};

const cmdConfig: CommandHandler = async ({ openWizard }) => {
  await openWizard({ kind: "menu" });
};

/**
 * `/model` 能改的三个作用级别 —— 与模型的三级解析一一对应（`会话级 > Agent 定义 > 全局兜底`）。
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
 * /model -a|--agent <id> → Agent 定义（`agent.model.set`，`/model` 从前的意思）
 * /model -g|--global <id>→ 全局兜底（`config.defaultModel`）
 * /model -a|-g           → 对应档位的选择器（三档共用同一个选择器）
 * ```
 *
 * 为什么缺省落到**会话级**：`/model` 最常表达的是「这次换个模型」。写进 Agent 定义会连带
 * 改掉所有用这个 Agent 的会话（另一个终端里正聊着的对话会莫名换模型），代价远大于收益 ——
 * 要改定义就显式说 `-a`。
 */
function parseModelSelection(args: readonly string[]): ModelSelection {
  const flag = args[0]?.toLowerCase();
  const scope = flag ? MODEL_SCOPE_FLAGS[flag] : undefined;
  // 首个 token 不是作用级别参数 → 它就是模型 id（`/model <id>`），落在会话级
  if (!scope) return { scope: "session", modelId: args[0] };
  return { scope, modelId: args[1] };
}

const cmdModel: CommandHandler = async ({ session, push, args, pick, config }) => {
  const appConfig = await config.readConfig();
  const models = appConfig.models ?? [];
  if (models.length === 0) {
    push(t("cmd.model.noModels"), "error");
    return;
  }

  const selection = parseModelSelection(args);
  const scopeName = t(`cmd.model.scope.${selection.scope}`);
  let chosen: string | undefined = selection.modelId;
  if (chosen && !models.some((model) => model.id === chosen)) {
    push(
      t("cmd.model.unknown", { id: chosen, options: models.map((m) => m.id).join(" / ") }),
      "error",
    );
    return;
  }
  if (!chosen) {
    const items: SelectItem<string>[] = models.map((model) => ({
      label: model.id === session.modelId ? `${model.name}${t("common.current")}` : model.name,
      value: model.id,
      hint: model.id,
    }));
    // 三档共用这一个选择器，所以标题必须说清两件事：**这次改哪一档**、**当前生效的是哪一档**
    // （生效档来自服务端的解析结果 `modelLevel`，客户端不自己推顺序）。
    const picked = await pick(
      t("cmd.model.title", {
        scope: scopeName,
        level: t(`cmd.model.scope.${session.modelLevel}`),
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
   *   - 会话级：快照里的**生效**模型 —— 用户看到的就是它；覆盖没设时它来自下一档，
   *     此时「已经是这个模型」依然成立（再设一次覆盖不会有任何可观察的变化）；
   *   - Agent 定义：定义上的 `modelId`（多一次往返，值得：`/model -a` 是低频命令，
   *     而拿生效模型去比会把「定义已经是它、只是本会话覆盖了别的」误报成「已切换」）；
   *   - 全局兜底：`defaultModel`（`readConfig` 刚拿到的，不用再问）。
   */
  const currentOfScope = async (): Promise<string | undefined> => {
    if (selection.scope === "session") return session.modelId;
    if (selection.scope === "global") return appConfig.defaultModel;
    const store = await config.readAgentStore();
    return store.agents.find((agent) => agent.id === session.agentId)?.modelId;
  };
  if (chosen === (await currentOfScope())) {
    // 提示里报的是**模型现在真正来自哪一档**（不是「你本来想改哪一档」）：会话级短路时
    // 这个模型往往来自下一档（如定义上就是这个），说成「已经是会话级模型」就是在撒谎。
    const alreadyScope =
      selection.scope === "session" ? t(`cmd.model.scope.${session.modelLevel}`) : scopeName;
    push(t("cmd.model.already", { scope: alreadyScope, id: chosen }));
    return;
  }

  // 先确认目标模型可用：端点缺 Key 时切过去根本跑不起来，这里只是给用户的可读提示
  // （不是校验层 —— 真正的拒绝由服务端的 `session.model.set` / `agent.model.set` 给出）
  const targetModel = models.find((model) => model.id === chosen)!;
  const targetEndpoint = (appConfig.endpoints ?? []).find(
    (endpoint) => endpoint.id === targetModel.endpointId,
  );
  if (!targetEndpoint) {
    push(t("cmd.model.endpointMissing", { id: chosen, endpoint: targetModel.endpointId }), "error");
    return;
  }
  if (!targetEndpoint.apiKey) {
    push(t("cmd.model.noApiKey", { name: targetEndpoint.name }), "error");
    return;
  }

  try {
    // 三条写路径都在服务端，各写各的那一档：
    //   session → 会话存档的 `modelId`（只影响这一段）
    //   agent   → Agent 定义的 `modelId`（影响所有用它的会话；顺带清空思考参数）
    //   global  → `config.json` 的 `defaultModel`（只在 Agent 没绑模型时兜底）
    // 命令层不再「读定义 → 改字段 → 写回」：思考参数重置、窄方法写盘这些规则只该有一份实现。
    if (selection.scope === "session") await session.setModel(chosen);
    else if (selection.scope === "agent") await config.setModel(session.agentId, chosen);
    else await config.setDefaultModel(chosen);

    // 之后**只有其中两档**还要再重建一次这段会话 —— 分界线是「谁写的这一笔」：
    //   - 会话级走 `channel.setModel`，包里拿到回执里的快照就 `applySnapshot`：新的
    //     `modelId` / `apiModel` / `modelParams` 当场就是屏幕上的事实。这里再补一次
    //     `reload()` 只是**多一个往返、多一次「该重画了」**，而屏幕上一个字都不会变；
    //   - `-a` 走 `agent.save`（`config.setModel` → `agent.model.set`）、`-g` 写
    //     `config.defaultModel`：两条都**不经过** channel 的模型动作，没有 `applySnapshot`，
    //     这段活着的会话仍跑在旧模型上，状态栏的 `modelId` 也只能靠新快照才会更新。
    //
    // 这里**刻意不再 `exit({ restart: true })`**：模型变了不需要重挂载整个对话屏 ——
    // 重启会把整屏刷一遍，还会丢掉用户正在写的输入草稿。
    if (selection.scope !== "session") await session.reload();

    if (selection.scope === "agent") {
      // 写进定义那条会顺带清空思考参数，所以它的提示要说明「思考强度已重置」；
      // 另外两档不动思考参数，别跟着说一句不成立的话。
      push(
        t("modelSwitch.summary", {
          name: targetModel.name,
          id: chosen,
          agent: session.agentId,
          hint: t("modelSwitch.resetHint"),
        }),
      );
    } else {
      push(t("cmd.model.done", { scope: scopeName, name: targetModel.name, id: chosen }));
    }
  } catch (error: any) {
    push(t("cmd.model.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdAgent: CommandHandler = async ({ session, push, args, pick, config }) => {
  const appConfig = await config.readConfig();
  const store = await config.readAgentStore();
  const choices = listAgentChoices(appConfig, store.agents);
  if (choices.length === 0) {
    push(t("cmd.agent.noAgents"), "error");
    return;
  }

  // 支持 `/agent <id>` 直切，无参时弹选择器（与 /model 同一套做法）
  let chosen: string | undefined = args[0];
  if (chosen && !choices.some((choice) => choice.id === chosen)) {
    push(
      t("cmd.agent.unknown", {
        id: chosen,
        options: choices.map((choice) => choice.id).join(" / "),
      }),
      "error",
    );
    return;
  }
  if (!chosen) {
    const items: SelectItem<string>[] = choices.map((choice) => {
      const current = choice.id === session.agentId;
      return {
        label: `${choice.name}${current ? t("common.current") : ""}${choice.selectable ? "" : t("cmd.agent.unavailable")}`,
        value: choice.id,
        // 可用时给模型名（切换等于连模型一起换，得让用户看见换成哪个）；
        // 不可用时给原因，否则用户只能干看着选不动
        hint: choice.selectable ? (choice.modelName ?? choice.id) : (choice.reason ?? ""),
      };
    });
    const picked = await pick(t("cmd.agent.title"), items);
    if (picked == null) {
      push(t("cmd.agent.cancelled"));
      return;
    }
    chosen = picked;
  }

  const target = choices.find((choice) => choice.id === chosen)!;
  // 切过去跑不起来（未绑模型 / 端点缺 Key）就别切：重挂载后用户会卡在启动错误屏
  if (!target.selectable) {
    push(
      t("cmd.agent.unavailableReason", { name: target.name, reason: target.reason ?? "" }),
      "error",
    );
    return;
  }

  try {
    const result = checkAgentSwitch({
      config: appConfig,
      agents: store.agents,
      targetAgentId: chosen,
    });
    // 「默认 Agent」是配置里的**一个字段**，走窄方法（整份写回会把并发修改抹掉）
    await config.setDefaultAgent(chosen);
    if (chosen === session.agentId) {
      // 会话已经在这个 Agent 上：只需把「默认 Agent」记号写对，不必重建
      push(t("cmd.agent.alreadyOn", { summary: result.summary }));
      return;
    }
    // 换 Agent 是**会话层**的事：服务端按新定义重建、保留消息、更新会话的 `agentId`。
    //
    // 不能走「重挂载对话屏」：重挂载只能换个参数，而服务端对**活着的**会话直接返回、
    // 忽略 `agentId`（`attach` 的语义就是「接上」）—— 于是界面提示「已切换」，实际下一轮
    // 仍由旧 Agent 跑；会话不活且没存档时反而撞 `session-missing` 掉进启动错误屏。
    await session.setAgent(chosen);
    // `summary` 已经是给人看的一句（`agentSwitch.summary`），原样推出
    push(result.summary);
  } catch (error: any) {
    push(t("cmd.agent.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdReload: CommandHandler = async ({ session, push }) => {
  // 手改配置文件（mcp.json / skills / tools / config.json）后不用重启 CLI：
  // `session.reload()` 在服务端重建 Agent（Scope 失效 → 旧 MCP 连接断开 → 重新发现）。
  // 消息与上下文保留，所以「刷新一下就看到新东西」不需要新开对话。
  try {
    await session.reload();
    push(t("cmd.reload.done"));
  } catch (error: any) {
    push(t("cmd.reload.failed", { error: error?.message ?? error }), "error");
  }
};

// ==================== /update ====================

/** `/update` 的安装目标包 */
const UPDATE_PACKAGE = "@ai-zen/cli";

/** npm 查询类调用的超时：断网 / registry 无响应时不能无限期挂着 */
const UPDATE_QUERY_TIMEOUT_MS = 20_000;

/**
 * 跑一次 npm 并收集 stdout（**异步**）。
 *
 * 为什么不能用 `spawnSync`：`npm view` 走网络要 1–3 秒，同步执行会把事件循环钉死，
 * Ink 的动画定时器跟着停摆 —— 用户看到的是一个**冻住的转圈**，既没有进度也不知道
 * 在等什么。超时主动 kill，避免断网时命令永远不返回。
 */
function runNpmCapture(
  args: string[],
  spawnImpl: typeof spawn = spawn,
): Promise<{ code: number | null; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawnImpl("npm", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const done = (value: { code: number | null; stdout: string; error?: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk;
    });
    // `error` 与 `close` 可能都触发（`spawn` 失败时先 error 再 close），settled 保证只结算一次
    child.on("error", (err: Error) => done({ code: null, stdout, error: err.message }));
    child.on("close", (code) => done({ code, stdout }));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, error: `timeout ${UPDATE_QUERY_TIMEOUT_MS}ms` });
    }, UPDATE_QUERY_TIMEOUT_MS);
  });
}

/**
 * 读取包在 registry 上的全部 dist-tag（`{ latest, alpha, … }`）。
 *
 * 只拿 `latest` **不够**：本项目的实际发布状态就是「alpha 比正式版新」，只认 `latest` 会把
 * 正在跑 alpha 的用户**降级**回去。所以取全部 tag、再挑 semver 最大的那个。
 *
 * `--prefer-online`：npm 会缓存 packument，刚发版时 `npm view` 可能仍拿到旧 tag，
 * 把「有新版」误判成「已是最新」（发布当天踩过这个坑）。
 *
 * 失败（npm 不存在 / 网络不通 / 输出不是 JSON）返回 `undefined`，由调用方报错。
 */
async function readDistTags(
  pkg: string,
  spawnImpl?: typeof spawn,
): Promise<Record<string, string> | undefined> {
  const result = await runNpmCapture(
    ["view", pkg, "dist-tags", "--json", "--prefer-online"],
    spawnImpl,
  );
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const tags: Record<string, string> = {};
    for (const [tag, version] of Object.entries(parsed)) {
      if (typeof version === "string") tags[tag] = version;
    }
    return tags;
  } catch {
    return undefined;
  }
}

/** 全局安装目录（`npm root -g`）；读不到返回 `undefined` */
async function readGlobalRoot(spawnImpl?: typeof spawn): Promise<string | undefined> {
  const result = await runNpmCapture(["root", "-g"], spawnImpl);
  const dir = result.stdout.trim();
  return result.code === 0 && dir ? dir : undefined;
}

/**
 * 读取**全局安装目录**里某个包的实际版本，读不到返回 `undefined`。
 *
 * 走 `npm root -g` + 读 `package.json`，而不是 `npm view`：后者查的是 registry，
 * 刚装完的版本在 registry 上通常要几分钟才可见（发布经验，见交接文档），
 * 拿它报「装好了没」会把成功误报成失败。
 */
async function readGlobalInstalledVersion(
  pkg: string,
  spawnImpl?: typeof spawn,
): Promise<string | undefined> {
  try {
    const root = await readGlobalRoot(spawnImpl);
    if (!root) return undefined;
    const parsed = JSON.parse(await readFile(join(root, pkg, "package.json"), "utf-8")) as {
      version?: string;
    };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安装（`stdio: inherit`，npm 的输出直接打在真实终端上）。成功返回 `undefined`，失败返回原因。
 *
 * `--prefer-online` 治 npm 的元数据缓存（否则刚发版的包可能解析失败 / 装到旧版本）；
 * `--no-fund` 只是减噪 —— 募捐提示对正在等结果的人没有信息量。
 */
function installGlobal(spec: string, spawnImpl: typeof spawn = spawn): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawnImpl("npm", ["install", "-g", spec, "--prefer-online", "--no-fund"], {
      stdio: "inherit",
    });
    child.on("error", (err: Error) => resolve(err.message));
    child.on("close", (code) => resolve(code === 0 ? undefined : `exit ${code ?? "unknown"}`));
  });
}

const cmdUpdate: CommandHandler = async ({
  push,
  suspendTerminal,
  confirm,
  restartProcess,
  session,
  spawn: spawnImpl,
}) => {
  // 每一步都说清「在干什么、看到什么」：只给一个转圈，无法区分「在查」和「在装」
  push(t("cmd.update.checking", { pkg: UPDATE_PACKAGE }));
  const tags = await readDistTags(UPDATE_PACKAGE, spawnImpl);
  if (!tags) {
    push(t("cmd.update.tagsFailed", { pkg: UPDATE_PACKAGE }), "error");
    return;
  }
  // 全部 dist-tag 里 semver 最大的那个——不管是 alpha 还是正式版
  const target = pickNewest(Object.values(tags));
  if (!target) {
    push(t("cmd.update.noVersion", { pkg: UPDATE_PACKAGE }), "error");
    return;
  }
  // 不比当前进程新就不装：本地跑的开发版（或超前于 registry 的构建）不能被「升级」降级
  const order = compareVersions(target, CLI_VERSION);
  if (order !== null && order <= 0) {
    push(t("cmd.update.same", { version: CLI_VERSION }));
    return;
  }
  const spec = `${UPDATE_PACKAGE}@${target}`;
  push(t("cmd.update.found", { target, current: CLI_VERSION }));

  // 安装过程交给**真实终端**（`suspendTerminal` 期间 Ink 暂停渲染）：npm 的进度条与
  // 报错直接打在 TTY 上，比捕获后回放可读。移交之前先在 TTY 上打一段头部 ——
  // 否则用户只看到 npm 自己的滚动输出，不知道装的是什么、从哪来、装到哪。
  const root = await readGlobalRoot(spawnImpl);
  let error: string | undefined;
  await suspendTerminal(async () => {
    process.stdout.write(
      t("cmd.update.installHeader", {
        spec,
        current: CLI_VERSION,
        root: root ?? t("cmd.update.rootUnknown"),
      }) + "\n",
    );
    error = await installGlobal(spec, spawnImpl);
  });

  if (error) {
    push(t("cmd.update.failed", { spec, error }), "error");
    return;
  }

  // 装完读全局目录里的版本：读不到（自建安装路径 / 别的包管理器）就按目标版本报
  const installed = (await readGlobalInstalledVersion(UPDATE_PACKAGE, spawnImpl)) ?? target;
  if (installed === CLI_VERSION) {
    push(t("cmd.update.same", { version: installed }));
    return;
  }
  push(t("cmd.update.done", { spec, current: CLI_VERSION, version: installed }));

  // 新代码只在**新进程**里生效：本进程的模块图已经加载完了，连 `exit({ restart: true })`
  // 都只是重挂载界面、跑的还是旧模块，所以「重启」必须是真的重新 exec 自己。
  // 用二次确认而不是装完直接重启：否则「装好了什么」这句结果还没看清，画面就换掉了；
  // 确认框默认停在「是」——敲 `/update` 的人本来就是要升级，一个回车就走完。
  const ok = await confirm(
    t("cmd.update.confirmRestart", { current: CLI_VERSION, version: installed }),
  );
  if (!ok) {
    push(t("cmd.update.restart", { current: CLI_VERSION }));
    return;
  }

  // 重启前把当前对话落盘：新进程靠 `last-session.json` 指针续接，而指针正是落盘时更新的。
  // 没有用户消息（刚开的新会话）就不落盘，免得留下一份空会话文件。
  if (session.messages.some((m) => m.role === AgentNS.Role.User)) {
    try {
      await session.save();
    } catch {
      // 落盘失败不阻断重启：SessionPersistPlugin 每轮已落过一次，这里只是补最后一手
    }
  }
  await restartProcess();
};

const cmdMcp: CommandHandler = async ({ push, args, openWizard, config }) => {
  // 不另建一套 MCP 编辑界面：直接打开配置中心里已有的 MCP 屏。
  // 增 / 删 / 改 / 启停 / 切换作用域都在那一屏里；关闭后宿主会因 `mcpChanged`
  // 自动 `session.reload()`，新服务器当场生效（与 /config 走同一条路径）。
  const rawScope = args[0];
  const explicit = parseMcpScope(rawScope);
  if (rawScope && !explicit) {
    push(t("cmd.mcp.unknownScope", { scope: rawScope }), "error");
    return;
  }
  const scope =
    explicit ??
    pickStartScope({
      // 这里读只是为了「默认进哪个作用域」：坏文件按空配置算即可，
      // 「已损坏」的提示由编辑屏负责（宿主那一轮会重新读并带上原因）
      global: mcpConfigOrEmpty(await config.readMcpConfig("global")),
      // 项目作用域不传路径：`<工作区>/.ai-zen/mcp.json` 里的「工作区」是服务端的事实，
      // 由端口自己解析；客户端再传一份路径过去，就又多了一份会漂的真相
      project: mcpConfigOrEmpty(await config.readMcpConfig("project")),
    });
  await openWizard({ kind: "mcp", scope });
};

const cmdLang: CommandHandler = async ({ push, args, refreshLocale }) => {
  // `/lang` 无参在中文 / 英文之间切；`/lang zh`、`/lang en` 直接指定。
  // 状态栏、输入行、通知等界面文案都走 `t()`，但它是模块级函数 —— 语言变了
  // 已渲染的内容不会自己更新，必须让 React 重跑一遍渲染函数（refreshLocale）。
  const wanted = args[0]?.toLowerCase();
  if (wanted && wanted !== "zh" && wanted !== "en") {
    push(t("cmd.lang.unknown", { lang: wanted }), "error");
    return;
  }
  const target = (wanted as "zh" | "en" | undefined) ?? (getLocale() === "zh" ? "en" : "zh");
  await persistLocale(target);
  refreshLocale();
  push(t("notice.languageChanged"));
};

/**
 * `/think` —— 改思考强度，**写到「模型来自哪一级」那一层**（与 SDK 的 `resolveModelParams`
 * 同一条规则，这是它的客户端投影）。
 *
 * 三档各写各的：
 *   - `session`：模型是本段会话换的 → 参数也写本段会话（`session.modelParams.set`）；
 *   - `agent`  ：模型来自 Agent 定义 → 写定义（`agent.save`，一直是这个行为）；
 *   - `global` ：模型来自全局兜底 → **没有可写的一层**（全局那一级只有 `config.defaultModel`），
 *     直接拒绝并说明：要调参数就把模型固定到会话或定义上。
 *
 * 两个容易错的地方，都用**生效模型**（`session.modelId`）而不是定义上的 `modelId`：
 *   - 「未绑定模型」的误报：模型来自全局兜底时定义上本来就没有 `modelId`，拿定义去判会
 *     报一句假的错；
 *   - 档位列表：能选哪些档、每档写成什么参数都挂在模型上（`reasoningPreset`），拿定义上
 *     那个模型算，会话级换过模型之后列出来的全是另一套档位。
 */
const cmdThink: CommandHandler = async ({ session, push, args, setEffortView, pick, config }) => {
  const appConfig = await config.readConfig();
  const presets = await config.readReasoningPresets();

  const modelId = session.modelId;
  if (!modelId) {
    push(t("cmd.think.noModel", { id: session.agentId }), "error");
    return;
  }

  // 参数跟着「模型来自哪一级」走；全局兜底那一级没有任何一层可以放参数，所以明确拒绝 ——
  // 写到一个不生效的地方比报错更坏（用户会以为改成功了，请求里却还是旧参数）。
  const level = session.modelLevel;
  if (level === "global") {
    push(t("cmd.think.globalLevel"), "error");
    return;
  }

  const model = (appConfig.models ?? []).find((item) => item.id === modelId);
  if (!model) {
    push(t("cmd.think.modelMissing", { id: modelId }), "error");
    return;
  }

  const choices = effortChoices(model, presets);
  if (choices.length === 0) {
    push(t("cmd.think.notAdjustable", { id: model.id }), "error");
    return;
  }

  // 「Agent 定义」这一层：**只有模型来自定义时**才需要它（它既是要改的对象，也是「当前
  // 档位」的来源）。会话级的参数在服务端存档里、客户端读不到（快照不返回参数）—— 那一档
  // 既没有「当前」可标，也没有定义可改，所以这条路一个字节都不读定义。
  let agentSide: { store: AgentStore; definition: AgentDefinition | null } | null = null;
  if (level === "agent") {
    const agentStore = await config.readAgentStore();
    agentSide = {
      store: agentStore,
      definition: agentStore.agents.find((item) => item.id === session.agentId) ?? null,
    };
  }
  /** 目标那一层写着的参数（读不到就没有）：只用于「当前档位」与置灰的显示 */
  const currentParams = agentSide?.definition?.modelParams;
  // 只展示目标那一层的参数（读不到就按「跟随模型默认」显示）
  const shown = currentParams ? { modelParams: currentParams } : null;

  // 支持 `/think high` 直设、`/think default` 恢复跟随模型默认，无参时弹选择器
  let picked: string | undefined = args[0];
  if (picked !== undefined && picked !== "default" && !choices.includes(picked)) {
    push(t("cmd.think.unknown", { level: picked, options: choices.join(" / ") }), "error");
    return;
  }
  if (!picked) {
    // 「当前」指目标那一层真正写着的那一档（模型默认参数不算，那是跟随状态）
    const current = matchLevel(presetFor(model.id, model.reasoningPreset, presets), currentParams);
    const items: SelectItem<string>[] = [
      {
        label: `${t("cmd.think.followDefault")}${current ? "" : t("common.current")}`,
        value: "default",
        hint: level === "session" ? t("cmd.think.clearHintSession") : t("cmd.think.clearHint"),
      },
      ...choices.map((value) => ({
        label: `${effortLabel(value)}${value === current ? t("common.current") : ""}`,
        value,
        hint: value,
      })),
    ];
    const choice = await pick(
      t("cmd.think.title", { level: describeEffort(model, presets, shown) }),
      items,
    );
    if (choice == null) {
      push(t("cmd.think.cancelled"));
      return;
    }
    picked = choice;
  }

  const effort = picked === "default" ? null : (picked as string);
  // 「没变化」只在能读到目标那一层的参数时才判得了：会话级读不到（存档在服务端），
  // 这时直接写 —— 写同一个值没有任何副作用，比按别层的参数猜「没变」诚实。
  if (agentSide) {
    const agentLevel = matchLevel(
      presetFor(model.id, model.reasoningPreset, presets),
      currentParams,
    );
    const unchanged = effort === null ? agentLevel === undefined : agentLevel === effort;
    if (unchanged) {
      push(t("cmd.think.unchanged"));
      return;
    }
  }

  try {
    if (!agentSide) {
      // 会话级：参数写这一段会话（服务端写存档 + 重建 Agent），**不碰 Agent 定义** ——
      // 模型是本段会话换的，参数写进定义既影响别的会话、在这一段又根本不生效。
      // `null` = 清掉这一层的覆盖（服务端把它当「跟随模型出厂参数」）。
      const params = effortParams({ presets, model, effort });
      await session.setModelParams(params ?? null);
      // 状态栏先跟上：此刻读不到服务端存档里的那份，就用刚算出来的这一份
      setEffortView(describeEffortView(model, presets, params ? { modelParams: params } : null));
      // 与 `/model` 的会话级同一条理由：`channel.setModelParams` 自己就 `applySnapshot`，
      // 档位当场就是屏幕上的事实，再补一次 `reload()` 只是多一个往返、多一次通知。
      push(t("effort.summarySession", { label: effortLabelText(effort), model: model.id }));
      return;
    }

    // 模型来自 Agent 定义：写定义（改造前唯一的路径，行为逐字不变）
    const side = agentSide;
    const result = await setAgentEffort({
      config: appConfig,
      presets,
      agentId: session.agentId,
      // 档位与补丁都按**生效模型**算（会话级覆盖 / 全局兜底时定义上的模型不是它在跑的那个）
      modelId,
      effort,
      // 已读过定义，避免命令层与写入层各读一次盘
      readAgent: async () => side.definition,
      // 写也必须回到**配置面的那一侧**：`setAgentEffort` 没有缺省的写入路径，
      // 递错一个本地实现就是写客户端本机的文件 —— 服务端看不到，于是「界面说改成功了，
      // Agent 实际档位没变」。用刚才那份快照的 `save`（远程即 `agent.save`）才是同一份真相。
      writeAgent: (next) => side.store.save("agent", next),
    });
    // 状态栏先跟上；档位要通过重建 Agent 才会进请求参数
    setEffortView(describeEffortView(result.model, presets, result.definition));
    await session.reload();
    push(result.summary);
  } catch (error: any) {
    push(t("cmd.think.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdKey: CommandHandler = async ({ openKeyEditor }) => {
  await openKeyEditor();
};

/**
 * 这次失败是不是「用户按 Ctrl+C 取消了」。
 *
 * 不能 `instanceof HandoffAbortedError`：远程模式下错误是 `SocketServerClient` 现造的
 * 普通 `Error` + `code`（跨进程没有类的同一性），`instanceof` 永远为假 —— 取消就会显示成
 * 「交接失败：handoff-aborted: …」。服务端本来就发机器可判的 code，认它即可。
 */
function isHandoffAborted(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "handoff-aborted";
}

const cmdHandoff: CommandHandler = async ({ session, push, args, pick }) => {
  const handoff = parseHandoffSelection(args);
  if (handoff.invalid !== undefined) {
    push(t("cmd.handoff.unknownMode", { who: handoff.invalid }), "error");
    return;
  }
  if (!session.messages.some((m) => m.role === AgentNS.Role.User)) {
    push(t("cmd.handoff.empty"), "error");
    return;
  }
  // 未显式指定执行者时三选一（与自动迁移统一）；显式 `/handoff self|summary` 则直接采用
  const chosen =
    handoff.mode ?? toHandoffMode(await pick(t("cmd.handoff.title"), handoffModeItems()));
  if (chosen == null) {
    push(t("cmd.handoff.cancelled"));
    return;
  }
  try {
    const path = await session.handoff(chosen);
    push(t("cmd.handoff.done", { path }));
  } catch (error: any) {
    // 用户按 Ctrl+C 取消：不是失败，也不该报错堆栈。交接回合已由服务截掉、
    // 本次新建的文档也删了，会话处于交接前的状态
    if (isHandoffAborted(error)) {
      push(t("cmd.handoff.cancelled"));
      return;
    }
    push(t("cmd.handoff.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdMigrate: CommandHandler = async ({ session, push, args, pick, clearTranscript }) => {
  const handoff = parseHandoffSelection(args);
  if (handoff.invalid !== undefined) {
    push(t("cmd.handoff.unknownMode", { who: handoff.invalid }), "error");
    return;
  }
  if (!session.messages.some((m) => m.role === AgentNS.Role.User)) {
    push(t("cmd.migrate.empty"), "error");
    return;
  }
  // 与原 yes/no 确认统一为三选一：选「不交接」即取消本次迁移
  const chosen =
    handoff.mode ?? toHandoffMode(await pick(t("cmd.migrate.title"), handoffModeItems()));
  if (chosen == null) {
    push(t("cmd.migrate.cancelled"));
    return;
  }
  try {
    const path = await session.migrate(chosen);
    // 迁移用 `prune` 策略把 messages 剔除到「系统提示 + 交接断点」（仅 1~2 条），
    // 转录显示起点必须跟着归零，否则 `messages.slice(transcriptFrom)` 恒为空——
    // 迁移成功、上下文有内容，但屏幕上什么都没有（同 `/new` 分支的做法）。
    clearTranscript();
    push(t("cmd.migrate.done", { path }));
  } catch (error: any) {
    // 用户按 Ctrl+C 取消：不是失败。交接已停下且会话已退回交接前（交接回合被截掉、
    // 没有开新会话），不能报成「失败」
    if (isHandoffAborted(error)) {
      push(t("cmd.migrate.cancelled"));
      return;
    }
    push(t("cmd.migrate.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdHelp: CommandHandler = async ({ push }) => {
  const lines = [t("cmd.help.title")];
  for (const hint of matchCommandHints("")) {
    lines.push(`  ${hint.label}  ${hint.description}`);
  }
  push(lines.join("\n"));
};

const cmdExit: CommandHandler = async ({ doExit }) => {
  await doExit();
};

/**
 * 命令处理器表 —— 键是**主名**，类型保证与 `COMMAND_REGISTRY` 一一对应。
 * 别名（`/effort`、`/quit`）由 `canonicalCommandName()` 归一后落到同一处理器。
 */
const HANDLERS: Record<CommandName, CommandHandler> = {
  save: cmdSave,
  load: cmdLoad,
  new: cmdNew,
  back: cmdBack,
  editor: cmdEditor,
  clear: cmdClear,
  config: cmdConfig,
  model: cmdModel,
  agent: cmdAgent,
  reload: cmdReload,
  update: cmdUpdate,
  mcp: cmdMcp,
  lang: cmdLang,
  think: cmdThink,
  key: cmdKey,
  handoff: cmdHandoff,
  migrate: cmdMigrate,
  help: cmdHelp,
  exit: cmdExit,
};

/**
 * 执行一条斜杠命令。
 *
 * 执行上下文就是宿主 + 解析出来的名字/参数/通知出口：`pick` / `confirm` 是宿主自己实现的
 * 异步口 —— 命令层不持有渲染状态，进出都由宿主自己实现。
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
  await HANDLERS[canonical](context);
}
