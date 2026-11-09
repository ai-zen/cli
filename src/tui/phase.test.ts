/**
 * 生成阶段状态机测试。
 *
 * 断言的是「按事件形状推进阶段」这条纯逻辑：不涉及 Ink，也不真连模型。
 */

import { describe, it, expect, afterEach } from "vitest";
import { PhaseTracker, pendingToolCalls, phaseLabel } from "./phase.js";
import { DEFAULT_LOCALE, setLocale } from "../i18n/index.js";

/** 构造一个流式 chunk（只带关心字段，其余留空） */
const chunk = (delta: Record<string, unknown>) => ({ choices: [{ delta }] });

afterEach(() => setLocale(DEFAULT_LOCALE));

describe("PhaseTracker", () => {
  it("初始为空闲（null）", () => {
    expect(new PhaseTracker().phase).toBeNull();
  });

  it("请求发出 → connecting，响应头到达 → queued", () => {
    const tracker = new PhaseTracker();
    tracker.connecting();
    expect(tracker.phase).toEqual({ kind: "connecting" });
    tracker.opened();
    expect(tracker.phase).toEqual({ kind: "queued" });
  });

  it("收到 reasoning_content → thinking", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ reasoning_content: "先想想" }));
    expect(tracker.phase).toEqual({ kind: "thinking" });
  });

  it("收到 content → streaming", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ reasoning_content: "想" }));
    tracker.delta(chunk({ content: "答案" }));
    expect(tracker.phase).toEqual({ kind: "streaming" });
  });

  it("收到 tool_calls → tool-calling，并记住工具名", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ tool_calls: [{ index: 0, function: { name: "read_file", arguments: "" } }] }));
    expect(tracker.phase).toEqual({ kind: "tool-calling", tool: "read_file" });
  });

  it("后续参数片段只带 arguments 时沿用已知工具名", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ tool_calls: [{ index: 0, function: { name: "read_file" } }] }));
    tracker.delta(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }));
    expect(tracker.phase).toEqual({ kind: "tool-calling", tool: "read_file" });
  });

  it("流结束且本轮带工具调用 → tool-waiting（带工具名）", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ tool_calls: [{ index: 0, function: { name: "grep" } }] }));
    tracker.streamEnded({ tool_calls: [{ function: { name: "grep" } }] });
    expect(tracker.phase).toEqual({ kind: "tool-waiting", tools: ["grep"], calls: [{ name: "grep" }] });
  });

  it("并行工具：流结束时记下**全部**调用（不是只记第一个）", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ tool_calls: [{ index: 0, function: { name: "edit" } }] }));
    tracker.delta(chunk({ tool_calls: [{ index: 1, function: { name: "exec" } }] }));
    tracker.streamEnded({
      tool_calls: [
        { id: "t1", index: 0, function: { name: "edit" } },
        { id: "t2", index: 1, function: { name: "exec" } },
      ],
    });

    expect(tracker.phase).toEqual({
      kind: "tool-waiting",
      tools: ["edit", "exec"],
      calls: [
        { id: "t1", name: "edit" },
        { id: "t2", name: "exec" },
      ],
    });
  });

  it("并行拼参数时工具名按 index 挂：第二个工具的参数片段不会串成第一个的名字", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ tool_calls: [{ index: 0, function: { name: "edit" } }] }));
    tracker.delta(chunk({ tool_calls: [{ index: 1, function: { name: "exec" } }] }));
    // 后续只带参数片段、不带名字：必须沿用**本下标**的名字
    tracker.delta(chunk({ tool_calls: [{ index: 1, function: { arguments: '{"cmd"' } }] }));
    expect(tracker.phase).toEqual({ kind: "tool-calling", tool: "exec" });
    tracker.delta(chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }));
    expect(tracker.phase).toEqual({ kind: "tool-calling", tool: "edit" });
  });

  it("流结束但本轮没有工具调用 → 阶段不变（交由 reset 收尾）", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ content: "全剧终" }));
    tracker.streamEnded({ content: "全剧终" });
    expect(tracker.phase).toEqual({ kind: "streaming" });
  });

  it("无 delta 的 chunk（如只带 usage 的收尾包）不改变阶段", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ reasoning_content: "想" }));
    tracker.delta({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 10 } });
    expect(tracker.phase).toEqual({ kind: "thinking" });
    tracker.delta({});
    tracker.delta(undefined);
    expect(tracker.phase).toEqual({ kind: "thinking" });
  });

  it("一个 chunk 同时带 content 与 reasoning 时，以 content 为准", () => {
    const tracker = new PhaseTracker();
    tracker.opened();
    tracker.delta(chunk({ reasoning_content: "想", content: "说" }));
    expect(tracker.phase).toEqual({ kind: "streaming" });
  });

  it("reset 回到空闲", () => {
    const tracker = new PhaseTracker();
    tracker.connecting();
    tracker.reset();
    expect(tracker.phase).toBeNull();
  });
});

