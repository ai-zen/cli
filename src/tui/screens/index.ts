// 对话屏（screens）—— 对外统一出口
//
// 原 src/tui/screens.tsx（1316 行）已按职责拆分为本目录下的多个模块，
// 此处仅做 re-export，保持既有引用路径 `./screens/index.js`。

// 文本度量 / 折行 / 整帧高度：仍位于 ../text.js，此处转发（历史引用与测试依赖）。
export { displayWidth, wrapText, layoutInput, INPUT_PREFIX_WIDTH, usableFrameRows, stripCwdNote } from "../text.js";

export { contentLines, toolSpans, clipSpans, spanLine, innerWidth } from "./lines.js";
export type { LineKind, RLine, Span } from "./lines.js";

export {
  messageToLines,
  cachedMessageToLines,
  transcriptLines,
  messageText,
} from "./messages-view.js";

export {
  inputLines,
  computeInputCursorPosition,
  isWordChar,
  wordLeft,
  wordRight,
  deleteWordLeft,
  deleteWordRight,
  deleteToLineEnd,
  deleteToLineStart,
} from "./input.js";

export { CONFIRM_LINES, pickerLines, computeChatLayout, clampViewTop } from "./layout.js";
export type { ChatLayoutInput, ChatLayout } from "./layout.js";

export { Splash } from "./splash.js";

export { NoticeChannel, noticeLines, MAX_NOTICE_LINES } from "./notice.js";
export type { Notice } from "./notice.js";

export { Chat, resolveSubmitText } from "./chat.js";
export type { ChatScreenProps } from "./chat.js";
