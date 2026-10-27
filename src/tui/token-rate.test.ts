import { describe, it, expect } from "vitest";
import {
  IDLE_RATE,
  MIN_SPAN_MS,
  TokenRateMeter,
  deltaText,
  estimateTokens,
} from "./token-rate.js";

describe("estimateTokens（按字符估算）", () => {
  it("空文本为零", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("中文约 0.7 token/字，英文约 0.25 token/字符", () => {
    expect(estimateTokens("中文")).toBeCloseTo(1.4, 5);
    expect(estimateTokens("abcd")).toBeCloseTo(1, 5);
  });

  it("空白算少量（不白送 token，也不当成整字）", () => {
    expect(estimateTokens(" ")).toBeCloseTo(0.1, 5);
    expect(estimateTokens("a b")).toBeCloseTo(0.25 + 0.1 + 0.25, 5);
  });

  it("混合文本按字符逐类累加", () => {
    // 2 个中文（1.4）+ 4 个英文（1.0）
    expect(estimateTokens("中文abcd")).toBeCloseTo(2.4, 5);
  });
});

describe("deltaText（从流式 chunk 取新增文本）", () => {
  const wrap = (delta: any) => ({ choices: [{ delta }] });

  it("正文增量", () => {
    expect(deltaText(wrap({ content: "你好" }))).toBe("你好");
  });

  it("数组形式的正文增量", () => {
    expect(deltaText(wrap({ content: [{ index: 0, text: "ab" }, { index: 0, text: "cd" }] }))).toBe("abcd");
  });

  it("思考增量也计入（推理模型的思考同样是吐出来的 token）", () => {
    expect(deltaText(wrap({ reasoning_content: "想一想" }))).toBe("想一想");
  });

  it("工具调用名与参数增量也计入", () => {
    expect(deltaText(wrap({ tool_calls: [{ function: { name: "read", arguments: '{"a":1}' } }] }))).toBe(
      'read{"a":1}',
    );
  });

  it("无 delta 的 chunk（纯 usage / 心跳）返回空串", () => {
    expect(deltaText({ choices: [{ delta: {} }] })).toBe("");
    expect(deltaText({ usage: { completion_tokens: 10 } })).toBe("");
    expect(deltaText(undefined)).toBe("");
  });
});

describe("TokenRateMeter（实时 + 本轮平均）", () => {
  it("未开始时为 IDLE（状态栏不显示速率）", () => {
    const meter = new TokenRateMeter();
    expect(meter.snapshot(1000)).toEqual(IDLE_RATE);
  });

  it("实时速率按滑动窗口算，不把更早的爆发算进来", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 0); // 10 tok
    meter.addDelta("x".repeat(40), 2000); // 再来 10 tok
    // 窗口 = [0, 2000]，基准值是 t=0 的 10 → 窗口内 10 tok / 2s
    expect(meter.snapshot(2000).live).toBeCloseTo(5, 5);
  });

  it("刚开局的短跨度不出速率（避免首包爆发被放大）", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 100);
    expect(meter.snapshot(100 + MIN_SPAN_MS - 1).live).toBeNull();
    expect(meter.snapshot(100 + MIN_SPAN_MS).live).not.toBeNull();
  });

  it("流停顿时实时速率归零（而不是停在上一秒的高值）", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 0);
    expect(meter.snapshot(5000).live).toBe(0);
  });

  it("本轮平均优先用真实 completion_tokens", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 1000);
    meter.addDelta("x".repeat(40), 3000);
    meter.addExact(50);
    meter.finish(3500);
    // 真实 50 tok / 首字到末字 2s
    expect(meter.snapshot(3500)).toEqual({ live: null, average: 25, running: false });
  });

  it("没有真实用量时退回估算值", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 1000); // 10 tok
    meter.addDelta("x".repeat(40), 3000); // 累计 20 tok
    meter.finish(3500);
    expect(meter.snapshot(3500).average).toBeCloseTo(10, 5);
  });

  it("多轮工具调用：真实用量逐轮累加", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 1000);
    meter.addExact(30);
    meter.addDelta("x".repeat(40), 3000);
    meter.addExact(20);
    meter.finish(3000);
    expect(meter.snapshot(3000).average).toBeCloseTo(25, 5); // (30+20)/2s
  });

  it("跨度太短时本轮平均为 null（算不出可信速率）", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 1000);
    meter.addExact(10);
    meter.finish(1100);
    expect(meter.snapshot(1100).average).toBeNull();
  });

  it("一轮没吐出任何内容时平均为 null", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.finish(5000);
    expect(meter.snapshot(5000)).toEqual({ live: null, average: null, running: false });
  });

  it("begin 会清掉上一轮的状态", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 1000);
    meter.addExact(10);
    meter.finish(2000);
    meter.begin(5000);
    expect(meter.snapshot(5000)).toEqual({ live: null, average: null, running: true });
  });

  it("reset 回到 IDLE", () => {
    const meter = new TokenRateMeter();
    meter.begin(0);
    meter.addDelta("x".repeat(40), 1000);
    meter.reset();
    expect(meter.snapshot(2000)).toEqual(IDLE_RATE);
  });
});
