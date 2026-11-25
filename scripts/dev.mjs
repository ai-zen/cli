#!/usr/bin/env node
/**
 * `pnpm dev` —— 起本地开发版宿主，再起 CLI，让它连上去。
 *
 * 为什么不走 `ensureHost` 那条「拉起宿主」的路：那条路里宿主是 CLI detached 拉起的，CLI 退了它还
 * 活着 —— 开发时最坑的一步就是「改了宿主代码没生效，因为上一把那个进程还在跑」。这里让宿主当本
 * 进程的子进程：日志就在眼前，Ctrl+C 一起收。
 *
 * 数据根缺省是**日常那个**（`~/.ai-zen`）：开发时想看到真实的数据、真实的配置、真实的会话。代价
 * 是它可能正被日常宿主占着，所以起之前先看一眼 `run/host.json`：还活着就停下来问一句，答应的才
 * 停 —— 杀进程是用户的东西，不能由脚本替他决定。
 *
 * 用法：
 *   pnpm dev                     构建宿主（连它依赖的各包）与 CLI，起宿主，起 CLI
 *   pnpm dev --skip-build        不构建，直接用现有 dist（快，可能拿到旧产物）
 *   pnpm dev --replace           日常宿主还活着就不问，直接停掉换开发版
 *   pnpm dev --keep-host         退出时不关宿主（下次直接连它）
 *   pnpm dev --ai-zen-dir <p>    换一个数据根
 *   pnpm dev -- --resume          `--` 之后的参数原样转给 CLI
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_ROOT = resolve(CLI_ROOT, "../agents");
const HOST_ENTRY = join(AGENTS_ROOT, "packages/host/dist/cli.js");
const CLI_ENTRY = join(CLI_ROOT, "dist/index.js");

/** 等宿主机就绪的上限：构建在起进程之前，这一段只等它监听与写发现文件 */
const READY_TIMEOUT_MS = 20_000;
/** 关宿主时先礼后兵：SIGTERM 之后等这么久，还不走就 SIGKILL */
const STOP_GRACE_MS = 5_000;

// ---- 参数 -------------------------------------------------------------------

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep === -1 ? argv : argv.slice(0, sep);
const passthrough = sep === -1 ? [] : argv.slice(sep + 1);

const flags = new Set(own.filter((arg) => arg.startsWith("--")));
const dirIndex = own.findIndex((arg) => arg === "--ai-zen-dir");
const explicitRoot = dirIndex === -1 ? undefined : own[dirIndex + 1];

const skipBuild = flags.has("--skip-build");
const replace = flags.has("--replace");
const keepHost = flags.has("--keep-host");

if (dirIndex !== -1 && explicitRoot === undefined) {
  fail("--ai-zen-dir 后面要跟一个路径");
}

/** 数据根：命令行 > `AI_ZEN_DIR` > `~/.ai-zen`（与宿主、与连接层同一口径） */
const dataRoot = resolve(explicitRoot ?? process.env.AI_ZEN_DIR ?? join(homedir(), ".ai-zen"));

// ---- 小工具 -----------------------------------------------------------------

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function say(message) {
  process.stdout.write(`${message}\n`);
}

