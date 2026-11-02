// 命令层回归：会话内容被「物理剔除」后，转录显示起点必须跟着重置。
//
// `/migrate` 走 `prune` 策略，把 `agent.messages` 砍到「系统提示 + 交接断点」（1~2 条）。
// 若 `transcriptFrom` 仍停在旧值，`messages.slice(transcriptFrom)` 恒为空 —— 迁移成功、
// 上下文里有内容，但屏幕一片空白。这类「状态与显示起点脱节」的 bug 只有真机才看得见，
// 所以在这里用最小 host 假件把它钉住。
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import { runCommand, type ChatCommandHost } from "./chat-commands.js";
import type { ChatSession } from "../chat-session.js";
import { persistConversation } from "../../conversation-repository.js";
import { useTempAiZenDir } from "../../test-support/temp-dir.js";
import { computeChatLayout } from "./layout.js";
import { usableFrameRows } from "../text.js";

/** 会话落盘要真写文件（`/back` 的修复点就是「有没有落盘」），故需要独立的临时根 */
const zen = useTempAiZenDir("aiz-cmd-test-");
beforeEach(() => zen.pin());
afterAll(() => zen.cleanup());

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

describe("/new：归档后重置转录显示起点", () => {  it("session.reset 之后调用 clearTranscript", async () => {
    const { host } = createHost();
    await runCommand("new", "/new", host);
    expect(host.clearTranscript).toHaveBeenCalledTimes(1);
  });
});

/**
 * 回归（PLAN L8）：`/back` 撤回后只 `exit({ restart: true })` 重挂界面，没落盘 ——
 * 存档文件里仍留着被撤回的消息，下次 `/load` 或重启就「复活」。
 */
describe("/back：撤回后必须落盘", () => {
  it("撤回后的消息写回文件（被撤回的那条不再存在）", async () => {
    const messages: any[] = [
      { role: AgentNS.Role.User, content: "第一条" },
      { role: AgentNS.Role.Assistant, content: "答一" },
      { role: AgentNS.Role.User, content: "第二条" },
    ];
    // 先落一份「完整的」存档，模拟撤回前已自动保存
    await persistConversation({ id: "chat_back", messages, cwd: "/work" });

    const session = {
      messages,
      currentId: "chat_back",
      agentId: "default",
      modelId: "m1",
      rollbackTo: vi.fn((index: number) => {
        const removed = messages.splice(index);
        return removed.find((m) => m.role === AgentNS.Role.User)?.content ?? "";
      }),
      save: vi.fn(async () => persistConversation({ id: "chat_back", messages, cwd: "/work" })),
    };
    const { host } = createHost({ ...session });
    // 选择器直接作答：选「第二条」（它的 messages 下标为 2，列表里是最近在前，但 value 就是下标）
    (host as any).setPickerState = (next: any) => {
      const state = typeof next === "function" ? next(null) : next;
      if (state) state.resolve("2");
    };

    await runCommand("back", "/back", host);

    expect(session.rollbackTo).toHaveBeenCalledWith(2);
    expect(session.save).toHaveBeenCalledTimes(1);
    // 先撤回、再落盘（顺序反了就会把完整对话又写回去）
    expect(session.rollbackTo.mock.invocationCallOrder[0]!).toBeLessThan(
      session.save.mock.invocationCallOrder[0]!,
    );

    const saved = JSON.parse(readFileSync(join(zen.dir, "cli", "conversations", "chat_back.json"), "utf-8"));
    expect(saved.messages.map((m: any) => m.content)).toEqual(["第一条", "答一"]);
  });
});

/**
 * 回归（PLAN L15）：picker 的条数上限少扣了 2 行。命令层用的是**原始终端行数**
 * （`rows`），而布局里 `usableFrameRows(rows) = rows - 1`；覆盖层占
 * `pickerLines(n) + STATUS_BAR_LINES`。旧的 `rows - 8` 让 n_max 多出 2 条，
 * 于是选择器会把状态栏顶出屏幕。
 */
describe("picker 条数上限（不超出一帧）", () => {
  const ROWS = 24;
  /** 用布局自己的公式量一遍：这个条数放不放得下 */
  const fits = (pickerItems: number): boolean =>
    computeChatLayout({
      columns: 80,
      rows: ROWS,
      transcript: [],
      input: "",
      busy: false,
      hintCount: 0,
      overlay: "picker",
      pickerItems,
    }).bottomLines <= usableFrameRows(ROWS);

  /** 接管选择器：只记条数 / 标签并立即作答（不真弹覆盖层），返回记录值 */
  const capturePick = (host: ChatCommandHost, answer: string | null) => {
    const seen = { count: 0, labels: [] as string[] };
    (host as any).setPickerState = (next: any) => {
      const state = typeof next === "function" ? next(null) : next;
      if (!state) return;
      seen.count = state.items.length;
      seen.labels = state.items.map((item: any) => item.label);
      state.resolve(answer);
    };
    return seen;
  };

  it("/load：条数上限正好装进一帧（rows − 10）", async () => {
    for (let i = 0; i < 20; i += 1) {
      await persistConversation({
        id: `chat_${String(i).padStart(2, "0")}`,
        messages: [{ role: AgentNS.Role.User, content: `第 ${i} 条` }] as any,
        cwd: "/work",
      });
    }
    const { host } = createHost();
    (host as any).rows = ROWS;
    const seen = capturePick(host, null);

    await runCommand("load", "/load", host);

    expect(seen.count).toBe(ROWS - 10);
    expect(fits(seen.count)).toBe(true);
    // 对照：多一条就装不下（证明上界算对了，不是碰巧）
    expect(fits(seen.count + 1)).toBe(false);
    // 列表只显示会话文件名（id），不再解析首条消息当摘要
    expect(seen.labels.every((label) => /^chat_\d{2}$/.test(label))).toBe(true);
    expect(seen.labels.some((label) => label.includes("条"))).toBe(false);
  });

  it("/back：条数上限同/load", async () => {
    const messages = Array.from({ length: 20 }, (_v, i) => ({ role: AgentNS.Role.User, content: `第 ${i} 条` }));
    const { host } = createHost({ messages, rollbackTo: vi.fn(() => "") });
    (host as any).rows = ROWS;
    const seen = capturePick(host, null);

    await runCommand("back", "/back", host);

    expect(seen.count).toBe(ROWS - 10);
    expect(fits(seen.count)).toBe(true);
  });
});
