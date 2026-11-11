/**
 * `CliApp` —— CLI 进程的**根**。
 *
 * ## 它是什么
 *
 * 一个进程里「这次调用要做什么、拿什么事实去做、最后退出码是几」的**唯一持有者**：路由结果
 * （`Invocation`）、本进程的事实（`CliEnv`）、终端能力（`TtyState`），以及出口（stdout /
 * stderr / 退出码）。
 *
 * `index.ts` 因此只剩两件事：在求值 React 之前把 `NODE_ENV` 钉成 production、把 EPIPE 当成
 * 正常结束；然后 `process.exitCode = await new CliApp().run()`。
 *
 * ## 为什么这一层以前是「没有名字的」
 *
 * 改动前这些全在 `index.ts` 的 `main()` 里，而「本进程事实」散在三个文件：
 * `config.ts` 的 `export let AI_ZEN_DIR`（模块求值时算一次）、`config.ts` 的
 * `serverUrlFlag`（一个 `setServerUrlFlag()` 往模块里塞值的注入点）、
 * `i18n/preferences.ts` 里**又抄了一遍**的 `HOME` 拼法（每次调用重算）。于是「根在哪」有两个
 * 答案、两种时机，「`--server` 什么时候落地」要靠读 `main()` 那 90 行才知道。
 *
 * 这就是「松散全局变量 + 松散模块」那一类：每个值单独看都有理由，合起来没人能回答
 * 「谁是主人」。现在主人是这个类。
 *
 * ## 三条纪律（判据，不是口号）
 *
 * 1. **只有本文件读 `process.argv` / `process.env` / `process.stdin.isTTY` / 写
 *    `process.stdout` / 定 `process.exitCode`。** 别的模块要这些事实就读 `cliEnv()`（由本类
 *    钉进去的那一份），或者由本类当参数递进去。判据：`grep -c "process.argv"
 *    src/**\/*.ts` 应当只有本文件与 `index.ts` 的 prelude。
 * 2. **不写业务。** 这里能出现的只有「接线」（把事实递给某条路径）与「退出码映射」。
 *    一次性调用怎么跑在 `stdio.ts`，界面怎么渲染在 `tui/`，钩子怎么装写在 `hook.ts`。
 *    要在这里写 `if` 判断业务，先问：这条判定换一个入口（将来的 `ai --json`）还成立吗？
 * 3. **依赖单向。** `stdio.ts` / `tui/` / `hook.ts` 都不认识 `CliApp`，它们只收参数。
 *    本类 import 它们，它们不知道本类存在。
 *
 * ## 边界：它**不**吞掉 i18n 与 sdk-log
 *
 * `t()` 与 `setLogger()` 是进程级单例（同 `console` 那一类），全仓 30 多个文件在用；把它们
 * 收进本类等于把整个 TUI 改成「一切都要从 Props 里取 `t`」，成本极高、换不到任何保证
 * —— 语言和日志出口**没有第二个真相**，它们的问题从来不是「谁是主人」。
 *
 * 本类对它们的职责只有**时机**：需要人话的路径（`help` / `hook` / `tui`）在说话之前先
 * `initLocale()`；`sdk-log` 的落盘根由 `cliEnv()` 给出（见 `sdk-log.ts`）。
 *
 * ## 退出码只有一个出口
 *
 * 改动前 `process.exitCode` 被写在 5 处，`process.exit(0)` 还被 EPIPE 处理器用了一次。
 * 现在 {@link CliApp.run} 返回数字，映射关系完整地摆在一个 `switch` 里：
 *
 * | 路由 | 退出码 |
 * |---|---|
 * | `help` / `version` / `hook`（含「只看用法」） | 0 |
 * | `hook` 的未知子动作 | 1 |
 * | `server-status` | 在跑 0 / 不在跑 1（脚本据此判断） |
 * | `stdio` | 它自己的返回值（没有输入 2、模型报错 1、成功 0） |
 * | `tui` | 0（`farewell()` 直接 `process.exit(0)`） |
 * | `tui-rejected`（`--tui` 但非 TTY） | 2 |
 * | 服务端地址拼错 | 2（命令本身用错了） |
 *
 * 「1 留给已经跑起来之后失败，2 留给命令本身用错了」这条分界是**脚本**在用的，别改。
 *
 * ## 为什么值得存在（收益不是美观）
 *
 * 改动前 `main()` 直接读 `process.argv`、直接写 `process.stdout`、直接设 `process.exitCode`
 * —— 于是五条分支**一条都验不了**，只能靠 `src/__tests__/e2e.test.ts` 起真进程
 * （`AGENTS.md` 里那句「组装根改了……只有真跑才看得见」就是这条的代价）。
 *
 * 现在 argv / env / tty / 三个出口 / 四条重路径全是注入项，`app.test.ts` 用假件就能把路由、
 * 地址校验、退出码、以及「哪条路径拿到了哪份事实」逐条咬死。真进程 e2e 仍然保留 —— 它验的是
 * 另一个东西（`dist/index.js` 装出来的产物能不能跑），不是路由逻辑。
 */

