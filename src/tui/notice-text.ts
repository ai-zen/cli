/**
 * 通知的机器码 → 人看的文案，只属于**客户端**。
 *
 * 服务端的通知只带 `{ code, params }`（`protocol/sessions.ts` 的 `SESSION_NOTICE_CODES`），
 * 一句自然语言都不产 —— 一个服务端同时接中文终端与英文浏览器时，它只能挑一种语言撒谎。
 * 于是「这句 code 该怎么说」落在各客户端自己的词典里，本文件就是 CLI 的这一份。
 *
 * 两个约定：
 *   - 词典里查不到就回 `notice.<code>`（i18n 的缺词条行为），不静默回退到别的语言；
 *   - 载荷里的**枚举值**（`mode: "self"`）也要在这里翻译，不能原样塞进句子里 ——
 *     否则中文界面会冒出 `正在交接（self）…`。
 */

import type { GlobalNoticeCode, SessionNoticeCode } from "@ai-zen/agents-server";
import { t } from "../i18n/index.js";

type NoticeCode = SessionNoticeCode | GlobalNoticeCode;

/** 通知码 → 词典 key。新增 code 时**必须**在这里加一行（否则界面上显示裸 key） */
const NOTICE_KEYS: Record<NoticeCode, string> = {
  // ---- 对话内 ----
  handoffAutoDetected: "handoff.autoDetected",
  handoffWriting: "handoff.writing",
  handoffPath: "handoff.path",
  handoffArchived: "handoff.savedSession",
  migrationDegraded: "handoff.degraded",
  turnAborted: "notice.turnAborted",
  persistFailed: "handoff.persistFailed",
  // 迁移落地的两条与「本次跳过」：旧版这三句在 CLI 侧产文案，服务端化之后一度静默
  handoffMigrated: "handoff.migrated",
  handoffMigratedHint: "handoff.migratedHint",
  migrationSkipped: "migrate.skipped",
  // 子 Agent 出错（`params.index` 指哪个子 Agent，`params.message` 是原文）。
  // 模板只是把 `message` 原样吐出来 —— 与进程内实现「直接把 `error.message` 推上通知栏」
  // 逐字一致，**不加**「子 Agent 1 出错：」这类前缀（那是交互变化）。
  subAgentFailed: "notice.subAgentFailed",
  // ---- 全局 ----
  mcpUnavailable: "notice.mcpUnavailable",
  storeUnavailable: "notice.storeUnavailable",
};

/**
 * 把一条通知渲染成本地文案。
 *
 * `params` 里已知的枚举会被翻译（`mode` / `requested` → 「原 agent 自交接」/「独立摘要」），
 * 其余原样代入 —— 服务端只放事实，不放句子。
 */
export function noticeText(
  code: NoticeCode,
  params: Record<string, unknown> = {},
): string {
  return t(NOTICE_KEYS[code] ?? `notice.${code}`, localizeParams(code, params));
}

function localizeParams(
  code: NoticeCode,
  params: Record<string, unknown>,
): Record<string, string | number> {
  const localized: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if ((name === "mode" || name === "requested") && typeof value === "string") {
      localized[name] = modeName(value);
    } else if (typeof value === "string" || typeof value === "number") {
      localized[name] = value;
    } else if (value != null) {
      localized[name] = String(value);
    }
  }
  // 存档那条模板用的是 `{name}`（会话名），而服务端只给 `sessionId`
  if (code === "handoffArchived" && localized.name === undefined && localized.sessionId !== undefined) {
    localized.name = localized.sessionId;
  }
  return localized;
}

/** 执行者的显示名（`self` / `summary`）；不认识的原样返回，让缺词条看得见 */
function modeName(mode: string): string {
  return mode === "self" || mode === "summary" ? t(`handoff.mode.${mode}`) : mode;
}
