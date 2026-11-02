import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "!src/__tests__/e2e.test.ts"],
    // 文件串行 + 单进程 + 不隔离：测试之间共享模块图，省掉 57 个文件各自重新加载
    // ink/react 的 ~12s。三个代价，都必须由用例自己承担：
    //   1. 不用 `vi.mock`（它按模块说明符全局注册，会串到别的文件）—— 一律依赖注入；
    //   2. 不靠 env/模块级状态跨文件（如 `AI_ZEN_DIR`）—— 用 `src/test-support/temp-dir.ts`；
    //   3. 不并行（共享模块状态 + env，并行必跌）。
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    isolate: false,
  },
});
