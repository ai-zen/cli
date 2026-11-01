// CwdTrackerPlugin —— cwd 注入的两种内容形态。
//
// 第二、三条用例是这次「粘贴图片」带出来的：消息内容一旦是内容块数组，
// 旧实现按 `typeof m.content === "string"` 找消息会**直接跳过**，于是带图那轮
// 静默丢掉 cwd（模型看到的路径可能还是上一轮的）。
import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { CwdTrackerPlugin } from "./cwd-tracker-plugin.js";

const ctxOf = (messages: any[]) => ({ agent: { messages } }) as any;
const userMessage = (content: any) => ({ id: "m1", role: AgentNS.Role.User, content }) as any;
const NOTE = "Current working directory:";

describe("CwdTrackerPlugin", () => {
  it("字符串消息：cwd 追加到消息末尾", async () => {
    const message = userMessage("hi");
    await new CwdTrackerPlugin().onInnerLoopStart(ctxOf([message]));
    expect(message.content).toBe(`hi\n\n[system-injected: current working directory — not written by the user]\n${NOTE} ${process.cwd()}`);
  });

  it("内容块消息（粘贴图片）：追加到最后一个 text 段，不新增段", async () => {
    const text = { type: "text", text: "看这张图" };
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } };
    const message = userMessage([text, image]);
    await new CwdTrackerPlugin().onInnerLoopStart(ctxOf([message]));

    expect(message.content).toHaveLength(2);
    expect(text.text).toContain("看这张图");
    expect(text.text).toContain(NOTE);
    // 图片段一个字节都不该被动
    expect(message.content[1]).toEqual(image);
  });

  it("内容块里只有图片时补一个 text 段（cwd 不能丢）", async () => {
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } };
    const message = userMessage([image]);
    await new CwdTrackerPlugin().onInnerLoopStart(ctxOf([message]));

    expect(message.content).toHaveLength(2);
    expect(message.content[1]).toEqual({ type: "text", text: `[system-injected: current working directory — not written by the user]\n${NOTE} ${process.cwd()}` });
  });

  it("cwd 未变化时不重复注入（第二次调用原样不动）", async () => {
    const message = userMessage("hi");
    const plugin = new CwdTrackerPlugin();
    await plugin.onInnerLoopStart(ctxOf([message]));
    const injected = message.content;
    await plugin.onInnerLoopStart(ctxOf([message]));
    expect(message.content).toBe(injected);
  });
});
