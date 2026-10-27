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
        push("配置里还没有任何模型，请用 /config 添加端点与模型", "error");
        break;
      }

      // 支持 `/model <id>` 直切，无参时弹选择器
      let chosen: string | undefined = args[0];
      if (chosen && !models.some((model) => model.id === chosen)) {
        push(`未知模型：${chosen}（可选：${models.map((m) => m.id).join(" / ")}）`, "error");
        break;
      }
      if (!chosen) {
        const items: SelectItem<string>[] = models.map((model) => ({
          label: model.id === session.modelId ? `${model.name}（当前）` : model.name,
          value: model.id,
          hint: model.id,
        }));
        const picked = await new Promise<string | null>((resolve) =>
          setPickerState({ title: "切换模型（会写入配置）", items, resolve }),
        );
        if (picked == null) {
          push("已取消切换模型");
          break;
        }
        chosen = picked;
      }

      if (chosen === session.modelId) {
        push(`已经是当前模型：${chosen}`);
        break;
      }

      // 先确认目标模型可用：重挂载走的是 ChatSession.create → createModel，
      // 端点缺 Key 会直接抛错落到启动错误屏，用户连 /key 都进不去
      const targetModel = models.find((model) => model.id === chosen)!;
      const targetEndpoint = (config.endpoints ?? []).find(
        (endpoint) => endpoint.id === targetModel.endpointId,
      );
      if (!targetEndpoint) {
        push(`模型 ${chosen} 引用的端点 ${targetModel.endpointId} 不存在，请用 /config 检查`, "error");
        break;
      }
      if (!targetEndpoint.apiKey) {
        push(`端点「${targetEndpoint.name}」还没有 API Key，请先用 /config 配置后再切换`, "error");
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
        push(`切换模型失败：${error?.message ?? error}`, "error");
      }
      break;
    }
    case "agent": {
      const config = await readConfig();
      const store = await readAgentStore();
      const choices = listAgentChoices(config, store.agents);
      if (choices.length === 0) {
        push("还没有任何主 Agent，请用 /config 创建", "error");
        break;
      }

      // 支持 `/agent <id>` 直切，无参时弹选择器（与 /model 同一套做法）
      let chosen: string | undefined = args[0];
      if (chosen && !choices.some((choice) => choice.id === chosen)) {
        push(`未知 Agent：${chosen}（可选：${choices.map((choice) => choice.id).join(" / ")}）`, "error");
        break;
      }
      if (!chosen) {
        const items: SelectItem<string>[] = choices.map((choice) => {
          const current = choice.id === session.agentId;
          return {
            label: `${choice.name}${current ? "（当前）" : ""}${choice.selectable ? "" : " · 不可用"}`,
            value: choice.id,
            // 可用时给模型名（切换等于连模型一起换，得让用户看见换成哪个）；
            // 不可用时给原因，否则用户只能干看着选不动
            hint: choice.selectable ? (choice.modelName ?? choice.id) : (choice.reason ?? ""),
          };
        });
        const picked = await new Promise<string | null>((resolve) =>
          setPickerState({ title: "切换主 Agent（会写入默认 Agent）", items, resolve }),
        );
        if (picked == null) {
          push("已取消切换主 Agent");
          break;
        }
        chosen = picked;
      }

      const target = choices.find((choice) => choice.id === chosen)!;
      // 切过去跑不起来（未绑模型 / 端点缺 Key）就别切：重挂载后用户会卡在启动错误屏
      if (!target.selectable) {
        push(`Agent「${target.name}」不可用：${target.reason}`, "error");
        break;
      }

      try {
        const result = switchAgent({ config, agents: store.agents, targetAgentId: chosen });
        await saveConfig(result.config);
        if (chosen === session.agentId) {
          // 会话已经在这个 Agent 上：只需把「默认 Agent」记号写对，不必重建
          push(`${result.summary}（当前会话已在该 Agent 上）`);
          break;
        }
        // Scope 持有 Agent / 配置快照：不重建的话下一轮请求还是旧 Agent
        await resetScope();
        // 重挂载对话屏：提示词、工具集、模型都跟着 Agent 变；消息与上下文保留
        exit({ restart: true, agentId: chosen, messages: session.messages, notice: result.summary });
      } catch (error: any) {
        push(`切换主 Agent 失败：${error?.message ?? error}`, "error");
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
        push(`未知作用域：${rawScope}（可选 global / project，或不带参数）`, "error");
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
        push(`未知语言：${wanted}（可选 zh / en，或不带参数切换）`, "error");
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
        push("已刷新运行环境：配置 / 工具 / Skill / MCP 已重新发现（消息与上下文保留）");
      } catch (error: any) {
        push(`刷新失败：${error?.message ?? error}`, "error");
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
        push(`Agent「${session.agentId}」未绑定模型，请用 /config 为它选择模型`, "error");
        break;
      }
      const model = (config.models ?? []).find((item) => item.id === modelId);
      if (!model) {
        push(`模型 ${modelId} 不存在，请用 /model 或 /config 检查`, "error");
        break;
      }

      const choices = effortChoices(model, presets);
      if (choices.length === 0) {
        push(
          `模型 ${model.id} 未关联可用的思考策略（缺 reasoningPreset，或策略表里没这一档），无法调整`,
          "error",
        );
        break;
      }

      // 支持 `/think high` 直设、`/think default` 恢复跟随模型默认，无参时弹选择器
      let picked: string | undefined = args[0];
      if (picked !== undefined && picked !== "default" && !choices.includes(picked)) {
        push(`未知强度：${picked}（可选 ${choices.join(" / ")} / default）`, "error");
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
            label: `跟随模型默认${current ? "" : "（当前）"}`,
            value: "default",
            hint: "删除 Agent 上的思考参数",
          },
          ...choices.map((value) => ({
            label: `${effortLabel(value)}${value === current ? "（当前）" : ""}`,
            value,
            hint: value,
          })),
        ];
        const choice = await new Promise<string | null>((resolve) =>
          setPickerState({
            title: `思考强度（当前：${describeEffort(model, presets, definition)}）`,
            items,
            resolve,
          }),
        );
        if (choice == null) {
          push("已取消切换思考强度");
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
        push("思考强度未变化");
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
        push(`切换思考强度失败：${error?.message ?? error}`, "error");
      }
      break;
    }
    case "help": {
      const lines = ["可用命令："];
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
      push(archivedId ? `旧对话已存档：${archivedId}\n已开始新对话` : "已开始新对话");
      break;
    }
    case "save": {
      try {
        const id = await session.save();
        push(`对话已保存：${id}`);
      } catch (error: any) {
        push(`保存失败：${error?.message ?? error}`, "error");
      }
      break;
    }
    case "load": {
      const list = await listConversations();
      if (list.length === 0) {
        push("还没有已保存的对话", "error");
        break;
      }
      const allItems: SelectItem<string>[] = list.map((c) => ({
        label: c.name,
        value: c.id,
        hint: formatShortTime(c.updatedAt),
      }));
      // 覆盖层不能高于终端：仅展示最近的有限条
      const maxItems = Math.max(1, (rows ?? 24) - 8);
      const items = allItems.slice(0, maxItems);
      const title =
        allItems.length > maxItems
          ? `选择要加载的对话（仅显示最近 ${maxItems} 条）`
          : "选择要加载的对话（当前会话将被替换）";
      const choice = await new Promise<string | null>((resolve) =>
        setPickerState({ title, items, resolve }),
      );
      if (choice == null) {
        push("已取消加载");
        break;
      }
      const conversation = await conversationRepository.read(choice);
      if (!conversation) {
        push(`对话不存在或读取失败：${choice}`, "error");
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
        push(`未知的执行者：${modeArg}（可选 self / summary）`, "error");
        break;
      }
      if (!session.messages.some((m) => m.role === AgentNS.Role.User)) {
        push("当前对话还没有可交接的内容", "error");
        break;
      }
      // 未显式指定执行者时三选一（与自动迁移统一）；显式 `/handoff self|summary` 则直接采用
      const chosen = mode ?? (await chooseHandoffMode(setPickerState, "编写交接文档 · 选择交接方式"));
      if (chosen == null) {
        push("已取消交接");
        break;
      }
      try {
        const path = await session.handoff(chosen);
        push(`交接文档已生成：${path}`);
      } catch (error: any) {
        push(`编写交接文档失败：${error?.message ?? error}`, "error");
      }
      break;
    }
    case "migrate": {
      if (invalidMode) {
        push(`未知的执行者：${modeArg}（可选 self / summary）`, "error");
        break;
      }
      if (!session.messages.some((m) => m.role === AgentNS.Role.User)) {
        push("当前对话还没有可迁移的内容", "error");
        break;
      }
      // 与原 yes/no 确认统一为三选一：选「不交接」即取消本次迁移
      const chosen = mode ?? (await chooseHandoffMode(setPickerState, "任务迁移 · 选择交接方式（完成后开启新会话）"));
      if (chosen == null) {
        push("已取消迁移");
        break;
      }
      try {
        const path = await session.migrate(chosen);
        push(`任务迁移完成，已开启新会话\n📄 交接文档：${path}`);
      } catch (error: any) {
        push(`任务迁移失败：${error?.message ?? error}`, "error");
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
        push("还没有可撤回的消息", "error");
        break;
      }
      // 最近的在最前；仅展示最近的有限条，避免覆盖层高于终端
      const maxItems = Math.max(1, (rows ?? 24) - 8);
      const items = allItems.reverse().slice(0, maxItems);
      const title =
        allItems.length > maxItems
          ? `选择要撤回到的消息（仅显示最近 ${maxItems} 条）`
          : "选择要撤回到的消息（其后内容将被移除）";
      const choice = await new Promise<string | null>((resolve) =>
        setPickerState({ title, items, resolve }),
      );
      if (choice == null) {
        push("已取消撤回");
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
        push(`编辑器打开失败：${error?.message ?? error}`, "error");
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
      push(`未知命令：${raw}（输入 /help 查看可用命令）`, "error");
  }
}
