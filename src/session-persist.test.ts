// persistSession —— 会话落盘的唯一入口。
//
// 收敛前「读旧记录拿 createdAt → 写 → 更新指针」在 5 个地方各写一遍，并且已经漂移：
// `saveSession()` 漏写 cwd、stdio 的 `--save` 不更新指针、还写了一个已废弃的
// `modelId`。现在工作区由存储层按 `process.cwd()` 决定（记录里不再带 cwd），
// 这里把收敛后的契约钉住：只写真相字段、落到本工作区、指针可开关。
//
// 目录走临时 `AI_ZEN_DIR`（见 `useTempAiZenDir`）：绝不能写进真实的 `~/.ai-zen/`。
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workspaceIdFor } from "@ai-zen/agents-server";

import { sessionStore, persistSession, type SessionRecord } from "./session-store.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";

const zen = useTempAiZenDir("aiz-conv-test-");
const ROOT = zen.dir;

/** 会话落在**当前工作区**（`process.cwd()`）的目录下 */
const sessionDir = () => join(ROOT, "workspaces", workspaceIdFor(process.cwd()), "sessions");

/** 最小用户消息（只用到 role / content） */
const userMsg = (text: string) => ({ role: "user", content: text }) as never;

const readBack = (id: string): SessionRecord =>
  JSON.parse(readFileSync(join(sessionDir(), `${id}.json`), "utf-8")) as SessionRecord;

beforeEach(() => {
  // 进程内共享模块：别的文件会改 `AI_ZEN_DIR`，每个用例前钉回本文件的临时根
  zen.pin();
  // 每例从空目录开始
  rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  zen.cleanup();
});

describe("persistSession（会话落盘的唯一入口）", () => {
  it("新建：写入 id / agentId / messages，不再写时间戳与 cwd", async () => {
    await persistSession({ id: "chat_new_1", agentId: "default", messages: [userMsg("hi")] });
    const saved = readBack("chat_new_1");
    expect(saved.id).toBe("chat_new_1");
    expect(saved.agentId).toBe("default");
    expect(saved.messages).toHaveLength(1);
    // 工作区由**目录位置**表达，记录里不再有 cwd（那是迁移前用来归位的临时凭据）
    expect(saved).not.toHaveProperty("cwd");
    expect(saved).not.toHaveProperty("modelId");
    // 时间戳字段已删：不再为保留 createdAt 而先全量读旧文件（排序看文件 mtime）
    expect(saved).not.toHaveProperty("createdAt");
    expect(saved).not.toHaveProperty("updatedAt");
  });

  it("落在「当前工作区」的目录里，不落在 cli/ 下", async () => {
    await persistSession({ id: "chat_where", messages: [userMsg("x")] });
    expect(existsSync(join(sessionDir(), "chat_where.json"))).toBe(true);
    expect(existsSync(join(ROOT, "cli", "conversations", "chat_where.json"))).toBe(false);
    // 工作区记录写明原始路径（目录名带哈希，不可逆）
    const record = JSON.parse(
      readFileSync(join(ROOT, "workspaces", workspaceIdFor(process.cwd()), "workspace.json"), "utf-8"),
    );
    expect(record.path).toBe(process.cwd());
  });

  it("更新：整体覆盖，不需要先读旧文件", async () => {
    await persistSession({ id: "chat_update_1", messages: [userMsg("one")] });
    await persistSession({ id: "chat_update_1", messages: [userMsg("one"), userMsg("two")] });
    const second = readBack("chat_update_1");
    expect(second.messages).toHaveLength(2);
    expect(second).not.toHaveProperty("createdAt");
  });

  it("agentId 缺省补 default（不让会话文件里出现 undefined）", async () => {
    await persistSession({ id: "chat_agent_default", messages: [userMsg("x")] });
    expect(readBack("chat_agent_default").agentId).toBe("default");
  });

  it("默认更新「本工作区上一轮会话」指针", async () => {
    await persistSession({ id: "chat_pointer_on", messages: [userMsg("x")] });
    expect((await (await sessionStore()).lastSession())?.id).toBe("chat_pointer_on");
  });

  it("setAsLastSession=false 时不碰指针（stdio 的 --save 语义）", async () => {
    await persistSession({
      id: "chat_pointer_off",
      messages: [userMsg("x")],
      setAsLastSession: false,
    });
    expect(await (await sessionStore()).lastSession()).toBeNull();
  });

  it("返回会话 id（调用方要用它展示「已保存」）", async () => {
    await expect(persistSession({ id: "chat_ret", messages: [] })).resolves.toBe("chat_ret");
  });

  it("写盘是原子的：成功写之后不留临时文件，且内容可读回", async () => {
    await persistSession({ id: "chat_atomic", messages: [userMsg("第一轮")] });
    const files = readdirSync(sessionDir());
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readBack("chat_atomic").messages).toHaveLength(1);
  });

  it("写入走「临时文件 → rename」（不是直接覆盖目标文件）", async () => {
    // 直写 `fs.writeFile(target)` 在写一半时被杀会留下半截 JSON；改成写 tmp 再 rename
    // 后，任何时刻读到的都是完整文件。这里钉住机制本身：rename 发生的那一刻，
    // 临时文件必须已经完整存在，且目标文件在 rename 前不该被创建/截断。
    const fsp = (await import("node:fs")).promises;
    const realRename = fsp.rename.bind(fsp);
    const seen: { from: string; to: string; tmpExisted: boolean }[] = [];
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      seen.push({ from: String(from), to: String(to), tmpExisted: existsSync(String(from)) });
      return realRename(from as never, to as never);
    });

    try {
      await persistSession({ id: "chat_atomic_mech", messages: [userMsg("x")] });
    } finally {
      spy.mockRestore();
    }

    // 指针文件也走 tmp + rename，这里只看会话文件那一次
    const sessionRenames = seen.filter((r) => r.to.endsWith("chat_atomic_mech.json"));
    expect(sessionRenames).toHaveLength(1);
    expect(sessionRenames[0]!.from.endsWith(".json.tmp")).toBe(true);
    expect(sessionRenames[0]!.tmpExisted).toBe(true);
    // rename 之后临时文件不残留
    expect(readdirSync(sessionDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
