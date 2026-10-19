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
import { WizardStep } from "../config-wizard/index.js";
import { truncate } from "./render.js";

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
    setConfirmState,
    setInputText,
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
      try {
        const path = await session.handoff(mode);
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
      const ok = await new Promise<boolean>((resolve) =>
        setConfirmState({
          question: `确定对当前对话进行任务迁移吗？（将生成交接文档并开启新会话）`,
          resolve,
        }),
      );
      if (!ok) {
        push("已取消迁移");
        break;
      }
      try {
        const path = await session.migrate(mode);
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
