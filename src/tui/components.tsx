/**
 * Ink 通用组件 —— Spinner / 选择列表 / 状态栏 / 斜杠命令菜单 / 键位提示
 */

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { theme } from "./theme.js";
import { clipWidth } from "./text.js";
import type { CommandHint } from "../conversation-commands/registry.js";

// ==================== Spinner ====================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text>
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
  tokens?: number;
  busy?: boolean;
  hint?: string;
}

export function StatusBar({ model, agent, tokens, busy, hint }: StatusBarProps) {
  return (
    <Box paddingX={1} justifyContent="space-between" flexShrink={0} width="100%">
      <Text wrap="truncate">
        <Text color={theme.brand[0]}>◆ </Text>
        <Text color={theme.accent}>{model}</Text>
        <Text color={theme.dim}> · agent </Text>
        <Text color={theme.assistant}>{agent}</Text>
        {tokens != null ? <Text color={theme.dim}> · {tokens} tok</Text> : null}
        {busy ? <Text color={theme.tool}> · ⏳ 生成中</Text> : null}
      </Text>
      <Text color={theme.faint} wrap="truncate">
        {hint ?? ""}
      </Text>
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
