/**
 * `statusBlocksOf` 的用例：块是客户端拼的，事实是会话层的活值。
 *
 * 三条纪律在这里钉住：
 *
 *   1. 块集合与顺序是固定的（身份 → 四件事 → 用量 → 速率 → 快捷键）—— 少一块、多一块都要在这里红；
 *   2. 用量那两个数是客户端从消息上算出来的事实（宿主不报用量，但消息上有 `usage`），
 *      传什么就摆什么，这一层不替它再算一遍；
 *   3. 块里带的是同一份活事实本身，不是抄一份值 —— 同一个字段换一个对象，下一帧就看见。
 */

import { describe, expect, it } from "vitest";
import { statusBlocksOf, type StatusBlockFacts } from "./status-blocks.js";
import type { RateSample } from "./session-rate.js";

const IDLE: RateSample = { live: null, average: null, running: false };

function facts(overrides: Partial<StatusBlockFacts> = {}): StatusBlockFacts {
  return {
    model: { modelId: "m1", name: "模型一", vision: false, source: "agent" },
    thinking: { preset: null, levels: [], selected: null, source: "not_adjustable", params: {} },
    lastTokens: 1284,
    totalTokens: 20345,
    rate: IDLE,
    working: false,
    status: "idle",
    inputPaused: false,
    outputPaused: false,
    alive: true,
    ...overrides,
  };
}

describe("statusBlocksOf", () => {
  it("五块按摆放顺序给出：身份 → 四件事 → 用量 → 速率 → 快捷键", () => {
    expect(statusBlocksOf(facts()).map((block) => block.id)).toEqual([
      "identity",
      "gates",
      "usage",
      "rate",
      "keys",
    ]);
  });

  it("四件事各一格地传下去 —— 不合成、不推算（PRD 4.4）", () => {
    const blocks = statusBlocksOf(
      facts({ status: "working", inputPaused: true, outputPaused: true, alive: false }),
    );
    const gates = blocks.find((block) => block.id === "gates");
    expect(gates).toEqual({
      id: "gates",
      facts: { status: "working", inputPaused: true, outputPaused: true, alive: false },
    });
  });

  it("用量块带着会话层算好的两个数：本轮 / 累计", () => {
    const usage = statusBlocksOf(facts()).find((block) => block.id === "usage");
    expect(usage?.id === "usage" && usage.facts).toEqual({ lastTokens: 1284, totalTokens: 20345 });
  });

  it("还没答过时两个数是 `null`（不写 0 假装）：块照样在，内容由渲染层决定不占位", () => {
    const usage = statusBlocksOf(facts({ lastTokens: null, totalTokens: null })).find(
      (block) => block.id === "usage",
    );
    expect(usage?.id === "usage" && usage.facts).toEqual({
      lastTokens: null,
      totalTokens: null,
    });
  });

  it("身份块只有两处活事实：模型 / 思考档（助手那一格已经从状态栏拿掉）", () => {
    const [identity] = statusBlocksOf(facts());
    expect(identity?.id).toBe("identity");
    if (identity?.id !== "identity") throw new Error("身份块不见了");
    expect(identity.facts.model.modelId).toBe("m1");
    expect(identity.facts.thinking.source).toBe("not_adjustable");
    // 助手那件事不再是状态栏的事实：整块只有模型与思考档两格
    expect(Object.keys(identity.facts).sort()).toEqual(["model", "thinking"]);
  });

  it("块里的值是同一份对象（不是抄一份值）—— 改一处事实，下一帧就看见", () => {
    const input = facts();
    const rate = statusBlocksOf(input).find((block) => block.id === "rate");
    // 会话层那份采样每次读都是新对象；这里要的是「块指向它」，而不是「块等于它当时的副本」
    expect(rate?.id === "rate" && rate.facts.rate === input.rate).toBe(true);
  });

  it("速率块同时带「手上有没有活」：生成中看实时、没活时看平均，那一格由事实带着", () => {
    const busyBlock = statusBlocksOf(facts({ working: true })).find((block) => block.id === "rate");
    expect(busyBlock?.id === "rate" && busyBlock.facts.working).toBe(true);
  });

  it("快捷键块没有宿主事实（写的是界面自己的话）", () => {
    const keys = statusBlocksOf(facts()).find((block) => block.id === "keys");
    expect(keys).toEqual({ id: "keys" });
  });

  it("上下文占用 / 目录 / 在跑的工具 / subagent 仍然不进来（阶段行与页签里已经有了）", () => {
    const ids = statusBlocksOf(facts()).map((block) => block.id);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("context");
    expect(ids).not.toContain("folder");
    expect(ids).not.toContain("tools");
    expect(ids).not.toContain("subagent");
  });
});
