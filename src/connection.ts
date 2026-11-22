/**
 * 「这次连哪台、连不连得上、要不要记住」—— CLI 侧把连接配置接起来的那一层。
 *
 * ## 三层事实，各有各的主人
 *
 * | 事实 | 谁给的 | 记不记 |
 * |---|---|---|
 * | `--server` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN` | 这一次的命令行 / 环境 | **不记**（这一次的表态） |
 * | `<aiZenDir>/cli/connection.json`（`HostTarget` 形状） | 用户在连接屏上选过的那一份 | 记（唯一会写盘的地方） |
 * | 发现文件 `run/host.json` + `run/token` | 那台机器上正在跑的宿主 | 不归本层（`ensureHost` 自己读） |
 *
 * ## 「没配过」是 `null`，不是一个默认值
 *
 * {@link readConnectPlan} 在「既没有显式地址、也没有落盘配置」时给出 `null`。三种消费者对它有三
 * 种反应，而**没有一种**是「默认连本地」：
 *
 *   · TUI：进连接屏（首启形态）；
 *   · `ai "…"`（stdio）：**直接失败**并指路 —— 一次性调用没有人可以问；
 *   · `--server-status`：不进本层（它自己带地址，见 {@link readHostStatus}）。
 *
 * ## 优先级只在这里判一次
 *
 * 显式地址压过落盘配置；显式凭证（`AI_ZEN_SERVER_TOKEN`）压过盘上那一份。「只写了凭证」不算配
 * 过：凭证答的是「拿什么进门」，不是「连哪台」。
 *
 * ## 拉起／发现两件事一件都不在这里
 *
 * 「本地起得来、远程只连不拉」是 `ensureHost` 的判据（`settings.mode === "remote"` 就只连）。
 * 本文件只把 CLI 的三样事实（数据根、日志落点、语言）绑上去，判据一条都不重复实现。
 *
 * ## 令牌三处来源（这一刀没变）
 *
 * 显式参数 / 落盘设置 / `<数据根>/run/token` —— 判据全在连接层（`settingsToTarget` 与
 * `ensureHost` 里的 `explicitToken`），本文件只负责把 CLI 这一侧的那两份递下去。
 */

import { join } from "node:path";

import { getLocale } from "./i18n/index.js";
import {
  addressLabel,
  connect as connectToHost,
  createLegacyCall,
  ensureHost,
  hostFilePath,
  isLoopbackHost,
  parseAddress,
  readHostFile,
  readLocalToken,
  readSettings,
  redactToken,
  SessionMirror,
  sessionIdOf,
  settingsPath,
  settingsToTarget,
  webSocketUrl,
  writeSettings,
  type ClientOptions,
  type ConnectionSettings,
  type EnsureHostResult,
  type HostClient,
  type HostEvent,
  type HostLaunchStage,
  type HostTarget,
  type Unsubscribe,
} from "./server-client/index.js";
import type { CliEnv } from "./env.js";
import { readHostVersion } from "./host-version.js";
import type { HostConnection } from "./session/types.js";
import { AGENTS_HOST_RANGE } from "./version.js";

/**
 * 把连接的 `call` 当值递出去（命令层与屏幕层都这么用）。
 *
 * 它是一个闭包（`createLegacyCall` 造的），本来就不吃 `this`；留这个名字是因为调用点很多，
 * 而它答的问题仍然是「把旧路摘出来、原样传下去」。
 */
export function boundCall(connection: HostConnection): HostConnection["call"] {
  return connection.call;
}

/** `<aiZenDir>/cli/connection.json` —— 与桌面端各存各的 */
export function connectionFile(env: CliEnv): string {
  return settingsPath(env.aiZenDir, "cli");
}

/**
 * `<aiZenDir>/logs/cli/launch.log` —— 本进程拉起宿主那一回的子进程输出。
 *
 * 落在 **CLI 那一格**（`logs/cli/`，与 `cli.log` 同一层）：拉起是 CLI 发起的，这个文件写的是
 * 那一次拉起的结果（每次拉起清空，失败时最后一行就是上屏的原因）。
 */
export function launchLogFile(env: CliEnv): string {
  return join(env.aiZenDir, "logs", "cli", "launch.log");
}

/**
 * 解出这次要连的那一份；`null` = 没配过（首启）。
 *
 * 读路径不炸：文件不在 / 坏 JSON / 字段不合法一律是 `null`（那是 `readSettings` 的契约）。
 */
export async function readConnectPlan(env: CliEnv): Promise<ConnectionSettings | null> {
  if (env.serverUrl !== undefined) {
    // 显式地址：命令行的表态不落盘
    return withExplicitToken({ mode: "remote", url: env.serverUrl }, env);
  }
  const stored = await readSettings(connectionFile(env));
  return stored ? withExplicitToken(stored, env) : null;
}

