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
        live: { reasoning: "", content: "", tools: [], sub: null, roundBase: 0 },
      };
    case "assistant-start":
      // 每次 API 请求（含一轮内并行调用后的后续轮次）都会触发：把本轮工具调用的
      // 起始下标锚到当前已收集的工具数，使新一轮 index 从 0 起也落到新的一行。
      return {
        ...state,
        live: state.live
          ? { ...state.live, roundBase: state.live.tools.length }
          : { reasoning: "", content: "", tools: [], sub: null, roundBase: 0 },
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
      // 落到「本轮起始下标 + 本轮内 index」：同一轮内的分片按 index 归并（并行调用
      // 各占一行），跨轮的同 index 因 roundBase 不同而分段，不再相互拼接。
      const pos = (state.live.roundBase ?? 0) + Math.max(0, action.index ?? 0);
      const tools = [...state.live.tools];
      // 保持数组稠密（避免稀疏空位在渲染时被 for...of 迭代为 undefined）
      while (tools.length < pos) tools.push({ name: "", args: "" });
      const prev = tools[pos] ?? { name: "", args: "" };
      tools[pos] = {
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
