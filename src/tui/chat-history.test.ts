// `↑` 历史的数据源：直接派生自 `session.messages`（不再是 hook 内部的一份 string[]）。
//
// 旧实现只存文本，于是 `↑` 回到「带图片的消息」时图片静默丢失，直接回车把一张图
// 变成了纯文本重发。真相本来就在 messages 的内容段里（`image_url` 的 data URL），
// 派生出草稿即可。
import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { userDrafts } from "./chat-history.js";

const user = (content: unknown) => ({ role: AgentNS.Role.User, content }) as unknown as AgentNS.Message;
const assistant = (content: unknown) =>
  ({ role: AgentNS.Role.Assistant, content }) as unknown as AgentNS.Message;

/** 内联图片段（`Ctrl+V` 粘贴的形态） */
const inlineImage = (mime: string, base64: string) => ({
  type: "image_url" as const,
  image_url: { url: `data:${mime};base64,${base64}` },
});

describe("userDrafts（↑ 历史 = messages 里的用户消息）", () => {
  it("只取用户消息，且保持发送顺序（最后一条最新）", () => {
    const drafts = userDrafts([
      user("第一条"),
      assistant("回答"),
      user("第二条"),
      assistant("回答二"),
    ]);
    expect(drafts.map((d) => d.text)).toEqual(["第一条", "第二条"]);
    expect(drafts.every((d) => d.images.length === 0)).toBe(true);
  });

  it("剥掉 CwdTracker 追加的工作目录注记（否则 ↑ 回来带着一坨系统提示）", () => {
    const drafts = userDrafts([
      user("你好\n\n[system-injected: working directory changed — not written by the user]\nCurrent working directory: /tmp/x"),
    ]);
    expect(drafts[0]!.text).toBe("你好");
  });

  it("多段内容：文本拼回原文，内联图片还原成 base64 + mime", () => {
    const drafts = userDrafts([
      user([{ type: "text", text: "看这张图" }, inlineImage("image/png", "QUJD")]),
    ]);
    expect(drafts[0]!.text).toBe("看这张图");
    expect(drafts[0]!.images).toEqual([{ mime: "image/png", base64: "QUJD" }]);
  });

  it("多张内联图片按原顺序还回来（重发时附件顺序不能乱）", () => {
    const drafts = userDrafts([
      user([{ type: "text", text: "两张" }, inlineImage("image/png", "AA"), inlineImage("image/jpeg", "BB")]),
    ]);
    expect(drafts[0]!.images).toEqual([
      { mime: "image/png", base64: "AA" },
      { mime: "image/jpeg", base64: "BB" },
    ]);
  });

  it("file_id 形式的图片还原不了：只恢复文本，不塞空图片", () => {
    const drafts = userDrafts([
      user([
        { type: "text", text: "上传过的图" },
        { type: "file", file_id: "file-abc" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ]),
    ]);
    expect(drafts[0]!.text).toBe("上传过的图");
    expect(drafts[0]!.images).toEqual([]);
  });

  it("没有消息 / 全是助手消息时返回空数组", () => {
    expect(userDrafts([])).toEqual([]);
    expect(userDrafts([assistant("只有回答")])).toEqual([]);
  });
});
