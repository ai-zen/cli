/**
 * 阶段文案用例：**几样契约事实 → 一句话**。
 *
 * 新契约里没有阶段值（没有六态、没有 `generation`）：宿主只报忙闲，更细的「排队 / 在想 / 在拼
 * 工具 / 在等工具 / 在出字」由客户端按「那条消息的 `status` / `reasoning_content` / `content` /
 * `tool_calls`」与「inbox 里还压着几句」自己推。所以这里断言的是「事实 → 人话」这一层，
 * 一句话都不许变成可以存下来的一格。
 */

import { afterEach, describe, expect, it } from "vitest";
import { phaseLine } from "./session-phase.js";
import type { PhaseFacts } from "./session-phase.js";
import { DEFAULT_LOCALE, setLocale } from "./i18n/index.js";
import { AgentNS } from "@ai-zen/agents-core";

afterEach(() => setLocale(DEFAULT_LOCALE));

/** 一条 AgentDefinition 消息（只写用例关心的那几格） */
function assistant(overrides: Partial<AgentNS.Message> = {}): AgentNS.Message {
  return {
    id: "m1",
    // `createdAt` 是 core 的必填格（夹具补齐，断言一个字不动）
    createdAt: overrides.createdAt ?? 1,
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Writing,
    ...overrides,
  };
}

const user = (): AgentNS.Message => ({
  id: "u1",
  createdAt: 1,
  role: AgentNS.Role.User,
  content: "hi",
});

const toolCall = (name?: string, id = "t1"): AgentNS.ToolCall => ({
  id,
  function: name === undefined ? {} : { name },
});

const toolResult = (callId: string): AgentNS.Message => ({
  id: `r-${callId}`,
  createdAt: 1,
  role: AgentNS.Role.Tool,
  tool_call_id: callId,
  content: "ok",
});

/** 一条「没排队」的现读事实：用例只关心消息那几格时就写这个 */
const inline = (messages: AgentNS.Message[]) => ({
  status: "working" as const,
  messages,
  inboxPending: 0,
});

/**
 * 用例的默认入口：`handingOff` 缺省为 `false`（不在交接）。
 *
 * 只有交接那一条用例会显式把它写成 `true` —— 生产里两个调用点（会话屏、`/sessions`）都从
 * `session.handoffSince` 现取现传，不存在「忘了传」这一路径。
 */
const line = (facts: Omit<PhaseFacts, "handingOff"> & { handingOff?: boolean }) =>
  phaseLine({ handingOff: false, ...facts });