describe("phaseLabel", () => {
  it("空阶段 → 处理中（busy 但还没进入具体阶段的场景，如 /migrate 写作）", () => {
    setLocale("zh");
    expect(phaseLabel(null)).toBe("处理中…");
  });

  it("六个阶段各自有独立文案（中）", () => {
    setLocale("zh");
    expect(phaseLabel({ kind: "connecting" })).toBe("连接中…");
    expect(phaseLabel({ kind: "queued" })).toBe("排队中…");
    expect(phaseLabel({ kind: "thinking" })).toBe("思考中…");
    expect(phaseLabel({ kind: "tool-calling" })).toBe("调用工具…");
    expect(phaseLabel({ kind: "tool-waiting" })).toBe("等待工具返回…");
    expect(phaseLabel({ kind: "streaming" })).toBe("输出中…");
    // 六者互不相同 —— 这正是本次改动的目的（原来全都叫「思考中…」）
    expect(new Set(Object.values({
      connecting: phaseLabel({ kind: "connecting" }),
      queued: phaseLabel({ kind: "queued" }),
      thinking: phaseLabel({ kind: "thinking" }),
      calling: phaseLabel({ kind: "tool-calling" }),
      waiting: phaseLabel({ kind: "tool-waiting" }),
      streaming: phaseLabel({ kind: "streaming" }),
    })).size).toBe(6);
  });

  it("带工具名时把工具名插进文案", () => {
    setLocale("zh");
    expect(phaseLabel({ kind: "tool-calling", tool: "read_file" })).toBe("调用工具 read_file…");
    expect(phaseLabel({ kind: "tool-waiting", tools: ["grep"] })).toBe("等待 grep 返回…");
  });

  it("多个并行工具时把还在跑的名字一起念出来", () => {
    setLocale("zh");
    expect(phaseLabel({ kind: "tool-waiting", tools: ["edit", "exec"] })).toBe(
      "等待 edit、exec 返回…",
    );
    setLocale("en");
    expect(phaseLabel({ kind: "tool-waiting", tools: ["edit", "exec"] })).toBe(
      "Waiting for edit, exec…",
    );
  });

  it("英文界面下同样是六个独立文案", () => {
    setLocale("en");
    expect(phaseLabel({ kind: "connecting" })).toBe("Connecting…");
    expect(phaseLabel({ kind: "queued" })).toBe("Queued…");
    expect(phaseLabel({ kind: "tool-waiting", tools: ["grep"] })).toBe("Waiting for grep…");
  });
});

describe("pendingToolCalls（谁还在跑）", () => {
  const calls = [
    { id: "t1", name: "edit" },
    { id: "t2", name: "exec" },
  ];
  /** 只需 `tool_call_id` + `status`：结果消息在执行前就以 pending 追加 */
  const result = (id: string, status?: string) => ({ role: "tool", tool_call_id: id, status });

  it("结果消息未落地时两个都算在跑", () => {
    expect(pendingToolCalls(calls, [])).toEqual(calls);
  });

  it("pending 算在跑；completed / error / aborted 算结束", () => {
    expect(pendingToolCalls(calls, [result("t1", "pending"), result("t2", "pending")])).toEqual(
      calls,
    );
    for (const done of ["completed", "error", "aborted"]) {
      expect(pendingToolCalls(calls, [result("t1", done), result("t2", "pending")])).toEqual([
        calls[1],
      ]);
    }
  });

  it("没有 id 的旧式 function_call 算在跑（宁可多念一个名字也不猜）", () => {
    expect(pendingToolCalls([{ name: "legacy" }], [])).toEqual([{ name: "legacy" }]);
  });
});
