/**
 * CLI 侧会话存储 —— 只是 `@ai-zen/agents-server` 会话存储的**接线**，逻辑全在服务端包里。
 *
 * ## 为什么会话不在 `cli/` 下了
 *
 * 会话属于**工作区**，不属于某个前端：CLI、桌面端、将来的浏览器连同一台服务端时，
 * 看到的必须是同一份 `<AI_ZEN_DIR>/workspaces/<workspaceId>/`。所以这里只剩三件事：
 *
 *   1. 把 `AI_ZEN_DIR` 与 `process.cwd()` 解析成具体路径（CLI 是组装根，允许读全局）；
 *   2. 保证老存档（`cli/conversations` + 按 cwd 分键的旧指针）搬过一次；
 *   3. 把 store 端口包成调用点习惯的几个函数。
 *
 * 服务端接管之后 1、3 两件事都会搬走，CLI 只留 `ServerClient`。**现在**先让数据位置
 * 与工作区对齐，否则等远程化的第二遍改，历史会话还得再搬一次。
 */

import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import {
  ensureWorkspace,
  FileSessionStore,
  migrateLegacySessions,
  type SessionRecord as StoredSessionRecord,
  type SessionRef,
  type SessionPointer,
} from "@ai-zen/agents-server";
import { AI_ZEN_DIR, CLI_DIR } from "./config.js";
import { formatFileStamp } from "./format-time.js";
import type { SessionContext } from "./types.js";

/** 存档里的会话（消息类型取 core 的 `AgentNS.Message`，服务端只当不透明载荷搬） */
export type SessionRecord = StoredSessionRecord<AgentNS.Message>;
export type { SessionRef, SessionPointer };

/** 工作区根目录：`<AI_ZEN_DIR>/workspaces`（每次现拼，`AI_ZEN_DIR` 是会变的活绑定） */
function workspacesRoot(): string {
  return join(AI_ZEN_DIR, "workspaces");
}

/**
 * 老存档搬迁的一次性闸门。
 *
 * 缓存 **Promise** 而不是「已搬过」布尔：并发调用（TUI 首屏续接 + 自动落盘）会在
 * `await` 窗口里一起穿透。键是当时的 `AI_ZEN_DIR` —— 测试会在用例之间换目录，
 * 用单个布尔就会让后一个用例永远跳过迁移（正是 `test-support/temp-dir.ts` 讲的那个坑）。
 */
let migration: { aiZenDir: string; done: Promise<void> } | null = null;

function migrateOnce(): Promise<void> {
  const aiZenDir = AI_ZEN_DIR;
  if (migration?.aiZenDir !== aiZenDir) {
    migration = {
      aiZenDir,
      done: migrateLegacySessions({
        // 旧位置全在 `cli/` 下，属于历史包袱：搬完就没了
        legacySessionsDir: join(CLI_DIR, "conversations"),
        legacyPointerFile: join(CLI_DIR, "last-session.json"),
        workspacesRoot: workspacesRoot(),
      }).then(() => undefined),
    };
  }
  return migration.done;
}

/**
 * 当前工作区（`process.cwd()`）的会话存储 —— CLI 侧唯一的取用入口。
 *
 * 每次调用新建一个轻对象：store 只包一个目录，而目录每次都可能不同（测试换
 * `AI_ZEN_DIR`、将来服务端服务多个工作区）。缓存实例等于把路径也缓存了。
 */
export async function sessionStore(): Promise<FileSessionStore<AgentNS.Message>> {
  await migrateOnce();
  const workspace = await ensureWorkspace({ workspacesRoot: workspacesRoot(), path: process.cwd() });
  return new FileSessionStore<AgentNS.Message>({ rootDir: workspace.rootDir });
}

/**
 * 生成文件名安全的会话 id：英文前缀 + 全下划线时间戳，中英一致。
 * 形如 `chat_2026_10_28_00_56_34`。
 */
export function generateSessionId(date: Date = new Date()): string {
  return `chat_${formatFileStamp(date.toISOString())}`;
}

/** 落盘一份会话所需的全部输入（工作区由 {@link sessionStore} 决定，不必再传） */
export interface PersistSessionInput {
  id: string;
  agentId?: string;
  messages: AgentNS.Message[];
  /**
   * 是否同时把「本工作区上一轮会话」指针指向它（默认 true）。
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
 * 漂移：`saveSession()` 漏写 `cwd`、stdio 的 `--save` 不更新指针、还写了一个已
 * 废弃的 `modelId`。收敛到这里后，各处差异只剩「是否更新指针」一个显式开关。
 */
export async function persistSession(input: PersistSessionInput): Promise<string> {
  // store **只取一次**：同一份落盘必须只落在一个工作区里
  const store = await sessionStore();
  await store.write({
    id: input.id,
    agentId: input.agentId || "default",
    messages: input.messages,
  });
  if (input.setAsLastSession !== false) await store.setLastSession(input.id);
  return input.id;
}

/**
 * 保存当前对话（交接前落盘旧会话时用）：以 `ctx` 为真相源，走统一的写入入口。
 */
export async function saveSession(ctx: SessionContext): Promise<string> {
  return persistSession({
    id: ctx.currentId || generateSessionId(),
    agentId: ctx.agentId,
    messages: ctx.agent.messages,
  });
}

/**
 * 会话文件是否已存在（`/save <名字>` 的重名判断）。
 *
 * 只 `access`：判断重名不需要解析内容，`read()` 会把整个会话 JSON.parse 一遍。
 */
export async function sessionExists(id: string): Promise<boolean> {
  return (await sessionStore()).exists(id);
}

/**
 * 列出**本工作区**已保存的会话，按文件 mtime 倒序。供对话内 `/load` 选择器使用。
 *
 * 只 `readdir` + `stat`，**不 read 任何会话文件**：列表只显示文件名，摘要（首条消息）
 * 已取消 —— 会话攒到上百条时，逐个 `JSON.parse` 会明显拖慢 `/load`。
 */
export async function listSessions(): Promise<SessionRef[]> {
  return (await sessionStore()).list();
}
