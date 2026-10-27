/**
 * English entries — the fallback language.
 *
 * 约定与 `zh.ts` 一致；英文额外使用 `_one` / `_other` 复数变体
 * （由 `t()` 依 `Intl.PluralRules` 选择，见 `index.ts`）。
 */
export const en: Record<string, string> = {
  // ---------- Input row ----------
  "input.placeholder": "Type a message, / for commands…",
  "input.hint.ready": "Enter send · Ctrl+J newline · / commands · PgUp history",
  "input.hint.scrolling": "↕ scrolling · PgUp/PgDn pages · send to jump to bottom",
  "input.hint.initializing": "Initializing…",

  // ---------- Status bar ----------
  "status.agent": " · agent ",
  "status.effort": " · thinking ",
  "status.lastTokens": "turn\u00a0{n}\u00a0tok",
  "status.totalTokens": "total\u00a0{n}\u00a0tok",
  "status.avgRate": "⚡\u00a0avg\u00a0{rate}",
  "status.busy": "⏳ generating",

  // ---------- Reasoning effort ----------
  "effort.off": "off",
  "effort.none": "off",
  "effort.minimal": "minimal",
  "effort.low": "low",
  "effort.medium": "medium",
  "effort.high": "high",
  "effort.xhigh": "xhigh",
  "effort.max": "max",
  "effort.custom": "custom",
  "effort.default": "default",
  "effort.unsupported": "—",

  // ---------- Generation state ----------
  "spinner.thinking": "Thinking…",

  // ---------- Notices ----------
  "notice.reloaded": "Session rebuilt with the new config (messages and context kept)",
  "notice.draftSaved": "Draft saved (Ctrl+S to restore)",
  "notice.draftRestored": "Draft restored",
  "notice.pasteImageUnsupported": "Image paste is not supported yet (Ctrl+V is reserved for it)",
  "notice.inputCleared": "Input cleared · press Ctrl+C again to exit",
  "notice.pressCtrlDAgain": "Press Ctrl+D again to exit",
  "notice.languageChanged": "Language switched to English",

  // ---------- Commands ----------
  "command.lang": "Switch interface language (中文 / English)",
};
