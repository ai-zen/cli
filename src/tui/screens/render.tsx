// 行渲染（Ink 组件）—— RLine → <Text>
import { Text } from "ink";
import { theme } from "../theme.js";
import { RLine, type LineKind } from "./lines.js";

/** 行 kind → 基础色（分段渲染时作默认色；`undefined` = 终端默认前景色） */
function baseColor(kind: LineKind): string | undefined {
  switch (kind) {
    case "user-header":
      return theme.user;
    case "ai-header":
      return theme.brand[2];
    case "reasoning":
      return theme.reasoning;
    case "tool":
      return theme.tool;
    // 正文**不指定颜色**：用终端默认前景色渲染，避免写死近白（如 #e2e8f0）后
    // 在亮色主题终端里「白底白字」看不见。绝对色只留给需要强调的分段（标题/代码等）。
    case "content":
      return undefined;
    case "notice":
      return theme.dim;
    case "error":
      return theme.error;
    default:
      return undefined;
  }
}

export function LineView({ line }: { line: RLine }) {
  // 语法高亮行：逐段渲染（外层给基础色，分段各自覆盖色）
  if (line.spans && line.spans.length) {
    return (
      <Text color={baseColor(line.kind)} italic={line.kind === "reasoning"} wrap="truncate">
        {line.spans.map((span, i) => (
          <Text key={i} color={span.color} dimColor={span.dim} bold={span.bold} italic={span.italic}>
            {span.text}
          </Text>
        ))}
      </Text>
    );
  }
  switch (line.kind) {
    case "gap":
      return <Text>{line.text}</Text>;
    case "user-header":
      return <Text color={theme.user} bold>{line.text}</Text>;
    case "user-text":
      return <Text wrap="truncate">{line.text}</Text>;
    case "ai-header":
      return <Text color={theme.brand[2]} bold>{line.text}</Text>;
    case "reasoning":
      return <Text color={theme.reasoning} italic wrap="truncate">{line.text}</Text>;
    case "tool":
      return <Text color={theme.tool} wrap="truncate">{line.text}</Text>;
    case "content":
      return <Text wrap="truncate">{line.text}</Text>;
    case "notice":
      return <Text color={theme.dim} wrap="truncate">{line.text}</Text>;
    case "error":
      return <Text color={theme.error} wrap="truncate">{line.text}</Text>;
    default:
      return <Text>{line.text}</Text>;
  }
}

/** 单行化文本（表格 / 列表项用）：折叠空白并截断 */
export function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
