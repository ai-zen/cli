import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCALE, getLocale, setLocale } from "./index.js";
import {
  initLocale,
  persistLocale,
  readPreferences,
  writePreferences,
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

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("readPreferences", () => {
  it("文件不存在 → 空偏好（第一次启动）", async () => {
    expect(await readPreferences(tmpPrefs())).toEqual({});
  });

  it("损坏的 JSON → 空偏好，不抛错", async () => {
    const file = tmpPrefs();
    writeFileSync(file, "{ not json");
    expect(await readPreferences(file)).toEqual({});
  });

  it("非法 language 值被忽略（当作没设置）", async () => {
    const file = tmpPrefs();
    writeFileSync(file, JSON.stringify({ language: "fr" }));
    expect(await readPreferences(file)).toEqual({});
  });

  it("合法值原样读出", async () => {
    const file = tmpPrefs();
    writeFileSync(file, JSON.stringify({ language: "zh" }));
    expect(await readPreferences(file)).toEqual({ language: "zh" });
  });
});

describe("writePreferences / persistLocale", () => {
  it("写入后可读回，且文件是合法 JSON", async () => {
    const file = tmpPrefs();
    await writePreferences({ language: "en" }, file);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ language: "en" });
    expect(await readPreferences(file)).toEqual({ language: "en" });
  });

  it("persistLocale 同时改内存并落盘", async () => {
    const file = tmpPrefs();
    await persistLocale("zh", file);
    expect(getLocale()).toBe("zh");
    expect(await readPreferences(file)).toEqual({ language: "zh" });
  });

  it("父目录不存在时自动创建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiz-prefs-"));
    const file = join(dir, "nested", "deep", "preferences.json");
    await writePreferences({ language: "zh" }, file);
    expect(await readPreferences(file)).toEqual({ language: "zh" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("initLocale", () => {
  it("有偏好时用偏好，不改写文件", async () => {
    const file = tmpPrefs();
    writeFileSync(file, JSON.stringify({ language: "zh" }));
    expect(await initLocale(file)).toBe("zh");
    expect(getLocale()).toBe("zh");
    expect(await readPreferences(file)).toEqual({ language: "zh" });
  });

  it("无偏好时按系统语言识别，并把结果落盘（只识别一次）", async () => {
    const file = tmpPrefs();
    const locale = await initLocale(file);
    // 识别结果写入磁盘，下次启动不再依赖系统语言
    expect(await readPreferences(file)).toEqual({ language: locale });
    expect(getLocale()).toBe(locale);
  });
});
