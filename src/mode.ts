/**
 * 运行模式判定与启动参数解析 —— 双模式改造的决策核心
 *
 * 最终形态为两种**互不混合**的运行模式（见 TODO §0）：
 *
 * | 模式        | 触发条件                                   | 面向对象               |
 * |-------------|--------------------------------------------|------------------------|
 * | 纯 stdio    | 带位置参数，或 stdin/stdout 非 TTY          | 脚本、管道、shell 钩子 |
 * | TUI         | 无参数且 stdin/stdout 均为 TTY              | 人类用户               |
 *
 * 本模块为纯函数与纯数据，不触碰 stdin/stdout、不 import chalk 等 UI 依赖，
 * 便于单测（模式判定与路由是改造中风险最高的逻辑，必须被测覆盖）。
 */

/** 运行模式 */
export type RunMode = "stdio" | "tui";

/** 终端能力快照（由入口注入，便于测试） */
export interface TtyState {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

/**
 * 一次启动要执行的动作（路由结果）。
 *
 * 子命令（hook/help/version）与运行模式正交：命中子命令时短路模式判定，
 * 不进入 stdio/TUI 任一路径。
 */
export type Invocation =
  | { kind: "hook"; action: "install" | "uninstall" | "usage" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "stdio"; instruction: string; save: boolean }
  | { kind: "tui" };

/** shell 兜底钩子的子动作 */
const HOOK_ACTIONS = new Set(["install", "uninstall"]);

/**
 * 模式判定（纯函数）。
 *
 * - 有位置参数 → stdio（脚本/管道优先，绝不进 TUI）
 * - 无参数但 stdin 或 stdout 非 TTY → stdio（管道、重定向、CI）
 * - 无参数且 stdin/stdout 均为 TTY → TUI
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
 */
export function resolveInvocation(argv: string[], tty: TtyState): Invocation {
  const positional: string[] = [];
  let save = false;
  let wantHelp = false;
  let wantVersion = false;
  let passthrough = false;

  for (const arg of argv) {
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
    if (arg === "--help" || arg === "-h") {
      wantHelp = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      wantVersion = true;
      continue;
    }
    positional.push(arg);
  }

  // 子命令短路（与运行模式无关的管理动作）
  if (positional[0] === "hook") {
    const action = positional[1];
    return {
      kind: "hook",
      action: action && HOOK_ACTIONS.has(action) ? (action as "install" | "uninstall") : "usage",
    };
  }
  if (wantHelp) return { kind: "help" };
  if (wantVersion) return { kind: "version" };

  const instruction = positional.join(" ").trim();
  const mode = decideMode(tty, positional.length > 0);
  if (mode === "tui") return { kind: "tui" };
  return { kind: "stdio", instruction, save };
}
