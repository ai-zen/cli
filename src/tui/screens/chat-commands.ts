// 斜杠命令执行器 —— 表驱动
//
// 命令的**元数据**（名字 / 别名 / 说明 / 是否阻塞输入）在
// `conversation-commands/registry.ts`；**执行体**在本文件末尾的 `HANDLERS` 表里。
// 两者以 `Record<CommandName, CommandHandler>` 绑定，于是「新增命令忘了写处理器」
// 是编译错误（此前是 557 行 switch，漏一个分支只会在运行时落到「未知命令」）。
//
// 每个处理器只做一件事，公共部分（参数解析、通知、选择器）由 `CommandContext`
// 统一提供 —— 命令层不再自己解析命令名（与宿主是两套解析的问题已消除）。
import type { Dispatch, SetStateAction } from "react";
import { AgentNS } from "@ai-zen/agents-core";
import type { HandoffMode } from "@ai-zen/agents-sdk";
import { HandoffAbortedError } from "@ai-zen/agents-sdk";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectItem } from "../components.js";
import { ChatSession, stripCwdNote } from "../chat-session.js";
import {
  canonicalCommandName,
  matchCommandHints,
  parseCommandArgs,
  type CommandName,
} from "../../conversation-commands/registry.js";
import { conversationRepository, listConversations } from "../../conversation-repository.js";
import { formatShortTime } from "../../format-time.js";
import { readConfig, readMcpConfig, readReasoningPresets, saveConfig } from "../../config.js";
import { resetScope } from "../../agent-creator.js";
import { switchModel } from "../../model-switch.js";
import { listAgentChoices, switchAgent } from "../../agent-switch.js";
import { parseMcpScope, pickStartScope } from "../../mcp-command.js";
import {
  effortChoices,
  effortLabel,
  describeEffort,
  describeEffortView,
  setAgentEffort,
} from "../../reasoning-effort.js";
import { matchLevel, presetFor } from "../../reasoning-presets.js";
import { getLocale, t } from "../../i18n/index.js";
import { persistLocale } from "../../i18n/preferences.js";
import { readAgentStore } from "../../agents-store.js";
import { CLI_VERSION } from "../../version.js";
import { compareVersions, pickNewest } from "../../version-compare.js";
import { WizardStep } from "../config-wizard/index.js";
import { truncate } from "./render.js";
import { chooseHandoffMode } from "./handoff-choice.js";

export interface ChatCommandHost {
  session: ChatSession;
  /** 通知通道：命令反馈（保存 / 清除 / 迁移结果 …）走独立栏位，不进 messages */
  notice: (text: string, tone?: "info" | "error") => void;
  /** 清屏（保留上下文）：把转录显示起点推到最新 */
  clearTranscript: () => void;
  rows: number;
  exit: (arg?: any) => void;
  suspendTerminal: (fn: () => void | Promise<void>) => Promise<void>;
  openWizard: (step: WizardStep) => Promise<void>;
  openKeyEditor: () => Promise<void>;
  doExit: () => void;
  setPickerState: Dispatch<
    SetStateAction<{ title: string; items: SelectItem<string>[]; resolve: (value: string | null) => void } | null>
  >;
  setConfirmState: Dispatch<SetStateAction<{ question: string; resolve: (value: boolean) => void } | null>>;
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
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

/**
 * 解析命令后的执行者参数（`/migrate self`、`/handoff summary`）。
 * 缺省返回 undefined（走服务默认值）；非法值也返回 undefined，由调用方报错。
 */
export function parseHandoffMode(raw?: string): HandoffMode | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "self" || value === "summary" ? value : undefined;
}

/**
 * 解析 `/handoff` `/migrate` 的执行者参数。
 *
 * 单独成函数而不是挂在 `CommandContext` 上：16 个命令里只有这两个用得到，
 * 挂在上下文中会让另外 14 个命令（`/save` `/help` `/clear` …）每次也白算一遍。
 */
export function parseHandoffSelection(args: readonly string[]): HandoffSelection {
  const raw = args[0]?.toLowerCase();
  const mode = parseHandoffMode(raw);
  return { mode, invalid: raw !== undefined && mode === undefined ? raw : undefined };
}

// ==================== 各命令 ====================

