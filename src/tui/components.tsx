/**
 * Ink 通用组件 —— Spinner / 选择列表 / 状态栏 / 斜杠命令菜单 / `@` 文件菜单 / 键位提示
 */

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { theme } from "./theme.js";
import { clipWidth, displayWidth } from "./text.js";
import type { AgentNS } from "@ai-zen/agents-core";
import { packSegments, type StatusSegment } from "./status-segments.js";
import { t } from "../i18n/index.js";
import { thinkingView } from "../reasoning-effort.js";
import type { SelectItem } from "../commands/types.js";
import type { InboxItem } from "../session/types.js";

/**
 * 状态栏的一块（`../status-blocks.ts` 的 `StatusBlock`）。
 *
 * 块由客户端用会话层的活事实拼（`statusBlocksOf`）：宿主只给事实，界面定块名、顺序与
 * 摆法。
 */
import type { StatusBlock } from "../status-blocks.js";
export type { StatusBlock };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    // `truncate`：转圈标签（如「等待首 token…」）一旦折行，
    // 那一行就会变成两行、把输入框顶出屏幕（`phaseLines` 恒为 1）。
    <Text wrap="truncate">
      <Text color={theme.brand[0]}>{SPINNER_FRAMES[frame]}</Text>
      {label ? <Text color={theme.dim}> {label}</Text> : null}
    </Text>
  );
}

/**
 * 阶段行 —— 生成中（或阻塞命令执行中）那一行状态，住在输入框上方的分割线之上。
 *
 * 为什么从输入框里搬到分割线之上：它曾经是「输入框整体被 Spinner 顶替」的产物 ——
 * 屏幕得腾一个位置给它，于是把输入框整个换掉，运行过程中就打不了字。挪到分割线之上后
 * 阶段信息只占自己那一行，输入框始终在原位、始终可编辑。
 *
 * 恒为一行：`computeChatLayout` 按 `phaseLines: 1` 算高度，标签超宽由 `Spinner` 的
 * `truncate` 兜底 —— 折成两行就把输入框顶出屏幕（与状态栏 / 通知栏同一类教训）。
 */
export function PhaseLine({ label }: { label: string }) {
  return (
    <Box paddingX={1}>
      <Spinner label={label} />
    </Box>
  );
}

/**
 * 选择器 InboxEntry 的形状住在命令层（`commands/types.ts`）—— 命令层产出InboxEntry、这里渲染它，
 * 所以它是两边共享的词汇而不是本文件的私有类型。这里再转出一遍，是为了让 tui 内的引用
 * 路径保持不变（`../components.js`）；新增字段去那边加。
 */
export type { SelectItem } from "../commands/types.js";

