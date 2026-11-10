// 通知栏 —— 只负责「把算好的行画出来」。
//
// 折行、多条让位、条内截断这些排版决策都在 `notice.ts`（纯逻辑）里做完，这里只做
// 「逐行按 tone 着色」这一个动作。单独成组件是为了可测：`Chat` 依赖整条会话链路
// （读配置、建 Agent、连 MCP），无法单独渲染，通知有没有真的上屏就无法断言。
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { NoticeLine, NoticeTone } from "./notice.js";

/** 语气 → 颜色。warn 单独一档：它既不是「没事」，也还没到「报错」 */
const TONE_COLOR: Record<NoticeTone, string> = {
  info: theme.dim,
  warn: theme.warn,
  error: theme.error,
};

export function NoticeBar({ lines }: { lines: readonly NoticeLine[] }) {
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Text key={i} color={TONE_COLOR[line.tone]} wrap="truncate">
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
