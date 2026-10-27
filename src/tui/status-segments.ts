/**
 * 状态栏的折行 —— 输入是「按优先级排好的信息块」，输出是「确定的若干行」
 *
 * 为什么不用 Ink 自己的 wrap：状态栏高度必须是**确定值**，`computeChatLayout` 要靠它
 * 算出对话区还能占几行（整帧高度恒等于终端行数，输入框才吸得住底）。让 Ink 在渲染时
 * 折行，行数只有渲染完才知道，布局预算就会算错——轻则顶部留白多一行，重则把输入框
 * 顶出屏幕。所以这里先在纯逻辑里折好，渲染层只负责按行铺颜色。
 *
 * 折行以「块」为单位（见 `packSegments`）：身份、用量、快捷键各是一块，窄屏时整块
 * 顺延到下一行，而不是把一块劈成两半——也不再用 `justify-content: space-between` 把
 * 两侧各切一半（左边「思考 高」被吃掉、右边提示只剩半截）。
 */

import { displayWidth } from "./text.js";

/** 一段带样式的文本（颜色由调用方给，这里只管切分） */
export interface StatusSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

interface StyledChar {
  ch: string;
  color?: string;
  bold?: boolean;
  width: number;
}

function toChars(segments: StatusSegment[]): StyledChar[] {
  const chars: StyledChar[] = [];
  for (const segment of segments) {
    for (const ch of segment.text) {
      chars.push({ ch, color: segment.color, bold: segment.bold, width: displayWidth(ch) });
    }
  }
  return chars;
}

/** 连续同色同粗细的字符合并回一个片段 */
function toSegments(chars: StyledChar[]): StatusSegment[] {
  const segments: StatusSegment[] = [];
  for (const char of chars) {
    const last = segments[segments.length - 1];
    if (last && last.color === char.color && last.bold === char.bold) {
      last.text += char.ch;
    } else {
      segments.push({ text: char.ch, color: char.color, bold: char.bold });
    }
  }
  return segments;
}

/** 行尾空格没有意义（会视觉上「多出一截」），折行前后都裁掉 */
function trimTail(line: StyledChar[]): void {
  while (line.length > 0 && line[line.length - 1]!.ch === " ") line.pop();
}

/**
 * 把片段流按显示宽度折成若干行。
 *
 * 断行策略与 `wrapText` 一致：优先在**空格**处断（英文单词不被劈开），没有空格可断
 * 时按字符硬断（CJK 本来就能任意断行）。折行后的行首空格会被吃掉，避免出现
 * 「第二行无故缩进两格」。
 */
export function wrapSegments(segments: StatusSegment[], width: number): StatusSegment[][] {
  const limit = Math.max(1, width);
  const chars = toChars(segments);
  const lines: StyledChar[][] = [];
  let line: StyledChar[] = [];
  let lineWidth = 0;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    // 行已满且下一个正好是空格：直接断行并把这个空格丢掉，而不是往回找上一处空格
    // （否则会把已经排好的「aaaa bbbb」硬拆成「aaaa」+「bbbb」，白白浪费半行）
    if (char.ch === " " && lineWidth + char.width > limit && line.length > 0) {
      trimTail(line);
      lines.push(line);
      line = [];
      lineWidth = 0;
      continue;
    }
    if (lineWidth + char.width > limit && line.length > 0) {
      // 当前行最后一个空格的位置：能在此断就在此断，把尾巴挪到下一行
      let spaceAt = -1;
      for (let i = line.length - 1; i > 0; i -= 1) {
        if (line[i]!.ch === " ") {
          spaceAt = i;
          break;
        }
      }
      if (spaceAt > 0) {
        const carry = line.slice(spaceAt + 1);
        line = line.slice(0, spaceAt);
        trimTail(line);
        lines.push(line);
        line = carry;
        lineWidth = carry.reduce((sum, item) => sum + item.width, 0);
      } else {
        trimTail(line);
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
    }
    if (line.length === 0) {
      if (char.ch === " ") continue; // 行首不吃空格
      // 行首的孤儿分隔符（`·`）是折行切出来的，留在开头只会变成「· ⚡ 47 tok/s」，
      // 难看且无意义（换行本身已表达分隔），连同其后的空格一并丢掉。
      if (char.ch === "·" && index > 0) {
        while (index + 1 < chars.length && chars[index + 1]!.ch === " ") index += 1;
        continue;
      }
    }
    line.push(char);
    lineWidth += char.width;
  }
  trimTail(line);
  lines.push(line);

  return lines.map(toSegments);
}

/** 片段流的总显示宽度（宽字符算 2 列） */
export function segmentsWidth(segments: StatusSegment[]): number {
  let width = 0;
  for (const segment of segments) {
    for (const ch of segment.text) width += displayWidth(ch);
  }
  return width;
}

/**
 * 以**块**为单位装行：能塞进当前行剩余宽度就并排（用 `separator` 连起来），
 * 塞不下就整块挪到下一行；只有单块本身就比一整行还宽时，才退化成块内折行
 * （`wrapSegments`），此时优先在空格 / CJK 边界断，尽量不劈开英文单词。
 *
 * 这样「换行时一块占一行」是默认行为：块是原子的排版单位，行的边界只会落在块边界上。
 */
export function packSegments(
  blocks: StatusSegment[][],
  width: number,
  separator: StatusSegment[] = [{ text: " · " }],
): StatusSegment[][] {
  const limit = Math.max(1, width);
  const separatorWidth = segmentsWidth(separator);
  const lines: StatusSegment[][] = [];
  let line: StatusSegment[] = [];
  let lineWidth = 0;

  const flush = () => {
    if (line.length === 0) return;
    lines.push(line);
    line = [];
    lineWidth = 0;
  };

  for (const block of blocks) {
    const blockWidth = segmentsWidth(block);
    if (blockWidth === 0) continue; // 空块（如本轮没有速率）不占位，也不留分隔符
    if (line.length > 0) {
      if (lineWidth + separatorWidth + blockWidth <= limit) {
        line = [...line, ...separator, ...block];
        lineWidth += separatorWidth + blockWidth;
        continue;
      }
      flush();
    }
    if (blockWidth <= limit) {
      line = [...block];
      lineWidth = blockWidth;
      continue;
    }
    // 单块超一整行：块内折行兜底，尾巴留在 `line` 上等着接下一块
    const chunks = wrapSegments(block, limit);
    const tail = chunks.pop()!;
    lines.push(...chunks);
    line = tail;
    lineWidth = segmentsWidth(tail);
  }
  flush();

  return lines.length > 0 ? lines : [[]];
}
