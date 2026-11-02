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
  /**
   * 时间戳字段（`createdAt` / `updatedAt`）**已删除**。
   *
   * 留着 `createdAt` 就得在每次落盘前先把整个会话文件读一遍（几 MB 的 JSON.parse），
   * 只为了把一个不会变的值抄回去；`updatedAt` 则完全等于文件 mtime。
   * 排序改用 `stat().mtime`（见 `listConversations`），于是落盘不再需要先读。
   * 旧存档里的这两个字段会被反序列化时忽略。
   */
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

  /**
   * 会话文件的绝对路径（`/save <名字>` 删旧文件名时用）。
   *
   * 只是把 SDK 的 `protected path()` 公开出来，**不另写一套拼接** —— 待 L2 在 `path()`
   * 里加上路径穿越校验后，`/save ../x` 这类名字会自然被拦住。
   */
  filePath(id: string): string {
    return this.path(id);
  }
}

/**
 * 会话仓储。
 *
 * 每次调用新建一个轻对象：仓储本身无内部状态（只包一个目录），而目录（`CONVERSATIONS_DIR`）
 * 是会变的活绑定。若在模块加载时固化成单例，进程内共享模块跑测试时后一个用例会
 * 继续读写前一个用例的目录。
 */
export function conversationRepository(): AtomicConversationRepository {
  return new AtomicConversationRepository(CONVERSATIONS_DIR);
}

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
  /**
   * 会话所属工作目录。**必填**：调用点都知道自己属于哪个目录，
   * 留成可选只会在入口处多一层 `?? process.cwd()`，与调用点自己的兜底重复。
   */
  cwd: string;
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
  // 仓储**只取一次**：`CONVERSATIONS_DIR` 是活绑定，同一份落盘必须只读一个目录。
  const repository = conversationRepository();
  await repository.write({
    id: input.id,
    agentId: input.agentId || "default",
    messages: input.messages,
    cwd: input.cwd,
  });
  if (input.setAsLastSession !== false) await writeLastSession(input.cwd, input.id);
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

/** `/load` 选择器的一行：只有会话文件名（id） */
export interface ConversationSummary {
  id: string;
}

/**
 * 会话文件是否已存在（`/save <名字>` 的重名判断）。
 *
 * 只 `access`：判断重名不需要解析内容，`read()` 会把整个会话 JSON.parse 一遍。
 */
export async function conversationExists(id: string): Promise<boolean> {
  try {
    await fs.access(conversationRepository().filePath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出已保存的会话，按文件 mtime 倒序。供对话内 `/load` 选择器使用。
 *
 * 只 `readdir` + `stat`，**不 read 任何会话文件**：列表只显示文件名，摘要（首条消息）
 * 已取消 —— 会话攒到上百条时，逐个 `JSON.parse` 会明显拖慢 `/load`。
 */
export async function listConversations(): Promise<ConversationSummary[]> {
  const dir = CONVERSATIONS_DIR;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return []; // 首次启动：会话目录还没建
  }
  const entries: Array<{ id: string; mtime: number }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    try {
      const st = await fs.stat(join(dir, file));
      entries.push({ id, mtime: st.mtimeMs });
    } catch {
      /* 读目录与 stat 之间被别的进程删掉：跳过（不是错误，也不该让 /load 崩） */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.map((entry) => ({ id: entry.id }));
}
