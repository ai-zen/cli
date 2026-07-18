/**
 * 对话管理菜单
 *
 * 直接使用 SDK 的 listConversations / deleteConversation。
 */

import chalk from "chalk";
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { CONVERSATIONS_DIR } from "../config.js";
import { formatRelativeTime, formatFileSize } from "../format-time.js";
import {
  selectItemAndAction,
  confirmAction,
  SEPARATOR_LONG,
} from "./common.js";

/**
 * 获取对话列表（仅读文件名和 mtime，不解析 JSON 内容）。
 *
 * SDK 的 listConversations 会解析每个文件为完整的 Conversation 对象，
 * 在大量对话场景下可能较慢。这里只读文件元数据，适用于列表展示。
 * 如需完整数据，请使用 SDK 的 readConversation(CONVERSATIONS_DIR, id)。
 */
export function getConversationsList(): Array<{
  id: string;
  name: string;
  updatedAt: string;
  size: number;
}> {
  if (!existsSync(CONVERSATIONS_DIR)) return [];
  const files = readdirSync(CONVERSATIONS_DIR);
  const result: Array<{ id: string; name: string; updatedAt: string; size: number }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    try {
      const st = statSync(join(CONVERSATIONS_DIR, file));
      result.push({ id, name: id, updatedAt: st.mtime.toISOString(), size: st.size });
    } catch { /* skip */ }
  }
  return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function deleteConversation(id: string): void {
  const p = join(CONVERSATIONS_DIR, `${id}.json`);
  if (existsSync(p)) unlinkSync(p);
}

function formatConversationDetails(c: { id: string; name: string; updatedAt: string; size: number }): string[] {
  return [
    chalk.white.bold(`  📝 ${c.name}`),
    chalk.gray(`     ID: ${c.id}`),
    chalk.gray(`     更新时间: ${formatRelativeTime(c.updatedAt)}`),
    SEPARATOR_LONG,
  ];
}

export async function manageConversations(): Promise<void> {
  while (true) {
    console.log(chalk.blue.bold("\n📂 对话管理\n"));

    const conversations = getConversationsList();
    if (conversations.length === 0) {
      console.log(chalk.yellow("📭 没有已保存的对话\n"));
      return;
    }

    const result = await selectItemAndAction(conversations, {
      getName: (c) => `${c.name} (${formatRelativeTime(c.updatedAt)}, ${formatFileSize(c.size || 0)})`,
      getValue: (c) => c.id,
      getDetails: (c) => formatConversationDetails(c),
      actions: [{ name: "🗑️  删除", value: "delete" }],
      emptyMessage: "📭 没有已保存的对话",
    });

    if (!result) return;
    const { item: conversation, action } = result;

    const confirmed = await confirmAction(`确定要删除对话 "${conversation.name}" 吗?`, false);
    if (confirmed) {
      deleteConversation(conversation.id);
      console.log(chalk.green(`\n✅ 对话 "${conversation.name}" 已删除\n`));
    }
  }
}
