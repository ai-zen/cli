/**
 * 「这次连哪台、连不连得上、要不要记住」—— CLI 侧把连接配置接起来的那一层。
 *
 * ## 三层事实，各有各的主人
 *
 * | 事实 | 谁给的 | 记不记 |
 * |---|---|---|
 * | `--server` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN` | 这一次的命令行 / 环境 | **不记**（这一次的表态） |
 * | `<aiZenDir>/cli/connection.json` | 用户在连接屏上选过的那一份 | 记（唯一会写盘的地方） |
 * | 发现文件 `run/server.json` + `run/token` | 那台机器上正在跑的服务端 | 不归本层（连接层自己读） |
 *
 * ## 「没配过」是一个独立的事实
 *
 * {@link readConnectPlan} 在「既没有显式地址、也没有落盘配置」时给出 `settings: null`。三种
 * 消费者对它有三种反应，而**没有一种**是「默认连本地」：
 *
 *   · TUI：进连接屏（首启形态）；
 *   · `ai "…"`（stdio）：**直接失败**并指路 —— 一次性调用没有人可以问，替用户猜一个
 *     「那我帮你起个本地服务端吧」的后果是：脚本在没配过的机器上偷偷下一个服务端。
 *     这条是用户明确定的口径（「未进行任何配置的情况下 `ai "xxx"` 应当直接失败」）；
 *   · `--server-status`：不进本层（诊断命令自己带地址）。
 *
 * ## 优先级只在这里判一次
 *
 * 显式地址压过落盘配置；显式凭证（`AI_ZEN_SERVER_TOKEN`）压过落盘那一份 —— 与包里
 * `resolveToken` 的优先级逐字一致（显式 > `<aiZenDir>/run/token`）。**只写了凭证不算配过**
 * （见 {@link readConnectPlan}）：凭证答的是「拿什么进门」，不是「连哪台」，而这里缺的正是后者。
 */

import {
  CLIENT_INFO,
  SERVER_PACKAGE,
  connectionSettingsPath,
  connectionSettingsToTarget,
  ensureServer,
  explainUnauthorized,
  readConnectionSettings,
  resolveToken,
  writeConnectionSettings,
  type ConnectionSettings,
  type ServerTargetSource,
} from "./server-client/index.js";
import type { CliEnv } from "./env.js";

/**
 * 一次进程的「连哪儿」。
 *
 * `settings: null` 只出现在「显式地址与落盘配置都没有」这一种情况下 —— 它是「没配过」的
 * **唯一**判据，别用 `mode === "local"` 去猜（那会把首启压成「用户选过本地」）。
 */
export interface ConnectPlan {
  /** 要连的那一份；`null` = 没配过 */
  settings: ConnectionSettings | null;
  /** 这份是命令行 / 环境给的（**成功也不落盘**：这一次的表态不是长期偏好） */
  explicit: boolean;
}

/** `<aiZenDir>/cli/connection.json` —— 与桌面端各存各的（见包里 `connectionSettingsPath`） */
export function connectionFile(env: CliEnv): string {
  return connectionSettingsPath(env.aiZenDir, "cli");
}

/**
 * 解出这次要连的那一份。
 *
 * `env.serverUrl` 的合法性不在这里判 —— `CliApp` 在启动早期已经用 `serverUrlError()` 拦过
 * （拼错时退出码 2，根本走不到这里）。两处判据分叉的症状是「启动时过了、连的时候报错」。
 */
export async function readConnectPlan(env: CliEnv): Promise<ConnectPlan> {
  if (env.serverUrl !== undefined) {
    return {
      settings: {
        mode: "remote",
        serverUrl: env.serverUrl,
        ...(env.serverToken ? { serverToken: env.serverToken } : {}),
      },
      explicit: true,
    };
  }
  return { settings: await readConnectionSettings(connectionFile(env)), explicit: false };
}

/**
 * 用户敲的地址 → 一条能交给 `parseServerUrl` 的地址。
 *
 * 只做一件事：**没写 scheme 就补 `ws://`**。用户在连接屏上敲 `10.0.0.5:8790` 是最自然的
 * 写法，而 `parseServerUrl` 要求带 scheme —— 不补的话他会得到一句「不是合法的服务端地址」，
 * 而真正的问题只是少敲了六个字符。
 *
 * **不猜加密**：写了 `https://` / `wss://` 就按他的（包里有 `http→ws`、`https→wss` 的映射），
 * 没写就当内网明文 —— 反过来「自动给你升成 wss」会在连一个没配证书的服务端时得到一条
 * 与地址无关的 TLS 报错。
 */
