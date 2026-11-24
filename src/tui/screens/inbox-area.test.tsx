// 排队区（收下 `RunState.inbox` 的那条带子，住在阶段行之后、分割线之上）的护栏。
//
// 为什么单拎出来测：`computeChatLayout`（占高）、`computeInputCursorPosition`（IME 光标 y）、
// `InboxArea`（实际渲染行数）三处必须一致 —— 差一行，输入框整体位移、输入法候选框跟着偏。
// 本仓在这件事上有前科（通知栏漏算过），附件行、阶段行因此各有一套同样的用例。
import { describe, expect, it } from "vitest";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { setLocale, t } from "../../i18n/index.js";
import { InboxArea, inboxAreaLines, INBOX_MAX_ROWS } from "../components.js";
import { computeChatLayout } from "./layout.js";
import { computeInputCursorPosition } from "./input.js";
import { displayWidth } from "../text.js";
import type { InboxItem } from "../../session/types.js";

/** 渲染出来的非空行（空行不参与「占了几行」的判断） */
const lines = (frame: string) => frame.split("\n").filter((line) => line.trim().length > 0);

/** 一条排队 InboxEntry（形状照契约：`RunState.inbox` 的元素） */
function item(preview: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    messageId: `m-${preview}`,
    source: { kind: "user" },
    createdAt: "2026-01-01T00:00:00.000Z",
    priority: "high",
    preview,
    ...overrides,
  };
}

describe("InboxArea：显示规则", () => {
  it("① 0 条 → 整块不渲染、不占行", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={60}>
        <InboxArea items={[]} />
      </Box>,
    );
    expect(lines(lastFrame() ?? "")).toHaveLength(0);
    // 「不占行」是布局事实，不只是画面事实：0 条时这块必须报 0 行
    expect(inboxAreaLines(0)).toBe(0);
    unmount();
  });

  it("② 一条 → 显示 preview 与「排队中」前缀", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={60}>
        <InboxArea items={[item("先跑一遍测例再说")]} />
      </Box>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(t("inbox.pending"));
    expect(frame).toContain("先跑一遍测例再说");
    expect(lines(frame)).toHaveLength(1);
    unmount();
  });

  it("②-b 优先级写在每条最前面：high / low 原样上屏", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={60}>
        <InboxArea
          items={[
            item("高优先级那句", { priority: "high" }),
            item("低优先级那句", { priority: "low" }),
          ]}
        />
      </Box>,
    );
    const rendered = lines(lastFrame() ?? "");
    // 行首就是优先级：截掉前导空白后必须以协议用词开头
    expect(rendered[0]?.trimStart().startsWith("high")).toBe(true);
    expect(rendered[1]?.trimStart().startsWith("low")).toBe(true);
    unmount();
  });

  it("③ 四条 → 只渲染 3 行，第 3 行是「还有 2 条」（前两行照常显示前两条）", () => {
    setLocale("zh");
    const items = [item("第一句"), item("第二句"), item("第三句"), item("第四句")];
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={60}>
        <InboxArea items={items} />
      </Box>,
    );
    const rendered = lines(lastFrame() ?? "");
    expect(rendered).toHaveLength(INBOX_MAX_ROWS);
    expect(rendered[0]).toContain("第一句");
    expect(rendered[1]).toContain("第二句");
    // 第 3 行不是第三条 InboxEntry，而是「还有 N 条」（N = 没显示出来的条数 = 4 − 2）
    expect(rendered[2]).toContain(t("inbox.more", { n: 2 }));
    expect(rendered[2]).not.toContain("第三句");
    expect(lastFrame() ?? "").not.toContain("第四句");
    expect(inboxAreaLines(items.length)).toBe(INBOX_MAX_ROWS);
    unmount();
  });

  it("④ 超宽 preview 被截断、绝不折行", () => {
    setLocale("zh");
    const preview = `${"很长的排队摘要".repeat(20)}结尾标记`;
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={30}>
        <InboxArea items={[item(preview)]} />
      </Box>,
    );
    const rendered = lines(lastFrame() ?? "");
    // 折行的话这里会变成好几行 —— 那会把输入框顶出屏幕
    expect(rendered).toHaveLength(1);
    // 真的被裁掉了：结尾那一截没有上屏，行宽也在框内
    expect(rendered[0]).not.toContain("结尾标记");
    expect(displayWidth(rendered[0]!)).toBeLessThanOrEqual(30);
    unmount();
  });

  it("非 user 来源用来源名（超 12 字符截断），不走「排队中」词条", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={60}>
        <InboxArea
          items={[
            item("会话里排的一句", {
              messageId: "m-session",
              source: { kind: "agent", label: "session" },
            }),
            item("长来源名的一句", {
              messageId: "m-long",
              source: { kind: "system", label: "webhook-relay-alpha" },
            }),
          ]}
        />
      </Box>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("session");
    expect(frame).not.toContain(t("inbox.pending"));
    // 12 字符以内原样、超了截断加 `…`
    expect(frame).toContain("webhook-rela…");
    expect(frame).not.toContain("webhook-relay-alpha");
    unmount();
  });
});

describe("排队区参与布局与硬件光标", () => {
  const base = {
    columns: 80,
    rows: 24,
    transcript: [],
    input: "",
    hintCount: 0,
    overlay: "none" as const,
    pickerItems: 0,
  };

  it("computeChatLayout：有排队区时底部多占相应行数，消息区少相应行数", () => {
    const without = computeChatLayout({ ...base });
    const withInbox = computeChatLayout({ ...base, inboxLines: 2 });
    expect(withInbox.bottomLines).toBe(without.bottomLines + 2);
    expect(withInbox.budget).toBe(without.budget - 2);
    // 整帧高度不变（额度是从会话区扣的，不是把帧撑高）
    expect(withInbox.lines.length).toBe(withInbox.budget);
    // 3 行（InboxEntry 多于上限时）同样按实数计入
    expect(computeChatLayout({ ...base, inboxLines: 3 }).bottomLines).toBe(without.bottomLines + 3);
  });

  it("computeInputCursorPosition：排队区行数计入 y（否则 IME 候选框会偏高几行）", () => {
    const position = (inboxCount?: number) =>
      computeInputCursorPosition({
        transcriptLines: 5,
        hintCount: 0,
        cursorRow: 0,
        cursorCol: 0,
        lineText: "",
        placeholder: false,
        inboxCount,
      });
    expect(position(2).y).toBe(position(0).y + 2);
    expect(position(2).x).toBe(position(0).x);
  });
});