const cmdSave: CommandHandler = async ({ session, push }) => {
  try {
    const id = await session.save();
    push(t("cmd.save.done", { id }));
  } catch (error: any) {
    push(t("cmd.save.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdLoad: CommandHandler = async ({ push, rows, exit, pick }) => {
  // 先算可见条数：摘要只为将要显示的那几条解析（会话多时不拖慢 /load）
  const maxItems = Math.max(1, (rows ?? 24) - 8);
  const list = await listConversations({ previewLimit: maxItems });
  if (list.length === 0) {
    push(t("cmd.load.none"), "error");
    return;
  }
  const allItems: SelectItem<string>[] = list.map((c) => ({
    // 有首条消息就用它当标签：纯时间戳 id 根本分不清哪条是哪条
    label: c.preview || c.name,
    value: c.id,
    hint: formatShortTime(c.updatedAt),
  }));
  // 覆盖层不能高于终端：仅展示最近的有限条
  const items = allItems.slice(0, maxItems);
  const title =
    allItems.length > maxItems ? t("cmd.load.tooMany", { n: maxItems }) : t("cmd.load.titleReplacing");
  const choice = await pick(title, items);
  if (choice == null) {
    push(t("cmd.load.cancelled"));
    return;
  }
  const conversation = await conversationRepository.read(choice);
  if (!conversation) {
    push(t("cmd.load.readFailed", { id: choice }), "error");
    return;
  }
  // 整体切换会话（含模型 / Agent）——交由上层重挂载对话屏
  exit({
    load: {
      agentId: conversation.agentId,
      messages: conversation.messages,
      conversationId: conversation.id,
      conversationName: conversation.id,
    },
  });
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
  // 最近的在最前；仅展示最近的有限条，避免覆盖层高于终端
  const maxItems = Math.max(1, (rows ?? 24) - 8);
  const items = allItems.reverse().slice(0, maxItems);
  const title = allItems.length > maxItems ? t("cmd.back.tooMany", { n: maxItems }) : t("cmd.back.title");
  const choice = await pick(title, items);
  if (choice == null) {
    push(t("cmd.back.cancelled"));
    return;
  }
  const text = session.rollbackTo(Number(choice));
  exit({ restart: true, messages: session.messages, initialInput: text });
};

const cmdEditor: CommandHandler = async ({ push, suspendTerminal, setInputText }) => {
  const file = join(tmpdir(), `aizen-input-${Date.now()}.md`);
  try {
    writeFileSync(file, "", "utf-8");
    await suspendTerminal(() => {
      const editor =
        process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi");
      const result = spawnSync(editor, [file], { stdio: "inherit" });
      if (result.error) throw result.error;
    });
    const text = readFileSync(file, "utf-8").trim();
    if (text) setInputText(text);
  } catch (error: any) {
    push(t("cmd.editor.failed", { error: error?.message ?? error }), "error");
  } finally {
    try {
      unlinkSync(file);
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

const cmdModel: CommandHandler = async ({ session, push, args, exit, pick }) => {
  const config = await readConfig();
  const models = config.models ?? [];
  if (models.length === 0) {
    push(t("cmd.model.noModels"), "error");
    return;
  }

  // 支持 `/model <id>` 直切，无参时弹选择器
  let chosen: string | undefined = args[0];
  if (chosen && !models.some((model) => model.id === chosen)) {
    push(t("cmd.model.unknown", { id: chosen, options: models.map((m) => m.id).join(" / ") }), "error");
    return;
  }
  if (!chosen) {
    const items: SelectItem<string>[] = models.map((model) => ({
      label: model.id === session.modelId ? `${model.name}${t("common.current")}` : model.name,
      value: model.id,
      hint: model.id,
    }));
    const picked = await pick(t("cmd.model.title"), items);
    if (picked == null) {
      push(t("cmd.model.cancelled"));
      return;
    }
    chosen = picked;
  }

  if (chosen === session.modelId) {
    push(t("cmd.model.already", { id: chosen }));
    return;
  }

  // 先确认目标模型可用：重挂载走的是 ChatSession.create → createModel，
  // 端点缺 Key 会直接抛错落到启动错误屏，用户连 /key 都进不去
  const targetModel = models.find((model) => model.id === chosen)!;
  const targetEndpoint = (config.endpoints ?? []).find((endpoint) => endpoint.id === targetModel.endpointId);
  if (!targetEndpoint) {
    push(t("cmd.model.endpointMissing", { id: chosen, endpoint: targetModel.endpointId }), "error");
    return;
  }
  if (!targetEndpoint.apiKey) {
    push(t("cmd.model.noApiKey", { name: targetEndpoint.name }), "error");
    return;
  }

  try {
    // 只写 Agent 定义（模型唯一真相源）
    const result = await switchModel({ config, agentId: session.agentId, modelId: chosen });
    // Scope 持有配置快照：不重建的话 getScope() 会把旧模型又交给新 Agent
    await resetScope();
    // 重挂载对话屏：模型变了要重算上下文阈值、重建 Agent；消息与上下文保留
    exit({ restart: true, agentId: session.agentId, messages: session.messages, notice: result.summary });
  } catch (error: any) {
    push(t("cmd.model.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdAgent: CommandHandler = async ({ session, push, args, exit, pick }) => {
  const config = await readConfig();
  const store = await readAgentStore();
  const choices = listAgentChoices(config, store.agents);
  if (choices.length === 0) {
    push(t("cmd.agent.noAgents"), "error");
    return;
  }

  // 支持 `/agent <id>` 直切，无参时弹选择器（与 /model 同一套做法）
  let chosen: string | undefined = args[0];
  if (chosen && !choices.some((choice) => choice.id === chosen)) {
    push(
      t("cmd.agent.unknown", { id: chosen, options: choices.map((choice) => choice.id).join(" / ") }),
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
    push(t("cmd.agent.unavailableReason", { name: target.name, reason: target.reason ?? "" }), "error");
    return;
  }

  try {
    const result = switchAgent({ config, agents: store.agents, targetAgentId: chosen });
    await saveConfig(result.config);
    if (chosen === session.agentId) {
      // 会话已经在这个 Agent 上：只需把「默认 Agent」记号写对，不必重建
      push(t("cmd.agent.alreadyOn", { summary: result.summary ?? "" }));
      return;
    }
    // Scope 持有 Agent / 配置快照：不重建的话下一轮请求还是旧 Agent
    await resetScope();
    // 重挂载对话屏：提示词、工具集、模型都跟着 Agent 变；消息与上下文保留
    exit({ restart: true, agentId: chosen, messages: session.messages, notice: result.summary });
  } catch (error: any) {
    push(t("cmd.agent.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdReload: CommandHandler = async ({ session, push }) => {
  // 手改配置文件（mcp.json / skills / tools / config.json）后不用重启 CLI：
  // `session.reload()` 内含 resetScope()（断开旧 MCP 连接）→ 重建 Agent → 重新发现。
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

/**
 * 读取包在 registry 上的全部 dist-tag（`{ latest, alpha, … }`）。
 *
 * 只拿 `latest` **不够**：本项目的实际发布状态就是「alpha 比正式版新」
 * （曾经 `latest = 0.9.0`、`alpha = 1.0.0-alpha.23`），只认 `latest` 会把正在跑
 * alpha 的用户**降级**回去。所以取全部 tag、再挑 semver 最大的那个。
 *
 * 失败（npm 不存在 / 网络不通 / 输出不是 JSON）返回 `undefined`，由调用方报错。
 */
function readDistTags(pkg: string): Record<string, string> | undefined {
  const result = spawnSync("npm", ["view", pkg, "dist-tags", "--json"], { encoding: "utf-8" });
  if (result.error || result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout ?? "") as Record<string, unknown>;
    const tags: Record<string, string> = {};
    for (const [tag, version] of Object.entries(parsed)) {
      if (typeof version === "string") tags[tag] = version;
    }
    return tags;
  } catch {
    return undefined;
  }
}

/**
 * 读取**全局安装目录**里某个包的实际版本，读不到返回 `undefined`。
 *
 * 走 `npm root -g` + 读 `package.json`，而不是 `npm view`：后者查的是 registry，
 * 刚装完的版本在 registry 上通常要几分钟才可见（发布经验，见交接文档），
 * 拿它报「装好了没」会把成功误报成失败。
 */
function readGlobalInstalledVersion(pkg: string): string | undefined {
  try {
    const root = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
    const dir = (root.stdout ?? "").trim();
    if (!dir) return undefined;
    const parsed = JSON.parse(readFileSync(join(dir, pkg, "package.json"), "utf-8")) as {
      version?: string;
    };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

const cmdUpdate: CommandHandler = async ({ push, suspendTerminal }) => {
  const tags = readDistTags(UPDATE_PACKAGE);
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

  // 安装过程交给**真实终端**（`suspendTerminal` 期间 Ink 暂停渲染）：npm 的进度条与
  // 报错直接打在 TTY 上，比捕获后回放可读；也因为不能阻塞事件循环——阻塞会让 Ink
  // 帧写坏、进度一条都看不见。
  let error: string | undefined;
  await suspendTerminal(() => {
    const result = spawnSync("npm", ["install", "-g", spec], { stdio: "inherit" });
    if (result.error) error = result.error.message;
    else if (result.status !== 0) error = `exit ${result.status ?? result.signal ?? "unknown"}`;
  });

  if (error) {
    push(t("cmd.update.failed", { spec, error }), "error");
    return;
  }

  // 装完读全局目录里的版本：读不到（自建安装路径 / 别的包管理器）就按目标版本报
  const installed = readGlobalInstalledVersion(UPDATE_PACKAGE) ?? target;
  if (installed === CLI_VERSION) {
    push(t("cmd.update.same", { version: installed }));
    return;
  }
  push(t("cmd.update.done", { spec, current: CLI_VERSION, version: installed }));
  // 不自动重启：内存里跑的还是旧代码，`exit({restart: true})` 只是重挂载界面；
  // 也不能替用户杀进程——当前会话会跟着没了。让用户自己决定何时重开。
  push(t("cmd.update.restart", { current: CLI_VERSION }));
};

const cmdMcp: CommandHandler = async ({ push, args, openWizard }) => {
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
      global: await readMcpConfig("global"),
      project: await readMcpConfig("project"),
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

const cmdThink: CommandHandler = async ({ session, push, args, setEffortView, pick }) => {
  const config = await readConfig();
  const presets = await readReasoningPresets();
  const store = await readAgentStore();
  const definition = store.agents.find((item) => item.id === session.agentId) ?? null;
  const modelId = definition?.modelId;
  if (!modelId) {
    push(t("cmd.think.noModel", { id: session.agentId }), "error");
    return;
  }
  const model = (config.models ?? []).find((item) => item.id === modelId);
  if (!model) {
    push(t("cmd.think.modelMissing", { id: modelId }), "error");
    return;
  }

  const choices = effortChoices(model, presets);
  if (choices.length === 0) {
    push(t("cmd.think.notAdjustable", { id: model.id }), "error");
    return;
  }

  // 支持 `/think high` 直设、`/think default` 恢复跟随模型默认，无参时弹选择器
  let picked: string | undefined = args[0];
  if (picked !== undefined && picked !== "default" && !choices.includes(picked)) {
    push(t("cmd.think.unknown", { level: picked, options: choices.join(" / ") }), "error");
    return;
  }
  if (!picked) {
    // 「当前」指 Agent 定义上真正写着的那一档（模型默认参数不算，那是跟随状态）
    const current = matchLevel(presetFor(model.id, model.reasoningPreset, presets), definition?.modelParams);
    const items: SelectItem<string>[] = [
      {
        label: `${t("cmd.think.followDefault")}${current ? "" : t("common.current")}`,
        value: "default",
        hint: t("cmd.think.clearHint"),
      },
      ...choices.map((value) => ({
        label: `${effortLabel(value)}${value === current ? t("common.current") : ""}`,
        value,
        hint: value,
      })),
    ];
    const choice = await pick(t("cmd.think.title", { level: describeEffort(model, presets, definition) }), items);
    if (choice == null) {
      push(t("cmd.think.cancelled"));
      return;
    }
    picked = choice;
  }

  const effort = picked === "default" ? null : (picked as string);
  const agentLevel = matchLevel(presetFor(model.id, model.reasoningPreset, presets), definition?.modelParams);
  const unchanged = effort === null ? agentLevel === undefined : agentLevel === effort;
  if (unchanged) {
    push(t("cmd.think.unchanged"));
    return;
  }

  try {
    const result = await setAgentEffort({
      config,
      presets,
      agentId: session.agentId,
      effort,
      // 已读过定义，避免命令层与写入层各读一次盘
      readAgent: async () => definition,
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

const cmdHandoff: CommandHandler = async ({ session, push, args, setPickerState }) => {
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
  const chosen = handoff.mode ?? (await chooseHandoffMode(setPickerState, t("cmd.handoff.title")));
  if (chosen == null) {
    push(t("cmd.handoff.cancelled"));
    return;
  }
  try {
    const path = await session.handoff(chosen);
    push(t("cmd.handoff.done", { path }));
  } catch (error: any) {
    // 用户按 Ctrl+C 取消：不是失败，也不该报错堆栈
    if (error instanceof HandoffAbortedError) {
      push(t("cmd.handoff.cancelled"));
      return;
    }
    push(t("cmd.handoff.failed", { error: error?.message ?? error }), "error");
  }
};

const cmdMigrate: CommandHandler = async ({ session, push, args, setPickerState, clearTranscript }) => {
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
  const chosen = handoff.mode ?? (await chooseHandoffMode(setPickerState, t("cmd.migrate.title")));
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
    // 用户按 Ctrl+C 取消：交接已停下且未改动会话，不是失败
    if (error instanceof HandoffAbortedError) {
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

/** 组装执行上下文：参数解析、通知与选择器的统一入口 */
function buildContext(name: CommandName, raw: string, host: ChatCommandHost): CommandContext {
  return {
    ...host,
    name,
    raw,
    // 参数切分与命令名解析同源（registry 的 splitCommandInput），命令层不再自己切一遍
    args: parseCommandArgs(raw),
    push: (text, tone = "info") => host.notice(text, tone),
    pick: (title, items) =>
      new Promise<string | null>((resolve) => host.setPickerState({ title, items, resolve })),
  };
}

/**
 * 执行一条斜杠命令。
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
  await HANDLERS[canonical](buildContext(canonical, raw, host));
}
