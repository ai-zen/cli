// Agent 栏目 —— 主 Agent 与各子 Agent 之间的切换条。
//
// 位置固定在「消息列表下方、通知栏上方」：它切换的是消息列表的内容，所以要紧贴
// 被它控制的那块区域。行为（何时出现、左右键怎么分流）在 chat.tsx，这里只负责画。
//
// 宽度：整条栏目**恰好占一行**。它参与 `computeChatLayout` 的底部高度预算，一旦
// Ink 自己折出第二行，整帧就会比预算高一行、把输入框顶出屏幕。
// 所以外层 `<Text wrap="truncate">` 兜住宽度，内层嵌套 `<Text>` 保住逐项着色
// （Ink 里截断发生在带 `wrap` 的那一层，不会把内层样式丢掉）。
//
// 执行状态内联在标签**前**（一个圆点 + 颜色），不另推通知：通知栏凭空多一行会让整帧
// 高度跳一下。运行中的圆点会闪烁（亮蓝 ↔ 暗），完成后恒为绿色，失败恒为红色。
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** 一个可切换的 Agent 条目 */
export interface AgentTab {
  /** 稳定 id：`"main"` 或子 Agent 视图 id */
  id: string;
  /** 展示名（主 Agent 用 `agentTabs.main`，子 Agent 用 `agentTabs.sub` 带序号） */
  label: string;
  /** 执行状态；undefined = 不画圆点（主 Agent 的忙碌由输入行的 Spinner 表示） */
  status?: AgentTabStatus;
}

/** 子 Agent 的执行状态 */
export type AgentTabStatus = "running" | "done" | "failed";

/**
 * 状态符号：三种状态**同形不同色**（蓝 / 绿 / 红）。
 *
 * 用 `◈`（U+25C8）：比 `•` 更像个「状态指示符」，又不像 `●` 那样把一行密集文本撑得松散。
 * 符号位于标签**之前**，使各标签的文字起始位置对齐。
 */
export const AGENT_STATUS_DOT = "◈";

/**
 * 状态圆点的颜色 —— 状态的**唯一视觉真相**。
 *
 * 运行中在「亮蓝 ↔ 暗」之间交替（闪烁），其余状态恒定。抽成纯函数是因为颜色没法在
 * 测试里断言（`ink-testing-library` 的 stdout 不是 TTY，Ink 不输出 ANSI）。
 *
 * @param blinkOn 仅对 `running` 有意义：false 时返回暗色，形成一亮一暗的闪烁
 */
export function agentStatusColor(status: AgentTabStatus, blinkOn = true): string {
  if (status === "running") return blinkOn ? theme.running : theme.faint;
  return status === "done" ? theme.ok : theme.error;
}

/** 闪烁周期（毫秒）：一亮一暗为一个完整周期 */
export const AGENT_BLINK_MS = 500;

/**
 * 运行中时返回随时间翻转的开关（其余时候恒为 true，且不启定时器）。
 *
 * 定时器只在本组件内驱动自己的重渲染，不牵动上层：`AgentTabs` 的 state 变化只影响
 * 它自己这一行。
 */
export function useBlink(active: boolean, intervalMs = AGENT_BLINK_MS): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) {
      setOn(true);
      return;
    }
    const timer = setInterval(() => setOn((value) => !value), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return on;
}

/**
 * 单个栏目的样式 —— 高亮规则的**唯一真相源**（组件与测试共用）。
 *
 * 抽成纯函数是因为颜色没法在测试里断言，只能锁样式契约。
 */
export function agentTabStyle(active: boolean): {
  color: string;
  bold: boolean;
  backgroundColor?: string;
} {
  return {
    color: active ? theme.assistant : theme.faint,
    bold: active,
    // 背景色块比改字色更能一眼看出「现在看的是谁」；非活动项必须没有背景，否则整条都是高亮
    backgroundColor: active ? theme.border : undefined,
  };
}

export interface AgentTabsProps {
  tabs: readonly AgentTab[];
  /** 当前选中的 id；不在 `tabs` 里时按「主 Agent」处理 */
  activeId: string;
}

export function AgentTabs({ tabs, activeId }: AgentTabsProps) {
  // 只要有一个子 Agent 在跑就闪——整条栏目共用一个节奏，避免几个圆点各闪各的
  const blinkOn = useBlink(tabs.some((tab) => tab.status === "running"));

  return (
    <Box>
      <Text wrap="truncate">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          // 左右各一个空格作为选项**自身**的 padding（落在高亮块内部），而不是把分隔空格
          // 拼在下一个选项里——后者会让高亮底色贴住上一个选项的文案。
          // 也不靠外层 Box 的 paddingX：那样首个选项的文字会整体右移一格，与 ❯ / 分隔线不齐。
          return (
            <Text key={tab.id} {...agentTabStyle(active)}>
              {" "}
              {tab.status ? (
                <Text color={agentStatusColor(tab.status, blinkOn)}>{AGENT_STATUS_DOT}</Text>
              ) : null}
              {tab.label}
              {" "}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
