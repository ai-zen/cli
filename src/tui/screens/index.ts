// 对话屏（screens）—— 对外统一出口
//
// 本目录按职责分成多个模块，此处只做 re-export —— 本目录只有这一个出口，外部
// （`tui/index.tsx` 等）一律写 `from "./screens/index.js"`。

// 文本度量 / 折行 / 整帧高度住在 ../text.js（纯函数、无 React 依赖），此处转发。
export {
  displayWidth,
  wrapText,
  layoutInput,
  INPUT_PREFIX_WIDTH,
  usableFrameRows,
  stripCwdNote,
} from "../text.js";

export { contentLines, toolSpans, clipSpans, spanLine, innerWidth } from "./lines.js";
export type { LineKind, RLine, Span } from "./lines.js";

export {
  messageToLines,
  cachedMessageToLines,
  transcriptLines,
  messageText,
  entersContext,
} from "./messages-view.js";

export {
  inputLines,
  inputWindow,
  INPUT_MAX_ROWS,
  computeInputCursorPosition,
  moveCursorRow,
  isWordChar,
  wordLeft,
  wordRight,
  deleteWordLeft,
  deleteWordRight,
  deleteToLineEnd,
  deleteToLineStart,
} from "./input.js";

export {
  CONFIRM_LINES,
  STATUS_BAR_LINES,
  AGENT_TABS_LINES,
  pickerLines,
  pickerCapacity,
  computeChatLayout,
  clampViewTop,
} from "./layout.js";
export type { ChatLayoutInput, ChatLayout } from "./layout.js";

export { welcomeLines } from "./welcome.js";

export { NoticeChannel, noticeLines, MAX_NOTICE_LINES } from "./notice.js";
export type { Notice } from "./notice.js";

export { AgentTabs } from "./agent-tabs.js";
export type { AgentTab, AgentTabsProps } from "./agent-tabs.js";

export { Chat, resolveSubmitText, busySpinnerLabel } from "./chat.js";
export type { ChatScreenProps } from "./chat.js";
