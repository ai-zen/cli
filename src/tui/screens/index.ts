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

export { Chat, resolveSubmitText, workingSpinnerLabel } from "./chat.js";
export type { ChatScreenProps } from "./chat.js";
