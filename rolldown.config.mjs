import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "rolldown";

const require = createRequire(import.meta.url);
const versionOf = (spec) => JSON.parse(readFileSync(require.resolve(spec), "utf-8")).version;

/**
 * 三个版本号在**构建时**定死。
 *
 * 产物里 `version.ts` 被 hoist 进 `dist/chunks/`，`createRequire(import.meta.url)` 之后
 * `../package.json` 不再指向包根；而 `@ai-zen/agents-sdk` / `-core` 打包后根本不在
 * 消费者机器上。构建时读一次、替换成字面量，比运行期解析更准也更简单。
 */
const define = {
  __CLI_VERSION__: JSON.stringify(versionOf("./package.json")),
  __SDK_VERSION__: JSON.stringify(versionOf("@ai-zen/agents-sdk/package.json")),
  __CORE_VERSION__: JSON.stringify(versionOf("@ai-zen/agents-core/package.json")),
};

/**
 * CLI 打包配置。
 *
 * ## 为什么从 `tsc` 改成打包
 *
 * `@ai-zen/agents-client` 是**私有**包，`@ai-zen/agents-sdk` / `@ai-zen/agents-server`
 * 在运行期本来就不该由消费者安装 —— 三者都该被**内联**进产物。`tsc` 只逐文件转译，
 * 做不到；换成打包顺带把没用到的模块摇掉：`@ai-zen/agents-sdk` 的 barrel 里挂着
 * `openai`（20 MB）与 MCP SDK，而 CLI 只用到其中几个纯函数。
 *
 * ## 为什么 `moduleSideEffects: false`
 *
 * `@ai-zen/*` 都是本仓自己的库，模块级没有副作用（没有注册全局、没有 patched
 * console）。不开这个开关，打包器会按「万一有副作用」保守保留 —— 于是 sdk 的 barrel
 * 整个进来，摇树等于没摇。
 */
export default defineConfig({
  input: {
    index: "src/index.ts",
    stdio: "src/stdio.ts",
    session: "src/session.ts",
    "commands/index": "src/commands/index.ts",
  },
  platform: "node",
  transform: { define },
  // 运行期依赖：这些真的要在宿主机器上存在（React / Ink 不内联 —— 内联它们得自带
  // 一份 reconciler，收益远小于风险）
  external: [
    "ink",
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "highlight.js",
    "lowlight",
    "string-width",
  ],
  treeshake: {
    moduleSideEffects: false,
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "chunks/[name]-[hash].js",
    sourcemap: true,
  },
});
