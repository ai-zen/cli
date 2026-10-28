// 通知栏 —— 只负责「把算好的行画出来」。
//
// 折行、多条让位、条内截断这些排版决策都在 `notice.ts`（纯逻辑）里做完，这里只做
// 「逐行按 tone 着色」这一个动作。单独成组件是为了可测：这段映射原先内联在 `Chat`
// 的 JSX 里，而 `Chat` 依赖整条会话链路（读配置、建 Agent、连 MCP），无法单独渲染，
// 于是「通知有没有真的上屏」始终没有断言。
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { NoticeLine } from "./notice.js";

export function NoticeBar({ lines }: { lines: readonly NoticeLine[] }) {
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Text key={i} color={line.tone === "error" ? theme.error : theme.dim} wrap="truncate">
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
