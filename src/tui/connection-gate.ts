/**
 * 启动时的**连接门** —— 「先看上次那台还能不能用，不行就摆一块屏让用户选」。
 *
 * ## 它管的四步，一步都不许省
 *
 * ```
 *   有配过？─否─→ 连接屏（首启形态，不探活）
 *      │是
 *      ↓
 *   探一次（local 会拉起本地服务端，remote 只连不拉起）
 *      ├─通─→ 直接用这份，**不写盘**（见下）
 *      └─不通→ 连接屏（失败形态，带原因、预填上次那份）
 *                ├─用户选完并连上─→ **写盘** → 继续启动
 *                └─用户退出───────→ 结束（宿主 farewell）
 * ```
 *
 * ## 为什么「探通了不写盘，屏上选完才写盘」
 *
 * 写盘等于「记住这次的选择」。而启动时探的那一份**本来就是上次记住的**（或者命令行临时给的），
 * 再写一次是空转；命令行的更糟 —— `ai --server ws://同事的机器` 用过一次就把默认改掉，用户
 * 下次在别的目录敲 `ai` 会莫名其妙连到别人机器上。所以：**只有「用户在屏上做的选择」值得记住**。
 *
 * 反过来说，屏上的「提交」是**先验证再落盘**：连不上就不写，不把一个已知是错的配置留在盘上，
 * 下次启动还得先撞一次同样的墙。（桌面端的设置页相反 —— 那边用户明确改了配置，尊重他的意图；
 * 两处语义不同，各自写清，不合成一条。）
 *
 * ## 首启为什么不探活
 *
 * 没配过的时候，「探一次」这件事本身没有意义（探谁？），而**后果很坏**：没有显式地址的探测会
 * 让连接层读发现文件、读不到就**拉起一个本地服务端**。首启于是变成「悄悄装一个服务端」，用户
 * 根本没做过这个决定。所以首启直接进屏，一次 I/O 都不做。
 *
 * ## 屏是注入的
 *
 * 它拿 `showConnectScreen` 当参数（生产 = `mount(<ConnectScreen/>)`，用例 = 一个按剧本回答的
 * 假屏）。重试循环、写盘时机、退出这十几行因此能在没有 Ink 的地方验 —— 而它们恰好是「哪一步
 * 写盘」「连上之后还会不会再弹屏」这类只能靠读代码确认的事。
 */

import type { ConnectionSettings, ServerTargetSource } from "../server-client/index.js";
import { connectionTargetOf, saveConnectPlan, probeConnection } from "../connection.js";
import type { CliEnv } from "../env.js";
import type { ConnectPlan, ProbeResult } from "../connection.js";
import type { ConnectScreenResult } from "./screens/connect.js";

// 屏的结局形状由屏自己定义（它是生产者），这里只转出一个名字给宿主用 ——
// 不让两边各写一份同样的 union（那就是两份判据，改一处忘一处的开始）
export type { ConnectScreenResult };

/** 弹屏：把当前上下文递进去，等用户决定 */
export type ShowConnectScreen = (input: {
  /** 本次尝试的失败原因（首启形态没有） */
  reason?: string;
  /** 预填（上次那份配置）；首启是 `null` */
  initial: ConnectionSettings | null;
  /** 屏上「提交」时调：`null` = 连上了 */
  connect: (settings: ConnectionSettings) => Promise<string | null>;
}) => Promise<ConnectScreenResult>;

export interface ConnectionGateDeps {
  plan: ConnectPlan;
  env: CliEnv;
  showConnectScreen: ShowConnectScreen;
  /** 探活（缺省真去连；用例换成按剧本回答的假件） */
  probe?: (source: {
    aiZenDir: string;
    serverUrl?: string;
    serverToken?: string;
  }) => Promise<ProbeResult>;
  /** 写盘（缺省写 `<aiZenDir>/cli/connection.json`） */
  save?: (env: CliEnv, settings: ConnectionSettings) => Promise<void>;
}

export type ConnectionGateResult =
  /** `source` 是递给连接层的三个值（`aiZenDir` + 已合并优先级后的地址与凭证） */
  | { ok: true; settings: ConnectionSettings; source: ServerTargetSource }
  /** 用户在连接屏上放弃了 → 宿主该收摊退出 */
  | { ok: false };

export async function settleConnection(deps: ConnectionGateDeps): Promise<ConnectionGateResult> {
  const probe = deps.probe ?? probeConnection;
  const save = deps.save ?? saveConnectPlan;

  /** 一份设置 → 递去探活的那三个值（`aiZenDir` + 合并后的地址与凭证） */
  const sourceOf = (settings: ConnectionSettings) => ({
    aiZenDir: deps.env.aiZenDir,
    ...connectionTargetOf({ settings, explicit: false }, deps.env),
  });

  let reason: string | undefined;
  let initial = deps.plan.settings;

  // ① 配过就先试一次。首启（`settings: null`）**不探** —— 见文件头「首启为什么不探活」
  if (initial) {
    const result = await probe(sourceOf(initial));
    if (result.ok) return { ok: true, settings: initial, source: sourceOf(initial) };
    reason = result.message;
  }

  // ② 连接屏。**只弹一次**：「再试一次」发生在屏**里面**（它自己调 `connect`），不是重挂一遍
  // —— 重挂会清屏，而一次失败的尝试只该多一行原因，不该让整块界面闪一下
  const outcome = await deps.showConnectScreen({
    reason,
    initial,
    connect: async (settings) => {
      const result = await probe(sourceOf(settings));
      return result.ok ? null : result.message;
    },
  });
  if (outcome.kind === "exit") return { ok: false };

  // 屏上已经验过一次（`connect` 返回 null 才可能走到 `connected`），所以这里只负责落盘
  await save(deps.env, outcome.settings);
  return { ok: true, settings: outcome.settings, source: sourceOf(outcome.settings) };
}