import { applyCliEnv, resolveCliEnv, serverUrlError, type CliEnv } from "./env.js";
import { installHook, uninstallHook } from "./hook.js";
import { t } from "./i18n/index.js";
import { initLocale } from "./i18n/preferences.js";
import { resolveInvocation, type Invocation, type TtyState } from "./mode.js";
import { CLIENT_INFO } from "./server-client/index.js";
import {
  readServerStatus,
  type ServerStatus,
  type ServerStatusDeps,
} from "./server-client/index.js";
import { runStdio, type StdioRunOptions } from "./stdio.js";
// 类型**只**为「注入点的形状」而取：`RunTuiOptions` 的定义仍在 `tui/index.tsx` 一处，
// 不在这里抄第二份。`import type` 在编译期擦除，所以它不会把 Ink 拖进 `dist/index.js`
// 的运行期依赖图（真正的求值是 `run()` 里那句动态 import）。
import type { RunTuiOptions } from "./tui/index.js";
import { CLI_VERSION } from "./version.js";

/**
 * 注入点（生产全用缺省值；用例喂假件）。
 *
 * 分出这几组是为了让「路由」与「重路径」分开验：`argv` / `env` / `tty` / 出口决定**去哪**，
 * 下面四条 `run*` / `hook*` 决定**去了之后干什么**。
 */
export interface CliAppDeps {
  /** 启动参数（不含 `node` 与脚本路径）；缺省 `process.argv.slice(2)` */
  argv?: string[];
  /** 进程环境；缺省 `process.env`。`AI_ZEN_DIR` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN` 从这里读 */
  env?: NodeJS.ProcessEnv;
  /** 终端能力；缺省按 `process.stdin.isTTY` / `process.stdout.isTTY` 算 */
  tty?: TtyState;
  /** stdout；缺省 `process.stdout.write` */
  writeOut?: (text: string) => void;
  /** stderr；缺省 `process.stderr.write` */
  writeErr?: (text: string) => void;
  /** 管道模式；缺省真的跑一轮（`stdio.ts`） */
  runStdio?: (options: StdioRunOptions) => Promise<number>;
  /** 交互界面；缺省 `await import("./tui/index.js")` 再跑（**必须**是动态的，见 `index.ts`） */
  runTui?: (options: RunTuiOptions) => Promise<void>;
  /** 诊断查询；缺省真去问服务端（不拉起） */
  readStatus?: (deps: ServerStatusDeps) => Promise<ServerStatus>;
  /** shell 钩子安装；缺省 `hook.ts` 的那一个 */
  installHook?: () => Promise<void>;
  /** shell 钩子卸载；缺省 `hook.ts` 的那一个 */
  uninstallHook?: () => Promise<void>;
  /** 界面语言初始化；缺省读偏好 / 识别系统语言（`i18n/preferences.ts`） */
  initLocale?: () => Promise<unknown>;
  /** 版本号；缺省本包版本 */
  version?: string;
}

