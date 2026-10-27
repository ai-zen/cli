/**
 * 可测量的输入行 —— 让**渲染器自己**告诉我们虚拟光标在第几列、第几行
 *
 * ## 为什么要测量，而不是算
 *
 * 真实光标 = (x, y)。y 是行号，不依赖宽度计算；x 取决于「光标前那段文本占几列」。
 * 而宽度是个陷阱：Ink 排版时用 `string-width`（`ink/build/output.js`），我们手写的
 * `displayWidth` 与它在若干字符上不一致 —— 实测 `⚡` `✅` `✨` `⭐` 这类 East Asian
 * Wide 符号（我们算 1、Ink 算 2）、ZWJ 组合 emoji `👨‍👩‍👧`（我们算 8、Ink 算 2）、
 * keycap `1️⃣`（我们算 3、Ink 算 2）。输入里只要出现这类字符，算出来的 x 就会偏。
 *
 * 既然这一行**已经渲染出来了**，最可靠的来源就是渲染器本身：Ink 7 的
 * `measureElement()` 返回元素的布局坐标 `{ x, y, width, height }`（内部累加所有
 * 祖先 offset），拿到的就是帧内绝对列 / 行。
 *
 * ## 为什么光标块要单独包一个 Box
 *
 * `measureElement()` 只能量**有独立布局节点**（yoga node）的元素。把整行写成
 * 一个 `<Text>` 里嵌套若干片段时，那些片段在排版中被并进父文本节点，对它们调用
 * `measureElement()` 直接返回 `null`（实测）。所以这里把**光标所在的那个字符**
 * 单独包进 `<Box ref>`：它成为真实节点，坐标就能被测出来。
 *
 * ## 拆行之后怎么保住「一行就是一行」
 *
 * 整行拆成多个节点后，原本 `<Text wrap="truncate">` 的整行截断兜底就不存在了：
 * 一旦内容超宽（例如宽度模型把 `⚡` 算成 1 列而 Ink 按 2 列排），这一行会被顶成
 * 两行，整帧高度 +1，底部输入框/状态栏会被顶出屏幕。
 *
 * 解法是让溢出被**可截断的邻段吸收**：`before` / `after` 两段设为
 * `flexShrink={1} minWidth={0}` + `wrap="truncate"`，光标块 `flexShrink={0}`。
 * 实测：容器 40、`before` 60 列时仍是**一行**（行高 1），光标被钳在可用区边缘。
 *
 * ## 时序
 *
 * `measureElement()` 只能在渲染之后（`useEffect`）调用，而 Ink 的 `setCursorPosition`
 * 只在 commit 阶段（`useInsertionEffect`）把位置推给渲染器，所以「测量 → 上报」天然
 * 跨一次 commit：宿主把结果存进 state，下一次 commit 才把硬件光标挪过去（多一趟渲染，
 * Ink 自带节流，肉眼无感）。因此宿主仍保留手算位置作为**首帧兜底**。
 */

import { useEffect, useRef } from "react";
import { Box, measureElement, Text, type DOMElement } from "ink";
import { theme } from "../theme.js";

/** 帧内坐标：x 为列（0 起始）、y 为行（0 起始，从整帧第一行算起） */
export interface CursorPosition {
  x: number;
  y: number;
}

export interface CursorInputRowProps {
  /** 是否为输入区首行（首行用 `❯ ` 提示符，其余行留两格） */
  firstLine: boolean;
  /** 光标之前的文本 */
  before: string;
  /** 光标处的字符（行尾时传 `" "`，保证光标块有宽度） */
  at: string;
  /** 光标之后的文本 */
  after: string;
  /** 测量结果回调（坐标未变化时不会重复触发） */
  onMeasure: (position: CursorPosition) => void;
}

/**
 * 光标所在的输入行：把光标字符包成可测节点，渲染后上报它的布局坐标。
 *
 * 视觉与「整块 `<Text>`」渲染等价（提示符 / 正文 / 反显光标块 / 后续文本），
 * 区别只是各处成为独立节点，于是可以被 `measureElement()` 量到。
 */
export function CursorInputRow({ firstLine, before, at, after, onMeasure }: CursorInputRowProps) {
  const cursorRef = useRef<DOMElement | null>(null);
  /** 上一次上报的值：相同就不再上报，避免「测量 → setState → 渲染 → 再测量」打转 */
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const node = cursorRef.current;
    if (!node) return;
    const { x, y } = measureElement(node);
    const key = `${x}:${y}`;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    onMeasure({ x, y });
  }, [firstLine, before, at, after, onMeasure]);

  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        {firstLine ? (
          <Text color={theme.brand[0]} bold>
            {"❯ "}
          </Text>
        ) : (
          <Text>{"  "}</Text>
        )}
      </Box>
      {/* 邻段可收缩可截断：超宽时由它们吃掉溢出，保证这一行恒为一行高 */}
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">{before}</Text>
      </Box>
      <Box ref={cursorRef} flexShrink={0}>
        <Text inverse color={theme.brand[0]}>
          {at}
        </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">{after}</Text>
      </Box>
    </Box>
  );
}
