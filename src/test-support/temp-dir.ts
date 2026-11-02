/**
 * 给用例一个独立的 `AI_ZEN_DIR`。
 *
 * ## 为什么必须走这里，而不是自己设 env
 *
 * `config.ts` 的路径只在**调用 `refreshPaths()` 时**重算。进程内共享模块
 * （`vitest.config.ts` 的 `isolate: false`）时，`config.js` 早在第一个测试文件里就加载完了，
 * 后面任何文件「设 env」都不会自动生效 —— 只是把变量改成一个没人读的值，写入仍然落在
 * **上一个文件**的临时目录里。这种错法不会红：两边都是临时目录，断言照样过，
 * 代价是每个文件的隔离都是假的，收尾时还会把别人刚删掉的目录重建出来（在 /tmp 留垃圾）。
 *
 * 所以「设 env → 刷新路径 → 收尾还原」必须一起做，且每个用例前都要重做一遍
 * （别的文件会在两次之间改 env）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPaths } from "../config.js";

export interface TempAiZenDir {
  /** 本次运行专属的临时根（`<tmp>/<prefix>XXXXXX`） */
  dir: string;
  /** 在 `beforeEach` 里调：把 `AI_ZEN_DIR` 钉回本文件的临时根并重算路径 */
  pin: () => void;
  /** 在 `afterAll` 里调：还回原来的 `AI_ZEN_DIR`、重算路径、删掉临时根 */
  cleanup: () => void;
}

export function useTempAiZenDir(prefix = "aizen-test-"): TempAiZenDir {
  const previous = process.env.AI_ZEN_DIR;
  const dir = mkdtempSync(join(tmpdir(), prefix));

  const pin = () => {
    process.env.AI_ZEN_DIR = dir;
    refreshPaths();
  };
  // 建目录的同时就钉一次：`beforeAll` 里创建实体、或模块顶层读路径的文件都靠这一下
  pin();

  return {
    dir,
    pin,
    cleanup() {
      if (previous === undefined) delete process.env.AI_ZEN_DIR;
      else process.env.AI_ZEN_DIR = previous;
      // 还原后必须重算：否则进程里留下的路径仍指向即将被删掉的临时根
      refreshPaths();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
