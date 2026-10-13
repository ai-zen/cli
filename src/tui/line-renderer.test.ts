import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { LineRenderer } from "./line-renderer.js";

function assistant(partial: Partial<AgentNS.Message>): AgentNS.Message {
  return { id: "a", role: AgentNS.Role.Assistant, ...partial } as AgentNS.Message;
}

describe("LineRenderer（只追加，不重绘）", () => {
  it("增量打印 reasoning → tools → content 的新增部分", () => {
    const out: string[] = [];
    const r = new LineRenderer((t) => out.push(t));

    const m = assistant({ id: "a1", reasoning_content: "想" });
    r.update(m);
    m.reasoning_content = "想清楚";
    r.update(m);
    m.content = "答案";
    r.update(m);
    m.content = "答案了";
    r.update(m);

    const joined = out.join("");
    expect(joined).toContain("✦ AI");
    expect(joined).toContain("想清楚");
    expect(joined).toContain("答案了");
    // 增量：不重复整段
    expect(joined.match(/想清楚/g)?.length).toBe(1);
  });

  it("重复 update 同一状态不再输出", () => {
    const out: string[] = [];
    const r = new LineRenderer((t) => out.push(t));
    const m = assistant({ id: "a1", content: "hi" });
    r.update(m);
    const len = out.join("").length;
    r.update(m);
    expect(out.join("").length).toBe(len);
  });

  it("工具调用按出现顺序各打印一行", () => {
    const out: string[] = [];
    const r = new LineRenderer((t) => out.push(t));
    const m = assistant({
      id: "a1",
      tool_calls: [
        { index: 0, id: "t0", type: "function", function: { name: "read", arguments: "" } },
        { index: 1, id: "t1", type: "function", function: { name: "grep", arguments: "" } },
      ],
    } as Partial<AgentNS.Message>);
    r.update(m);
    const joined = out.join("");
    expect(joined).toContain("⚙ read");
    expect(joined).toContain("⚙ grep");
  });

  it("新一轮 assistant（新 id）重置游标并重新打头", () => {
    const out: string[] = [];
    const r = new LineRenderer((t) => out.push(t));
    r.update(assistant({ id: "a1", content: "one" }));
    r.update(assistant({ id: "a2", content: "two" }));
    const joined = out.join("");
    expect(joined).toContain("one");
    expect(joined).toContain("two");
    expect(joined.match(/✦ AI/g)?.length ?? 0).toBe(2);
  });

  it("非 assistant 消息忽略", () => {
    const out: string[] = [];
    const r = new LineRenderer((t) => out.push(t));
    r.update({ id: "u", role: AgentNS.Role.User, content: "x" } as AgentNS.Message);
    expect(out.join("")).toBe("");
  });
});
