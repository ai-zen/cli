/**
 * 统一时间格式化工具
 *
 * 所有用户可见的时间文案统一走本模块，格式随界面语言变化：
 *   - 中文：`7月1日 14:30`、`昨天 14:30`
 *   - 英文：`Jul 1, 14:30`、`Yesterday 14:30`
 *
 * 语言从 `i18n` 现取（不同模块级常量），因此 `/lang` 切完下一帧就生效。
 * 例外：`formatFileStamp()` 用于**文件名 / 会话 id**，不随语言变（否则新旧文件混排）。
 */

import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";
import { getLocale, t } from "./i18n/index.js";

// dayjs 自身的全局默认（仅兜底；实际格式化按当前界面语言逐次指定）
dayjs.locale("zh-cn");

/** 当前界面语言对应的 dayjs locale 名 */
function dayjsLocale(): string {
  return getLocale() === "zh" ? "zh-cn" : "en";
}

/**
 * 格式化时间戳为"相对时间"（用于列表展示）
 *
 * 规则：
 *   - 今天：     HH:mm
 *   - 昨天：     昨天 HH:mm
 *   - 今年：     M月D日 HH:mm
 *   - 更早：     YYYY年M月D日 HH:mm
 */
export function formatRelativeTime(isoString: string): string {
  const d = dayjs(isoString).locale(dayjsLocale());
  const now = dayjs();

  if (d.isSame(now, "day")) {
    return d.format("HH:mm");
  }
  if (d.isSame(now.subtract(1, "day"), "day")) {
    return t("time.yesterday", { time: d.format("HH:mm") });
  }
  if (d.isSame(now, "year")) {
    return d.format(t("time.pattern.thisYear"));
  }
  return d.format(t("time.pattern.older"));
}

/**
 * 格式化时间戳为完整格式（用于详情展示）
 * 例（中）：2025年7月1日 14:30:00　（英）：Jul 1, 2025 14:30:00
 */
export function formatFullTime(isoString: string): string {
  return dayjs(isoString).locale(dayjsLocale()).format(t("time.pattern.full"));
}

/**
 * 文件名安全的时间戳：全下划线、纯数字，用作会话 id。
 * 例：2026_10_28_00_56_34
 *
 * **刻意不随界面语言变**：它进了文件名与会话 id，跟着语言变会让历史文件与新文件混排。
 */
export function formatFileStamp(isoString: string): string {
  return dayjs(isoString).format("YYYY_MM_DD_HH_mm_ss");
}

/**
 * 紧凑时间戳（列表/详情提示显示用），随界面语言变：
 * 中文 `2025年07月01日15时30分00秒`，英文 `Jul 1, 2025 15:30:00`。
 */
export function formatShortTime(isoString: string): string {
  return dayjs(isoString).locale(dayjsLocale()).format(t("time.pattern.short"));
}

/**
 * 格式化消息数量+时间（用于会话标签；当前暂无调用点，保留供 P1 主菜单复用）
 * 例：12 条消息, 今天 14:30
 */
export function formatMessageTime(messageCount: number, isoString: string): string {
  return t("time.messageCount", { n: messageCount, time: formatRelativeTime(isoString) });
}

/**
 * 格式化文件大小为人类可读格式
 * 例：1.2 KB, 3.5 MB
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