describe("phaseLine（契约事实 → 阶段那一句话）", () => {
  it("手上没活 → `null`（不占行）", () => {
    setLocale("zh");
    expect(line({ status: "idle", messages: [], inboxPending: 0 })).toBeNull();
    // 读数还没到也不许说「在忙什么」
    expect(line({ status: null, messages: [assistant()], inboxPending: 0 })).toBeNull();
  });

  it("忙、但这一批的消息还没落下来 → 连接中…", () => {
    setLocale("zh");
    expect(line({ status: "working", messages: [], inboxPending: 0 })).toBe("连接中…");
    // 用户那句刚落、AgentDefinition 那条还没冒出来：同样还在等
    expect(line({ status: "working", messages: [user()], inboxPending: 0 })).toBe("连接中…");
  });

  it("**排队 = inbox 里有货**：话还没被取走、屏上还没有它一个字", () => {
    setLocale("zh");
    // 一条消息都还没有，队里压着一句 → 排队
    expect(line({ status: "working", messages: [], inboxPending: 1 })).toBe("排队中…");
    // 用户那句刚落（AgentDefinition 那条还没冒头）、后面还压着一句 → 排队
    expect(line({ status: "working", messages: [user()], inboxPending: 2 })).toBe("排队中…");
    // AgentDefinition 那条冒头了但还空着、队里还有货 → 还是排队（一个字都没吐出来）
    expect(line({ status: "working", messages: [user(), assistant()], inboxPending: 1 })).toBe(
      "排队中…",
    );
  });

  it("一旦这一批吐出东西就不再是排队（队里那几句由排队区自己回显）", () => {
    setLocale("zh");
    for (const message of [
      assistant({ reasoning_content: "想一想" }),
      assistant({ content: "答案是" }),
      assistant({ tool_calls: [toolCall("read_file")] }),
    ]) {
      expect(line({ status: "working", messages: [user(), message], inboxPending: 3 })).not.toBe(
        "排队中…",
      );
    }
  });

  it("没排队、助手那条还空着 → 等待首字…（请求已发出，服务端还没吐字）", () => {
    setLocale("zh");
    expect(line(inline([user(), assistant()]))).toBe("等待首字…");
  });

  it("思考与正文分开：只有 reasoning_content 说思考中，有正文才说输出中", () => {
    setLocale("zh");
    expect(line(inline([user(), assistant({ reasoning_content: "想一想" })]))).toBe("思考中…");
    expect(
      line(inline([user(), assistant({ reasoning_content: "想一想", content: "答案是" })])),
    ).toBe("输出中…");
  });

  it("拼工具参数时把已知的工具名念出来（名字还没到就只说在拼）", () => {
    setLocale("zh");
    expect(line(inline([user(), assistant({ tool_calls: [toolCall("read_file")] })]))).toBe(
      "调用工具 read_file…",
    );
    expect(line(inline([user(), assistant({ tool_calls: [toolCall()] })]))).toBe("调用工具…");
  });

  it("参数拼完（`finish_reason: tool_calls`）→ 等待工具返回，并行时把名字全念出来", () => {
    setLocale("zh");
    expect(
      line(
        inline([
          user(),
          assistant({
            tool_calls: [toolCall("grep")],
            finish_reason: AgentNS.FinishReason.ToolCalls,
          }),
        ]),
      ),
    ).toBe("等待 grep 返回…");
    expect(
      line(
        inline([
          user(),
          assistant({
            tool_calls: [toolCall("edit", "t1"), toolCall("exec", "t2")],
            finish_reason: AgentNS.FinishReason.ToolCalls,
          }),
        ]),
      ),
    ).toBe("等待 edit、exec 返回…");
  });

  it("工具结果回来一条 → 只报还没回来的那几个（读消息本身，不另记一份在跑的工具）", () => {
    setLocale("zh");
    const call = assistant({
      tool_calls: [toolCall("edit", "t1"), toolCall("exec", "t2")],
      finish_reason: AgentNS.FinishReason.ToolCalls,
    });
    expect(line(inline([user(), call, toolResult("t1")]))).toBe("等待 exec 返回…");
    // 两条都回来了：还剩一句「等待工具返回」（下一次请求正在路上）
    expect(line(inline([user(), call, toolResult("t1"), toolResult("t2")]))).toBe("等待工具返回…");
  });

  it("六句话都在，且彼此可分辨（都说「处理中…」的话用户分不清在排队、思考还是出字）", () => {
    setLocale("zh");
    const lines = [
      line({ status: "working", messages: [], inboxPending: 0 }), // 连上了
      line({ status: "working", messages: [], inboxPending: 1 }), // 排队
      line(inline([user(), assistant({ reasoning_content: "x" })])), // 在想
      line(inline([user(), assistant({ content: "x" })])), // 在输出
      line(inline([user(), assistant({ tool_calls: [toolCall()] })])), // 调工具
      line(
        inline([
          user(),
          assistant({ tool_calls: [toolCall()], finish_reason: AgentNS.FinishReason.ToolCalls }),
        ]),
      ), // 等工具回来
    ];
    expect(new Set(lines).size).toBe(6);
  });

  it("英文界面同一套事实换一种说法", () => {
    setLocale("en");
    expect(line(inline([user(), assistant({ reasoning_content: "x" })]))).toBe("Thinking…");
    expect(line({ status: "working", messages: [], inboxPending: 1 })).toBe("Waiting in queue…");
    expect(
      line(
        inline([
          user(),
          assistant({
            tool_calls: [toolCall("grep")],
            finish_reason: AgentNS.FinishReason.ToolCalls,
          }),
        ]),
      ),
    ).toBe("Waiting for grep…");
  });

  it("**正在交接**盖过其余一切：闲也在说、忙也在说（PRD 4.5）", () => {
    setLocale("zh");
    // 独立交接那一路没有流可看，这一格会是 idle —— 仍然要说「正在交接」
    expect(line({ status: "idle", messages: [], inboxPending: 0, handingOff: true })).toBe(
      "正在交接…",
    );
    // 自交接在写文档（忙）：不报「思考中 / 输出中」，只说正在交接
    expect(
      line({
        status: "working",
        messages: [assistant({ content: "x" })],
        inboxPending: 0,
        handingOff: true,
      }),
    ).toBe("正在交接…");
    // 读数还没回来也一样（交接是宿主挂牌的事实，不靠忙闲判）
    expect(line({ status: null, messages: [], inboxPending: 2, handingOff: true })).toBe(
      "正在交接…",
    );
    setLocale("en");
    expect(line({ status: "idle", messages: [], inboxPending: 0, handingOff: true })).toBe(
      "Handing off…",
    );
  });
});
