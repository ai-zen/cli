/**
 * Ink 通用组件 —— Spinner / 选择列表 / 状态栏 / 斜杠命令菜单 / 键位提示
 */

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { theme } from "./theme.js";
import { clipWidth } from "./text.js";
import type { CommandHint } from "../conversation-commands/registry.js";
import type { RateSample } from "./token-rate.js";
import { packSegments, type StatusSegment } from "./status-segments.js";
import { t } from "../i18n/index.js";

// ==================== Spinner ====================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    // `truncate`：busy 时输入区高度被 `computeChatLayout` 固定为 1 行（`inputHeight = 1`），
    // 标签（如「排队中…（等待首 token）」）一旦折行就会把输入框顶出屏幕。
    <Text wrap="truncate">
      <Text color={theme.brand[0]}>{SPINNER_FRAMES[frame]}</Text>
      {label ? <Text color={theme.dim}> {label}</Text> : null}
    </Text>
  );
}

// ==================== 选择列表 ====================

export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
  icon?: string;
}

export interface SelectListProps<T> {
  items: SelectItem<T>[];
  onSelect: (value: T) => void;
  isActive?: boolean;
  initialIndex?: number;
  /**
   * 终端列数：提供时把每项裁成严格单行。
   *
   * 「吸底」布局的顶部留白是按行数算的，任一条目折行都会多占一行、把整帧顶高一格，
   * 故列表类屏幕必须传它。
   */
  columns?: number;
}

/** 把列表项裁到单行（给提示文字留出空间）；未提供列数则原样返回 */
function fitItem<T>(item: SelectItem<T>, columns?: number): SelectItem<T> {
  if (!columns) return item;
  const available = Math.max(8, columns - 4); // 左留白 2 + 光标 2
  if (!item.hint) return { ...item, label: clipWidth(item.label, available) };
  const labelMax = Math.max(6, Math.floor(available * 0.55));
  const hintMax = Math.max(4, available - labelMax - 2);
  return { ...item, label: clipWidth(item.label, labelMax), hint: clipWidth(item.hint, hintMax) };
}

