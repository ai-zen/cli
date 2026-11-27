/**
 * 运行模式判定与启动参数解析：纯函数与纯数据，是双模式路由的唯一决策点。
 *
 * 两种互不混合的运行模式，同一进程只走其中一条：带位置参数，或 stdin/stdout 非 TTY 时走纯 stdio
 * （面向脚本与管道）；无参数且 stdin/stdout 均为 TTY，或带 `--tui` 时走 TUI（面向人）。
 *
 * `--new` 是 TUI 路径上的修饰项，不改变模式判定，只表示跳过续接、开一条新会话；出现在 stdio 路径上
 * 时被忽略（stdio 本就是一次性会话）。`--server <url>` 同样是修饰项，它答的是连哪台服务端：三条会连
 * 服务端的路径（stdio / TUI / `--server-status`）都把它带在结果上，由根（`app.ts` 的 `CliApp`）交给
 * `env.ts` 与环境变量一起定优先级。接什么后端（发现文件 `<数据根>/run/host.json`、凭证文件
 * `run/token`）由 `@ai-zen/agents-client` 决定。本模块只负责把它从 argv 里认出来，不校验地址、也不读
 * 环境变量 —— 那两件事都归 `env.ts`（`serverUrlError` / `resolveCliEnv`）。
 *
 * shell 钩子不属于纯 stdio：钩子的发起场景是人坐在交互终端前敲错了命令，因此它走
 * `ai --tui --new "$@"` 进 TUI 并把原命令作为首条消息发送；写成 `ai "$@"` 会让钩子会话落到管道模式。
 *
 * 本模块不触碰 stdin/stdout、不 import React / Ink：模式判定与路由是启动链上最不能出错的一环，必须
 * 被用例覆盖。
 */

export type RunMode = "stdio" | "tui";

export interface TtyState {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

/**
 * 一次启动要执行的动作（路由结果）。
 *
 * 子命令（hook/help/version/server-status）与运行模式正交：命中子命令时短路模式判定，
 * 不进入 stdio/TUI 任一路径。
 */
export type Invocation =
  /**
   * `invalidAction`：给了子动作但不认识（如 `ai hook boom`）。与「只想看用法」
   * （`ai hook` / `ai hook --help`，此时无该字段）区分开 —— 前者该报错退出，
   * 后者是正常的信息请求，退出码必须是 0。
   */
  | { kind: "hook"; action: "install" | "uninstall" | "usage"; invalidAction?: string }
  | { kind: "help" }
  | { kind: "version" }
  /** `--server-status`：打印常驻服务进程的状态（诊断用，**不**拉起、不进界面） */
  | { kind: "server-status"; serverUrl?: string }
  | { kind: "stdio"; instruction: string; save: boolean; serverUrl?: string }
  /**
   * `initialPrompt`：进 TUI 后自动作为首条消息发送的内容（shell 钩子用）
   * `newSession`：`--new` 要求开新会话，跳过「续接该目录上一次的会话」
   * `serverUrl`：`--server <url>`（显式地址）；没给就没有这个字段，地址交给环境变量 / 发现文件
   */
  | { kind: "tui"; initialPrompt?: string; newSession?: boolean; serverUrl?: string }
  /** `--tui` 明确要求交互界面，但终端不支持：报错退出，**绝不**降级成 stdio */
  | { kind: "tui-rejected" };

const HOOK_ACTIONS = new Set(["install", "uninstall"]);

/**
 * 模式判定（纯函数）。
 *
 * `--tui` 不经过本函数：它是显式覆盖，在 `resolveInvocation()` 里优先处理。
 */
export function decideMode(tty: TtyState, hasArgs: boolean): RunMode {
  if (hasArgs) return "stdio";
  if (!tty.stdinIsTTY || !tty.stdoutIsTTY) return "stdio";
  return "tui";
}

/**
 * 解析 argv 并路由为 `Invocation`。
 *
 * 选项在遇到 `--` 之后一律视为位置参数（便于传入以 `-` 开头的提示词）。
 * 未知的 `-x` 选项不报错，按位置参数处理，避免误伤以 `-` 开头的正常提问。
 *
 * `--server <url>` 只被认出来：合法性不在这里判（那是 `env.ts` 的 `serverUrlError`
 * 在启动早期做的事），否则同一条命令会在两处报两种错。
 */
export function resolveInvocation(argv: string[], tty: TtyState): Invocation {
  const positional: string[] = [];
  let save = false;
  let wantHelp = false;
  let wantVersion = false;
  let wantServerStatus = false;
  let wantTui = false;
  let wantNew = false;
  /**
   * `--server` 的值。`undefined` = 没给过；空串 = 给了但没下一个参数（拼错的调用）。
   *
   * 两种情形必须分开：前者是「走默认（环境变量 → 发现文件）」，后者是「参数少了一个值」
   * —— 静默当成「没给」的话，`ai --server` 会连回本机，而用户以为他指定了远端。
   */
  let serverUrl: string | undefined;
  let passthrough = false;

  // 下标循环：`--server` 要吃掉下一个参数当值（`for…of` 拿不到它）
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (passthrough) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--save") {
      save = true;
      continue;
    }
    if (arg === "--server") {
      // 值就是紧跟的那一个，以 `-` 开头也照收：值是不是合法地址由 `env.ts` 的早期校验判，
      // 不在这里拦
      serverUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--tui") {
      wantTui = true;
      continue;
    }
    if (arg === "--new") {
      wantNew = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      wantHelp = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      wantVersion = true;
      continue;
    }
    if (arg === "--server-status") {
      wantServerStatus = true;
      continue;
    }
    positional.push(arg);
  }

  // 子命令短路（与运行模式无关的管理动作）
  if (positional[0] === "hook") {
    const action = positional[1];
    if (action && HOOK_ACTIONS.has(action))
      return { kind: "hook", action: action as "install" | "uninstall" };
    // 没给子动作（含 `ai hook --help`，`--help` 已被当选项吃掉）：只是要看用法
    if (action === undefined) return { kind: "hook", action: "usage" };
    return { kind: "hook", action: "usage", invalidAction: action };
  }
  // 诊断动作：只读发现文件（或直接问显式地址），不拉起服务端 —— 所以优先级高于
  // help/version（要的就是当前状态）
  if (wantServerStatus) return { kind: "server-status", serverUrl };
  if (wantHelp) return { kind: "help" };
  if (wantVersion) return { kind: "version" };
  // `ai help` / `ai version`：单词形式与 `--help` / `--version` 等价。
  // 只在它是唯一参数时判定 —— `ai help me refactor this` 仍然是在提问。
  if (positional.length === 1 && positional[0] === "help") return { kind: "help" };
  if (positional.length === 1 && positional[0] === "version") return { kind: "version" };

  const instruction = positional.join(" ").trim();

  // 显式要求 TUI（shell 钩子走这条）：参数不再是「脚本提问」，而是待发送的首条消息。
  // 非 TTY 时宁可报错，也不默默降级成 stdio，否则界面内容会写进管道
  if (wantTui) {
    if (!tty.stdinIsTTY || !tty.stdoutIsTTY) return { kind: "tui-rejected" };
    return {
      kind: "tui",
      initialPrompt: instruction || undefined,
      newSession: wantNew || undefined,
      serverUrl,
    };
  }

  const mode = decideMode(tty, positional.length > 0);
  // `--new` 只在 TUI 路径有意义；走到 stdio（脚本 / 管道）时静默忽略
  if (mode === "tui") return { kind: "tui", newSession: wantNew || undefined, serverUrl };
  return { kind: "stdio", instruction, save, serverUrl };
}
