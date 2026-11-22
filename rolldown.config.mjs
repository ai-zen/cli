import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "rolldown";

const require = createRequire(import.meta.url);
const versionOf = (spec) => JSON.parse(readFileSync(require.resolve(spec), "utf-8")).version;

/**
 * 连接层（`@ai-zen/agents-client`）的**源文件入口**。
 *
 * 它是隔壁仓里那份 `private: true`、**不发版**的连接层：`package.json` 里只有 `types`、没有
 * `main` / `exports`（见那条约束：共享代码只做私有包，cli 与 desktop 各自把它捆进自己的产物）。
 * 于是 Node 与打包器都解析不到它的运行期入口 —— 不指别名，rolldown 会把它当外部依赖原样留在
 * 产物里（`UNRESOLVED_IMPORT: treating it as an external dependency`），产物一跑就
 * `ERR_MODULE_NOT_FOUND`。
 *
 * 指 `src/index.ts` 而不是它的 `dist`：那个包的 `dist` 里没有运行期入口可用，指源码意味着不必
 * 先把它 build 一遍，也不会出现「类型来自 dist、运行期来自 src」那种各说各话。同一份路径在
 * `vitest.config.ts` 的 alias 里也有一份（桌面端的 `packages/main/rolldown.config.mjs` 是第三份）。
 */
const CLIENT_ENTRY = fileURLToPath(
  new URL("../agents/packages/client/src/index.ts", import.meta.url),
);

/**
 * 三个版本号 + 宿主的版本范围在**构建时**定死。
 *
 * 产物里 `version.ts` 被 hoist 进 `dist/chunks/`，`createRequire(import.meta.url)` 之后
 * `../package.json` 不再指向包根；而 `@ai-zen/agents-sdk` / `-core` 打包后根本不在
 * 消费者机器上。构建时读一次、替换成字面量，比运行期解析更准也更简单。
 *
 * `__AGENTS_HOST_RANGE__` 是**宿主那一版**的 semver range（PRD L14）：CLI **声明**宿主的
 * semver range、**不装**它，运行期把这个 range 交给 `npx`，由 npx 解析成「满足范围的最新版」
 * （升级因此是「重新拉起一次」就够，F-E3）。
 *
 * 它现在**不再**等于 `devDependencies` 里那一条的字面量：开发时那条是 `link:../agents/packages/host`
 * （类型与实现取自本地宿主仓，`@ai-zen/agents-host` 因此不是发布版），而 `npx` 只认 semver
 * range。两者的含义本来就不同 —— 前者说「我照哪一份源码编译」，后者说「线上该拉哪一版」。
 * 所以这里把路径式的那条归一成「那个包自己的版本」加上限：`^<version>`。
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

/**
 * 一个 `link:` / `file:` / `workspace:` 依赖 → 它指向的那份包自己的版本范围。
 *
 * npx 不认识路径式依赖；而「开发时对着哪一份、线上该拉哪一版」这两件事本来就该分开写。
 */
function hostRangeOf(spec, fallbackPath) {
  if (/^[\^~]?\d/.test(spec)) return spec;
  const target = spec.replace(/^(link|file|workspace):/, "");
  const base = new URL("./", import.meta.url);
  const pkgPath = new URL(`${target}/package.json`, base);
  const linked = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (typeof linked.version !== "string" || linked.version.length === 0) {
    throw new Error(`读不出宿主版本（${fallbackPath}）：npx 要一个 semver range`);
  }
  return `^${linked.version}`;
}

const define = {
  __CLI_VERSION__: JSON.stringify(pkg.version),
  __SDK_VERSION__: JSON.stringify(versionOf("@ai-zen/agents-sdk/package.json")),
  __CORE_VERSION__: JSON.stringify(versionOf("@ai-zen/agents-core/package.json")),
  __AGENTS_HOST_RANGE__: JSON.stringify(
    hostRangeOf(pkg.devDependencies["@ai-zen/agents-host"], "@ai-zen/agents-host"),
  ),
};

/**
 * CLI 打包配置。
 *
 * ## 为什么从 `tsc` 改成打包
 *
 * `@ai-zen/agents-client` 是**私有**包，`@ai-zen/agents-sdk` / `@ai-zen/agents-host`
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
  /**
   * 连接层内联：别名指向它的 TS 源文件，rolldown 于是把它当**本仓源码**收进产物，
   * 而不是当裸包名外置。`resolve.alias` 在 rolldown 1.2 上就是这条语义（桌面端产物
   * 用的是同一个字段），改完必须用 `grep -rn "@ai-zen/agents-client" dist/` 证死。
   */
  resolve: {
    alias: { "@ai-zen/agents-client": CLIENT_ENTRY },
  },
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
