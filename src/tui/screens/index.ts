// 对话屏（screens）—— 对外统一出口
//
// 原 src/tui/screens.tsx（1316 行）已按职责拆分为本目录下的多个模块，
// 此处仅做 re-export，保持既有引用路径 `./screens/index.js` 与对外符号不变。

// 文本度量 / 折行 / 整帧高度：仍位于 ../text.js，此处转发（历史引用与测试依赖）。
export { displayWidth, wrapText, layoutInput, INPUT_PREFIX_WIDTH, usableFrameRows } from "../text.js";

export { blockToLines, liveToLines, contentLines, toolSpans, clipSpans } from "./lines.js";
export type { LineKind, RLine, Span, ToolLine, Block, LiveAssistant } from "./lines.js";

export { inputLines, computeInputCursorPosition, isWordChar, wordLeft, wordRight } from "./input.js";

export { CONFIRM_LINES, pickerLines, computeChatLayout } from "./layout.js";
export type { ChatLayoutInput, ChatLayout } from "./layout.js";

export { Splash } from "./splash.js";

export { chatReducer } from "./state.js";
export type { ChatState, ChatAction } from "./state.js";

export { messagesToBlocks } from "./render.js";

export { Chat, resolveSubmitText } from "./chat.js";
export type { ChatScreenProps } from "./chat.js";
