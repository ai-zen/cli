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
import { readConfig } from "../../config.js";
import { resetScope } from "../../agent-creator.js";
import { switchModel } from "../../model-switch.js";
import {
  EFFORT_LABELS,
  describeEffort,
  effortChoices,
  setAgentEffort,
  type ReasoningEffort,
} from "../../reasoning-effort.js";
import { readAgentStore } from "../../agents-store.js";
import { isReasoningEffort } from "@ai-zen/agents-sdk";
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
  /** 更新状态栏的思考强度展示（`/think` 写入后由上层重取） */
  setEffortText: (text: string) => void;
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
    setEffortText,
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
        // 写入位置由「Agent 是否显式绑定模型」决定（见 model-switch.ts）
        const result = await switchModel({ config, agentId: session.agentId, modelId: chosen });
        // Scope 持有配置快照：不重建的话 getScope() 会把旧模型又交给新 Agent
        await resetScope();
        // 重挂载对话屏：模型变了要重算上下文阈值、重建 Agent；消息与上下文保留
        exit({
          restart: true,
          modelId: chosen,
          agentId: session.agentId,
          messages: session.messages,
          notice: result.summary,
        });
      } catch (error: any) {
        push(`切换模型失败：${error?.message ?? error}`, "error");
      }
      break;
    }
    case "think":
    case "effort": {
      const config = await readConfig();
      const store = await readAgentStore();
      const definition = store.agents.find((item) => item.id === session.agentId) ?? null;
      const modelId = definition?.modelId ?? config.defaultModel;
      const model = (config.models ?? []).find((item) => item.id === modelId);
      if (!model) {
        push(`模型 ${modelId} 不存在，请用 /model 或 /config 检查`, "error");
        break;
      }

      const choices = effortChoices(model);
      if (choices.length === 0) {
        push(
          `模型 ${model.id} 未声明可调档位（模型配置缺少 reasoning.efforts，或该型号不支持调整）`,
          "error",
        );
        break;
      }

      // 支持 `/think high` 直设、`/think default` 恢复跟随模型默认，无参时弹选择器
      let picked: string | undefined = args[0];
      if (picked !== undefined && picked !== "default" && !isReasoningEffort(picked)) {
        push(`未知强度：${picked}（可选 ${choices.join(" / ")} / default）`, "error");
        break;
      }
      if (!picked) {
        const current = definition?.reasoningEffort;
        const items: SelectItem<string>[] = [
          {
            label: `跟随模型默认${current ? "" : "（当前）"}`,
            value: "default",
            hint: "删除 Agent 上的档位声明",
          },
          ...choices.map((value) => ({
            label: `${EFFORT_LABELS[value]}${value === current ? "（当前）" : ""}`,
            value,
            hint: value,
          })),
        ];
        const choice = await new Promise<string | null>((resolve) =>
          setPickerState({
            title: `思考强度（当前：${describeEffort(model, definition)}）`,
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

      const effort = picked === "default" ? null : (picked as ReasoningEffort);
      const unchanged = effort === null ? !definition?.reasoningEffort : definition?.reasoningEffort === effort;
      if (unchanged) {
        push("思考强度未变化");
        break;
      }

      try {
        const result = await setAgentEffort({
          config,
          agentId: session.agentId,
          effort,
          // 已读过定义，避免命令层与写入层各读一次盘
          readAgent: async () => definition,
        });
        // 状态栏先跟上；档位要通过重建 Agent 才会进请求参数
        setEffortText(describeEffort(result.model, result.definition));
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
          modelId: conversation.modelId,
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
    case "migrate":
    case "migration": {
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
