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
  /** 稳定 id：`"main"` 或子 Agent 视图 id（展示名可能重复，不能当 key） */
  id: string;
  /** 展示名（主 Agent 用 `agentTabs.main` 词条，子 Agent 用 skill id / 工具名） */
  label: string;
}

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
          return (
            <Text key={tab.id} {...agentTabStyle(active)}>
              {index === 0 ? " " : "  "}
              {` ${tab.label} `}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
