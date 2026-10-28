// 由 src/tui/screens/chat.tsx 拆分而来 —— 斜杠命令执行器（/config /key /save /load /back …）
import { Dispatch, SetStateAction } from "react";
import { AgentNS } from "@ai-zen/agents-core";
import type { HandoffMode } from "@ai-zen/agents-sdk";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectItem } from "../components.js";
import { ChatSession, stripCwdNote } from "../chat-session.js";
import { matchCommandHints } from "../../conversation-commands/registry.js";
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
 * 解析命令后的执行者参数（`/migrate self`、`/handoff summary`）。
 * 缺省返回 undefined（走服务默认值）；非法值也返回 undefined，由调用方报错。
 */
export function parseHandoffMode(raw?: string): HandoffMode | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "self" || value === "summary" ? value : undefined;
}

export async function runCommand(name: string, raw: string, host: ChatCommandHost): Promise<void> {
  const {
    session,
    notice,
    clearTranscript,
    rows,
    exit,
    suspendTerminal,
    openWizard,
    openKeyEditor,
    doExit,
    setPickerState,
    setInputText,
    setEffortView,
    refreshLocale,
  } = host;

  const push = (text: string, tone: "info" | "error" = "info") => {
    notice(text, tone);
  };

  // 命令参数：首个 token 为命令名，其余为参数（如 `/migrate summary`）
  const args = raw.trim().split(/\s+/).slice(1);
  const modeArg = args[0]?.toLowerCase();
  const mode = parseHandoffMode(modeArg);
  const invalidMode = modeArg !== undefined && mode === undefined;

  switch (name) {
    case "config":
      await openWizard({ kind: "menu" });
      break;
    case "key":
      await openKeyEditor();
      break;
    case "model": {
      const config = await readConfig();
      const models = config.models ?? [];
      if (models.length === 0) {
        push(t("cmd.model.noModels"), "error");
        break;
      }

      // 支持 `/model <id>` 直切，无参时弹选择器
      let chosen: string | undefined = args[0];
      if (chosen && !models.some((model) => model.id === chosen)) {
        push(t("cmd.model.unknown", { id: chosen, options: models.map((m) => m.id).join(" / ") }), "error");
        break;
      }
      if (!chosen) {
        const items: SelectItem<string>[] = models.map((model) => ({
          label: model.id === session.modelId ? `${model.name}${t("common.current")}` : model.name,
          value: model.id,
          hint: model.id,
        }));
        const picked = await new Promise<string | null>((resolve) =>
          setPickerState({ title: t("cmd.model.title"), items, resolve }),
        );
        if (picked == null) {
          push(t("cmd.model.cancelled"));
          break;
        }
        chosen = picked;
      }

      if (chosen === session.modelId) {
        push(t("cmd.model.already", { id: chosen }));
        break;
      }

      // 先确认目标模型可用：重挂载走的是 ChatSession.create → createModel，
      // 端点缺 Key 会直接抛错落到启动错误屏，用户连 /key 都进不去
      const targetModel = models.find((model) => model.id === chosen)!;
      const targetEndpoint = (config.endpoints ?? []).find(
        (endpoint) => endpoint.id === targetModel.endpointId,
      );
      if (!targetEndpoint) {
        push(
          t("cmd.model.endpointMissing", { id: chosen, endpoint: targetModel.endpointId }),
          "error",
        );
        break;
      }
      if (!targetEndpoint.apiKey) {
        push(t("cmd.model.noApiKey", { name: targetEndpoint.name }), "error");
        break;
      }

      try {
        // 只写 Agent 定义（模型唯一真相源）
        const result = await switchModel({ config, agentId: session.agentId, modelId: chosen });
        // Scope 持有配置快照：不重建的话 getScope() 会把旧模型又交给新 Agent
        await resetScope();
        // 重挂载对话屏：模型变了要重算上下文阈值、重建 Agent；消息与上下文保留
        exit({
          restart: true,
          agentId: session.agentId,
          messages: session.messages,
          notice: result.summary,
        });
      } catch (error: any) {
        push(t("cmd.model.failed", { error: error?.message ?? error }), "error");
      }
      break;
    }
    case "agent": {
      const config = await readConfig();
      const store = await readAgentStore();
      const choices = listAgentChoices(config, store.agents);
      if (choices.length === 0) {
        push(t("cmd.agent.noAgents"), "error");
        break;
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
        break;
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
        const picked = await new Promise<string | null>((resolve) =>
          setPickerState({ title: t("cmd.agent.title"), items, resolve }),
        );
        if (picked == null) {
          push(t("cmd.agent.cancelled"));
          break;
        }
        chosen = picked;
      }

      const target = choices.find((choice) => choice.id === chosen)!;
      // 切过去跑不起来（未绑模型 / 端点缺 Key）就别切：重挂载后用户会卡在启动错误屏
      if (!target.selectable) {
        push(t("cmd.agent.unavailableReason", { name: target.name, reason: target.reason ?? "" }), "error");
        break;
      }

      try {
        const result = switchAgent({ config, agents: store.agents, targetAgentId: chosen });
        await saveConfig(result.config);
        if (chosen === session.agentId) {
          // 会话已经在这个 Agent 上：只需把「默认 Agent」记号写对，不必重建
          push(t("cmd.agent.alreadyOn", { summary: result.summary ?? "" }));
          break;
        }
        // Scope 持有 Agent / 配置快照：不重建的话下一轮请求还是旧 Agent
        await resetScope();
        // 重挂载对话屏：提示词、工具集、模型都跟着 Agent 变；消息与上下文保留
        exit({ restart: true, agentId: chosen, messages: session.messages, notice: result.summary });
      } catch (error: any) {
        push(t("cmd.agent.failed", { error: error?.message ?? error }), "error");
      }
      break;
    }
    case "mcp": {
      // 不另建一套 MCP 编辑界面：直接打开配置中心里已有的 MCP 屏。
      // 增 / 删 / 改 / 启停 / 切换作用域都在那一屏里；关闭后宿主会因 `mcpChanged`
      // 自动 `session.reload()`，新服务器当场生效（与 /config 走同一条路径）。
      const rawScope = args[0];
      const explicit = parseMcpScope(rawScope);
      if (rawScope && !explicit) {
        push(t("cmd.mcp.unknownScope", { scope: rawScope }), "error");
        break;
      }
      const scope =
        explicit ??
        pickStartScope({
          global: await readMcpConfig("global"),
          project: await readMcpConfig("project"),
        });
      await openWizard({ kind: "mcp", scope });
      break;
    }
    case "lang": {
      // `/lang` 无参在中文 / 英文之间切；`/lang zh`、`/lang en` 直接指定。
      // 状态栏、输入行、通知等界面文案都走 `t()`，但它是模块级函数 —— 语言变了
      // 已渲染的内容不会自己更新，必须让 React 重跑一遍渲染函数（refreshLocale）。
      const wanted = args[0]?.toLowerCase();
      if (wanted && wanted !== "zh" && wanted !== "en") {
        push(t("cmd.lang.unknown", { lang: wanted }), "error");
        break;
      }
      const target = (wanted as "zh" | "en" | undefined) ?? (getLocale() === "zh" ? "en" : "zh");
      await persistLocale(target);
      refreshLocale();
      push(t("notice.languageChanged"));
      break;
    }
    case "reload": {
      // 手改配置文件（mcp.json / skills / tools / config.json）后不用重启 CLI：
      // `session.reload()` 内含 resetScope()（断开旧 MCP 连接）→ 重建 Agent → 重新发现。
      // 消息与上下文保留，所以自己“刷新一下就看到新东西”不需要新开对话。
      try {
        await session.reload();
        push(t("cmd.reload.done"));
      } catch (error: any) {
        push(t("cmd.reload.failed", { error: error?.message ?? error }), "error");
      }
      break;
    }
    case "think":
    case "effort": {
      const config = await readConfig();
      const presets = await readReasoningPresets();
      const store = await readAgentStore();
      const definition = store.agents.find((item) => item.id === session.agentId) ?? null;
      const modelId = definition?.modelId;
      if (!modelId) {
        push(t("cmd.think.noModel", { id: session.agentId }), "error");
        break;
      }
      const model = (config.models ?? []).find((item) => item.id === modelId);
      if (!model) {
        push(t("cmd.think.modelMissing", { id: modelId }), "error");
        break;
      }

      const choices = effortChoices(model, presets);
      if (choices.length === 0) {
        push(
          t("cmd.think.notAdjustable", { id: model.id }),
          "error",
        );
        break;
      }

      // 支持 `/think high` 直设、`/think default` 恢复跟随模型默认，无参时弹选择器
      let picked: string | undefined = args[0];
      if (picked !== undefined && picked !== "default" && !choices.includes(picked)) {
        push(t("cmd.think.unknown", { level: picked, options: choices.join(" / ") }), "error");
        break;
      }
      if (!picked) {
        // 「当前」指 Agent 定义上真正写着的那一档（模型默认参数不算，那是跟随状态）
        const current = matchLevel(
          presetFor(model.id, model.reasoningPreset, presets),
          definition?.modelParams,
        );
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
        const choice = await new Promise<string | null>((resolve) =>
          setPickerState({
            title: t("cmd.think.title", { level: describeEffort(model, presets, definition) }),
            items,
            resolve,
          }),
        );
        if (choice == null) {
          push(t("cmd.think.cancelled"));
          break;
        }
        picked = choice;
      }

      const effort = picked === "default" ? null : (picked as string);
      const agentLevel = matchLevel(
        presetFor(model.id, model.reasoningPreset, presets),
        definition?.modelParams,
      );
      const unchanged = effort === null ? agentLevel === undefined : agentLevel === effort;
      if (unchanged) {
        push(t("cmd.think.unchanged"));
        break;
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
      break;
    }
    case "help": {
      const lines = [t("cmd.help.title")];
      for (const hint of matchCommandHints("")) {
        lines.push(`  ${hint.label}  ${hint.description}`);
      }
      push(lines.join("\n"));
      break;
    }
    case "clear":
      // 清屏但保留上下文：仅把转录显示起点推到最新
      clearTranscript();
      break;
    case "new": {
      // reset 会先归档当前对话（有内容才存），返回存档 id（无内容为 null）
      const archivedId = await session.reset();
      clearTranscript();
      push(archivedId ? t("cmd.new.archived", { id: archivedId }) : t("cmd.new.started"));
      break;
    }
    case "save": {
      try {
        const id = await session.save();
        push(t("cmd.save.done", { id }));
      } catch (error: any) {
        push(t("cmd.save.failed", { error: error?.message ?? error }), "error");
      }
      break;
    }
    case "load": {
      // 先算可见条数：摘要只为将要显示的那几条解析（会话多时不拖慢 /load）
      const maxItems = Math.max(1, (rows ?? 24) - 8);
      const list = await listConversations({ previewLimit: maxItems });
      if (list.length === 0) {
        push(t("cmd.load.none"), "error");
        break;
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
        allItems.length > maxItems
          ? t("cmd.load.tooMany", { n: maxItems })
          : t("cmd.load.titleReplacing");
      const choice = await new Promise<string | null>((resolve) =>
        setPickerState({ title, items, resolve }),
      );
      if (choice == null) {
        push(t("cmd.load.cancelled"));
        break;
      }
      const conversation = await conversationRepository.read(choice);
      if (!conversation) {
        push(t("cmd.load.readFailed", { id: choice }), "error");
        break;
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
      break;
    }
    case "handoff": {
      if (invalidMode) {
        push(t("cmd.handoff.unknownMode", { who: modeArg }), "error");
        break;
      }
      if (!session.messages.some((m) => m.role === AgentNS.Role.User)) {
        push(t("cmd.handoff.empty"), "error");
        break;
      }
      // 未显式指定执行者时三选一（与自动迁移统一）；显式 `/handoff self|summary` 则直接采用
      const chosen = mode ?? (await chooseHandoffMode(setPickerState, t("cmd.handoff.title")));
      if (chosen == null) {
        push(t("cmd.handoff.cancelled"));
        break;
      }
      try {
        const path = await session.handoff(chosen);
        push(t("cmd.handoff.done", { path }));
      } catch (error: any) {
        push(t("cmd.handoff.failed", { error: error?.message ?? error }), "error");
      }
      break;
    }
    case "migrate": {
      if (invalidMode) {
        push(t("cmd.handoff.unknownMode", { who: modeArg }), "error");
        break;
      }
      if (!session.messages.some((m) => m.role === AgentNS.Role.User)) {
        push(t("cmd.migrate.empty"), "error");
        break;
      }
      // 与原 yes/no 确认统一为三选一：选「不交接」即取消本次迁移
      const chosen = mode ?? (await chooseHandoffMode(setPickerState, t("cmd.migrate.title")));
      if (chosen == null) {
        push(t("cmd.migrate.cancelled"));
        break;
      }
      try {
        const path = await session.migrate(chosen);
        // 迁移用 `prune` 策略把 messages 剔除到「系统提示 + 交接断点」（仅 1~2 条），
        // 转录显示起点必须跟着归零，否则 `messages.slice(transcriptFrom)` 恒为空——
        // 迁移成功、上下文有内容，但屏幕上什么都没有（同 `/new` 分支的做法）。
        clearTranscript();
        push(t("cmd.migrate.done", { path }));
      } catch (error: any) {
        push(t("cmd.migrate.failed", { error: error?.message ?? error }), "error");
      }
      break;
    }
    case "back": {
      const allItems: SelectItem<string>[] = [];
      session.messages.forEach((message, index) => {
        if (message.role !== AgentNS.Role.User) return;
        const content = typeof message.content === "string" ? message.content : "";
        allItems.push({ label: truncate(stripCwdNote(content), 60), value: String(index) });
      });
      if (allItems.length === 0) {
        push(t("cmd.back.empty"), "error");
        break;
      }
      // 最近的在最前；仅展示最近的有限条，避免覆盖层高于终端
      const maxItems = Math.max(1, (rows ?? 24) - 8);
      const items = allItems.reverse().slice(0, maxItems);
      const title =
        allItems.length > maxItems
          ? t("cmd.back.tooMany", { n: maxItems })
          : t("cmd.back.title");
      const choice = await new Promise<string | null>((resolve) =>
        setPickerState({ title, items, resolve }),
      );
      if (choice == null) {
        push(t("cmd.back.cancelled"));
        break;
      }
      const text = session.rollbackTo(Number(choice));
      exit({ restart: true, messages: session.messages, initialInput: text });
      break;
    }
    case "editor": {
      const file = join(tmpdir(), `aizen-input-${Date.now()}.md`);
      try {
        writeFileSync(file, "", "utf-8");
        await suspendTerminal(() => {
          const editor =
            process.env.EDITOR ||
            process.env.VISUAL ||
            (process.platform === "win32" ? "notepad" : "vi");
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
      break;
    }
    case "exit":
    case "quit": {
      await doExit();
      break;
    }
    default:
      push(t("cmd.unknown", { cmd: raw }), "error");
  }
}
