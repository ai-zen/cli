/**
 * 通知通道：系统级提示（notice / error）的旁路，与会话转录严格分离。
 *
 * 栏位上那两个清空入口跟着通知栏走（`noticeLines` 末尾那一行），那一行写的是两个键：
 *
 *   · `Ctrl+X`（`common-keys.ts` 的 `handleClearNoticesKey`）：清掉本地队列
 *     （`NoticeChannel.clear`），再让宿主把这一段会话的通知清掉（`notice.deleteAll` 的按会话
 *     那一档，入参是 `sessionId`）。不给 `sessionId` 就是清整个宿主库，会把别的会话还没上屏
 *     的通知一起抹掉。
 *   · `Ctrl+G`（`handleClearAllNoticesKey`）：清全部。它自己不发任何请求，只开一次确认，并在
 *     那一问里把全局通知、别的会话的通知一起点名，列出全部受影响的范围，而不是一次静默的全清。
 *
 * 不能塞进 `session.messages`：那份数组会被 `formatHistory()` 原样发给模型，把「配置已更新 /
 * 已中止 / 保存失败」这类 UI 提示写进去，等于往上下文里灌噪声，甚至带偏模型行为。所以
 * notice / error 走这条独立通道，由会话屏订阅后渲染到输入框上方的独立栏位，不进 messages。
 *
 * 不采用「只留最新一条」：订阅端要是单值 state，`push` 多次就只有最后一条能显示。而实际存在
 * 两类连续推送：同一批摘要（配置中心关闭时逐条 push 变更）只剩最后一条，前面的变更说明丢失；
 * 进度流（交接 / 迁移分阶段 push）各阶段互相覆盖，用户看不到完整过程。保留最近
 * `MAX_NOTICE_HISTORY` 条的队列，两类都能看见。同时第一类在调用侧会合成一条多行
 * （`use-wizard-host.ts` 的 `closeWizard`），避免一批摘要把整个栏位占满；第二类本来就是流式的，
 * 各阶段自然各占一条。
 *
 * 纯逻辑、不依赖 React，可独立单测。
 */

import { t } from "../../i18n/index.js";
import type { NoticeOrigin, NoticeTone } from "../../session/types.js";
import { wrapText } from "../text.js";

/**
 * 通知语气：info 普通提示 / warn 警告（不影响使用，但需要看见）/ error 错误。
 *
 * 定义在 `session/types.ts`：会话层要把宿主的四档（`NoticeLevel`）映到这三档，而 `tui/` 是
 * 叶子（其它地方不 import 它），所以词定义在上层、这里只转出。
 */
export type { NoticeTone };

/** 通知来源（`app` = 应用自己说的、`log` = 日志上浮来的）：与语气同理，词定义在上层 */
export type { NoticeOrigin };

export interface Notice {
  text: string;
  tone: NoticeTone;
  /**
   * 谁让它出现的。只作事实留着（日志上浮来的一批与业务提示分开看）：清除时机不按它分档，
   * 用户发送那一刻两档一起清（`NoticeChannel.clear`）。
   */
  origin: NoticeOrigin;
  /** 递增序号：同一文本重复推送也能被 React 依赖感知为「新通知」，用于渲染 key */
  seq: number;
}

/** 订阅回调收到的是当前全部通知（最近的在最后），而不是单个增量 */
export type NoticeListener = (notices: readonly Notice[]) => void;

/** 通知保留条数：新通知挤掉最旧的。进度类提示会连续到达，需要保留最近几步 */
export const MAX_NOTICE_HISTORY = 4;

/** 通知栏最多占用的行数（多条合计；超出时整条让位，不把通知劈成两半） */
export const MAX_NOTICE_LINES = 8;

/** 单条通知渲染出的一行（带 tone，供渲染侧逐行着色） */
export interface NoticeLine {
  text: string;
  tone: NoticeTone;
}

export class NoticeChannel {
  private seq = 0;
  private queue: Notice[] = [];
  private readonly listeners = new Set<NoticeListener>();

  /** 当前通知（最近的在最后）；组件用它做 `useState` 的初值。
   *
   * 返回副本：`readonly` 只在编译期生效，直接交给外部等于把内部队列的引用泄出去
   * （对方一次 `push` 就能绕开 `MAX_NOTICE_HISTORY`）。
   */
  get notices(): readonly Notice[] {
    return [...this.queue];
  }

