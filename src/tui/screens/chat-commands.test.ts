// 命令层回归：会话内容被「物理剔除」后，转录显示起点必须跟着重置。
//
// `/migrate` 走 `prune` 策略，把 `agent.messages` 砍到「系统提示 + 交接断点」（1~2 条）。
// 若 `transcriptFrom` 仍停在旧值，`messages.slice(transcriptFrom)` 恒为空 —— 迁移成功、
// 上下文里有内容，但屏幕一片空白。这类「状态与显示起点脱节」的 bug 只有真机才看得见，
// 所以在这里用最小 host 假件把它钉住。
import { describe, expect, it, vi } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { runCommand, type ChatCommandHost } from "./chat-commands.js";
import type { ChatSession } from "../chat-session.js";

/** 只造 runCommand 实际会碰到的字段，其余用 noop 顶住 */
function createHost(overrides: Record<string, unknown> = {}) {
  const notices: Array<{ text: string; tone?: "info" | "error" }> = [];
  const session = {
    messages: [{ role: AgentNS.Role.User, content: "hi" }],
    agentId: "default",
    modelId: "m1",
    migrate: vi.fn(async () => "/tmp/handoff.md"),
    reset: vi.fn(async () => "chat_archived"),
    save: vi.fn(async () => "chat_saved"),
    ...overrides,
  };
  const host = {
    session: session as unknown as ChatSession,
    notice: (text: string, tone?: "info" | "error") => notices.push({ text, tone }),
    clearTranscript: vi.fn(),
    rows: 24,
    exit: vi.fn(),
    suspendTerminal: async (fn: () => void | Promise<void>) => {
      await fn();
    },
    openWizard: vi.fn(async () => {}),
    openKeyEditor: vi.fn(async () => {}),
    doExit: vi.fn(async () => {}),
    setPickerState: vi.fn(),
    setConfirmState: vi.fn(),
    setInputText: vi.fn(),
    setEffortView: vi.fn(),
    refreshLocale: vi.fn(),
  } as unknown as ChatCommandHost;
  return { host, notices, session };
}

describe("/migrate：prune 后必须重置转录显示起点", () => {
  it("迁移成功后调用 clearTranscript（否则 messages 变短、屏幕一片空白）", async () => {
    const { host, notices } = createHost();
    await runCommand("migrate", "/migrate self", host);
    expect(host.clearTranscript).toHaveBeenCalledTimes(1);
    expect(notices.map((n) => n.text).join("\n")).toContain("/tmp/handoff.md");
  });

  it("迁移失败时不重置（保留现场给用户看）", async () => {
    const { host } = createHost({
      migrate: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await runCommand("migrate", "/migrate self", host);
    expect(host.clearTranscript).not.toHaveBeenCalled();
  });

  it("显式执行者参数非法时完全不调 migrate", async () => {
    const { host, session } = createHost();
    await runCommand("migrate", "/migrate nobody", host);
    expect(session.migrate).not.toHaveBeenCalled();
    expect(host.clearTranscript).not.toHaveBeenCalled();
  });
});

describe("/new：归档后重置转录显示起点", () => {
  it("session.reset 之后调用 clearTranscript", async () => {
    const { host } = createHost();
    await runCommand("new", "/new", host);
    expect(host.clearTranscript).toHaveBeenCalledTimes(1);
  });
});
