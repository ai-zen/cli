/**
 * 中文词条（默认兜底语言之外的另一半）。
 *
 * 约定：
 * - 扁平 key，`域.语义` 分组；
 * - `{name}` 为插值占位；
 * - `\u00a0`（不换行空格）用于把「数字 + 单位」绑成一格，窄屏折行时不会被拆开；
 * - 复数只给英文写 `_one` / `_other` 变体，中文写基础 key 即可。
 */
export const zh: Record<string, string> = {
  // ---------- 输入行 ----------
  "input.placeholder": "输入消息，/ 查看命令…",
  "input.hint.ready": "Enter 发送 · Ctrl+J 换行 · / 命令 · PgUp 看历史",
  "input.hint.scrolling": "↕ 滚动中 · PgUp/PgDn 翻页 · 发送回到底部",
  "input.hint.initializing": "初始化中…",

  // ---------- 状态栏 ----------
  "status.agent": " · agent ",
  "status.effort": " · 思考 ",
  "status.lastTokens": "本轮\u00a0{n}\u00a0tok",
  "status.totalTokens": "累计\u00a0{n}\u00a0tok",
  "status.avgRate": "⚡\u00a0均\u00a0{rate}",
  "status.busy": "⏳ 生成中",

  // ---------- 思考档位 ----------
  "effort.off": "关",
  "effort.none": "关",
  "effort.minimal": "极低",
  "effort.low": "低",
  "effort.medium": "中",
  "effort.high": "高",
  "effort.xhigh": "极高",
  "effort.max": "最高",
  "effort.custom": "自定义",
  "effort.default": "默认",
  "effort.unsupported": "—",

  // ---------- 生成状态 ----------
  "spinner.thinking": "思考中…",

  // ---------- 通知 ----------
  "notice.reloaded": "已按新配置重建会话（消息与上下文保留）",
  "notice.draftSaved": "已暂存输入（Ctrl+S 恢复）",
  "notice.draftRestored": "已恢复暂存的输入",
  "notice.pasteImageUnsupported": "暂不支持粘贴图片（Ctrl+V 预留给图片粘贴，当前未实现）",
  "notice.inputCleared": "已清空输入 · 再按一次 Ctrl+C 退出",
  "notice.pressCtrlDAgain": "再按一次 Ctrl+D 退出",
  "notice.languageChanged": "界面语言已切换为中文",

  // ---------- 命令 ----------
  "command.lang": "切换界面语言（中文 / English）",
};
