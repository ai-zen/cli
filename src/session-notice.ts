/**
 * 通知的机器码 → 人看的文案，只属于**客户端**。
 *
 * 服务端的通知只带 `{ code, params }`（协议里的 `SESSION_NOTICE_CODES` / `SERVER_NOTICE_CODES`），
 * 一句自然语言都不产 —— 一个服务端同时接中文终端与英文浏览器时，它只能挑一种语言撒谎。
 * 于是「这句 code 该怎么说」落在各客户端自己的词典里，本文件就是 CLI 的这一份。
 *
 * ## 两档 code，一份词典
 *
 * 会话内的（`SessionNoticeCode`）与会话无关的（`ServerNoticeCode`）在协议里是两张表
 * —— 它们的**作用域**不同（前者跟着 sessionId 过滤，后者不过滤）。而「怎么念」是同一
 * 件事，所以本文件仍只留一张 `NOTICE_KEYS`：拆成两份只会让「新增一条 code 时忘了在哪张表
 * 里加一行」变成两个地方各忘一次。
 *
 * 两个约定：
 *   - 词典里查不到就回 `notice.<code>`（i18n 的缺词条行为），不静默回退到别的语言；
 *   - 载荷里的**枚举值**（`mode: "self"`）也要在这里翻译，不能原样塞进句子里 ——
 *     否则中文界面会冒出 `正在交接（self）…`。
 */

import type { ServerNoticeCode, SessionNoticeCode } from "@ai-zen/agents-client";
import { t } from "./i18n/index.js";

type NoticeCode = SessionNoticeCode | ServerNoticeCode;

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
  // 迁移落地的两条与「本次跳过」：服务端只发 code，句子得由这边给
  handoffMigrated: "handoff.migrated",
  handoffMigratedHint: "handoff.migratedHint",
  migrationSkipped: "migrate.skipped",
  // 子 Agent 出错（`params.index` 指哪个子 Agent，`params.message` 是原文）。
  // 模板就是 `{message}`：把服务端给的原文原样吐出来，**不加**「子 Agent 1 出错：」这类
  // 前缀 —— 那是交互层的措辞，塞进模板就成了第二份真相（模板只放事实，不放句子）。
  subAgentFailed: "notice.subAgentFailed",
  // ---- 服务端级（不属于任何一段会话，不过 sessionId 过滤）----
  mcpUnavailable: "notice.mcpUnavailable",
  storeUnavailable: "notice.storeUnavailable",
};

/**
 * 把一条通知渲染成本地文案。
 *
 * `params` 里已知的枚举会被翻译（`mode` / `requested` → 「原 agent 自交接」/「独立摘要」），
 * 其余原样代入 —— 服务端只放事实，不放句子。
 */
export function noticeText(code: NoticeCode, params: Record<string, unknown> = {}): string {
  return t(NOTICE_KEYS[code] ?? `notice.${code}`, localizeParams(params));
}

/**
 * 把 `params` 里的值变成可直接代入模板的字符串/数字。
 *
 * 模板用的是协议里的字段名，所以这里不做别名映射：服务端给什么，就代什么。
 */
function localizeParams(params: Record<string, unknown>): Record<string, string | number> {
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
  return localized;
}

/** 执行者的显示名（`self` / `summary`）；不认识的原样返回，让缺词条看得见 */
function modeName(mode: string): string {
  return mode === "self" || mode === "summary" ? t(`handoff.mode.${mode}`) : mode;
}
