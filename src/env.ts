/**
 * 本进程的事实：配置根在哪、显式宿主地址、显式凭证。
 *
 * 这三个值收成一个对象，是因为它们原本是三个散着的读取函数（`AI_ZEN_DIR` 常量 + `explicitServerUrl()`
 * + `explicitServerToken()`），于是「根目录」这事有两个答案：`resolveRoot()` 在模块求值那一刻算一次，
 * `i18n/preferences.ts` 又抄了一遍同样的 `HOME` 拼法在每次调用时重算。两套判据、两种时机，症状是设了
 * `AI_ZEN_DIR` 之后有个文件跟着走、另一个不跟。现在只有一处解析（{@link resolveCliEnv}）、一个值
 * （{@link CliEnv}）、一个写点（{@link applyCliEnv}，生产侧只有 `CliApp` 调）。
 *
 * 没有缺省值：{@link cliEnv} 在没设置时抛错，不回落成自己读 `process.env`。回落会让「谁在什么时候定
 * 的根」重新变成不可回答的问题，而且错得很安静 —— 拿到的是一个看起来正常的目录；抛错是一句能贴进
 * issue 的话。
 *
 * `AIZ_DEBUG_KEYS` / `AIZ_PREFERENCES_FILE` 这些开关留在读取点：它们是「当场要不要打个诊断」的开关，
 * 不进任何契约，也不需要跟配置根同时成立。搬进来只会让这个对象变大，换不到任何保证。从前的
 * `AIZ_DEBUG_SDK` / `AIZ_SDK_LOG_FILE` 随 `sdk-log.ts` 一起没了：日志实例由根造、落点由布局定，不再
 * 有一个全局开关。
 */

import { join } from "node:path";
// 地址形状的唯一定义处（四种 scheme、IPv6、缺省端口）—— 校验不在这里再写一份，
// 否则「启动时能过、连的时候报错」这种两边判据分叉的错必然出现
import { parseAddress } from "./server-client/index.js";

/**
 * 一次进程生命的三个事实：连哪儿、拿什么进门、本机的东西放哪。其余环境变量都不需要在启动时定死。
 */
export interface CliEnv {
  /** 配置根（`AI_ZEN_DIR` > `<home>/.ai-zen`）—— 本机唯一一处会被写的目录树 */
  aiZenDir: string;
  /**
   * 显式宿主地址：`--server` > `AI_ZEN_SERVER_URL` > `undefined`。
   *
   * `undefined` 之后接什么（发现文件 `run/host.json` + `run/token`）不是本文件的事 —— 那是
   * `@ai-zen/agents-client` 的 `ensureHost`，它才是「连哪儿 + 拿什么进门」的唯一解析点。这里只把
   * argv / env 里那两份显式值捞出来递给它，判据不重复实现。
   *
   * 字段名与两个环境变量名（`--server` / `AI_ZEN_SERVER_URL`）保持一致：那两个名字是用户面的（脚本里
   * 写着、帮助里印着），不随内部的 host 词汇改名。
   */
  serverUrl?: string;
  /**
   * 显式凭证（`AI_ZEN_SERVER_TOKEN`），只在显式地址那条路上有意义。
   *
   * 本机（走发现文件）那条路一律读 `<aiZenDir>/run/token`：那是 `ensureHost` 的规则，本文件与
   * `connection.ts` 都不重复实现一遍（两份判据分叉的症状是「本机连上了、远端被拒」）。
   */
  serverToken?: string;
}

/**
 * 从 `env` 与 argv 的 `--server` 解出这次进程的事实（纯函数：不改任何状态）。
 *
 * `serverUrlFlag` 的三种取值都要分开对待：`undefined` 是这次没给 `--server`，退回
 * `AI_ZEN_SERVER_URL`；空串是给了参数但没给值（`ai --server` 结尾），那是拼错的调用，不当成没给，
 * 否则会静默地连回本机，而用户以为他指定了远端；其它就直接用它，合法性由 {@link serverUrlError} 在
 * 启动早期判。
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

let current: CliEnv | undefined;

/**
 * 钉下这一份事实（唯一写点）。
 *
 * 生产侧只有 `CliApp` 的构造函数调它，一次进程只该钉一次；用例侧走
 * `src/test-support/temp-dir.ts`（它同时负责收尾还原）。
 */
export function applyCliEnv(env: CliEnv): void {
  current = env;
}

/**
 * 读这一份事实。
 *
 * 没设置就抛：调用点（`sdkLogFile()` / `preferencesFile()` 这类进程级单例）全在函数里，所以时机由调用
 * 方决定，而不是由 import 顺序决定 —— 这正是原来 `export let AI_ZEN_DIR = resolveRoot()` 给不了的性
 * 质。
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
 * 显式地址的早期校验：不合法时返回一句人话，合法（或压根没给）返回 `null`。
 *
 * 必须在启动早期判：地址拼错时，唯一能把它说清楚的地方是入口。让它飘到 `connectHost` /
 * `readHostStatus` 那一层，用户看到的会是「连不上 x:80」或者一条栈 —— 而真正的原因是他把
 * `wss://example.com/ai-zen` 敲成了 `wss:/example.com`。
 *
 * 判据就是连接层那一句 `parseAddress`（地址形状的唯一实现处）：它接受 `ws:` / `wss:` / `http:` /
 * `https:`，没写 scheme 的裸 `host:port` 按 `ws://` 补。所以这里不另立一套「合法地址」定义，措辞也
 * 用它给的那句。
 *
 * @returns 一句带原值的人话（由入口写到 stderr）；没有问题返回 `null`
 */
export function serverUrlError(env: CliEnv): string | null {
  const raw = env.serverUrl;
  if (raw === undefined) return null;
  // `--server` 给了却没给值：先给一句对症的话（要用户去猜 `"" 不是合法的宿主地址 ` 太刻薄）
  if (raw.trim() === "") {
    return "--server 需要一个地址（例：--server wss://example.com/ai-zen）";
  }
  try {
    parseAddress(raw);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 空白等于没有：`AI_ZEN_SERVER_URL=""` 是「别用它」的常见写法，不是一条非法地址。
 *
 * 「不传」与「传空串」的区别是实的：连接层（`settings.ts` 的 `settingsToTarget`）第一句就是空串归一成
 * `undefined`，于是空串会落到下一级（读 `<aiZenDir>/run/token`）；而宿主对长度为 0 的凭证只会回
 * `unauthorized`。所以空白一律算没设，不把一格空格当成一把锁。
 */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}
