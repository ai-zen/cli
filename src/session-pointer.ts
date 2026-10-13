/**
 * CLI 会话指针 — 按「工作目录（cwd）」记录各自的「上一轮会话 id」。
 *
 * 取代原草稿机制：不再维护单独的单文件草稿（`drafts/_current.json`），
 * 而是让每个会话直接落盘为 `conversations/<id>.json`，再用本指针记住
 * 「每个目录最近活动的会话 id」，供下次在该目录启动时自动续接。
 *
 * 存储位置：`$AI_ZEN_DIR/cli/last-session.json`，结构为 cwd → 续接记录的 map：
 *
 *   {
 *     "version": 1,
 *     "sessions": {
 *       "/abs/path/to/proj-a": { "id": "对话_...", "updatedAt": "..." },
 *       "/abs/path/to/proj-b": { "id": "对话_...", "updatedAt": "..." }
 *     }
 *   }
 *
 * 以 `process.cwd()` 的**精确字符串**为键：不同目录各记各的，互不干扰。
 * 旧版单指针文件（顶层 `{ id, updatedAt }`）无法归属到具体目录，一律视为
 * 「无记录」——宁可丢一次续接，也不把别的目录的历史错认到当前目录。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { CLI_DIR } from "./config.js";

const POINTER_FILE = join(CLI_DIR, "last-session.json");
const FILE_VERSION = 1;

/** 单个工作目录的续接记录 */
export interface SessionPointer {
  /** 上一轮（最近活动）会话 id */
  id: string;
  /** 最后活动时间（ISO 字符串） */
  updatedAt: string;
}

/** 指针文件结构：cwd → 续接记录 */
interface PointerFile {
  version: number;
  sessions: Record<string, SessionPointer>;
}

/** 读取整份指针文件；不存在 / 损坏 / 旧版格式时返回空结构 */
async function readPointerFile(): Promise<PointerFile> {
  const empty: PointerFile = { version: FILE_VERSION, sessions: {} };
  let parsed: any;
  try {
    parsed = JSON.parse(await fs.readFile(POINTER_FILE, "utf-8"));
  } catch {
    return empty;
  }
  // 仅接受新版 map 结构；旧版单指针（顶层 id）或其它形状一律视为空。
  if (!parsed || typeof parsed !== "object" || typeof parsed.sessions !== "object" || parsed.sessions === null) {
    return empty;
  }
  const sessions: Record<string, SessionPointer> = {};
  for (const [cwd, entry] of Object.entries(parsed.sessions as Record<string, unknown>)) {
    const e = entry as Partial<SessionPointer> | null;
    if (e && typeof e === "object" && typeof e.id === "string" && e.id) {
      sessions[cwd] = { id: e.id, updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "" };
    }
  }
  return { version: FILE_VERSION, sessions };
}

/** 原子写入整份指针文件（必要时创建目录，tmp + rename 避免半截文件） */
async function writePointerFile(file: PointerFile): Promise<void> {
  try {
    await fs.access(CLI_DIR);
  } catch {
    await fs.mkdir(CLI_DIR, { recursive: true });
  }
  const tmp = `${POINTER_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tmp, POINTER_FILE);
}

/** 读取指定工作目录的「上一轮会话 id」；无记录时返回 null */
export async function readLastSession(cwd: string): Promise<SessionPointer | null> {
  const file = await readPointerFile();
  return file.sessions[cwd] ?? null;
}

/** 更新指定工作目录的「上一轮会话 id」（保留其它目录的记录，原子写） */
export async function writeLastSession(cwd: string, id: string): Promise<void> {
  const file = await readPointerFile();
  file.sessions[cwd] = { id, updatedAt: new Date().toISOString() };
  await writePointerFile(file);
}

/** 清除指定工作目录的指针（会话被删除等场景使用） */
export async function clearLastSession(cwd: string): Promise<void> {
  const file = await readPointerFile();
  if (!(cwd in file.sessions)) return;
  delete file.sessions[cwd];
  await writePointerFile(file);
}