export function SelectList<T>({ items, onSelect, isActive = true, initialIndex = 0, columns }: SelectListProps<T>) {
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(items.length - 1, 0)));

  useInput(
    (_input, key) => {
      if (items.length === 0) return;
      if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % items.length);
      else if (key.return) onSelect(items[index].value);
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {items.map((raw, i) => {
        const item = fitItem(raw, columns);
        const selected = i === index;
        return (
          <Box key={`${i}-${raw.label}`}>
            <Text color={selected ? theme.brand[0] : theme.faint} wrap="truncate">
              {selected ? "❯ " : "  "}
            </Text>
            <Text bold={selected} color={selected ? theme.highlight : theme.assistant} wrap="truncate">
              {item.icon ? `${item.icon} ` : ""}
              {item.label}
            </Text>
            {item.hint ? (
              <Text color={theme.dim} wrap="truncate">
                {"  "}
                {item.hint}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

// ==================== 状态栏 ====================

export interface StatusBarProps {
  model: string;
  agent: string;
  /** 思考强度文案（已按当前语言本地化）；不传则不展示该段 */
  effort?: string | null;
  /**
   * 思考强度是否置灰（不可调档 / 关档）。
   *
   * **不能靠文案判断**（旧实现是 `effort === "关"`，英文界面下永远不成立），
   * 由调用方基于档位语义计算（见 `reasoning-effort.ts` 的 `effortDimmed()`）。
   */
  effortDimmed?: boolean;
  /** 最近一轮的 token 用量（lastUsage.total_tokens） */
  lastTokens?: number;
  /** 本会话累计 token 用量（含子 Agent） */
  totalTokens?: number;
  busy?: boolean;
  hint?: string;
  /** 生成速率：生成中看 `live`（实时估算），结束后看 `average`（本轮平均） */
  rate?: RateSample | null;
  /** 终端列数（用于折行与行数测量）；缺省 80 */
  columns?: number;
}

/** 不换行空格：把「数字 + 单位」绑成一个整体，折行时不会被拆成「1284」/「tok」两行 */
const NBSP = "\u00a0";

/** 速率文案：两位数以上取整（避免小数跳得眼花），个位数保留一位 */
function formatRate(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  return value >= 10 ? `${Math.round(value)}${NBSP}tok/s` : `${value.toFixed(1)}${NBSP}tok/s`;
}

/** 块内并排用的分隔符（同色的不属于任何块，折行时随块边界消失） */
const INNER_SEPARATOR = " · ";

/**
 * 状态栏的三个信息块 —— **换行以块为单位**：
 *
 * 1. 身份块：模型 · Agent · 思考强度（最优先，任何情况下先占首行）；
 * 2. 用量块：本轮 / 累计 token · 生成速率；
 * 3. 快捷键块（优先级最低，放末尾）。
 *
 * 每块内部不再拆行（除单块宽度超一整行），窄屏时整块顺延到下一行——而不是用
 * `space-between` 把两侧各切一半。块内空的部分（如本轮没有速率）直接不占位。
 */
export function statusBarBlocks(props: StatusBarProps): StatusSegment[][] {
  const { model, agent, effort, effortDimmed, lastTokens, totalTokens, busy, hint, rate } = props;

  // ① 身份块
  const identity: StatusSegment[] = [];
  const pushIdentity = (text: string, color: string) => identity.push({ text, color });
  pushIdentity("◆ ", theme.brand[0]);
  pushIdentity(model, theme.accent);
  pushIdentity(t("status.agent"), theme.dim);
  pushIdentity(agent, theme.assistant);
  if (effort != null && effort !== "") {
    pushIdentity(t("status.effort"), theme.dim);
    pushIdentity(effort, effortDimmed ? theme.faint : theme.reasoning);
  }

  // ② 用量块
  const usage: StatusSegment[] = [];
  const pushUsage = (text: string, color: string) => {
    if (usage.length > 0) usage.push({ text: INNER_SEPARATOR, color: theme.dim });
    usage.push({ text, color });
  };
  if (lastTokens != null) pushUsage(t("status.lastTokens", { n: lastTokens }), theme.dim);
  if (totalTokens != null) pushUsage(t("status.totalTokens", { n: totalTokens }), theme.dim);
  // 生成中只认实时值（没有就留白，避免把上一轮的均速冒充成本轮）；空闲时展示本轮平均。
  // 用 `busy` 而不是 `rate.running` 做门闸：`/migrate` 这类命令也会 busy，但不算一轮对话。
  const rateText = busy
    ? rate?.live != null
      ? `⚡${NBSP}${formatRate(rate.live)}`
      : ""
    : rate?.average != null
      ? t("status.avgRate", { rate: formatRate(rate.average) })
      : "";
  if (rateText) pushUsage(rateText, theme.tool);
  // 「生成中」这一段不再往状态栏放：本轮到底在干什么（连上没、等首字、想、调工具、出字）
  // 已由消息栏 spinner 逐阶段说明，状态栏再挂一个笼统的「生成中」只是重复占宽度。

  // ③ 快捷键块：能被挤掉的永远是它，所以排在最末
  const keys: StatusSegment[] = hint ? [{ text: hint, color: theme.faint }] : [];

  return [identity, usage, keys];
}

/**
 * 折行后的实际行 —— **行数即状态栏占用的终端行数**。
 *
 * 调用方（`chat.tsx`）先拿它算行数交给 `computeChatLayout`，再交给 `StatusBar` 渲染，
 * 两处用的是同一个纯函数，测量与渲染不会脱节。
 *
 * 装行以块为单位（见 `packSegments`）：放得下就并排，放不下就把整块挪到下一行。
 */
export function statusBarRows(props: StatusBarProps, columns = 80): StatusSegment[][] {
  // 可用宽度 = 列数 − 2（两侧 paddingX(1)）− 1（安全余量）。
  //
  // 那 1 列余量原本是必需的：当时我们自己算宽度，`◆` / `·` / `⚡` 这类字符与 Ink 的
  // 测量差 1 列，按满宽算时会被 Ink 的 `truncate` 吃掉行尾半个词。现在 `displayWidth()`
  // 直接就是 Ink 用的 `string-width`，两边不会再对不上；这 1 列降级为纯安全边际
  //（终端自己的 Ambiguous 宽度判定仍可能与 Unicode 表不同），所以保留。
  const width = Math.max(8, columns - 3);
  return packSegments(statusBarBlocks(props), width, [{ text: INNER_SEPARATOR, color: theme.dim }]);
}

/**
 * 底部状态栏 —— 三个信息块，窄屏时按块换行：
 *
 * 模型 · Agent · 思考强度 ｜ 本轮 / 累计 token · 生成速率 · 生成状态 ｜ 快捷键提示。
 *
 * 行数不固定：放不下的块（从最末的快捷键提示开始）整块顺延到下一行，而不是与
 * 高位信息一起被截掉一半，也不会把某块劈成两半。
 */
export function StatusBar(props: StatusBarProps) {
  const rows = statusBarRows(props, props.columns ?? 80);
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      {rows.map((row, index) => (
        <Box key={index} paddingX={1} width="100%">
          {/* `truncate` 是兜底：折行已在 statusBarRows 里算好，万一有出入也不允许 Ink
              再折出第 N+1 行（多一行就把输入框顶出屏幕）。 */}
          <Text wrap="truncate">
            {row.map((segment, i) => (
              <Text key={i} color={segment.color} bold={segment.bold}>
                {segment.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ==================== 斜杠命令菜单 ====================

export interface SlashMenuProps {
  hints: CommandHint[];
  selected: number;
}

export function SlashMenu({ hints, selected }: SlashMenuProps) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {hints.map((hint, i) => {
        const active = i === selected;
        return (
          <Box key={hint.label}>
            <Text color={active ? theme.brand[0] : theme.faint}>{active ? "❯ " : "  "}</Text>
            <Text bold={active} color={active ? theme.highlight : theme.assistant}>
              {hint.label}
            </Text>
            <Text color={theme.dim}>  {hint.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ==================== 键位提示 ====================

export function KeyHints({ hints }: { hints: [string, string][] }) {
  return (
    <Box paddingLeft={2} gap={2}>
      {hints.map(([key, label]) => (
        <Text key={key} color={theme.faint} wrap="truncate">
          <Text color={theme.dim} wrap="truncate">{key}</Text> {label}
        </Text>
      ))}
    </Box>
  );
}
