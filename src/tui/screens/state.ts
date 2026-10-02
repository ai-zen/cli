// 由 src/tui/screens.tsx 拆分而来 —— 对话状态与归约器
import { ChatEvent } from "../chat-session.js";
import { Block, LiveAssistant } from "./lines.js";

// ==================== 对话状态与归约器 ====================

export interface ChatState {
  blocks: Block[];
  live: LiveAssistant | null;
}

export type ChatAction = ChatEvent | { type: "clear" };

export let blockSeq = 0;
export const nextId = () => ++blockSeq;

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "clear":
      return { blocks: [], live: null };
    case "user":
      return {
        blocks: [...state.blocks, { id: nextId(), kind: "user", text: action.text }],
        live: { reasoning: "", content: "", tools: [], sub: null },
      };
    case "assistant-start":
      return {
        ...state,
        live: state.live ?? { reasoning: "", content: "", tools: [], sub: null },
      };
    case "reasoning":
      return state.live
        ? { ...state, live: { ...state.live, reasoning: state.live.reasoning + action.text } }
        : state;
    case "content":
      return state.live
        ? { ...state, live: { ...state.live, content: state.live.content + action.text } }
        : state;
    case "tool": {
      if (!state.live) return state;
      const tools = [...state.live.tools];
      const prev = tools[action.index] ?? { name: "", args: "" };
      tools[action.index] = {
        name: prev.name + (action.name ?? ""),
        args: prev.args + (action.args ?? ""),
      };
      return { ...state, live: { ...state.live, tools } };
    }
    case "subagent-start":
      return state.live ? { ...state, live: { ...state.live, sub: action.name } } : state;
    case "subagent-end":
      return state.live ? { ...state, live: { ...state.live, sub: null } } : state;
    case "notice":
      return {
        ...state,
        blocks: [...state.blocks, { id: nextId(), kind: "notice", tone: "info", text: action.text }],
      };
    case "error":
      return {
        ...state,
        blocks: [...state.blocks, { id: nextId(), kind: "notice", tone: "error", text: action.text }],
      };
    case "done": {
      if (!state.live) return state;
      const { reasoning, content, tools } = state.live;
      // 请求失败时 live 可能为空壳（无思考/内容/工具）——不产生空白的 AI 块
      const isEmpty = !reasoning.trim() && !content.trim() && !tools.some((t) => t.name);
      if (isEmpty) return { ...state, live: null };
      const finished: Block = { id: nextId(), kind: "assistant", reasoning, content, tools };
      return { blocks: [...state.blocks, finished], live: null };
    }
    default:
      return state;
  }
}