export function normalizeServerAddress(raw: string): string {
  const text = raw.trim();
  if (text === "") return text;
  return text.includes("://") ? text : `ws://${text}`;
}

/**
 * 一份计划 → 递给连接层的两个值。
 *
 * 显式凭证压过落盘那份：`AI_ZEN_SERVER_TOKEN` 是「这次就用它」的表态，而落盘那份是「上次
 * 填的」。`local` 模式下落盘那份吐的是 `undefined`（{@link connectionSettingsToTarget}），
 * 于是它正确地走发现文件 + 本机 `run/token`。
 */
export function connectionTargetOf(
  plan: ConnectPlan,
  env: CliEnv,
): { serverUrl?: string; serverToken?: string } {
  const fromSettings = plan.settings ? connectionSettingsToTarget(plan.settings) : {};
  return {
    serverUrl: fromSettings.serverUrl,
    serverToken: env.serverToken ?? fromSettings.serverToken,
  };
}

/** 记住这一次的选择（**只有这一处写盘**） */
export async function saveConnectPlan(env: CliEnv, settings: ConnectionSettings): Promise<void> {
  await writeConnectionSettings(connectionFile(env), settings);
}

/** 探活的结果：成功只说「能用了」，失败带一句能照做的话 */
export type ProbeResult = { ok: true } | { ok: false; message: string };

/**
 * 探一次活：能不能真的连上、握上手。
 *
 * ## 为什么它只调 `ensureServer`
 *
 * 「要不要拉起本地服务端」这条判据已经在连接层里（**有显式地址就只连、绝不拉起**，见 D10）。
 * 在这里再写一遍「地址是 loopback 吗 / 端口通吗」就是第二份判据，而两份判据分叉的症状恰好是
 * 最难查的那种：探活说不行、于是拉起一个、拉起之后还是连不上。
 *
 * 于是：
 *   · `local`（`serverUrl` 为 `undefined`）→ 发现文件 → 探活 → **拉起** → 轮询；
 *   · `remote`（给了地址）→ **只连、绝不拉起**。
 *
 * ## 为什么要自己套一层超时
 *
 * `ensureServer` 的 `timeoutMs` 管的是「拉起之后等它监听」那一段；显式地址那条路上没有它 ——
 * 一个丢包的黑洞地址会让 TCP 自己耗到几十秒，而用户此刻正盯着一块不动的屏。所以整段再套一个
 * 上限，超时就给一句「这么久还没连上」。
 *
 * 超时那一支**不取消**在飞的那次连接（WebSocket 没有取消语义），只是不再等它；它的 rejection
 * 由下面的 `.catch` 吃掉，不会变成 unhandled rejection。
 */
export const PROBE_TIMEOUT_MS = 15_000;

export async function probeConnection(
  source: ServerTargetSource,
  options: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probe = (async () => {
    const { client } = await ensureServer({
      aiZenDir: source.aiZenDir,
      clientInfo: CLIENT_INFO,
      serverPackage: SERVER_PACKAGE,
      serverUrl: source.serverUrl,
      serverToken: source.serverToken,
    });
    try {
      // `ping` 是唯一同时证明「连上了」与「进得去」的一句话：握手（含凭证）不过就没有它
      await client.call("ping");
    } finally {
      client.close();
    }
  })();
  // 输掉竞速的那一条不许冒成 unhandled rejection
  probe.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const outcome = await Promise.race([probe.then(() => "ok" as const), timeout]);
    if (outcome === "ok") return { ok: true };
    return {
      ok: false,
      message: `等了 ${Math.round(timeoutMs / 1000)} 秒还没连上 ${source.serverUrl ?? "本机服务端"}`,
    };
  } catch (error) {
    return { ok: false, message: await reasonOf(error, source) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 失败原因的一句话（**上屏**）。
 *
 * `unauthorized` 那四种成因由包的 `explainUnauthorized` 翻（措辞只有那一份，桌面端说的是同一
 * 句话）；其余错误用它自己的 `message` —— 连接层已经把「连不上哪个地址、为什么没去拉起」写在
 * 里面了，这里改一个字都会让两边说的不一样。
 *
 * 凭证本身**永不回显**（这句话会被贴进 issue）：`resolveToken` 只为了拿到「凭证从哪来」那一格，
 * 它的 `token` 字段一个字符都不进返回值。
 */
async function reasonOf(error: unknown, source: ServerTargetSource): Promise<string> {
  const { source: tokenSource } = await resolveToken(source);
  return explainUnauthorized(error, {
    explicit: source.serverUrl !== undefined,
    source: tokenSource,
    serverUrl: source.serverUrl,
    aiZenDir: source.aiZenDir,
  }).message;
}