export class CliApp {
  /** 这次调用要做什么（`mode.ts` 的纯函数算出来的） */
  readonly invocation: Invocation;
  /** 本进程的事实（唯一解析点，见 `env.ts`） */
  readonly env: CliEnv;
  /** 终端能力快照 */
  readonly tty: TtyState;

  private readonly writeOut: (text: string) => void;
  private readonly writeErr: (text: string) => void;
  private readonly runStdioImpl: (options: StdioRunOptions) => Promise<number>;
  private readonly runTuiImpl: (options: RunTuiOptions) => Promise<void>;
  private readonly readStatusImpl: (deps: ServerStatusDeps) => Promise<ServerStatus>;
  private readonly installHookImpl: () => Promise<void>;
  private readonly uninstallHookImpl: () => Promise<void>;
  private readonly initLocaleImpl: () => Promise<unknown>;
  private readonly version: string;
  /** 显式地址的早期校验结果（`null` = 没问题或压根没给） */
  private readonly badServerUrl: string | null;

  constructor(deps: CliAppDeps = {}) {
    const env = deps.env ?? process.env;
    this.tty = deps.tty ?? {
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
    };
    this.invocation = resolveInvocation(deps.argv ?? process.argv.slice(2), this.tty);
    this.env = resolveCliEnv({ env, serverUrlFlag: serverUrlFlagOf(this.invocation) });
    /**
     * 钉下去 —— 本进程的事实从这一刻起就是这一份。
     *
     * 放在构造函数里而不是 `run()`：`run()` 之前的任何代码（将来某个模块的顶层）都可能读
     * `cliEnv()`，而「根什么时候成立」有一个答案比有两个好。
     */
    applyCliEnv(this.env);

    this.writeOut = deps.writeOut ?? ((text) => void process.stdout.write(text));
    this.writeErr = deps.writeErr ?? ((text) => void process.stderr.write(text));
    this.runStdioImpl = deps.runStdio ?? runStdio;
    this.runTuiImpl =
      deps.runTui ??
      (async (options) => {
        // 动态 import：React/Ink 必须在 `index.ts` 的 `NODE_ENV ||= "production"` 之后求值，
        // 否则加载的是 DEV 版 reconciler，`performance.measure()` 的缓冲无界增长会把堆顶爆
        const { runTui } = await import("./tui/index.js");
        await runTui(options);
      });
    this.readStatusImpl = deps.readStatus ?? readServerStatus;
    this.installHookImpl = deps.installHook ?? installHook;
    this.uninstallHookImpl = deps.uninstallHook ?? uninstallHook;
    this.initLocaleImpl = deps.initLocale ?? initLocale;
    this.version = deps.version ?? CLI_VERSION;

    // 只对三条**会连服务端**的路径校验：`--help` / `--version` / `hook` 不连服务端，不该被一个
    // 与本命令无关的 `AI_ZEN_SERVER_URL` 拖住（写错时帮助仍须能出来）
    this.badServerUrl = needsServer(this.invocation) ? serverUrlError(this.env) : null;
  }