/**
 * 显式凭证压过盘上那份（「这次就用它」压过「上次填的」）。
 *
 * 只对 `mode === "remote"` 生效：本机（走发现文件）那条路的凭证是 `<数据根>/run/token`。
 */
export function withExplicitToken(settings: ConnectionSettings, env: CliEnv): ConnectionSettings {
  if (settings.mode !== "remote" || !env.serverToken) return settings;
  return { ...settings, token: env.serverToken };
}

/** 记住这一次的选择（**只有这一处写盘**；`0600` + 原子写由库里的 `writeSettings` 实现） */
export async function saveConnectPlan(env: CliEnv, settings: ConnectionSettings): Promise<void> {
  await writeSettings(connectionFile(env), settings);
}

/**
 * 把一条连接层拿到的 `HostClient` 包成 CLI 的 {@link HostConnection}。
 *
 * 多出来的三件事全是 **CLI 自己的账**：
 *
 *   · `language`：本地文案用哪种语言（连接层只管「宿主按哪种语言渲染」）；
 *   · `call`：旧路（`server-client/methods.ts`：只有 `session.create` / `session.send` 能真的
 *     转成 `api.agent.send`，其余抛 `unsupported`）；
 *   · `open` / `resync` / `closeMirror`：**一段会话的镜像**。新契约没有增量事件（流式期间推的是
 *     整条消息），所以「攒」这件事不需要规则，只需要把宿主那一条流分发给打开着的镜像。
 *
 * 事件**只订一次**：底层的 `subscribe` 在第一个订阅者出现时建立，最后一个走了才拆。会话与镜像
 * 都在这一条分发上，宿主那边因此只有一条流。
 */
export function bindConnection(client: HostClient, language: string | undefined): HostConnection {
  const mirrors = new Map<string, SessionMirror>();
  const handlers = new Set<{
    onEvent: (event: HostEvent) => void;
    onError?: (error: unknown) => void;
  }>();
  let stop: Unsubscribe | null = null;

  const dispatch = (event: HostEvent): void => {
    // 先过镜像（与旧库同一个次序：订阅者拿到事件那一刻，镜像里已经包含它）
    const sessionId = sessionIdOf(event);
    if (sessionId !== null) mirrors.get(sessionId)?.apply(event);
    for (const handler of [...handlers]) handler.onEvent(event);
  };

  const ensureSubscribed = (): void => {
    if (stop !== null) return;
    stop = client.subscribe(dispatch, (error) => {
      for (const handler of [...handlers]) handler.onError?.(error);
    });
  };

  const openMirror = async (sessionId: string): Promise<SessionMirror> => {
    const opened = await client.api.session.open.query({ sessionId });
    const existing = mirrors.get(sessionId);
    if (existing) {
      existing.applyOpen(opened);
      return existing;
    }
    // 先按宿主那一行立起来，再铺四格：`applyOpen` 会把「先到的那些事件」按序重放
    const mirror = new SessionMirror(opened.session);
    mirrors.set(sessionId, mirror);
    mirror.applyOpen(opened);
    ensureSubscribed();
    return mirror;
  };

  return {
    api: client.api,
    language,
    call: createLegacyCall(client.api, language),
    subscribe(onEvent, onError) {
      const handler = { onEvent, ...(onError === undefined ? {} : { onError }) };
      handlers.add(handler);
      ensureSubscribed();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0 && mirrors.size === 0 && stop !== null) {
          stop();
          stop = null;
        }
      };
    },
    reconnect: () => client.reconnect(),
    close: () => client.close(),
    open: openMirror,
    resync: openMirror,
    closeMirror(sessionId) {
      mirrors.delete(sessionId);
      if (handlers.size === 0 && mirrors.size === 0 && stop !== null) {
        stop();
        stop = null;
      }
    },
  };
}

/**
 * 建一条到宿主的连接（{@link connectHost} 与 {@link probeConnection} 共用的入参）。
 */
export interface ConnectHostOptions {
  /** 本进程的事实（数据根由它给） */
  env: CliEnv;
  /** 连哪台、拿什么进门（{@link readConnectPlan} 或连接屏给的那一份） */
  settings: ConnectionSettings;
  /** 「确保有一个能连的宿主」（缺省库里的 `ensureHost`；用例注入一个假的） */
  ensure?: typeof ensureHost;
  /** 本机拉起宿主的阶段（消费者只有 TUI 的下载屏） */
  onStage?: (stage: HostLaunchStage) => void;
  /** 取消这次拉起（下载屏上按 Esc / Ctrl+C 时 abort，子进程随之被杀） */
  signal?: AbortSignal;
}

/** `connectHost` 的结果：连接 + 连接层报的那几格事实 */
export type ConnectedHost = Omit<EnsureHostResult, "client"> & { client: HostConnection };

