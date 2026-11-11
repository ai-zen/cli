/**
 * 本进程的**事实** —— 配置根在哪、显式服务端地址、显式凭证。
 *
 * ## 为什么这三个值要收成一个对象
 *
 * 它们原本是三个散着的读取函数（`AI_ZEN_DIR` 常量 + `explicitServerUrl()` +
 * `explicitServerToken()`），于是「根目录」这事有两个答案：本文件的 `resolveRoot()` 在
 * **模块求值**那一刻算一次，`i18n/preferences.ts` 自己又抄了一遍同样的 `HOME` 拼法在**每次
 * 调用**时重算。两套判据、两种时机，症状是「设了 `AI_ZEN_DIR` 有个文件跟着走、另一个不跟」。
 *
 * 现在只有一处解析（{@link resolveCliEnv}）、一个值（{@link CliEnv}）、一个写点
 * （{@link applyCliEnv}，生产侧只有 `CliApp` 调）。要读就 {@link cliEnv}。
 *
 * ## 为什么没有缺省值
 *
 * {@link cliEnv} 在没设置时**抛错**，不回落成「自己读 `process.env`」：回落会让「谁在什么
 * 时候定的根」重新变成不可回答的问题，而错得很安静 —— 拿到的是一个看起来正常的目录。
 * 抛错是一句能贴进 issue 的话。
 *
 * ## 边界：调试开关不进来
 *
 * `AIZ_DEBUG_SDK` / `AIZ_DEBUG_KEYS` / `AIZ_PREFERENCES_FILE` 这些**留在读取点**：它们是
 * 「当场要不要打个诊断」的开关，不进任何契约，也不需要跟配置根同时成立。搬进来只会让这个
 * 对象变大，换不到任何保证。
 */

import { join } from "node:path";
// 地址形状的**唯一**定义处（四种 scheme、IPv6、缺省端口）—— 校验不在这里再写一份，
// 否则「启动时能过、连的时候报错」这种两边判据分叉的错必然出现
import { parseServerUrl } from "@ai-zen/agents-client";

/**
 * 一次进程生命的三个事实。
 *
 * 之所以只有三个：这三个是「连哪儿、拿什么进门、本机的东西放哪」，其余环境变量都不需要
 * 在启动时定死（见文件头「调试开关不进来」）。
 */
export interface CliEnv {
  /** 配置根（`AI_ZEN_DIR` > `<home>/.ai-zen`）—— 本机唯一一处会被写的目录树 */
  aiZenDir: string;
  /**
   * 显式服务端地址：`--server` > `AI_ZEN_SERVER_URL` > `undefined`。
   *
   * `undefined` 之后接什么（发现文件 `run/server.json`）不是本文件的事 —— 那是
   * `@ai-zen/agents-client` 的 `resolve-target.ts`，它才是「连哪儿 + 拿什么进门」的唯一
   * 解析点。这里只把 argv / env 里那两份**显式**值捞出来递给它，判据不重复实现。
   */
  serverUrl?: string;
  /** 显式凭证（`AI_ZEN_SERVER_TOKEN`）；`undefined` = 读 `<aiZenDir>/run/token` */
  serverToken?: string;
}

/**
 * 从 `env` 与 argv 的 `--server` 解出这次进程的事实（纯函数：不改任何状态）。
 *
 * `serverUrlFlag` 的三种取值都要分开对待：
 *   · `undefined` = 这次没给 `--server` → 退回 `AI_ZEN_SERVER_URL`；
 *   · 空串 = 「`--server` 给了但没给值」（`ai --server` 结尾）—— 那是拼错的调用，**不**当成
 *     「没给」，否则会静默地连回本机，而用户以为他指定了远端；
 *   · 其它 = 就用它（合法性由 {@link serverUrlError} 在启动早期判）。
 */
export function resolveCliEnv(input: { env: NodeJS.ProcessEnv; serverUrlFlag?: string }): CliEnv {
  const { env, serverUrlFlag } = input;
  // `AI_ZEN_DIR` 用 `||` 而不是 `??`：空串是「别用它」的常见写法，不是一条合法根路径
  const aiZenDir = env.AI_ZEN_DIR || join(env.HOME || env.USERPROFILE || "", ".ai-zen");
  return {
    aiZenDir,
    serverUrl: serverUrlFlag !== undefined ? serverUrlFlag : nonBlank(env.AI_ZEN_SERVER_URL),
    serverToken: nonBlank(env.AI_ZEN_SERVER_TOKEN),
  };
}

/** 当前这一份（由 {@link applyCliEnv} 钉进来的） */
let current: CliEnv | undefined;

/**
 * 钉下这一份事实（**唯一写点**）。
 *
 * 生产侧只有 `CliApp` 的构造函数调它 —— 一次进程只该钉一次；用例侧走
 * `src/test-support/temp-dir.ts`（它同时负责收尾还原）。
 */
export function applyCliEnv(env: CliEnv): void {
  current = env;
}

/**
 * 读这一份事实。
 *
 * 没设置就抛：调用点（`sdkLogFile()` / `preferencesFile()` / `createServerConnection()`）
 * 全在函数里，所以时机由调用方决定，而不是由 import 顺序决定 —— 这正是原来
 * `export let AI_ZEN_DIR = resolveRoot()` 给不了的性质。
 */
export function cliEnv(): CliEnv {
  if (!current) {
    throw new Error(
      "CliEnv 还没设置。生产侧由 CliApp 在启动时设置；用例请走 src/test-support/temp-dir.ts" +
        "（或直接 applyCliEnv()）。",
    );
  }
  return current;
}

/**
 * 显式地址的**早期校验**（D12）：不合法时返回一句人话，合法（或压根没给）返回 `null`。
 *
 * 为什么必须在启动早期判：地址拼错时，唯一能把它说清楚的地方是入口。让它飘到
 * `ensureServer` / `readServerStatus` 那一层，用户看到的会是「连不上 example.com:80」或者
 * 一条栈 —— 而真正的原因是他把 `wss://example.com/ai-zen` 敲成了 `wss:/example.com`。
 *
 * @returns 一句带原值的人话（由入口写到 stderr）；没有问题返回 `null`
 */
export function serverUrlError(env: CliEnv): string | null {
  const raw = env.serverUrl;
  if (raw === undefined) return null;
  // `--server` 给了却没给值：先给一句对症的话（要用户去猜 `"" 不是合法的服务端地址` 太刻薄）
  if (raw.trim() === "") {
    return "--server 需要一个地址（例：--server wss://example.com/ai-zen）";
  }
  try {
    parseServerUrl(raw);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * 空白 = 没有（`AI_ZEN_SERVER_URL=""` 是「别用它」的常见写法，不是一条非法地址）。
 *
 * 「不传」与「传空串」的区别是实的：客户端 `resolveToken` 的第一句就是「显式凭证非空才算」，
 * 空串会落到下一级（读文件）；而服务端对长度为 0 的凭证只会回 `unauthorized`。所以空白一律
 * 算「没设」，不把一格空格当成一把锁。
 */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}