export interface SelectListProps<T> {
  items: SelectItem<T>[];
  onSelect: (value: T) => void;
  isActive?: boolean;
  initialIndex?: number;
  /**
   * 终端列数：提供时把每项裁成严格单行。
   *
   * 「吸底」布局的顶部留白是按行数算的，任一 InboxEntry 折行都会多占一行、把整帧顶高一格，
   * 故列表类屏幕都传它。
   */
  columns?: number;
  /**
   * 一次最多画几条（视窗高度）。缺省 = 全画。
   *
   * 为什么要有它：候选可以比屏幕高（一家订阅式端点就带进来 19 条模型，`/ws` 也可能有几十个
   * 工作区）。全部画出来的后果不是「被裁掉一截」，而是整块比可用帧还高 —— Ink 会把顶上的行
   * 挤出终端，状态栏与输入框跟着看不见。给了它之后列表滚动：高亮往下走，视窗跟着走，
   * 装不下的那几行被移出窗口（顶/末行左侧的 `↑` `↓` 说明「还有」）。
   *
   * 传进来的数与布局那份同源（`pickerCapacity` / `usableFrameRows` 算出来的），
   * 否则「渲染几行」与「布局留几行」对不上，输入框会整体位移。
   */
  maxRows?: number;
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

/**
 * 选择列表的视窗：自顶部锚定的连续滚动（与底部锚定的 `menuViewport` 相反，这里是自上往下读）。
 *
 * 高亮越过窗口底部就整窗下移，保证选中项留在窗内；`from` 的第二个钳制保证末页贴底时
 * 窗口里仍是连续的一段（不会只露出最后一条）。
 */
function listViewport(
  total: number,
  selected: number,
  maxRows: number,
): { from: number; to: number } {
  const size = Math.min(total, Math.max(1, maxRows));
  const active = Math.max(0, Math.min(selected, total - 1));
  const from = Math.max(0, Math.min(active - size + 1, total - size));
  return { from, to: from + size };
}

export function SelectList<T>({
  items,
  onSelect,
  isActive = true,
  initialIndex = 0,
  columns,
  maxRows,
}: SelectListProps<T>) {
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(items.length - 1, 0)));
  // `index` 只在挂载时算一次，而 `items` 可能变短（异步列表回填 / 过滤）—— 越界时
  // `items[index]` 是 `undefined`，回车就会抛 TypeError。只在渲染与确认处钳制，
  // 不改 state：否则要写 effect 去跟随 items.length，多一处状态同步就多一处不同步。
  const safeIndex = Math.min(index, Math.max(items.length - 1, 0));

  useInput(
    (_input, key) => {
      if (items.length === 0) return;
      if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % items.length);
      else if (key.return) onSelect(items[safeIndex]!.value);
    },
    { isActive },
  );

  const { from, to } = listViewport(items.length, safeIndex, maxRows ?? items.length);
  return (
    <Box flexDirection="column">
      {items.slice(from, to).map((raw, offset) => {
        const i = from + offset;
        const item = fitItem(raw, columns);
        const selected = i === safeIndex;
        /**
         * 首/末行左侧那两格：选中标记优先（`❯ `）；否则若这一行之外还有候选，用 `↑ ` / `↓ `
         * 说明「上面/下面还有」。不额外占行 —— 覆盖层的高度由候选条数算出，
         * 多画一行提示就会把输入框顶出一行。
         */
        const marker = selected
          ? "❯ "
          : i === from && from > 0
            ? "↑ "
            : i === to - 1 && to < items.length
              ? "↓ "
              : "  ";
        return (
          <Box key={`${i}-${raw.label}`}>
            <Text color={selected ? theme.brand[0] : theme.faint} wrap="truncate">
              {marker}
            </Text>
            <Text
              bold={selected}
              color={selected ? theme.highlight : theme.assistant}
              wrap="truncate"
            >
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

/**
 * 状态栏的入参：块由会话层拼，摆法由这里定。
 *
 * `blocks` 由会话层用活事实拼（`../status-blocks.ts`），顺序就是那里给的顺序。
 * 客户端不再自己算「现在用哪个模型」「思考强度是哪一档」「生成多快」「用了多少 tok」：
 * 前两样是宿主给的事实，后两样是会话层的采样与合计（`../session-rate.ts` /
 * `session.ts` 的 `lastTotalTokens` / `totalTokens`），屏幕只决定摆哪几块、怎么说。
 *
 * 速率那一段的取数口径（生成中看实时、结束后看平均）跟着事实走：它由块的 `facts` 带着，
 * 不再由这里另收一份「忙闲 / 速率」—— 同一个数字摆两处就必然会漂。
 */
export interface StatusBarProps {
  blocks: readonly StatusBlock[];
  /** 快捷键提示（客户端自己的话，宿主不给）；优先级最低，被挤掉的就是它 */
  hint?: string;
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
 * 一块 → 一段带样式的文本（旧版那三块的样子，见 `cli-old-archive` 的 `statusBarBlocks`）。
 *
 * 块内不再写块名：旧版就没写（「模型 AgentDefinition 一」变成「◆ AgentDefinition 一 · agent AgentDefinition 一」），
 * 身份块自己带着标签（` · agent `、` · 思考 ` 由词条给），用量块每段都是自带单位的数字。
 * 值从 `facts` 里挑，这里不做任何算术 —— 用量那两个数也已经算好了（会话层从消息的 `usage`
 * 上算）。
 *
 * 返回空数组 = 这块现在没有内容（没有提示可显示），排版时整块不占位。
 */
function statusBlockSegments(block: StatusBlock, hint: string | undefined): StatusSegment[] {
  switch (block.id) {
    case "identity": {
      const { model, thinking } = block.facts;
      // 身份块：品牌标记 + 模型 · 思考强度，一段紧接一段（分隔符在词条里，旧版如此）。
      //
      // 模型那一格只写 id：宿主这一版不再把「模型名字」当一条事实发下来（配置里的显示名
      // 是另一处的事），而状态要说的是一个能拿去 `/model` 用的标识 —— 见口径⑥。
      //
      // 「当前助手」那一格不在状态栏：它一整个会话不变，每一帧占着宽度而零信息；
      // 要换助手是 `/agent` 的事，换完之后这条会话的模型 / 思考档会随之变化。
      const view = thinkingView(thinking);
      return [
        { text: "◆ ", color: theme.brand[0] },
        { text: model.modelId ?? t("status.noModel"), color: theme.accent },
        { text: t("status.effort"), color: theme.dim },
        { text: view.text, color: view.dimmed ? theme.faint : theme.reasoning },
      ];
    }
    case "gates": {
      // 四件事：闲 / 忙、输入开关、输出开关、会话存活状态。
      //
      // 忙闲常显（一个字）—— 它是每一秒都在变的那一格，也是用户最关心的；两开关与存活状态只在
      // 非默认时出现：它们正常就是「开 / 开 / 活」，把三个「正常」也画上去是每帧占三个词的
      // 宽度而零信息。异常时它们各自出自己那一句，不合并成一个「暂停」。
      const { status, inputPaused, outputPaused, alive } = block.facts;
      // 读数还没到：一个字都不说（不借「闲」占位，那是要报给用户的事实）
      if (status === null) return [];
      const segments: StatusSegment[] = [
        status === "working"
          ? { text: t("status.busy"), color: theme.accent }
          : { text: t("status.idle"), color: theme.dim },
      ];
      const pushGate = (text: string, color: string) => {
        segments.push({ text: INNER_SEPARATOR, color: theme.dim });
        segments.push({ text, color });
      };
      if (alive === false) pushGate(t("status.dead"), theme.error);
      if (outputPaused === true) pushGate(t("status.outputPaused"), theme.warn);
      if (inputPaused === true) pushGate(t("status.inputPaused"), theme.warn);
      return segments;
    }
    case "usage": {
      // 本次 / 累计 tok：数字由会话层从消息的 `usage` 上算（宿主不报用量，但消息上有这个事实，
      // 两个数各自可能「还不知道」—— 那就整段不占位，
      // 不写 0 假装。
      const segments: StatusSegment[] = [];
      const pushUsage = (text: string) => {
        if (segments.length > 0) segments.push({ text: INNER_SEPARATOR, color: theme.dim });
        segments.push({ text, color: theme.dim });
      };
      if (block.facts.lastTokens != null) {
        pushUsage(t("status.lastTokens", { n: block.facts.lastTokens }));
      }
      if (block.facts.totalTokens != null) {
        pushUsage(t("status.totalTokens", { n: block.facts.totalTokens }));
      }
      return segments;
    }
    case "rate": {
      // 速率这一段只管速率：用量那两个数在上一块（同一个数字摆两处就必然会漂）。
      //
      // 生成中取实时值（没有就整块留白）；不在生成中时展示本次会话的平均。
      // 用块里的 `working`（会话的忙闲那一格）而不是 `rate.running` 做门开关：`/update` 这类阻塞
      // 命令也会让界面转圈，但那不是生成，没有速率可说。
      const { rate, working } = block.facts;
      const rateText = working
        ? rate?.live != null
          ? `⚡${NBSP}${formatRate(rate.live)}`
          : ""
        : rate?.average != null
          ? t("status.avgRate", { rate: formatRate(rate.average) })
          : "";
      return rateText ? [{ text: rateText, color: theme.tool }] : [];
    }
    case "keys":
      // 快捷键提示是界面自己的话（随语言与滚动状态变），没有宿主事实可挂
      return hint ? [{ text: hint, color: theme.faint }] : [];
  }
}

/**
 * 状态栏的全部信息块 —— 换行以块为单位：放得下就并排，放不下整块顺延到下一行，
 * 而不是把某块劈成两半。块内空的部分直接不占位（`packSegments` 会跳过空块）。
 */
function statusBarBlocks(props: StatusBarProps): StatusSegment[][] {
  return props.blocks.map((block) => statusBlockSegments(block, props.hint));
}

/**
 * 折行后的实际行 —— 行数即状态栏占用的终端行数。
 *
 * 调用方（`chat.tsx`）先拿它算行数交给 `computeChatLayout`，再交给 `StatusBar` 渲染，
 * 两处用的是同一个纯函数，测量与渲染不会脱节。
 *
 * 装行以块为单位（见 `packSegments`）：放得下就并排，放不下就把整块挪到下一行。
 */
export function statusBarRows(props: StatusBarProps, columns = 80): StatusSegment[][] {
  // 可用宽度 = 列数 − 2（两侧 paddingX(1)）− 1（安全余量）。
  //
  // 那 1 列是纯安全边际：`displayWidth()` 已经就是 Ink 用的 `string-width`，两边不会再
  // 对不上，但终端自己的 Ambiguous 宽度判定仍可能与 Unicode 表不同。
  const width = Math.max(8, columns - 3);
  return packSegments(statusBarBlocks(props), width, [{ text: INNER_SEPARATOR, color: theme.dim }]);
}

/**
 * 底部状态栏 —— 身份 / 用量 / 速率 / 快捷键四块，窄屏时按块换行。
 *
 * 行数不固定：放不下的块（从最末的快捷键提示开始）整块顺延到下一行，而不是与高位信息
 * 一起被截掉一半，也不会把某块劈成两半。
 */
export function StatusBar(props: StatusBarProps) {
  const rows = statusBarRows(props, props.columns ?? 80);
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      {rows.map((row, index) => (
        <Box key={index} paddingX={1} width="100%">
          {/* `truncate` 是兜底：折行已在 statusBarRows 里算好，万一有出入，Ink 也不会
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

export interface MenuItem {
  /** React key；同一份候选里唯一（命令取首个别名，路径取相对路径） */
  key: string;
  label: string;
  /** 右侧灰字说明（命令的 description）；不传则只有 label */
  hint?: string;
}

/**
 * 菜单视窗：自底部锚定的连续滚动。
 *
 * 菜单长在输入框上方，`items[0]` 紧贴输入框、往后各项依次向上。于是「数据顺序」与
 * 「视觉顺序」相反 —— 换算只发生在渲染层（`slice(from, to).reverse()`），`selected`
 * 始终是数据下标：按键、回车、滚动、测试都按数据顺序读，不反转数据。
 *
 * 高亮一旦越过窗口顶部就整窗上移（`from = selected − size + 1`），保证选中项可见；
 * 装不下的从顶部丢弃（即索引大的候选先消失，因为它们离输入框最远）。
 */
function menuViewport(
  total: number,
  selected: number,
  maxRows: number,
): { from: number; to: number } {
  const size = Math.min(total, Math.max(0, maxRows));
  if (size <= 0) return { from: 0, to: 0 };
  const active = Math.max(0, Math.min(selected, total - 1));
  const from = Math.max(0, Math.min(active - size + 1, total - size));
  return { from, to: from + size };
}

export interface BottomMenuProps {
  /** 按数据顺序（`items[0]` 最靠近输入框） */
  items: MenuItem[];
  /** 高亮项：数据下标 */
  selected: number;
  /**
   * 布局放行的行数 —— 来自 `computeChatLayout().hintRows`，不另算。
   * 差一行输入框就整体位移一行，硬件光标（IME 候选框）跟着偏。
   */
  maxRows: number;
  /** 终端列数：命令标签优先占满，说明按剩余宽度裁切 */
  columns: number;
  /** 菜单顶端附加的一行（`@` 索引未就绪时的「扫描中…」），与候选共用这份高度预算 */
  topLine?: string;
}

/** 菜单行的左缩进：`paddingLeft(2)` + 高亮标记 `❯ `（宽 2） */
const MENU_INDENT = 4;
/** 标签与说明之间的间隔 */
const MENU_GAP = 2;
/** 剩余宽度少于这个值就整条不显示说明（不留半个省略号） */
const MENU_HINT_MIN = 4;

/**
 * 把一项拆成「标签 + 可选的说明」，按列宽预算：
 *
 *   · 标签优先占满自己的宽度 —— 说明是次要信息，命令名不因说明长而被挤成一截；
 *   · 说明用剩下的宽度（不够就裁，裁到连三个字都放不下就不显示）；
 *   · 标签自己就超宽时才裁标签。
 *
 * 不把「标签与说明」做成两个并列 flex 子节点交给 Ink 分配：它会按内容比例分宽度，
 * 说明一长就把命令名挤成 `/confi`（真机反馈）。
 */
function menuRow(item: MenuItem, columns: number): { label: string; hint?: string } {
  const available = Math.max(1, columns - MENU_INDENT);
  const labelWidth = displayWidth(item.label);
  if (labelWidth > available) return { label: clipWidth(item.label, available) };
  if (!item.hint) return { label: item.label };
  const hintMax = available - labelWidth - MENU_GAP;
  if (hintMax < MENU_HINT_MIN) return { label: item.label };
  return { label: item.label, hint: clipWidth(item.hint, hintMax) };
}

/**
 * 底部锚定菜单 —— 斜杠命令与 `@` 文件补全共用同一套视窗（各写一份只会漂成两种手感）。
 *
 * 布局契约：整块高度 = `min(候选数 + (topLine ? 1 : 0), maxRows)`，与
 * `computeChatLayout` 回传的 `hintRows` 严格一致。
 */
export function BottomMenu({ items, selected, maxRows, columns, topLine }: BottomMenuProps) {
  const innerRows = Math.max(0, maxRows - (topLine ? 1 : 0));
  const { from, to } = menuViewport(items.length, selected, innerRows);
  const active = Math.max(0, Math.min(selected, items.length - 1));
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* 高度预算为 0 时连「扫描中…」也不画：多一行就把输入框顶出屏幕 */}
      {topLine && maxRows > 0 ? (
        <Text color={theme.faint} wrap="truncate">
          {topLine}
        </Text>
      ) : null}
      {items
        .slice(from, to)
        // 视觉反转只在这一行：下标大（离输入框远）的排在上面
        .reverse()
        .map((item, i) => {
          // 反转后的第 i 行对应数据下标 `to - 1 - i`
          const isActive = to - 1 - i === active;
          const row = menuRow(item, columns);
          return (
            <Box key={item.key}>
              {/* 整行是一个 Text 节点：并列的 Text 会被 flex 按内容比例分宽度，
                  说明一长就把命令名挤成一截；嵌套后宽度由 `menuRow` 预先算好，
                  外层 `truncate` 保证恒为一行（折行会把输入框顶出屏幕） */}
              <Text wrap="truncate">
                <Text color={isActive ? theme.brand[0] : theme.faint}>
                  {isActive ? "❯ " : "  "}
                </Text>
                <Text bold color={isActive ? theme.highlight : theme.assistant}>
                  {row.label}
                </Text>
                {row.hint ? (
                  <Text color={theme.dim}>{`${NBSP.repeat(MENU_GAP)}${row.hint}`}</Text>
                ) : null}
              </Text>
            </Box>
          );
        })}
    </Box>
  );
}

/**
 * 待发送附件提示行（`Ctrl+V` 粘贴的图片）。
 *
 * 恒为一行：`computeChatLayout` 按 `attachmentLines: 1` 算高度，内容超宽由
 * `truncate` 兜底 —— 折成两行会把输入框顶出屏幕（同一类教训：状态栏 / 通知栏）。
 */
export function PastedImagesBar({ count }: { count: number }) {
  return (
    <Box paddingLeft={2}>
      <Text color={theme.tool} wrap="truncate">
        {`📎 ${t("input.pastedImages", { n: count })}`}
      </Text>
    </Box>
  );
}

/**
 * 排队区最多占几行（第 3 行留给「还有 N 条」）。
 *
 * 上限不是审美选择：它是 `computeChatLayout` 的固定高度的一部分，块越高，会话区就被压得越扁。
 */
export const INBOX_MAX_ROWS = 3;

/** 一行里给来源名留多少字符（超了截断；来源名是内部名，preview 不被它挤没） */
const INBOX_SOURCE_MAX = 12;

/**
 * 排队区这一刻占几行（0 ～ `INBOX_MAX_ROWS`）：0 条时整块不渲染、不占行。
 *
 * 三处同源：渲染（`InboxArea` 画几行）、布局（`computeChatLayout` 的 `inboxLines`）、
 * IME 光标（`computeInputCursorPosition` 的 `inboxCount`）。差一行，输入框整体位移、
 * 输入法候选框跟着偏 —— 这是本仓多次出现的一类 bug（通知栏、附件行、阶段行都出过）。
 */
export function inboxAreaLines(count: number): number {
  if (count <= 0) return 0;
  return Math.min(count, INBOX_MAX_ROWS);
}

/**
 * 一条排队 InboxEntry 的前缀：用户自己排的那句说「排队中」（词条），其他来源（`session` 等）
 * 原样上屏 —— 内部来源名不对翻译表，超 `INBOX_SOURCE_MAX` 字符截断加 `…`。
 */
export function inboxPrefix(source: AgentNS.MessageSource): string {
  // 用户自己排的那句不给前缀名（它没有「来处」可言，只需说明「待发」）；
  // 别的来源把 label 显示出来 —— 那一格本来就是给人看的。
  if (source.kind === "user") return t("inbox.pending");
  const label = source.label;
  return label.length > INBOX_SOURCE_MAX ? `${label.slice(0, INBOX_SOURCE_MAX)}…` : label;
}

/**
 * 排队区 —— 还在队列里、没被取走的那几句（`session.state.inbox`），住在阶段行之后、
 * 分割线之上。
 *
 * 为什么不放进输入框那个 `Box`：那里的行数与 IME 光标定位是耦合的（`computeInputCursorPosition`
 * 按输入行算 y）。放在上面的带子里，它和阶段行走同一套 `phaseLines` 机制 —— 只占自己那几行，
 * 输入框照旧在原位、照旧可编辑。
 *
 * 显示规则（刻意只有这些，不加标题、不加边框）：
 *   · 最多 `INBOX_MAX_ROWS` 行；0 条时整块不渲染、不占行；
 *   · 每条一行：`优先级 前缀 preview`，`truncate`（折行会把输入框顶出屏幕）；
 *   · 优先级是 core 那两个协议用词（`high` / `low`），原样上屏、不进翻译表 —— 它说的是「为什么这一条
 *     还没被取走」（`high` 在内循环的工具边界就取、`low` 要等当前这一轮跑完），不是给终端用户看的
 *     产品词；
 *   · InboxEntry 数 > `INBOX_MAX_ROWS` 时，最后一行说「还有 N 条」（N = 没显示出来的条数）。
 */
export function InboxArea({ items }: { items: readonly InboxItem[] }) {
  if (items.length === 0) return null;
  const overflow = items.length > INBOX_MAX_ROWS;
  // 溢出时留一行给「还有 N 条」：前两行照常显示前两条
  const shown = overflow ? items.slice(0, INBOX_MAX_ROWS - 1) : items;
  const remaining = items.length - shown.length;
  return (
    <Box flexDirection="column">
      {shown.map((item) => (
        <Box key={item.messageId} paddingX={1}>
          {/* 整行是一个 Text：并列的 Text 会被 flex 按内容比例分宽度，preview 一长
              就把前缀挤成一截；外层 `truncate` 保证恒为一行 */}
          <Text wrap="truncate">
            <Text color={theme.dim}>{item.priority}</Text>
            <Text color={theme.dim}>{` ${inboxPrefix(item.source)}`}</Text>
            <Text color={theme.faint}>{` ${item.preview}`}</Text>
          </Text>
        </Box>
      ))}
      {overflow ? (
        <Box paddingX={1}>
          <Text color={theme.dim} wrap="truncate">
            {t("inbox.more", { n: remaining })}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function KeyHints({ hints }: { hints: [string, string][] }) {
  return (
    <Box paddingLeft={2} gap={2}>
      {hints.map(([key, label]) => (
        <Text key={key} color={theme.faint} wrap="truncate">
          <Text color={theme.dim} wrap="truncate">
            {key}
          </Text>{" "}
          {label}
        </Text>
      ))}
    </Box>
  );
}
