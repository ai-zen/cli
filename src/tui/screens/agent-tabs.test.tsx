// Agent 栏目渲染：断言「主 / 子 Agent 都上屏、当前项高亮、执行状态内联、恒为一行」。
//
// 恒为一行是硬要求：它参与 `computeChatLayout` 的底部高度预算（`AGENT_TABS_LINES`），
// 一旦 Ink 自己折出第二行，整帧就比预算高一行、把输入框顶出屏幕——与状态栏折行那类
// bug 同源。所以这里要在「内容远超一屏宽」时断言仍然只有一行。
//
// 执行状态（● / ✓ / ✖）内联在标签尾部，而不是另推一条通知：通知栏凭空多一行会让
// 整帧高度跳一下，这正是本设计要避免的。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { AgentTabs, agentTabStyle, agentStatusColor, AGENT_STATUS_DOT, type AgentTab } from "./agent-tabs.js";
import { theme } from "../theme.js";

const tabs: AgentTab[] = [
  { id: "main", label: "主AGENT" },
  { id: "sub-1", label: "子AGENT1", status: "running" },
  { id: "sub-2", label: "子AGENT2", status: "done" },
];

const draw = (items: AgentTab[], activeId: string): string => {
  const { lastFrame, unmount } = render(<AgentTabs tabs={items} activeId={activeId} />);
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
};

describe("AgentTabs（主 / 子 Agent 切换条）", () => {
  it("按出现顺序列出，标签内部不留空格（主AGENT / 子AGENT1 / 子AGENT2）", () => {
    const frame = draw(tabs, "main");
    expect(frame).toContain("主AGENT");
    expect(frame).toContain("子AGENT1");
    expect(frame).toContain("子AGENT2");
    expect(frame.indexOf("主AGENT")).toBeLessThan(frame.indexOf("子AGENT1"));
    expect(frame.indexOf("子AGENT1")).toBeLessThan(frame.indexOf("子AGENT2"));
  });

  it("执行状态用圆点内联在标签尾部（同形，靠颜色区分）", () => {
    const frame = draw(
      [
        { id: "main", label: "主AGENT" },
        { id: "a", label: "子AGENT1", status: "running" },
        { id: "b", label: "子AGENT2", status: "done" },
        { id: "c", label: "子AGENT3", status: "failed" },
      ],
      "main",
    );
    // 符号在标签**之前**（作状态指示符），且选项自带左右各 1 空格 padding
    expect(frame).toContain(`${AGENT_STATUS_DOT}子AGENT1`);
    expect(frame).toContain(`${AGENT_STATUS_DOT}子AGENT2`);
    expect(frame).toContain(`${AGENT_STATUS_DOT}子AGENT3`);
    expect(AGENT_STATUS_DOT).toBe("◈");
  });

  it("每个选项自带左右各 1 空格 padding（分隔空白属于前一项，不贴上一项文案）", () => {
    const frame = draw(tabs, "main");
    // 每一项周围都恰好一个空格：「 主AGENT   ◈子AGENT1 」形状
    // （末项的尾空格会被 Ink trim，所以只断言非末项）
    expect(frame).toContain(" 主AGENT ");
    expect(frame).toContain(` ${AGENT_STATUS_DOT}子AGENT1 `);
    // 首项前恰好 1 空格：与输入行的 ❯、分隔线同列对齐（外层不再叠 paddingX）
    expect(frame.startsWith(" 主AGENT")).toBe(true);
  });

  it("状态三色：运行中蓝、完成绿、失败红", () => {
    // 颜色在测试里断言不了（无 ANSI），所以锁颜色映射：三态必须取到三个不同色，
    // 且分别对应主题里的 running / ok / error
    expect(agentStatusColor("running", true)).toBe(theme.running);
    expect(agentStatusColor("done")).toBe(theme.ok);
    expect(agentStatusColor("failed")).toBe(theme.error);
    expect(new Set([theme.running, theme.ok, theme.error]).size).toBe(3);
  });

  it("运行中的圆点闪烁：亮蓝与暗色交替（其余状态不闪）", () => {
    const bright = agentStatusColor("running", true);
    const dim = agentStatusColor("running", false);
    expect(bright).toBe(theme.running);
    expect(dim).toBe(theme.faint);
    expect(bright).not.toBe(dim);
    // 完成 / 失败不受 blinkOn 影响（不闪）
    expect(agentStatusColor("done", true)).toBe(agentStatusColor("done", false));
    expect(agentStatusColor("failed", true)).toBe(agentStatusColor("failed", false));
  });

  it("没有状态时不画标记（主 Agent 的忙碌由输入行 Spinner 表示）", () => {
    const frame = draw([{ id: "main", label: "主AGENT" }], "main");
    expect(frame).toContain("主AGENT");
    expect(frame).not.toContain(AGENT_STATUS_DOT);
  });

  it("当前项高亮：加粗 + 背景色块，其余项无背景", () => {
    // 颜色无法在测试里断言（ink-testing-library 的 stdout 不是 TTY，不输出 ANSI），
    // 所以锁样式契约：活动项与非活动项必须在三处上都可区分
    const on = agentTabStyle(true);
    const off = agentTabStyle(false);
    expect(on.bold).toBe(true);
    expect(on.backgroundColor).toBeTruthy();
    expect(off.bold).toBe(false);
    expect(off.backgroundColor).toBeUndefined();
    expect(on.color).not.toBe(off.color);
  });

  it("内容远超一屏宽时仍只占一行（截断而非折行）", () => {
    const many: AgentTab[] = Array.from({ length: 40 }, (_, i) => ({
      id: `sub-${i}`,
      label: `子AGENT${i + 1}`,
    }));
    const frame = draw([tabs[0]!, ...many], "main");
    expect(frame.split("\n")).toHaveLength(1);
  });

  it("只有主 Agent 时也正常渲染（组件本身不判断是否该显示）", () => {
    const frame = draw([tabs[0]!], "main");
    expect(frame).toContain("主AGENT");
    expect(frame.split("\n")).toHaveLength(1);
  });
});
