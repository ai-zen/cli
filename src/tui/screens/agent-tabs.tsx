// Agent 栏目 —— 主 Agent 与各子 Agent 之间的切换条。
//
// 位置固定在「消息列表下方、通知栏上方」：它切换的是消息列表的内容，所以要紧贴
// 被它控制的那块区域。行为（何时出现、左右键怎么分流）在 chat.tsx，这里只负责画。
//
// 宽度：整条栏目**恰好占一行**。它参与 `computeChatLayout` 的底部高度预算，一旦
// Ink 自己折出第二行，整帧就会比预算高一行、把输入框顶出屏幕。
// 所以外层 `<Text wrap="truncate">` 兜住宽度，内层嵌套 `<Text>` 保住逐项着色
// （Ink 里截断发生在带 `wrap` 的那一层，不会把内层样式丢掉）。
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** 一个可切换的 Agent 条目 */
export interface AgentTab {
  /** 稳定 id：`"main"` 或子 Agent 视图 id */
  id: string;
  /** 展示名（主 Agent 用 `agentTabs.main`，子 Agent 用 `agentTabs.sub` 带序号） */
  label: string;
  /** 执行状态；undefined = 不画标记（主 Agent 的忙碌由输入行的 Spinner 表示） */
  status?: AgentTabStatus;
}

/** 子 Agent 的执行状态 */
export type AgentTabStatus = "running" | "done" | "failed";

/**
 * 状态字符 —— 内联在标签尾部。
 *
 * 不用通知栏报「子任务运行中 / 已完成」：通知栏多一行，整帧高度就跳一下。
 */
export const AGENT_STATUS_MARK: Record<AgentTabStatus, string> = {
  running: "●",
  done: "✓",
  failed: "✖",
};

export interface AgentTabsProps {
  tabs: readonly AgentTab[];
  /** 当前选中的 id；不在 `tabs` 里时按「主 Agent」处理 */
  activeId: string;
}

/**
 * 单个栏目的样式 —— 高亮规则的**唯一真相源**（组件与测试共用）。
 *
 * 抽成纯函数是因为颜色没法在测试里断言：`ink-testing-library` 的 stdout 不是 TTY，
 * Ink 不输出 ANSI（整帧只有纯文本），所以「当前项高亮」只能锁样式契约。
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

export function AgentTabs({ tabs, activeId }: AgentTabsProps) {
  return (
    <Box paddingX={1}>
      <Text wrap="truncate">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          // 状态字符紧贴在标签尾部（不加空格）：标签本身已经够紧凑，
          // 而执行状态属于这个 Agent 的一部分，不该另占地方
          const mark = tab.status ? AGENT_STATUS_MARK[tab.status] : "";
          return (
            <Text key={tab.id} {...agentTabStyle(active)}>
              {index === 0 ? "" : "  "}
              {`${tab.label}${mark}`}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
