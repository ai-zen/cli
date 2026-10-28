// persistConversation —— 会话落盘的唯一入口。
//
// 收敛前「读旧记录拿 createdAt → 写 → 更新指针」在 5 个地方各写一遍，并且已经漂移：
// `saveConversation()` 漏写 cwd、stdio 的 `--save` 不更新指针、还写了一个已废弃的
// `modelId`。这里把收敛后的契约钉住：保留 createdAt、总是写 cwd、指针可开关。
//
// 目录用 mock 顶成临时目录（`CONVERSATIONS_DIR` 是模块级常量，只能在模块求值时替换），
// 指针函数整体 mock —— 否则会写进真实的 `~/.ai-zen/cli/last-session.json`。
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  const { join: joinPath } = await import("node:path");
  const { tmpdir: tempDir } = await import("node:os");
  const root = joinPath(tempDir(), `aiz-conv-test-${process.pid}`);
  return {
    ...actual,
    CONVERSATIONS_DIR: joinPath(root, "conversations"),
    CLI_DIR: joinPath(root, "cli"),
  };
});

vi.mock("./session-pointer.js", () => ({
  writeLastSession: vi.fn(async () => {}),
  readLastSession: vi.fn(async () => null),
  clearLastSession: vi.fn(async () => {}),
}));

import { persistConversation, type Conversation } from "./conversation-repository.js";
import { writeLastSession } from "./session-pointer.js";

const ROOT = join(tmpdir(), `aiz-conv-test-${process.pid}`);
const CONV_DIR = join(ROOT, "conversations");

/** 最小用户消息（只用到 role / content） */
const userMsg = (text: string) => ({ role: "user", content: text }) as never;

const readBack = (id: string): Conversation =>
  JSON.parse(readFileSync(join(CONV_DIR, `${id}.json`), "utf-8")) as Conversation;

beforeEach(() => {
  vi.mocked(writeLastSession).mockClear();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("persistConversation（会话落盘的唯一入口）", () => {
  it("新建：写入 id / agentId / messages / cwd，createdAt 与 updatedAt 一致", async () => {
    await persistConversation({ id: "chat_new_1", agentId: "default", messages: [userMsg("hi")], cwd: "/work" });
    const saved = readBack("chat_new_1");
    expect(saved.id).toBe("chat_new_1");
    expect(saved.agentId).toBe("default");
    expect(saved.cwd).toBe("/work");
    expect(saved.messages).toHaveLength(1);
    expect(saved.createdAt).toBe(saved.updatedAt);
  });

  it("更新：保留原 createdAt，不把历史时间重置", async () => {
    await persistConversation({ id: "chat_update_1", messages: [userMsg("one")], cwd: "/work" });
    const first = readBack("chat_update_1");
    await persistConversation({ id: "chat_update_1", messages: [userMsg("one"), userMsg("two")], cwd: "/work" });
    const second = readBack("chat_update_1");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect(second.messages).toHaveLength(2);
  });

  it("agentId 缺省补 default（不让会话文件里出现 undefined）", async () => {
    await persistConversation({ id: "chat_agent_default", messages: [userMsg("x")] });
    expect(readBack("chat_agent_default").agentId).toBe("default");
  });

  it("cwd 缺省为 process.cwd()，且总会被写进文件（收敛前 saveConversation 漏写）", async () => {
    await persistConversation({ id: "chat_cwd_default", messages: [userMsg("x")] });
    expect(readBack("chat_cwd_default").cwd).toBe(process.cwd());
  });

  it("不再写入已废弃的 modelId 字段", async () => {
    await persistConversation({ id: "chat_no_model", agentId: "default", messages: [userMsg("x")] });
    expect(readBack("chat_no_model").modelId).toBeUndefined();
  });

  it("默认更新「本目录上一轮会话」指针", async () => {
    await persistConversation({ id: "chat_pointer_on", messages: [userMsg("x")], cwd: "/work" });
    expect(writeLastSession).toHaveBeenCalledWith("/work", "chat_pointer_on");
  });

  it("setAsLastSession=false 时不碰指针（stdio 的 --save 语义）", async () => {
    await persistConversation({
      id: "chat_pointer_off",
      messages: [userMsg("x")],
      cwd: "/work",
      setAsLastSession: false,
    });
    expect(writeLastSession).not.toHaveBeenCalled();
  });

  it("返回会话 id（调用方要用它展示「已保存」）", async () => {
    await expect(persistConversation({ id: "chat_ret", messages: [] })).resolves.toBe("chat_ret");
  });
});
