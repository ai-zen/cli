/**
 * 词典守卫 —— 两条**机械**检查，替代「靠人眼睛核对」。
 *
 * ## 为什么要有这个文件
 *
 * CLI 的词典是 `Record<string, string>`（没有 `MessageKey` 那种编译期枚举），`t()` 在缺词条时
 * 把 key 本身当文案返回。这个设计是刻意的（远端拼错时能一眼看出漏了哪条，见 `index.ts` 的
 * 注释），代价是两类错误编译期发现不了：
 *
 *   1. `t("cmd.xyz.desc")` 打错一个字 → 用户屏幕上直接出现 `cmd.xyz.desc`；
 *   2. 词典里多写了一条**没人取得到**的词条（`effort.custom` 就是这样：`custom` 不在档位
 *      白名单里，那条「自定义」永远不会上屏，而读词典的人以为它在用）。
 *
 * 这两条都能被机械检查出来，所以放在这里：改动词典或加一处 `t()` 时，红的是用例，不是用户。
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "./en.js";
import { en as enWizard } from "./en-wizard.js";
import { KNOWN_EFFORT_LEVELS } from "../reasoning-effort.js";

/** 合并后的英文词典（英文是兜底语言，键集合与中文一一对应，另有 `index.test.ts` 钉住） */
const DICT: Record<string, string> = { ...en, ...enWizard };

/** 源码根（`src/`） */
const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * `effort.*` 里**不是档位名**的那几条。
 *
 * `effort.<档位名>` 是**动态键**（`effortLabel()` 里拼出来的），取值域就是
 * {@link KNOWN_EFFORT_LEVELS}；其余几条是按语义取用的固定键。
 */
const NON_LEVEL_EFFORT_KEYS = new Set([
  "effort.default",
  "effort.custom",
  "effort.unsupported",
  "effort.followDefault",
  "effort.quoted",
  "effort.summary",
  "effort.summarySession",
]);

/**
 * 三族**动态键**及其取值域。
 *
 * 这些键在源码里以 `t(`xxx.${var}`)` 的形式拼出来，字面量搜不到 —— 所以这里把「取值域」
 * 声明出来，由下面的用例把它们排除在「字面引用」检查之外（它们自己的白名单仍有各自的用例）。
 */
const DYNAMIC_KEY_FAMILIES: Array<{ prefix: string; values: readonly string[] }> = [
  { prefix: "effort.", values: KNOWN_EFFORT_LEVELS },
  // 模型作用域三档（`handlers.ts` 的 `cmd.model.scope.${scope}`）
  { prefix: "cmd.model.scope.", values: ["session", "agent", "global"] },
];

/** 属于动态家族的那些键 */
const DYNAMIC_KEYS = new Set(
  DYNAMIC_KEY_FAMILIES.flatMap(({ prefix, values }) => values.map((value) => `${prefix}${value}`)),
);

/** 递归收集 `src/` 下的源码文件 */
async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 词典自己（含这个文件）不参与：它们本来就在定义键
      if (entry.name === "i18n") continue;
      out.push(...(await sourceFiles(path)));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("词典守卫", () => {
  /**
   * 字面量键必须存在。
   *
   * 只扫**字面量**（`t("cmd.load.desc")`）：动态键（`effort.${level}`、`wiz.reload.${key}`、
   * `cmd.model.scope.${scope}`）各自的白名单由下面的用例与各自的单元用例钉住 —— 这条守卫
   * 不假装能验证它们。（状态栏块名已不再拼词条：三块的身份标签写在 `status.agent` /
   * `status.effort` 两条字面量里，见 `status-blocks.ts`。）
   */
  it('每个字面量 t("…") 的键都在词典里', async () => {
    const missing: string[] = [];
    for (const file of await sourceFiles(SRC_ROOT)) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/\bt\(\s*"([A-Za-z][\w.]*)"/g)) {
        const key = match[1]!;
        if (!(key in DICT)) missing.push(`${file.slice(SRC_ROOT.length)} → ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * `effort.*` 的键集合必须**恰好**是「档位白名单 ∪ 那几条非档位的固定键」。
   *
   * 反过来漏一条（白名单里有、词典里没有）会显示英文原文；正过来多一条（词典里有、白名单
   * 里没有）就是永远上不了屏的死词条 —— `effort.custom` 正是这么活了很久。
   */
  it("effort 词条与档位白名单一一对应（不许有取不到的死词条）", () => {
    const fromLevels = KNOWN_EFFORT_LEVELS.map((level) => `effort.${level}`).sort();
    const extra = Object.keys(DICT)
      .filter((key) => key.startsWith("effort.") && !NON_LEVEL_EFFORT_KEYS.has(key))
      .sort();
    expect(extra).toEqual(fromLevels);

    // 白名单里的每一档都必须真的有词条
    for (const key of fromLevels) expect(DICT[key], `缺词条：${key}`).toBeTruthy();
  });

  /**
   * 每个词条都真的有人取 —— 要么在生产码里字面出现（`t("…")`、`descriptionKey` 里的键名），
   * 要么属于上面声明过的动态家族。
   *
   * 这是「不留垃圾」的机械版：词条跟着功能一起死掉时（规则搬到宿主了、屏改版了、
   * 只被用例当夹具引用），这条会红。`handoff.path` / `effort.err.*` / `ws.empty` 那批就是
   * 靠它发现并删掉的。
   */
  it("每个词条要么被生产码字面引用，要么属声明的动态家族", async () => {
    const production = (
      await Promise.all((await sourceFiles(SRC_ROOT)).map((file) => readFile(file, "utf8")))
    ).join("\n");

    const orphans = Object.keys(DICT).filter(
      (key) => !DYNAMIC_KEYS.has(key) && !production.includes(key),
    );
    expect(orphans).toEqual([]);
  });
});