/**
 * 建一条到宿主的连接。返回时**已经调通过一次调用**（`connect` 的握手就是这样），所以
 * 「连上了」与「进得去」是同一件事。
 *
 * 要不要拉起宿主不在这里判（见文件头）。
 */
export async function connectHost(options: ConnectHostOptions): Promise<ConnectedHost> {
  const ensure = options.ensure ?? ensureHost;
  // 拉哪一版宿主：`/upgrade` 记下的确切版本 > 构建时的范围
  const versionRange = (await readHostVersion(options.env.aiZenDir)) ?? AGENTS_HOST_RANGE;
  const result = await ensure({
    dataRoot: options.env.aiZenDir,
    // 拉起日志落在 CLI 那一格：库不管「日志放哪」，落点由调用方定
    launchLog: launchLogFile(options.env),
    settings: withExplicitToken(options.settings, options.env),
    // 宿主按这条连接的语言渲染它的句子：CLI 的界面语言就是它
    language: getLocale(),
    versionRange,
    ...(options.onStage === undefined ? {} : { onStage: options.onStage }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { ...result, client: bindConnection(result.client, getLocale()) };
}

/** 探活的结果：成功只说「能用了」，失败带一句能照做的话 */
export type ProbeResult = { ok: true } | { ok: false; message: string };

/**
 * 探一次活：这份设置能不能真的连上。
 *
 * 连接拿到就关：「测试连接」只回答一个问题，回答完就不该在宿主那边留下一条常驻连接。
 */
export async function probeConnection(options: ConnectHostOptions): Promise<ProbeResult> {
  let connected: ConnectedHost | null = null;
  try {
    connected = await connectHost(options);
    return { ok: true };
  } catch (error) {
    const settings = withExplicitToken(options.settings, options.env);
    return { ok: false, message: redactToken(messageOf(error), settings) };
  } finally {
    if (connected) void connected.client.close();
  }
}

/**
 * `--server-status` 的答案：**此刻**这个地址上有没有活着的宿主。
 *
 * 判据是「握手通过」而不是「发现文件在」。字段收窄成新版 `host.version` 的那一格
 * （`{ version }`）—— 旧版的 `protocolVersion` / `startedAt` / `pid` 宿主这一版都不报了
 * （口径⑥的同类：宿主不报的就不显示，不编）。
 */
export type HostStatus =
  | {
      running: true;
      /** 答话的那个地址（`host:port`，不含凭证） */
      endpoint: string;
      /** `host.version` 的出参，原样 */
      host: { version: string };
    }
  | { running: false; reason: string };

/** {@link readHostStatus} 的可注入项（生产全用缺省值） */
export interface HostStatusOptions {
  /** 建一条已调通的连接（缺省连接层的 `connect`；用例注入一个假的） */
  connect?: (options: ClientOptions) => Promise<HostClient>;
}

/**
 * 此刻这个地址上的宿主在不在跑、是哪一版。
 *
 * **绝不拉起**：这个命令是用来诊断的。所以它不走 `ensureHost`，而是「读一次发现文件 / 用一次
 * 显式地址，然后连一次」。
 */
export async function readHostStatus(
  env: CliEnv,
  options: HostStatusOptions = {},
): Promise<HostStatus> {
  const connect = options.connect ?? connectToHost;
  const settings = (await readConnectPlan(env)) ?? { mode: "local" as const };

  /** 问一次版本；连不上就把原因说出来 */
  const ask = async (target: HostTarget, token: string): Promise<HostStatus> => {
    let client: HostClient | null = null;
    try {
      client = await connect({ url: webSocketUrl(target), token, language: getLocale() });
      return {
        running: true,
        endpoint: addressLabel(target),
        host: await client.api.host.version.query(),
      };
    } catch (error) {
      return { running: false, reason: redactToken(messageOf(error), settings) };
    } finally {
      if (client) void client.close();
    }
  };

  const { url, token } = settingsToTarget(settings);
  if (settings.mode === "remote" && url) {
    const target = parseAddress(url);
    return ask(target, await tokenFor(target, token, env));
  }

  // 本机（或一份没有地址的坏配置）：只看发现文件 —— 这一次诊断不许拉起任何东西
  const facts = await readHostFile(env.aiZenDir);
  if (!facts) return { running: false, reason: `没有发现文件：${hostFilePath(env.aiZenDir)}` };
  const target: HostTarget = { host: facts.host, port: facts.port };
  return ask(target, (await readLocalToken(env.aiZenDir)) ?? "");
}

/**
 * 显式地址那条路用哪串凭证：设置里给了就用它；没给且目标是本机回环，就用本机 `run/token`。
 */
async function tokenFor(
  target: HostTarget,
  fromSettings: string | undefined,
  env: CliEnv,
): Promise<string> {
  if (fromSettings) return fromSettings;
  if (!isLoopbackHost(target.host)) return "";
  return (await readLocalToken(env.aiZenDir)) ?? "";
}

/** 抛出值 → 一句人话 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
