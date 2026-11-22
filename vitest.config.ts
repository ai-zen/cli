import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

/**
 * `@ai-zen/agents-client` 的运行期入口 —— 指向它的 **TS 源文件**。
 *
 * 那份包是隔壁仓里**私有、不发版**的连接层：它的 `package.json` 只有 `types`，没有 `main` /
 * `exports`。它本来就不是给 Node 直接 resolve 的，而是被 cli / desktop 各自的打包器**内联进
 * 产物**（R69）。于是「跑 TS 的用例」这条路上必须显式告诉解析器去哪找它 —— 桌面端的
 * `packages/main/vitest.config.ts` 是同一个别名、同一个理由。
 *
 * 类型检查不需要这条别名：`tsc` 走 `package.json` 的 `types`（`dist/index.d.ts`），两边认的是同一份
 * 契约。**打包**（`rolldown.config.mjs`）需要同一条别名 —— 那是构建侧的事，不在这里。
 */
const CLIENT_ENTRY = fileURLToPath(
  new URL("../agents/packages/client/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: { "@ai-zen/agents-client": CLIENT_ENTRY },
  },
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
