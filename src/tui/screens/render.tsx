// 行渲染（Ink 组件）—— RLine → <Text>
//
// 纯文本度量（`truncate` / `graphemes` / `clusterWidth`）在 `src/text.ts`：它零 UI 依赖，
// 所以命令层直接吃 `text.js`。本文件第一行就是 `import { Text } from "ink"`，只要有一个
// 命令层模块走本文件，`dist/commands/*.js` 的图上就会多出 ink 与 react/jsx-runtime。
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
  // `struck` 在最外层 Text 上生效：Ink 会把父级的 transform 作用在整段已拼接的文本上，
  // 于是分段着色照样保留、删除线一整行跨过去（不必给每个 span 单独标记）
  const struck = line.struck ?? false;
  if (line.spans && line.spans.length) {
    return (
      <Text
        color={baseColor(line.kind)}
        italic={line.kind === "reasoning"}
        strikethrough={struck}
        wrap="truncate"
      >
        {line.spans.map((span, i) => (
          <Text
            key={i}
            color={span.color}
            dimColor={span.dim}
            bold={span.bold}
            italic={span.italic}
          >
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
      return (
        <Text color={theme.user} bold strikethrough={struck}>
          {line.text}
        </Text>
      );
    case "user-text":
      return (
        <Text strikethrough={struck} wrap="truncate">
          {line.text}
        </Text>
      );
    case "ai-header":
      return (
        <Text color={theme.brand[2]} bold strikethrough={struck}>
          {line.text}
        </Text>
      );
    case "reasoning":
      return (
        <Text color={theme.reasoning} italic strikethrough={struck} wrap="truncate">
          {line.text}
        </Text>
      );
    case "tool":
      return (
        <Text color={theme.tool} strikethrough={struck} wrap="truncate">
          {line.text}
        </Text>
      );
    case "content":
      return (
        <Text strikethrough={struck} wrap="truncate">
          {line.text}
        </Text>
      );
    case "notice":
      return (
        <Text color={theme.dim} strikethrough={struck} wrap="truncate">
          {line.text}
        </Text>
      );
    case "error":
      return (
        <Text color={theme.error} strikethrough={struck} wrap="truncate">
          {line.text}
        </Text>
      );
    default:
      return <Text>{line.text}</Text>;
  }
}
