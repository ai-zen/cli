import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n/index.js";
import { noticeText } from "./notice-text.js";

/**
 * 通知码 → 文案：客户端这一侧的唯一定义处。
 *
 * 服务端只发 `{ code, params }`，所以这里断言两件事：每个 code 都有词条（不是裸 key），
 * 以及载荷里的**枚举**会被翻译成「人话」而不是原样塞进句子。
 */

beforeEach(() => {
  setLocale("zh");
});

describe("noticeText", () => {
  it("对话内通知：按 code 查本地词条", () => {
    expect(noticeText("handoffPath", { path: "/tmp/x.md" })).toBe("📄 交接文档：/tmp/x.md");
  });

  it("枚举参数也被翻译：不能出现「正在交接（self）…」", () => {
    const text = noticeText("handoffWriting", { mode: "self" });
    expect(text).toContain("原 agent 自交接");
    expect(text).not.toContain("self");
  });

  it("降级通知把「请求的」和「实际的」都翻成人话", () => {
    const text = noticeText("migrationDegraded", { requested: "self", mode: "summary" });
    expect(text).toContain("原 agent 自交接");
    expect(text).toContain("独立摘要");
  });

  it("旧会话存档：服务端给 sessionId，模板要的是 name", () => {
    expect(noticeText("handoffArchived", { sessionId: "chat_1" })).toContain("chat_1");
  });

  it("全局通知同样查表（不属于任何会话也照样能说人话）", () => {
    expect(noticeText("mcpUnavailable", { name: "filesystem" })).toContain("filesystem");
  });

  it("切语言后同一 code 换一种说法（服务端一个字都不用改）", () => {
    setLocale("en");
    expect(noticeText("turnAborted")).toContain("aborted");
  });
});
