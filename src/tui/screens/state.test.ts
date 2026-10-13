import { describe, expect, it } from "vitest";
import { chatReducer, trimTranscript, MAX_TRANSCRIPT_BLOCKS, type ChatState } from "./state.js";

describe("chatReducer 视图封顶（长对话内存有界）", () => {
  it("blocks 超过上限时只保留最近的 N 条", () => {
    let state: ChatState = { blocks: [], live: null };
    const total = MAX_TRANSCRIPT_BLOCKS + 50;
    for (let i = 0; i < total; i += 1) {
      state = chatReducer(state, { type: "user", text: `u${i}` });
    }
    expect(state.blocks.length).toBe(MAX_TRANSCRIPT_BLOCKS);
    // 保留的是「最近」的：最后一条是 u{total-1}
    expect(state.blocks[state.blocks.length - 1]).toMatchObject({ kind: "user", text: `u${total - 1}` });
    // 最旧的不复存在
    expect(state.blocks.some((b) => (b as any).text === "u0")).toBe(false);
  });

  it("notice / error / done 追加同样受封顶约束", () => {
    let state: ChatState = { blocks: [], live: null };
    for (let i = 0; i < MAX_TRANSCRIPT_BLOCKS + 10; i += 1) {
      state = chatReducer(state, { type: "notice", text: `n${i}` });
    }
    state = chatReducer(state, { type: "error", text: "boom" });
    expect(state.blocks.length).toBe(MAX_TRANSCRIPT_BLOCKS);
    expect(state.blocks[state.blocks.length - 1]).toMatchObject({ kind: "notice", tone: "error" });
  });

  it("封顶不触碰 live（流式中的回答不受影响）", () => {
    let state: ChatState = { blocks: [], live: null };
    for (let i = 0; i < MAX_TRANSCRIPT_BLOCKS + 5; i += 1) {
      state = chatReducer(state, { type: "user", text: `u${i}` });
    }
    state = chatReducer(state, { type: "content", text: "hi" });
    expect(state.live?.content).toBe("hi");
  });

  it("trimTranscript 对未超限数组原样返回（引用不变）", () => {
    const arr = [{ id: 1, kind: "user" as const, text: "x" }];
    expect(trimTranscript(arr)).toBe(arr);
  });
});
