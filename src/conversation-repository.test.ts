import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateConversationId,
  listConversations,
  persistConversation,
} from "./conversation-repository.js";
import { formatFileStamp } from "./format-time.js";
import { setLocale } from "./i18n/index.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";

/**
 * 会话 id 同时是**文件名**：格式一旦跟着界面语言变，历史文件与新文件就会混排。
 * 故这里把「纯 ASCII + 全下划线」钉死。
 */
describe("会话 id（文件名安全、中英一致）", () => {
  it("形如 chat_YYYY_MM_DD_HH_mm_ss", () => {
    const id = generateConversationId(new Date("2026-10-28T00:56:34"));
    expect(id).toBe("chat_2026_10_28_00_56_34");
  });

  it("只含 ASCII 与下划线（可直接当文件名）", () => {
    const id = generateConversationId(new Date("2026-01-02T03:04:05"));
    expect(id).toMatch(/^[A-Za-z0-9_]+$/);
    expect(id).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("同一秒内生成同一个 id（时间戳是本文件名的唯一来源）", () => {
    const d = new Date("2026-10-28T00:56:34");
    expect(generateConversationId(d)).toBe(generateConversationId(new Date(d)));
  });
});

describe("时间戳：文件名用，不随语言变", () => {
  it("formatFileStamp 恒为下划线数字", () => {
    setLocale("zh");
    const zh = formatFileStamp("2026-10-28T00:56:34");
    setLocale("en");
    const en = formatFileStamp("2026-10-28T00:56:34");
    expect(zh).toBe("2026_10_28_00_56_34");
    expect(en).toBe(zh);
  });
});

describe("listConversations（`/load` 只认文件名）", () => {
  const zen = useTempAiZenDir("aiz-list-test-");
  const convDir = () => join(zen.dir, "cli", "conversations");
  beforeEach(() => {
    zen.pin();
    // 每例从空目录开始（否则上一个用例落的会话会带到下一个）
    rmSync(convDir(), { recursive: true, force: true });
  });
  afterAll(() => zen.cleanup());

  it("每项只有 id 一个字段：不读文件内容、不产生摘要", async () => {
    await persistConversation({
      id: "chat_a",
      messages: [{ role: "user", content: "以前这里会当摘要显示" }] as never,
      cwd: "/work",
      setAsLastSession: false,
    });
    // 旧实现返回 { id, name, preview, updatedAt, size }，且为取 preview 逐个 JSON.parse
    expect(await listConversations()).toEqual([{ id: "chat_a" }]);
  });

  it("仍按文件 mtime 倒序（不显示时间 ≠ 不按时间排）", async () => {
    const stamps = ["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"];
    const ids = ["chat_a", "chat_b", "chat_c"];
    for (const [index, id] of ids.entries()) {
      await persistConversation({ id, messages: [], cwd: "/work", setAsLastSession: false });
      const when = new Date(stamps[index]!);
      utimesSync(join(convDir(), `${id}.json`), when, when);
    }
    expect((await listConversations()).map((c) => c.id)).toEqual(["chat_b", "chat_c", "chat_a"]);
  });

  it("只列 .json，临时文件与其它后缀不算会话", async () => {
    await persistConversation({ id: "chat_real", messages: [], cwd: "/work", setAsLastSession: false });
    writeFileSync(join(convDir(), "chat_real.json.tmp"), "{}", "utf-8");
    writeFileSync(join(convDir(), "notes.txt"), "x", "utf-8");
    expect((await listConversations()).map((c) => c.id)).toEqual(["chat_real"]);
  });

  it("目录不存在时返回空列表（首次启动）", async () => {
    expect(await listConversations()).toEqual([]);
  });
});
