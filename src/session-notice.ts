/**
 * 通知 → 上屏那一句话 + 那一档语气，只属于**客户端**的那一小段。
 *
 * ## 为什么这里没有翻译表
 *
 * 宿主存的是成品句子（`Notice.message`，按宿主当前语言渲染好的那一句），客户端不再自己维护一份
 * code → 词条的表 —— 存了两份，两处就会漂。
 *
 * ## 语气还剩三档
 *
 * 宿主给**四档**（`info` / `success` / `warning` / `error`），通知栏有**三档**颜色。映射放在
 * 一处，界面不必各自判断。
 *
 * `success`（「已保存」那种一秒提示）归 **`info`**：它是好消息，标红会让一屏的红字失去意义；
 * `warning` 与 `error` **各自一档** —— 两者都表示「有事」，但一个是「看一眼」，一个是「出错了」。
 */

import type { NoticeLevel, NoticeTone, NoticeView } from "./session/types.js";

/** 一条通知上屏的句子：宿主渲染好的那一句 */
export function noticeText(notice: NoticeView): string {
  return notice.message;
}

/** 通知语气 → 通知栏的三档（成功归普通，警告与错误各自一档） */
export function noticeTone(level: NoticeLevel): NoticeTone {
  if (level === "warning") return "warn";
  if (level === "error") return "error";
  return "info";
}