/** 同步读发现文件：解析不了就当没有（与宿主的 `readHostFile` 同一口径） */
function readHostFile() {
  const path = join(dataRoot, "run/host.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed?.pid === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 同步跑一条命令，输出直接进终端 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise();
      rejectPromise(new Error(`${command} 退出：${signal ?? `code ${code}`}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 问一句要不要；回车、`n`、随手写点别的都算不要 */
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---- 构建 -------------------------------------------------------------------

async function build() {
  if (skipBuild) {
    say("· 跳过构建（--skip-build）");
    return;
  }
  // 为什么不是「只建 host」：宿主运行时 require 的是各包自己的 `dist`，而 `build-host` 的链条里
  // 只有 host 一个 —— sdk / core / logger 的产物还停在上一把，改了 sdk 却拿到旧 dist，症状是
  // 「代码对、行为不对」。`@ai-zen/agents-host...` 末尾那三个点 = 「它依赖的那些包」：
  // pnpm 按拓扑序建 core / logger → sdk → host，将来多一个依赖也自动跟进来。
  say("· 构建宿主与它依赖的各包（core / sdk / logger …）");
  await run("pnpm", ["--dir", AGENTS_ROOT, "-r", "--filter", "@ai-zen/agents-host...", "build"]);
  // CLI 捆的是 `@ai-zen/agents-client`：它的类型直接由宿主的 `AppRouter` 推出来，不重建就会
  // 拿着旧宿主的形状去对 `tsc`（运行时也捆旧代码）。它不在 host 的依赖链上，所以另起一步。
  say("· 构建客户端库（@ai-zen/agents-client）");
  await run("pnpm", ["--dir", AGENTS_ROOT, "--filter", "@ai-zen/agents-client", "build"]);
  say("· 构建 CLI");
  await run("pnpm", ["--dir", CLI_ROOT, "run", "build"]);
}

// ---- 宿主 -------------------------------------------------------------------

/**
 * 起之前看一眼：日常宿主还活着就问一句，答应的才停。
 *
 * 返回 `"declined"` 表示「什么都没动」—— 主流程据此直接退出。非交互环境（stdin 不是终端）里没有
 * 人能回答，于是跟答「不要」一样处理，把动手的口子留给 `--replace`。
 */
async function clearTheWay() {
  const found = readHostFile();
  if (found === undefined || !isAlive(found.pid)) return;

  say(`· 数据根上已经有一个宿主在跑：pid ${found.pid}，${found.host}:${found.port}`);

  if (!replace) {
    if (!process.stdin.isTTY) {
      say("  非交互环境里没有人能回答，这次什么都没动；要换成开发版就给 --replace");
      return "declined";
    }
    if (!(await ask("  停掉它，起开发版宿主？（y/N） "))) {
      say("  那就没动它，退出");
      return "declined";
    }
  }

  say("· 停掉它（agents-host stop --yes）");
  // `--yes`：这条命令在非交互 shell 里需要显式确认，走到这里的确认已经在上面做过了
  await run(process.execPath, [HOST_ENTRY, "stop", "--ai-zen-dir", dataRoot, "--yes"]);
  for (let waited = 0; waited < STOP_GRACE_MS && isAlive(found.pid); waited += 100)
    await sleep(100);
  if (isAlive(found.pid)) fail(`pid ${found.pid} 还在，停不下来；手动处理后重试`);
}

async function startHost() {
  const previous = readHostFile();
  say(`· 起开发版宿主（数据根 ${dataRoot}）`);
  const child = spawn(process.execPath, [HOST_ENTRY, "serve", "--ai-zen-dir", dataRoot], {
    stdio: "inherit",
    env: { ...process.env, AI_ZEN_DIR: dataRoot },
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`宿主进程起完就退了（code ${child.exitCode}），看上面的日志`);
    }
    const found = readHostFile();
    // 只认这次起的那一个：旧文件里可能是上一把留下的死 pid
    if (found !== undefined && found.pid === child.pid && isAlive(found.pid)) {
      say(`· 宿主就绪：pid ${found.pid}，${found.host}:${found.port}`);
      return child;
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  fail(`宿主 ${READY_TIMEOUT_MS}ms 内没写出发现文件，看上面的日志`);
}

// ---- CLI --------------------------------------------------------------------

function startCli() {
  say(`· 起 CLI${passthrough.length === 0 ? "" : `（参数：${passthrough.join(" ")}）`}`);
  return spawn(process.execPath, [CLI_ENTRY, ...passthrough], {
    stdio: "inherit",
    env: { ...process.env, AI_ZEN_DIR: dataRoot },
  });
}

/** 停宿主：先 SIGTERM，等不到再 SIGKILL */
async function stopHost(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let waited = 0; waited < STOP_GRACE_MS; waited += 100) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
}

// ---- 主流程 -----------------------------------------------------------------

let host;
let cli;

try {
  await build();
  if (!existsSync(HOST_ENTRY)) fail(`找不到宿主入口：${HOST_ENTRY}（先构建，别带 --skip-build）`);
  if (!existsSync(CLI_ENTRY)) fail(`找不到 CLI 入口：${CLI_ENTRY}（先构建，别带 --skip-build）`);
  if ((await clearTheWay()) === "declined") process.exit(0);
  host = await startHost();
} catch (error) {
  await stopHost(host);
  fail(String(error?.message ?? error));
}

cli = startCli();

// Ctrl+C 会同时发给整组进程（宿主与 CLI 都在这一组里），这里只负责收尾：等它们走完再退
let stopping = false;
async function shutdown(reason, code) {
  if (stopping) return;
  stopping = true;
  if (!keepHost) await stopHost(host);
  process.exit(code ?? 0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal, 0);
  });
}

cli.once("exit", async (code) => {
  say(reason(code));
  await shutdown("cli", code ?? 0);
});

host.once("exit", (code) => {
  if (stopping) return;
  /**
   * 宿主没了 ≠ CLI 该没了。
   *
   * `/shutdown` 关掉宿主之后，CLI 会摆出连接屏让用户决定「再起一台 / 改连别处 / 退出」——
   * 这里把 CLI 一起杀掉，用户看到的就是「连接屏闪一下就没了」（真实终端里不会这样，只有
   * `pnpm dev` 会：宿主是这个脚本的子进程，它一退脚本就收尾）。
   *
   * 所以只报一句，CLI 留给用户自己退（或 Ctrl+C —— 那个走下面的 `shutdown`）。
   */
  say(`宿主退了（code ${code}）：CLI 还停在连接屏上，可以在那里再起一台，或 Ctrl+C 退出`);
});

/** 那一行「为什么收工了」的话 */
function reason(code) {
  if (keepHost) return `· CLI 退了（code ${code}），宿主留着（--keep-host）`;
  return `· CLI 退了（code ${code}），宿主一起收掉`;
}
