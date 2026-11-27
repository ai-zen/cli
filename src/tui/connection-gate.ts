/**
 * 启动时的**连接门** —— 「先看上次那台还能不能用，不行就摆一块屏让用户选」。
 *
 * ## 它管的五步
 *
 * ```
 *   有配过？─否─→ 连接屏（首启形态，不探活）
 *      │是
 *      ↓
 *   试一次：远程只连 / 本机走下载屏（拉起宿主，可能要下载）
 *      ├─通─→ 直接用这份，**不写盘**（见下）
 *      └─不通→ 连接屏（失败形态，带原因、预填上次那份）
 *                ├─远程：屏上试通 ─→ **写盘** → 继续启动
 *                ├─本机：屏上选完 → 下载屏 →（通）写盘 → 继续启动
 *                │                              └（Esc / 失败）→ 带着原因回连接屏
 *                └─用户退出───────→ 结束（宿主 farewell）
 * ```
 *
 * ## 本机那条路为什么单有一块屏
 *
 * 本机可能要现下现起一个宿主（PRD L14），那是几十秒的事，而屏幕上是**一个阶段一个阶段**的
 * 进度（D31）。把这段塞进连接屏的 spinner 底下，等于让用户盯着一句「正在连接…」等它下完 ——
 * 所以本机那条路交给 `host-download.tsx`：阶段、真原因、`R` 重试、`Esc` / `Ctrl+C` 折回连接屏
 * 都在那块屏上。远程没有这个过程（只连，不拉起宿主），仍在连接屏里当场验。
 *
 * ## 为什么「探通了不写盘，屏上选完才写盘」
 *
 * 写盘等于「记住这次的选择」。而启动时试的那一份**本来就是上次记住的**（或者命令行临时给的），
 * 再写一次是空转；命令行的更糟 —— `ai --server ws://同事的机器 ` 用过一次就把默认改掉，用户
 * 下次在别的目录敲 `ai` 会莫名其妙连到别人机器上。所以：**只有「用户在屏上做的选择」值得记住**。
 *
 * 反过来说，屏上的「提交」是**先验证再落盘**：连不上就不写，一个已知是错的配置不会留在盘上，
 * 否则下次启动会碰到同一个失败。（桌面端的设置页相反 —— 那边用户明确改了配置，尊重他的意图；
 * 两处语义不同，各自写清，不合成一条。）
 *
 * ## 首启为什么不探活
 *
 * 没配过的时候，「探一次」这件事本身没有意义（探谁？），而**后果很坏**：没有显式地址的探测会
 * 让连接层读发现文件、读不到就**拉起一个本地宿主**。首启于是变成「悄悄装一个宿主」，用户
 * 根本没做过这个决定。所以首启直接进屏，一次 I/O 都不做。
 *
 * ## 屏是注入的
 *
 * 两块屏都拿参数传进来（生产 = `mount(<…/>)`，用例 = 按剧本回答的假屏）。重试循环、写盘时机、
 * 退出这几十行因此能在没有 Ink 的地方验 —— 而这类事（哪一步写盘、连上之后还会不会再弹屏）
 * 靠读代码才能确认。
 *
 * ## 它交出去的是什么
 *
 * 只有**那一份设置**（`ConnectionSettings`）：往下的三样事实（数据根、地址、凭证）怎么拼成一条
 * 连接，是 `connection.ts` 的 `connectHost` 的事（它已经要吃 `{ env, settings }`）。这里再算一份
 * 「递去探活的三个值」就是第二份拼法，两处一旦分叉，症状是「探活说能连、真连却连不上」。
 */

import { probeConnection, saveConnectPlan } from "../connection.js";
import type { ConnectHostOptions, ProbeResult } from "../connection.js";
import type { ConnectionSettings } from "../server-client/index.js";
import type { CliEnv } from "../env.js";
import type { ConnectScreenResult } from "./screens/connect.js";
import type { HostDownloadScreenResult, HostLaunchHooks } from "./screens/host-download.js";

// 屏的结局形状由屏自己定义（它是生产者），这里只转出一个名字给宿主用 ——
// 不让两边各写一份同样的 union（那就是两份判据，改一处忘一处的开始）
export type { ConnectScreenResult, HostDownloadScreenResult };

/** 弹连接屏：把当前上下文递进去，等用户决定 */
export type ShowConnectScreen = (input: {
  /** 本次尝试的失败原因（首启形态没有） */
  reason?: string;
  /** 预填（上次那份配置）；首启是 `null` */
  initial: ConnectionSettings | null;
  /** 屏上「提交」时调：`null` = 连上了（只对远程） */
  connect: (settings: ConnectionSettings) => Promise<string | null>;
}) => Promise<ConnectScreenResult>;

