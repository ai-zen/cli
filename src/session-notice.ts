/**
 * 通知转成上屏的句子与语气档位，只属于客户端的那一小段。
 *
 * 宿主存的是成品句子（`Notice.message`，按宿主当前语言渲染好的那一句），客户端不再自己维护一份
 * code → 词条的表 —— 存了两份，两处就会漂。
 */

import type { NoticeLevel, NoticeTone, NoticeView } from "./session/types.js";

export function noticeText(notice: NoticeView): string {
  return notice.message;
}

/**
 * 宿主给四档（`info` / `success` / `warning` / `error`），通知栏只有三档颜色，映射放在一处，
 * 界面不必各自判断。
 *
 * `success`（「已保存」这类片刻即消失的提示）归 `info`：它是好消息，标红会让一屏的红字失去意义；
 * `warning` 与 `error` 各自一档 —— 两者都表示出了问题，但前者的含义是留意，后者的含义是失败。
 */
export function noticeTone(level: NoticeLevel): NoticeTone {
  if (level === "warning") return "warn";
  if (level === "error") return "error";
  return "info";
}
