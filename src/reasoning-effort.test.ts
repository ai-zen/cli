import { describe, it, expect, beforeEach } from "vitest";
import type { ThinkingState } from "./session/types.js";
import {
  KNOWN_EFFORT_LEVELS,
  effortLabel,
  effortLabelText,
  isAdjustable,
  thinkingView,
} from "./reasoning-effort.js";
import { setLocale } from "./i18n/index.js";

// 档位文案由 i18n 词典提供：这些用例断言中文文案，故显式锁定语言
beforeEach(() => setLocale("zh"));

/** 宿主算好的思考现状（`ThinkingState` 的四个事实） */
const thinkingOf = (over: Partial<ThinkingState> = {}): ThinkingState => ({
  preset: "deepseek",
  levels: ["low", "high", "max", "off"],
  selected: null,
  source: "following_default",
  params: {},
  ...over,
});

describe("档位标签", () => {
  it("常见档位有中文标签，未知档位原样显示", () => {
    for (const level of KNOWN_EFFORT_LEVELS) {
      // 中文界面下每个已知档位都有本土化文案，且不等于档位名本身
      expect(effortLabel(level)).not.toBe(level);
    }
    expect(effortLabel("high")).toBe("高");
    expect(effortLabel("ultra-max")).toBe("ultra-max"); // 用户在策略表里自建的档位名
  });

  it("英文界面下档位标签跟着变（文案不参与任何逻辑）", () => {
    setLocale("en");
    expect(effortLabel("high")).toBe("high");
    expect(effortLabel("off")).toBe("off");
  });

  it("effortLabelText 给汇总文案用的那个词（null = 跟随模型默认）", () => {
    expect(effortLabelText("high")).toBe("「高」");
    expect(effortLabelText(null)).toBe("跟随模型默认");
  });
});

describe("isAdjustable（能不能调档只看宿主给的 levels / source）", () => {
  it("有档位就能调", () => {
    expect(isAdjustable(thinkingOf())).toBe(true);
    expect(isAdjustable(thinkingOf({ selected: "high", source: "manual" }))).toBe(true);
  });

  it("一个档位都没有 → 不可调（宿主说 not_adjustable）", () => {
    expect(
      isAdjustable({
        preset: null,
        levels: [],
        selected: null,
        source: "not_adjustable",
        params: {},
      }),
    ).toBe(false);
  });
});

describe("thinkingView 状态栏文案与置灰", () => {
  it("不可调档 → 「—」并置灰", () => {
    const view = thinkingView({
      preset: null,
      levels: [],
      selected: null,
      source: "not_adjustable",
      params: {},
    });
    expect(view.text).toBe("—");
    expect(view.dimmed).toBe(true);
  });

  it("跟随默认 → 「默认」，不置灰", () => {
    const view = thinkingView(thinkingOf({ selected: null, source: "following_default" }));
    expect(view.text).toBe("默认");
    expect(view.dimmed).toBe(false);
  });

  it("手改过参数（凑不成任何一档）→ 「自定义」，与「默认」分开", () => {
    // 两者含义相反：自定义表示用户改过，默认表示用户没有设过。两者说成一样，会让用户以为
    // 自己那份没生效，或者再设一次把手写值覆盖掉。
    const view = thinkingView(
      thinkingOf({
        selected: null,
        source: "custom",
        params: { reasoning_effort: "ultra" },
      }),
    );
    expect(view).toEqual({ text: "自定义", dimmed: false });
    expect(view.text).not.toBe(thinkingView(thinkingOf()).text);
    // 英文界面下同一格事实由英文文案表达
    setLocale("en");
    expect(thinkingView(thinkingOf({ selected: null, source: "custom" })).text).toBe("custom");
    setLocale("zh");
  });

  it("手动设了某档 → 显示该档", () => {
    const high = thinkingView(
      thinkingOf({
        selected: "high",
        source: "manual",
        params: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      }),
    );
    expect(high).toEqual({ text: "高", dimmed: false });
    expect(thinkingView(thinkingOf({ selected: "max", source: "manual", params: {} })).text).toBe(
      "最高",
    );
  });

  it("关掉的档位（off / none）置灰，且判断依据是档位值而不是文案", () => {
    for (const level of ["off", "none"]) {
      expect(thinkingView(thinkingOf({ selected: level, source: "manual" })).dimmed).toBe(true);
    }
    // 切到英文后置灰结果不变（同样的档位值 → 同样的结论）
    const en = (() => {
      setLocale("en");
      const view = thinkingView(thinkingOf({ selected: "off", source: "manual" }));
      setLocale("zh");
      return view;
    })();
    expect(en.dimmed).toBe(true);
    expect(en.text).toBe("off");
  });

  it("用户在策略表里自建的档位名原样显示（不显示成「?」）", () => {
    const view = thinkingView(
      thinkingOf({ preset: "mine", levels: ["turbo"], selected: "turbo", source: "manual" }),
    );
    expect(view.text).toBe("turbo");
    expect(view.dimmed).toBe(false);
  });
});