  /**
   * 推入一条通知；空文本直接忽略（调用方常把错误消息直接透传进来）。
   *
   * `origin` 缺省 `app`：业务提示（宿主发的、CLI 自己说的那句）。日志上浮来的那一批由
   * `tui/screens/chat.tsx` 的 sink 显式传 `"log"`，它只用来分辨这条是日志转的。
   */
  push(text: string, tone: NoticeTone = "info", origin: NoticeOrigin = "app"): void {
    if (!text) return;
    const notice: Notice = { text, tone, origin, seq: ++this.seq };
    this.queue = [...this.queue, notice].slice(-MAX_NOTICE_HISTORY);
    this.broadcast();
  }

  /**
   * 清空（`/clear` / 会话重建 / 用户发送那一刻都调它，避免上一批提示挂着挡事）。
   *
   * 发送那一刻不区分 `origin`：它只记这条从哪来（日志还是业务提示），而用户开口了对两档都是
   * 同一个意思，上一批提示已经说完。曾经只清 `log` 那一档，结果是业务提示一路顶着输入框陪
   * 下一轮对话。
   */
  clear(): void {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.broadcast();
  }

  subscribe(listener: NoticeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(): void {
    for (const listener of this.listeners) listener(this.queue);
  }
}

/** 单条通知 → 若干行（按列宽折行；条内超出上限以 … 收尾）
 *
 * 不加任何行首装饰：既不带缩进，也不带 `· ` / `✖ ` 前缀。横向定位全部交给 `NoticeBar` 的
 * `paddingX`，于是通知文本与分隔线、输入行左对齐；语气差异由 `tone` 的着色表达（info 暗、
 * error 红），不需要符号占位。多行通知（如迁移完成 + 文档路径）每行都从行首开始，不另加
 * 续行缩进。
 */
function noticeBlockLines(notice: Notice, width: number): NoticeLine[] {
  const wrapped = wrapText(notice.text, width);
  const capped = wrapped.slice(0, MAX_NOTICE_LINES);
  if (capped.length > 0 && wrapped.length > capped.length) {
    capped[capped.length - 1] = `${capped[capped.length - 1]}…`;
  }
  return capped.map((text) => ({ text, tone: notice.tone }));
}

/**
 * 通知队列 → 栏位文本行（按显示宽度折行）。
 *
 * 总行数超过 `MAX_NOTICE_LINES` 时，从最早的通知开始整条让位：保持每条通知的自洽（不会
 * 看到半条「已迁移」），也保证栏位高度有确定上限（布局按行数预留空间）。
 */
export function noticeLines(notices: readonly Notice[], columns: number): NoticeLine[] {
  // 行宽留给容器 paddingX（左右各 1）+ 1 列余量，避免贴边被 Ink 再折一行
  const width = Math.max(4, columns - 3);
  const blocks: NoticeLine[][] = [];
  for (const notice of notices) {
    if (!notice.text) continue;
    blocks.push(noticeBlockLines(notice, width));
  }

  let start = 0;
  let total = blocks.reduce((sum, block) => sum + block.length, 0);
  while (total > MAX_NOTICE_LINES && start < blocks.length - 1) {
    total -= blocks[start]!.length;
    start += 1;
  }
  // 单条已被 `noticeBlockLines` 封顶到 MAX_NOTICE_LINES，而上面的循环保证至少留下最后一条，
  // 所以合计行数必然不超过上限，不需要再截一次
  return blocks.slice(start).flat();
}

/** 通知栏的渲染内容与高度（两者同源：高度就是渲染出来几行） */
export interface NoticeBarContent {
  lines: NoticeLine[];
  /** 入口提示（`Ctrl+X` 清本会话 · `Ctrl+G` 清全部）；栏位空时没有 */
  hint: string | null;
  /** 栏位占几行：正文行加提示那一行（布局与硬件光标都按它预留） */
  height: number;
}

/**
 * 算出通知栏要渲染什么、占几行。
 *
 * 用一个函数把两者一起给：布局（`computeChatLayout` 的 `noticeCount`）与硬件光标
 * （`computeInputCursorPosition`）都要知道栏位几行，而那一行提示是渲染时才有。让调用方自己
 * 算 `lines.length + 1` 会多出一份算式，哪天提示改成两行，输入框就会整体偏一行。
 *
 * 提示不计入 `MAX_NOTICE_LINES`：那个上限说的是通知最多占多少行，提示是入口，不是在念通知。
 */
export function noticeBarContent(notices: readonly Notice[], columns: number): NoticeBarContent {
  const lines = noticeLines(notices, columns);
  if (lines.length === 0) return { lines, hint: null, height: 0 };
  return { lines, hint: t("notice.deleteAllHint"), height: lines.length + 1 };
}
