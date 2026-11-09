/**
 * 阶段文案测试。
 *
 * 状态机（六态判定 / 谁还在跑）的测试跟着状态机走，现在在
 * `agents/packages/server/src/service/progress/PhaseTracker.test.ts`；
 * 这里只断言「事实 → 人话」这一层。
 */

import { describe, it, expect, afterEach } from "vitest";
import { phaseLabel } from "./phase-label.js";
import { DEFAULT_LOCALE, setLocale } from "../i18n/index.js";

afterEach(() => setLocale(DEFAULT_LOCALE));

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