  /**
   * 跑这一次调用，返回退出码（**不**自己设 `process.exitCode`，也不 `process.exit` ——
   * 调用方是一次性的入口，退出码只有一个出口）。
   */
  async run(): Promise<number> {
    // 地址拼错时唯一能说清楚的地方就是这里；退出码 2 = 命令本身用错了
    if (this.badServerUrl) {
      this.writeErr(`ai: ${this.badServerUrl}\n`);
      return 2;
    }

    const invocation = this.invocation;
    switch (invocation.kind) {
      case "help":
        // 帮助是用户可见的终端文案，跟随界面语言（偏好 / 系统语言）；stdio 刻意不做 i18n
        await this.initLocaleImpl();
        this.writeOut(helpText(this.version));
        return 0;

      case "version":
        this.writeOut(`${this.version}\n`);
        return 0;

      case "server-status": {
        // 只读发现文件（或直接问显式地址）+ 一次 status 调用，**不**拉起服务端：这个命令是用来
        // 诊断的，顺手拉一个起来会让答案失去意义。输出 JSON 供脚本消费（无需 i18n）。
        //
        // 显式地址必须递进去：远程场景下本机根本没有那份发现文件，不递就永远回
        // `no descriptor` —— 一句既不是「没在跑」也不是「连不上」的话。
        const status = await this.readStatusImpl({
          aiZenDir: this.env.aiZenDir,
          clientInfo: CLIENT_INFO,
          serverUrl: this.env.serverUrl,
          serverToken: this.env.serverToken,
        });
        this.writeOut(`${JSON.stringify(status, null, 2)}\n`);
        return status.running ? 0 : 1;
      }

      case "hook":
        // hook 的输出是给人看的终端文案，与 help 同理：先初始化语言，再打印
        await this.initLocaleImpl();
        if (invocation.action === "install") {
          await this.installHookImpl();
          return 0;
        }
        if (invocation.action === "uninstall") {
          await this.uninstallHookImpl();
          return 0;
        }
        if (invocation.invalidAction) {
          // 认不出的子动作：报错 + 非零退出码（脚本可据此判断），同时给出正确用法
          this.writeErr(`${t("cli.hookUnknownAction", { action: invocation.invalidAction })}\n`);
          this.writeErr(`${t("cli.hookUsage")}\n`);
          return 1;
        }
        // 只想看用法（`ai hook` / `ai hook --help`）：正常输出、退出码 0
        this.writeOut(`${t("cli.hookUsage")}\n`);
        return 0;

      case "stdio":
        return this.runStdioImpl({
          instruction: invocation.instruction,
          save: invocation.save,
          env: this.env,
        });

      case "tui":
        // `initialPrompt`（来自 shell 钩子 `ai --tui --new "$@"`）会作为首条消息自动发送；
        // `newSession`（`--new`）要求跳过续接、开一条新会话
        await this.runTuiImpl({
          initialPrompt: invocation.initialPrompt,
          newSession: invocation.newSession,
          env: this.env,
        });
        return 0;

      case "tui-rejected":
        // `--tui` 明确要求交互界面，但 stdin/stdout 不是 TTY（如被写进脚本或管道）：
        // 不悄悄降级成管道模式（那会把整屏界面内容写进管道），直接报错
        this.writeErr(
          "ai: --tui requires an interactive terminal (stdin and stdout must be TTYs)\n",
        );
        return 2;
    }
  }
}

/** 这三条会连服务端（`tui-rejected` 不在内：它连界面都进不去，先报那件事更重要） */
function needsServer(invocation: Invocation): boolean {
  return (
    invocation.kind === "stdio" || invocation.kind === "tui" || invocation.kind === "server-status"
  );
}

/**
 * `--server <url>` 的落地：**只**从这三条会连服务端的路由上取。
 *
 * 其它路由没有这个字段，`undefined` 于是正确地表示「这次没给 `--server`」—— 地址退回
 * `AI_ZEN_SERVER_URL`，与改动前 `setServerUrlFlag()` 的调用条件逐字一致。
 */
function serverUrlFlagOf(invocation: Invocation): string | undefined {
  return needsServer(invocation) && "serverUrl" in invocation ? invocation.serverUrl : undefined;
}

/**
 * 帮助文本按当前语言现拼（**不能**写成模块级常量：那会把「模块求值那一刻的语言」定死）。
 */
function helpText(version: string): string {
  return (
    [
      t("cli.help.title", { version }),
      t("cli.help.usage"),
      t("cli.help.options"),
      t("cli.help.notes"),
    ].join("\n") + "\n"
  );
}
