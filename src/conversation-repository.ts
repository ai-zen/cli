/**
 * CLI 会话存储 — Conversation 类型与会话仓储。
 *
 * 会话是 CLI 的产品数据，由 CLI 自己维护（SDK 只负责驱动与能力）。
 * 复用 SDK 的 EntityRepository，按 id 一个 JSON 文件（${conversationsDir}/${id}.json）。
 *
 * 「上一轮会话 id」指针（session-pointer.ts）随每次落盘更新，供下次启动续接。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { EntityRepository } from "@ai-zen/agents-sdk";
import { AgentNS } from "@ai-zen/agents-core";
import { CONVERSATIONS_DIR } from "./config.js";
import { formatFileStamp } from "./format-time.js";
import { writeLastSession } from "./session-pointer.js";
import type { ConversationContext } from "./types.js";

export interface Conversation {
  id: string;
  agentId: string;
  /**
   * @deprecated 已不再读**也不写**（收敛前 stdio 的 `--save` 曾写入它）。
   * 模型真相源是 `AgentDefinition.modelId`；保留字段仅为兼容旧存档的反序列化。
   */
  modelId?: string;
  messages: AgentNS.Message[];
  lastPromptTokens?: number;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 会话仓储：每个会话一个 JSON 文件（${conversationsDir}/${id}.json），**写盘是原子的**。
 *
 * 为什么要覆写 `write()`：SDK 的实现是直接 `fs.writeFile`，进程在写一半时被杀
 * （Ctrl+C、OOM、断电）就留下半截 JSON，`read()` 解析失败返回 null —— 整段历史
 * 就此丢失。会话文件可达数 MB，写入窗口并不小。这里改成「写临时文件 → rename」：
 * 同一文件系统内 rename 是原子操作，任何时刻读到的要么是旧文件、要么是完整新文件。
 *
 * 临时文件名为 `<id>.json.tmp`：`list()` 按 `.json` 后缀过滤，不会把它当成会话。
 */
class AtomicConversationRepository extends EntityRepository<Conversation> {
  override async write(entity: Conversation): Promise<void> {
    const target = this.path(entity.id);
    const tmp = `${target}.tmp`;
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(entity, null, 2), "utf-8");
    await fs.rename(tmp, target);
  }
}

export const conversationRepository = new AtomicConversationRepository(CONVERSATIONS_DIR);

/**
 * 生成文件名安全的会话 id：英文前缀 + 全下划线时间戳，中英一致。
 * 形如 `chat_2026_10_28_00_56_34`。
 */
export function generateConversationId(date: Date = new Date()): string {
  return `chat_${formatFileStamp(date.toISOString())}`;
}

/** 落盘一份会话所需的全部输入 */
export interface PersistConversationInput {
  id: string;
  agentId?: string;
  messages: AgentNS.Message[];
  /** 会话所属工作目录；缺省为 `process.cwd()` */
  cwd?: string;
  /**
   * 是否同时把「本目录上一轮会话」指针指向它（默认 true）。
   *
   * stdio 的 `--save` 传 false：那是一次性管道调用的归档，不该让下次 `ai` 续接到它
   * （否则连着跑几条 `cat … | ai --save` 之后，`ai` 会续接到最后一条管道结果上）。
   */
  setAsLastSession?: boolean;
}

/**
 * 落盘一份会话 —— **唯一的写入入口**。
 *
 * 此前「读旧记录拿 createdAt → 写 → 更新指针」这段在 5 个地方各写了一遍，并且已经
 * 漂移：`saveConversation()` 漏写 `cwd`、stdio 的 `--save` 不更新指针、还写了一个已
 * 废弃的 `modelId`。收敛到这里后，各处差异只剩「是否更新指针」一个显式开关。
 */
export async function persistConversation(input: PersistConversationInput): Promise<string> {
  const cwd = input.cwd ?? process.cwd();
  const existing = await conversationRepository.read(input.id);
  const now = new Date().toISOString();
  await conversationRepository.write({
    id: input.id,
    agentId: input.agentId || "default",
    messages: input.messages,
    cwd,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  if (input.setAsLastSession !== false) await writeLastSession(cwd, input.id);
  return input.id;
}

/**
 * 保存当前对话（交接前落盘旧会话时用）：以 `ctx` 为真相源，走统一的写入入口。
 */
export async function saveConversation(ctx: ConversationContext): Promise<string> {
  return persistConversation({
    id: ctx.currentId || generateConversationId(),
    agentId: ctx.agentId,
    messages: ctx.agent.messages,
    cwd: process.cwd(),
  });
}

/** `/load` 选择器的一行 */
export interface ConversationSummary {
  id: string;
  /** 文件名（= id），无摘要时的回退显示 */
  name: string;
  /** 首条用户消息的第一行（截断）；读不到时为空串 */
  preview: string;
  updatedAt: string;
  size: number;
}

/** 摘要最大字符数（渲染侧还会按终端宽度再裁一次） */
const PREVIEW_MAX = 80;

/**
 * 会话摘要：首条用户消息的第一行。
 *
 * 会话 id 是时间戳（`chat_2026_10_28_00_56_34`），直接当标签列出来完全分不清哪条是哪条。
 * 取首行而不是整段：`CwdTrackerPlugin` 会在消息末尾追加工作目录注记，末尾对辨认无意义。
 */
export function conversationPreview(conversation: Conversation | null): string {
  const first = conversation?.messages?.find((m) => m.role === AgentNS.Role.User);
  const content = typeof first?.content === "string" ? first.content : "";
  const line = content.split("\n").find((part) => part.trim()) ?? "";
  return line.trim().slice(0, PREVIEW_MAX);
}

/**
 * 列出已保存的会话，按更新时间倒序。供对话内 `/load` 选择器使用。
 *
 * 先只 stat（快），排序后**只为将要显示的那几条**解析内容取摘要 —— 会话攒到上百条时，
 * 逐个 `JSON.parse` 会明显拖慢 `/load`。
 */
export async function listConversations(
  options: { previewLimit?: number } = {},
): Promise<ConversationSummary[]> {
  try {
    await fs.access(CONVERSATIONS_DIR);
  } catch {
    return [];
  }
  const files = await fs.readdir(CONVERSATIONS_DIR);
  const stats: Array<{ id: string; name: string; updatedAt: string; size: number }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    try {
      const st = await fs.stat(join(CONVERSATIONS_DIR, file));
      stats.push({ id, name: id, updatedAt: st.mtime.toISOString(), size: st.size });
    } catch {
      /* 跳过读取失败的条目 */
    }
  }
  stats.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const previewLimit = Math.max(0, options.previewLimit ?? 0);
  const withPreview = await Promise.all(
    stats.map(async (item, index): Promise<ConversationSummary> => {
      if (index >= previewLimit) return { ...item, preview: "" };
      return { ...item, preview: conversationPreview(await conversationRepository.read(item.id)) };
    }),
  );
  return withPreview;
}
