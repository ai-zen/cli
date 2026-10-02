/**
 * CLI 会话指针 — 记录「上一轮会话 id」。
 *
 * 取代原草稿机制：不再维护单独的单文件草稿（`drafts/_current.json`），
 * 而是让每个会话直接落盘为 `conversations/<id>.json`，再用本指针记住
 * 「最近活动的会话 id」，供下次启动自动续接。
 *
 * 存储位置：`$AI_ZEN_DIR/cli/last-session.json`。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { CLI_DIR } from "./config.js";

const POINTER_FILE = join(CLI_DIR, "last-session.json");

export interface SessionPointer {
  /** 上一轮（最近活动）会话 id */
  id: string;
  /** 最后活动时间（ISO 字符串） */
  updatedAt: string;
}

/** 读取「上一轮会话 id」；文件不存在或内容损坏时返回 null */
export async function readLastSession(): Promise<SessionPointer | null> {
  try {
    const raw = await fs.readFile(POINTER_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionPointer>;
    if (typeof parsed?.id !== "string" || !parsed.id) return null;
    return { id: parsed.id, updatedAt: parsed.updatedAt ?? "" };
  } catch {
    return null;
  }
}

/** 更新「上一轮会话 id」（原子写，避免中断产生半截文件） */
export async function writeLastSession(id: string): Promise<void> {
  try {
    await fs.access(CLI_DIR);
  } catch {
    await fs.mkdir(CLI_DIR, { recursive: true });
  }
  const pointer: SessionPointer = { id, updatedAt: new Date().toISOString() };
  const tmp = `${POINTER_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(pointer, null, 2), "utf-8");
  await fs.rename(tmp, POINTER_FILE);
}

/** 清除指针（会话被删除等场景使用） */
export async function clearLastSession(): Promise<void> {
  try {
    await fs.unlink(POINTER_FILE);
  } catch {
    /* 不存在则忽略 */
  }
}
