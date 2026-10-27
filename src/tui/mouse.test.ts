import { describe, it, expect, vi } from "vitest";
import {
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  WHEEL_STEP,
  disableMouseTracking,
  enableMouseTracking,
  isMouseSequence,
  parseWheel,
} from "./mouse.js";

describe("isMouseSequence（SGR 鼠标上报识别）", () => {
  it("识别滚轮 / 点击 / 拖拽 / 释放", () => {
    expect(isMouseSequence("[<64;10;5M")).toBe(true); // 滚轮上
    expect(isMouseSequence("[<65;10;5M")).toBe(true); // 滚轮下
    expect(isMouseSequence("[<0;10;5M")).toBe(true); // 左键按下
    expect(isMouseSequence("[<0;10;5m")).toBe(true); // 左键释放
    expect(isMouseSequence("[<35;7;2M")).toBe(true); // 拖拽（motion 位）
  });

  it("允许带前导 ESC（原始 stdin 数据未剥 ESC）", () => {
    expect(isMouseSequence("\u001b[<64;10;5M")).toBe(true);
  });

  it("不误伤普通输入与半截序列", () => {
    expect(isMouseSequence("")).toBe(false);
    expect(isMouseSequence("hello")).toBe(false);
    expect(isMouseSequence("[<64;10;5")).toBe(false); // 缺终止字节
    expect(isMouseSequence("[<64;10;5M ")).toBe(false);
    expect(isMouseSequence("我滚了一下 [<64;10;5M")).toBe(false);
  });
});

describe("parseWheel（滚轮方向解析）", () => {
  it("64 = 向上（回看更早），65 = 向下", () => {
    expect(parseWheel("[<64;10;5M")).toEqual({ direction: -1, x: 10, y: 5 });
    expect(parseWheel("[<65;3;22M")).toEqual({ direction: 1, x: 3, y: 22 });
  });

  it("剥掉修饰位（Shift 4 / Meta 8 / Ctrl 16）后仍识别滚轮", () => {
    expect(parseWheel("[<68;10;5M")?.direction).toBe(-1); // Shift + 上
    expect(parseWheel("[<69;10;5M")?.direction).toBe(1); // Shift + 下
    expect(parseWheel("[<72;10;5M")?.direction).toBe(-1); // Meta + 上
    expect(parseWheel("[<80;10;5M")?.direction).toBe(-1); // Ctrl + 上
    expect(parseWheel("[<81;10;5M")?.direction).toBe(1); // Ctrl + 下
  });

  it("横向滚轮（66 / 67）不换算成纵向滚动", () => {
    expect(parseWheel("[<66;10;5M")).toBeNull();
    expect(parseWheel("[<67;10;5M")).toBeNull();
  });

  it("点击 / 释放 / 移动都不是滚轮", () => {
    expect(parseWheel("[<0;10;5M")).toBeNull();
    expect(parseWheel("[<2;10;5m")).toBeNull();
    expect(parseWheel("[<35;7;2M")).toBeNull();
  });

  it("非鼠标输入返回 null", () => {
    expect(parseWheel("")).toBeNull();
    expect(parseWheel("a")).toBeNull();
    expect(parseWheel("[?0u")).toBeNull();
  });
});

describe("终端模式序列", () => {
  it("开启 = 1000（按钮事件）+ 1006（SGR 坐标），关闭完全对应", () => {
    expect(MOUSE_ENABLE).toBe("\u001b[?1000h\u001b[?1006h");
    expect(MOUSE_DISABLE).toBe("\u001b[?1000l\u001b[?1006l");
  });

  it("enable / disable 写入传入的流（可注入，便于测试）", () => {
    const write = vi.fn();
    const stream = { write } as unknown as NodeJS.WriteStream;
    enableMouseTracking(stream);
    expect(write).toHaveBeenCalledWith(MOUSE_ENABLE);
    disableMouseTracking(stream);
    expect(write).toHaveBeenCalledWith(MOUSE_DISABLE);
  });

  it("滚轮步长为整数行数", () => {
    expect(Number.isInteger(WHEEL_STEP)).toBe(true);
    expect(WHEEL_STEP).toBeGreaterThan(0);
  });
});
