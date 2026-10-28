import { describe, it, expect } from "vitest";
import { conversationPreview, generateConversationId, type Conversation } from "./conversation-repository.js";
import { formatFileStamp, formatShortTime } from "./format-time.js";
import { setLocale } from "./i18n/index.js";

/**
 * 会话 id 同时是**文件名**：格式一旦跟着界面语言变，历史文件与新文件就会混排。
 * 故这里把「纯 ASCII + 全下划线」钉死，并顺带钉住「显示用时间戳才随语言变」。
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

describe("时间戳：文件名用不随语言变，显示用随语言变", () => {
  it("formatFileStamp 恒为下划线数字", () => {
    setLocale("zh");
    const zh = formatFileStamp("2026-10-28T00:56:34");
    setLocale("en");
    const en = formatFileStamp("2026-10-28T00:56:34");
    expect(zh).toBe("2026_10_28_00_56_34");
    expect(en).toBe(zh);
  });

  it("formatShortTime 随界面语言切换 pattern", () => {
    setLocale("zh");
    expect(formatShortTime("2026-10-28T00:56:34")).toContain("年");
    setLocale("en");
    expect(formatShortTime("2026-10-28T00:56:34")).not.toContain("年");
    setLocale("zh");
  });
});

describe("conversationPreview（/load 列表摘要）", () => {
  const conv = (messages: Array<{ role: string; content: unknown }>): Conversation =>
    ({ id: "x", agentId: "default", messages, createdAt: "", updatedAt: "" }) as unknown as Conversation;

  it("取首条用户消息的第一行（会话 id 是时间戳，列表靠它分辨）", () => {
    expect(
      conversationPreview(
        conv([
          { role: "assistant", content: "先来的" },
          { role: "user", content: "第一行\n第二行" },
        ]),
      ),
    ).toBe("第一行");
  });

  it("跳过消息开头的空行", () => {
    expect(conversationPreview(conv([{ role: "user", content: "\n\n真正的第一行\n更多" }]))).toBe(
      "真正的第一行",
    );
  });

  it("非字符串 content（多段内容）返回空串，不猜", () => {
    expect(conversationPreview(conv([{ role: "user", content: [{ type: "text", text: "x" }] }]))).toBe("");
  });

  it("没有用户消息 / 会话为 null → 空串", () => {
    expect(conversationPreview(conv([{ role: "assistant", content: "只有回复" }]))).toBe("");
    expect(conversationPreview(null)).toBe("");
  });

  it("超长截断到 80 字（渲染侧还会按终端宽度再裁）", () => {
    expect(conversationPreview(conv([{ role: "user", content: "长".repeat(200) }]))).toHaveLength(80);
  });
});
