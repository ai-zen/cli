import { describe, expect, it, beforeEach } from "vitest";
import {
  chooseHandoffMode,
  handoffModeItems,
  HANDOFF_SKIP,
  type HandoffPickerState,
} from "./handoff-choice.js";
import { setLocale } from "../../i18n/index.js";

// 选项文案已 i18n 化：这些用例断言中文，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

/** 捕获 pickerState 的假 setter（chooseHandoffMode 以「值」形式调用它） */
function makeSetter() {
  let captured: HandoffPickerState | null = null;
  const set = ((value: HandoffPickerState | null | ((prev: HandoffPickerState | null) => HandoffPickerState | null)) => {
    captured = typeof value === "function" ? value(captured) : value;
  }) as Parameters<typeof chooseHandoffMode>[0];
  return { set, get: () => captured };
}

describe("handoffModeItems（三选一选项）", () => {
  it("顺序与取值：self / summary / 不交接(哨兵)", () => {
    const items = handoffModeItems();
    expect(items.map((i) => i.value)).toEqual(["self", "summary", HANDOFF_SKIP]);
    expect(items[0]!.label).toContain("当前会话自己写");
    expect(items[1]!.label).toContain("单独 Agent 写");
    expect(items[2]!.label).toBe("不交接");
  });
});

describe("chooseHandoffMode（选择 → HandoffMode | null）", () => {
  it("self / summary 原样返回", async () => {
    for (const mode of ["self", "summary"] as const) {
      const { set, get } = makeSetter();
      const p = chooseHandoffMode(set, "选择交接方式");
      expect(get()!.items).toHaveLength(3);
      get()!.resolve(mode);
      expect(await p).toBe(mode);
    }
  });

  it("「不交接」哨兵 → null", async () => {
    const { set, get } = makeSetter();
    const p = chooseHandoffMode(set, "t");
    get()!.resolve(HANDOFF_SKIP);
    expect(await p).toBeNull();
  });

  it("Esc 取消（resolve(null)）→ null", async () => {
    const { set, get } = makeSetter();
    const p = chooseHandoffMode(set, "t");
    get()!.resolve(null);
    expect(await p).toBeNull();
  });

  it("标题透传给选择器", () => {
    const { set, get } = makeSetter();
    void chooseHandoffMode(set, "上下文即将超限（200/80 tokens）· 选择交接方式");
    expect(get()!.title).toContain("选择交接方式");
  });
});
