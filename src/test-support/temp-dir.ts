/**
 * 给用例一个独立的 `AI_ZEN_DIR`。
 *
 * ## 为什么必须走这里，而不是自己设 env
 *
 * 本进程的事实由 `env.ts` 的 `applyCliEnv()` 钉下 —— 进程内共享模块（`vitest.config.ts` 的
 * `isolate: false`）时，上一个测试文件早就钉过一次了，后面任何文件「设 env」都不会自动生效
 * —— 只是把变量改成一个没人读的值，写入仍然落在**上一个文件**的临时目录里。这种错法不会红：
 * 两边都是临时目录，断言照样过，代价是每个文件的隔离都是假的，收尾时还会把别人刚删掉的目录
 * 重建出来（在 /tmp 留垃圾）。
 *
 * 所以「设 env → 重新钉根 → 收尾还原」必须一起做，且每个用例前都要重做一遍
 * （别的文件会在两次之间改 env）。
 *
 * 生产侧这件事由 `CliApp` 的构造函数做（它也是唯一调 `applyCliEnv()` 的地方）—— 用例没有
 * `CliApp`，所以在这里补一个同样语义的入口，而不是让被测模块自己去读 `process.env`。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCliEnv, resolveCliEnv } from "../env.js";

export interface TempAiZenDir {
  /** 本次运行专属的临时根（`<tmp>/<prefix>XXXXXX`） */
  dir: string;
  /** 在 `beforeEach` 里调：把 `AI_ZEN_DIR` 钉回本文件的临时根并重新钉根（`applyCliEnv`） */
  pin: () => void;
  /** 在 `afterAll` 里调：还回原来的 `AI_ZEN_DIR`、重新钉根、删掉临时根 */
  cleanup: () => void;
}

export function useTempAiZenDir(prefix = "aizen-test-"): TempAiZenDir {
  const previous = process.env.AI_ZEN_DIR;
  const dir = mkdtempSync(join(tmpdir(), prefix));

  const pin = () => {
    process.env.AI_ZEN_DIR = dir;
    applyCliEnv(resolveCliEnv({ env: process.env }));
  };
  // 建目录的同时就钉一次：`beforeAll` 里创建实体、或模块顶层读路径的文件都靠这一下
  pin();

  return {
    dir,
    pin,
    cleanup() {
      if (previous === undefined) delete process.env.AI_ZEN_DIR;
      else process.env.AI_ZEN_DIR = previous;
      // 还原后必须重新钉根：否则进程里留下的路径仍指向即将被删掉的临时根
      applyCliEnv(resolveCliEnv({ env: process.env }));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
