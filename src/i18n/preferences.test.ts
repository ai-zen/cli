import { describe, it, expect, afterEach, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogSink } from "@ai-zen/agents-logger";
import { DEFAULT_LOCALE, getLocale, setLocale } from "./index.js";
import {
  initLocale,
  persistLocale,
  readPreferences,
  writePreferences,
  alignLocaleWithHost,
} from "./preferences.js";

/** 本文件创建过的临时目录，`afterAll` 统一删除（否则每跑一次测试就在 /tmp 留一堆） */
const tempDirs: string[] = [];

/** 每个用例一个独立临时文件 */
function tmpPrefs(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiz-prefs-"));
  tempDirs.push(dir);
  return join(dir, "preferences.json");
}

afterEach(() => setLocale(DEFAULT_LOCALE));

/** 本文件里报出去的话（日志口从参数上递，不再走从前的全局日志器） */
const warnings: string[] = [];

const logger: LogSink = {
  info: () => {},
  warn: (message) => void warnings.push(message),
  error: () => {},
};

beforeEach(() => {
  warnings.length = 0;
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("readPreferences", () => {
  it("文件不存在 → 空偏好（第一次启动）", async () => {
    expect(await readPreferences(logger, tmpPrefs())).toEqual({});
  });

  it("损坏的 JSON → 空偏好，不抛错", async () => {
    const file = tmpPrefs();
    writeFileSync(file, "{ not json");
    expect(await readPreferences(logger, file)).toEqual({});
  });

  it("非法 language 值被忽略（当作没设置）", async () => {
    const file = tmpPrefs();
    writeFileSync(file, JSON.stringify({ language: "fr" }));
    expect(await readPreferences(logger, file)).toEqual({});
  });

  it("合法值原样读出", async () => {
    const file = tmpPrefs();
    writeFileSync(file, JSON.stringify({ language: "zh" }));
    expect(await readPreferences(logger, file)).toEqual({ language: "zh" });
  });
});

describe("writePreferences / persistLocale", () => {
  it("写入后可读回，且文件是合法 JSON", async () => {
    const file = tmpPrefs();
    await writePreferences({ language: "en" }, logger, file);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ language: "en" });
    expect(await readPreferences(logger, file)).toEqual({ language: "en" });
  });

  it("persistLocale 同时改内存并落盘", async () => {
    const file = tmpPrefs();
    await persistLocale("zh", logger, file);
    expect(getLocale()).toBe("zh");
    expect(await readPreferences(logger, file)).toEqual({ language: "zh" });
  });

  it("父目录不存在时自动创建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiz-prefs-"));
    const file = join(dir, "nested", "deep", "preferences.json");
    await writePreferences({ language: "zh" }, logger, file);
    expect(await readPreferences(logger, file)).toEqual({ language: "zh" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("initLocale", () => {
  it("有偏好时用偏好，不改写文件", async () => {
    const file = tmpPrefs();
    writeFileSync(file, JSON.stringify({ language: "zh" }));
    expect(await initLocale(logger, file)).toBe("zh");
    expect(getLocale()).toBe("zh");
    expect(await readPreferences(logger, file)).toEqual({ language: "zh" });
  });

  it("无偏好时按系统语言识别，并把结果落盘（只识别一次）", async () => {
    const file = tmpPrefs();
    const locale = await initLocale(logger, file);
    // 识别结果写入磁盘，下次启动不再依赖系统语言
    expect(await readPreferences(logger, file)).toEqual({ language: locale });
    expect(getLocale()).toBe(locale);
  });
});

describe("偏好文件读不出来 / 写不进去", () => {
  it("损坏的 JSON：报一句，按「没设置」继续，且那份文件一个字节都没动", async () => {
    const file = tmpPrefs();
    writeFileSync(file, "{ not json", "utf-8");

    const locale = await initLocale(logger, file);

    expect(warnings.join("\n")).toContain(file);
    // 写回就等于把那份读不出来的偏好覆盖成「识别结果」
    expect(readFileSync(file, "utf-8")).toBe("{ not json");
    expect(getLocale()).toBe(locale);
  });

  it("写不进去时报一句（不然重启后语言变回去，用户以为是自己记错了）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiz-prefs-"));
    tempDirs.push(dir);
    // 父路径是个普通文件：`mkdir` 必定 ENOTDIR，写一定失败
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf-8");

    await persistLocale("zh", logger, join(blocker, "preferences.json"));

    expect(warnings.join("\n")).toContain("preferences.json");
  });
});

describe("alignLocaleWithHost（出场那一次对齐）", () => {
  /** 宿主那份语言的替身：读给什么、写到哪里由用例定 */
  function hostOf(language: string | undefined) {
    const written: string[] = [];
    return {
      written,
      source: {
        read: async () => language,
        write: async (locale: string) => void written.push(locale),
      },
    };
  }

  it("宿主有值：以它为准，本机偏好也改回同一份", async () => {
    const file = tmpPrefs();
    await persistLocale("zh", logger, file);
    const host = hostOf("en");

    await alignLocaleWithHost(host.source, logger, file);

    expect(getLocale()).toBe("en");
    // 本机偏好也改成宿主那一份：下次启动不再对不上（不向宿主写任何东西）
    expect(await readPreferences(logger, file)).toEqual({ language: "en" });
    expect(host.written).toEqual([]);
  });

  it("宿主没这一格：把本机偏好推上去，两处从今天起是同一份", async () => {
    setLocale("zh");
    const host = hostOf(undefined);

    await alignLocaleWithHost(host.source, logger, tmpPrefs());

    expect(host.written).toEqual(["zh"]);
    expect(getLocale()).toBe("zh");
  });

  it("与宿主已经一致：一个字都不写", async () => {
    setLocale("zh");
    const host = hostOf("zh");

    await alignLocaleWithHost(host.source, logger, tmpPrefs());

    expect(host.written).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("读不到宿主那一格：报一句，界面语言保持本机偏好", async () => {
    setLocale("zh");
    await alignLocaleWithHost(
      {
        read: async () => {
          throw new Error("连不上");
        },
        write: async () => {},
      },
      logger,
      tmpPrefs(),
    );

    expect(getLocale()).toBe("zh");
    expect(warnings.join("\n")).toContain("连不上");
  });

  it("挑不知道的语言值：当作没设置，把本机偏好推上去", async () => {
    setLocale("en");
    const host = hostOf("fr");

    await alignLocaleWithHost(host.source, logger, tmpPrefs());

    expect(host.written).toEqual(["en"]);
  });
});