/** 弹下载屏：把「拉一次」递进去，等它给出结局 */
export type ShowHostDownloadScreen = (input: {
  /** 拉一次（本机）：`hooks.onStage` 收阶段、`hooks.signal` 用来取消 */
  connect: (hooks: HostLaunchHooks) => Promise<string | null>;
}) => Promise<HostDownloadScreenResult>;

export interface ConnectionGateDeps {
  /** 记住的那一份（`readConnectPlan` 的结果；`null` = 没配过） */
  initial: ConnectionSettings | null;
  env: CliEnv;
  showConnectScreen: ShowConnectScreen;
  /** 本机拉起宿主的那块屏（阶段 / 失败 / R 重试 / Esc 折回） */
  showHostDownloadScreen: ShowHostDownloadScreen;
  /** 探活（缺省真去连；用例换成按剧本回答的假件） */
  probe?: (options: ConnectHostOptions) => Promise<ProbeResult>;
  /** 写盘（缺省写 `<aiZenDir>/cli/connection.json`） */
  save?: (env: CliEnv, settings: ConnectionSettings) => Promise<void>;
  /**
   * 开场就摆连接屏（**不探活**），并把这句原因写在屏上。
   *
   * 目前只有 `/shutdown` 用：用户刚把宿主关掉，而「先试一次」在本机那条路上就是
   * **再拉起一个宿主** —— 那正好把用户刚才那一下抵消掉。所以这一档不试也不拉起，
   * 直接把「连哪台」交还给用户（他可以选本机重新起一台，也可以改连别处）。
   */
  openWith?: { reason: string };
}

export type ConnectionGateResult =
  /** 连哪台、拿什么进门 —— 连接层按它建那条连接 */
  | { ok: true; settings: ConnectionSettings }
  /** 用户在连接屏上放弃了 → 宿主该收摊退出 */
  | { ok: false };

/** 一次尝试的结局（门内用） */
type Attempted = { ok: true } | { ok: false; reason: string };

export async function settleConnection(deps: ConnectionGateDeps): Promise<ConnectionGateResult> {
  const probe = deps.probe ?? probeConnection;
  const save = deps.save ?? saveConnectPlan;

  /**
   * 试一份设置：远程只连（不出屏），本机走下载屏（拉起可能要下载）。
   *
   * 本机这条路**每次都**经过那块屏：宿主本来就在跑的时候它一个字节都不画（见屏的「没事可看的
   * 时候它一个字节都不画」），所以「有就上」那条快路不会被一块一闪即过的屏拖累。
   */
  const attempt = async (settings: ConnectionSettings): Promise<Attempted> => {
    if (settings.mode !== "local") {
      const result = await probe({ env: deps.env, settings });
      return result.ok ? { ok: true } : { ok: false, reason: result.message };
    }
    const outcome = await deps.showHostDownloadScreen({
      connect: (hooks) => probe({ env: deps.env, settings, ...hooks }).then(toReason),
    });
    return outcome.kind === "connected" ? { ok: true } : { ok: false, reason: outcome.reason };
  };

  // ① 配过就先试一次。首启（`initial: null`）**不试** —— 见文件头「首启为什么不探活」
  // 开场就摆屏（`openWith`）也不试：那时用户刚把宿主关掉，试就等于又拉起一个
  let reason: string | undefined = deps.openWith?.reason;
  if (deps.initial && deps.openWith === undefined) {
    const attempted = await attempt(deps.initial);
    if (attempted.ok) return { ok: true, settings: deps.initial };
    reason = attempted.reason;
  }

  /**
   * ② 连接屏。**只弹一次**：远程的「再试一次」发生在屏**里面**（它自己调 `connect`）；本机的
   * 重试在下载屏上。两块屏都不重建自己，所以一次失败的尝试只多一行原因，整块界面不闪。
   *
   * 本机那条路会回到这里（下载屏上按 `Esc` / 拉不起来），于是这里是一个循环：带着原因重摆
   * 连接屏，用户改走远程即可。
   */
  let prefill = deps.initial;
  while (true) {
    const outcome = await deps.showConnectScreen({
      ...(reason === undefined ? {} : { reason }),
      initial: prefill,
      connect: async (settings) => toReason(await probe({ env: deps.env, settings })),
    });
    if (outcome.kind === "exit") return { ok: false };

    if (outcome.kind === "connected") {
      // 远程在屏里已经验过（`connect` 返回 null 才可能走到 connected）
      await save(deps.env, outcome.settings);
      return { ok: true, settings: outcome.settings };
    }

    // 本机：交给下载屏去拉、去显示
    const attempted = await attempt(outcome.settings);
    if (attempted.ok) {
      await save(deps.env, outcome.settings);
      return { ok: true, settings: outcome.settings };
    }
    reason = attempted.reason;
    // 下次预填用刚选的那份：用户改回远程时，地址与凭证还在表单里
    prefill = outcome.settings;
  }
}

/** 探活结果 → 屏上那句原因（`null` = 通了） */
function toReason(result: ProbeResult): string | null {
  return result.ok ? null : result.message;
}
