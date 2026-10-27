import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_LOCALE,
  detectLocale,
  getLocale,
  normalizeLocale,
  setLocale,
  t,
  SUPPORTED_LOCALES,
} from "./index.js";

/** 每个用例后复位，避免语言全局状态互相污染 */
afterEach(() => setLocale(DEFAULT_LOCALE));

describe("normalizeLocale", () => {
  it("识别常见中文 / 英文写法", () => {
    for (const v of ["zh", "zh-CN", "zh_CN.UTF-8", "ZH_tw", " zh-Hans "]) {
      expect(normalizeLocale(v)).toBe("zh");
    }
    for (const v of ["en", "en-US", "en_GB.UTF-8", "EN"]) {
      expect(normalizeLocale(v)).toBe("en");
    }
  });

  it("空值与无语言信息的 C / POSIX 返回 null", () => {
    for (const v of ["", "   ", "C", "POSIX", null, undefined]) {
      expect(normalizeLocale(v)).toBeNull();
    }
  });
});

describe("detectLocale", () => {
  it("环境变量优先于系统 locale", () => {
    expect(detectLocale({ LANG: "zh_CN.UTF-8" } as any, "en-US")).toBe("zh");
    expect(detectLocale({ LC_ALL: "en_US.UTF-8" } as any, "zh-CN")).toBe("en");
  });

  it("LC_ALL 优先于 LC_MESSAGES 与 LANG", () => {
    expect(
      detectLocale({ LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "en_US", LANG: "en_US" } as any),
    ).toBe("zh");
    expect(detectLocale({ LC_MESSAGES: "en_US", LANG: "zh_CN" } as any)).toBe("en");
  });

  it("环境变量缺失时用系统 locale 兜底", () => {
    expect(detectLocale({ LANG: "C" } as any, "zh-CN")).toBe("zh");
  });

  it("完全识别不出来时回落英文", () => {
    expect(detectLocale({} as any, undefined)).toBe("en");
    expect(detectLocale({ LANG: "C" } as any, undefined)).toBe(DEFAULT_LOCALE);
    expect(detectLocale({ LANG: "fr_FR.UTF-8" } as any, "fr-FR")).toBe("en");
  });
});

describe("t", () => {
  it("按当前语言取词条", () => {
    setLocale("zh");
    expect(t("input.placeholder")).toBe("输入消息，/ 查看命令…");
    setLocale("en");
    expect(t("input.placeholder")).toBe("Type a message, / for commands…");
  });

  it("插值替换占位符", () => {
    setLocale("zh");
    expect(t("status.lastTokens", { n: 1284 })).toBe("本轮\u00a01284\u00a0tok");
    setLocale("en");
    expect(t("status.lastTokens", { n: 1284 })).toBe("turn\u00a01284\u00a0tok");
  });

  it("缺参数时保留占位符原样（便于发现漏传）", () => {
    setLocale("zh");
    expect(t("status.lastTokens")).toBe("本轮\u00a0{n}\u00a0tok");
  });

  it("词条缺失时返回 key 本身（不做跨语言静默回退）", () => {
    setLocale("en");
    expect(t("nope.missing")).toBe("nope.missing");
  });

  it("中英文词条一一对应（英文不缺 key）", async () => {
    const { zh } = await import("./zh.js");
    const { en } = await import("./en.js");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("两种语言都不含未替换的占位符残留", async () => {
    setLocale("zh");
    for (const locale of SUPPORTED_LOCALES) {
      setLocale(locale);
      // 逐 key 用完整参数渲染一遍，确保占位符都能被替换
      for (const key of ["status.lastTokens", "status.totalTokens", "status.avgRate"]) {
        expect(t(key, { n: 1, rate: "1 tok/s" })).not.toMatch(/\{\w+\}/);
      }
    }
  });
});

describe("setLocale / getLocale", () => {
  it("切换后 getLocale 跟随", () => {
    setLocale("zh");
    expect(getLocale()).toBe("zh");
    setLocale("en");
    expect(getLocale()).toBe("en");
  });

  it("非法值回落默认语言", () => {
    setLocale("fr" as any);
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });
});
