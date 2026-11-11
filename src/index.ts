#!/usr/bin/env node

import { installHook, uninstallHook } from "./hook.js";
import { resolveInvocation } from "./mode.js";
import { CLIENT_INFO } from "./server-client/index.js";
import { readServerStatus } from "./server-client/index.js";
import {
  AI_ZEN_DIR,
  explicitServerToken,
  explicitServerUrl,
  serverUrlError,
  setServerUrlFlag,
} from "./config.js";
import { runStdio } from "./stdio.js";
import { CLI_VERSION } from "./version.js";
import { initLocale } from "./i18n/preferences.js";
import { t } from "./i18n/index.js";

// ⚠️ 必须在加载 React/Ink 之前把 NODE_ENV 定为 production。
//
// 背景（OOM 根因）：Node 官方分发版没有内置“production” React，react/react-reconciler
// 的入口用 `process.env.NODE_ENV !== "production"` 决定引用哪个构建。若此变量为空，
// 就会加载 *development* 版 reconciler —— 它每次渲染都会调用 `performance.measure()`
// （User Timing API），而 Node 的 performance 条目缓冲**无界且从不逐出**。长时间流式
// TUI 会话下条目数持续增长，约 55 分钟即把堆顶到 heap_size_limit（本机 ~1GB）触发 OOM。
//
// ESM 的静态 `import` 会被提升到模块体之前执行，若此处仍静态 `import "./tui/index.js"`，
// 则 React 会在本行之前就被求值成 DEV 版。因此对 TUI 入口改用动态 import（见下方 tui 分支）。
// 用 `||=` 而非 `??=`：空的 NODE_ENV 同样会被 React 视为非 production，需一并纠正。
process.env.NODE_ENV ||= "production";

/**
 * stdout 被提前关闭（`ai --help | head -1`、`ai "…" | head`）时的 EPIPE。
 *
 * 默认行为是未捕获的 `'error'` 事件：Node 把堆栈打到 stderr、退出码 1 —— 管道下游
 * 主动不读了不是错误，按正常结束处理（退出码 0）。不在这里 flush 任何东西：
 * 写不进去就是没人要。
 */
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

/**
 * CLI 入口 —— 双模式路由
 *
 *   ai                      → TUI（仅当无参数且 stdin/stdout 均为 TTY）
 *   ai <提示词>              → 纯 stdio：结果写 stdout，日志写 stderr
 *   cat 文件 | ai "总结"      → 纯 stdio：stdin 为内容
 *   ai hook install         → 安装 shell 兜底钩子
 *   ai hook uninstall       → 卸载 shell 兜底钩子
 *   ai --help / --version   → 帮助 / 版本
 *   ai --server-status      → 常驻服务进程状态（JSON，未运行退出码 1）
 *   ai --server wss://… …   → 连到显式指定的服务端（地址也可放在 `AI_ZEN_SERVER_URL`）
 *
 * 模式判定与参数解析集中在 ./mode.ts（纯函数，单测覆盖），本文件只做分发。
 */

/**
 * 帮助文本按当前语言现拼（**不能**写成模块级常量：那会把“模块求值那一刻的语言”定死）。
 * stdio 模式刻意不做 i18n，但 `--help` 属终端交互文案，要跟随界面语言。
 */
function helpText(): string {
  return (
    [
      t("cli.help.title", { version: CLI_VERSION }),
      t("cli.help.usage"),
      t("cli.help.options"),
      t("cli.help.notes"),
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  const tty = {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
  const invocation = resolveInvocation(process.argv.slice(2), tty);

  /**
   * 显式服务端地址（`--server` > `AI_ZEN_SERVER_URL`）与凭证（`AI_ZEN_SERVER_TOKEN`）的**落地
   * 点**，而且就在分发之前。
   *
   * 为什么两件事都要在这里：
   *   1. **落地** —— argv 晚于模块求值，`config.ts` 无法自己读它；后面三条会连服务端的路径
   *      （stdio / TUI / `--server-status`）全都从 `config.ts` 取地址，不再各自看 argv。
   *   2. **校验** —— 地址拼错时唯一能把它说清楚的地方就是这里（D12）。让它飘进
   *      `ensureServer` / `readServerStatus`，用户看到的会是「连不上某个 host」或一条栈，
   *      而真正的原因是他把 `wss://example.com/ai-zen` 敲成了 `wss:/example.com`。
   *
   * 只对三条**会连服务端**的路径生效：`--help` / `--version` / `hook` 不连服务端，不该被一个
   * 与本命令无关的配置拖住（`AI_ZEN_SERVER_URL` 写错时，帮助仍须能出来）。
   */
  if (
    invocation.kind === "stdio" ||
    invocation.kind === "tui" ||
    invocation.kind === "server-status"
  ) {
    setServerUrlFlag(invocation.serverUrl);
    const invalidServerUrl = serverUrlError();
    if (invalidServerUrl) {
      // 退出码 2 = 「命令本身用错了」（与 `--tui` 非 TTY / stdio 无输入一致）；
      // 1 留给「已经跑起来之后失败」
      process.stderr.write(`ai: ${invalidServerUrl}\n`);
      process.exitCode = 2;
      return;
    }
  }

  switch (invocation.kind) {
    case "help":
      // 帮助是用户可见的终端文案，跟随界面语言（偏好 / 系统语言）；其余非 TUI 路径（stdio）不初始化语言
      await initLocale();
      process.stdout.write(helpText());
      return;

    case "version":
      process.stdout.write(`${CLI_VERSION}\n`);
      return;

    case "server-status": {
      // 只读发现文件（或直接问显式地址）+ 一次 status 调用，**不**拉起服务端：这个命令是用来
      // 诊断的，顺手拉一个起来会让答案失去意义。输出 JSON 供脚本消费（无需 i18n）。
      //
      // 显式地址必须递进去：远程场景下本机根本没有那份发现文件，不递就永远回
      // `no descriptor` —— 一句既不是「没在跑」也不是「连不上」的话。
      const status = await readServerStatus({
        aiZenDir: AI_ZEN_DIR,
        clientInfo: CLIENT_INFO,
        serverUrl: explicitServerUrl(),
        serverToken: explicitServerToken(),
      });
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      process.exitCode = status.running ? 0 : 1;
      return;
    }

    case "hook":
      // hook 的输出是给人看的终端文案，与 help 同理：先初始化语言，再打印
      await initLocale();
      if (invocation.action === "install") await installHook();
      else if (invocation.action === "uninstall") await uninstallHook();
      else if (invocation.invalidAction) {
        // 认不出的子动作：报错 + 非零退出码（脚本可据此判断），同时给出正确用法
        process.stderr.write(
          `${t("cli.hookUnknownAction", { action: invocation.invalidAction })}\n`,
        );
        process.stderr.write(`${t("cli.hookUsage")}\n`);
        process.exitCode = 1;
      } else {
        // 只想看用法（`ai hook` / `ai hook --help`）：正常输出、退出码 0
        process.stdout.write(`${t("cli.hookUsage")}\n`);
      }
      return;

    case "stdio":
      process.exitCode = await runStdio({
        instruction: invocation.instruction,
        save: invocation.save,
      });
      return;

    case "tui": {
      // 无参数且均为 TTY，或显式 `--tui`：进入全屏交互界面（Ink）。
      // 流式统一走 Ink —— 由 `RENDER_OPTIONS.incrementalRendering`（只重绘变化的行）
      // 压低输出量，SSH / 弱网下实测稳定。
      //
      // 动态 import：确保 React/Ink 的求值发生在上方 `process.env.NODE_ENV ||= "production"`
      // 之后，从而加载 production 版 reconciler（避免 DEV 版 performance.measure 缓冲撑爆堆）。
      const { runTui } = await import("./tui/index.js");
      // `initialPrompt`（来自 shell 钩子 `ai --tui --new "$@"`）会作为首条消息自动发送；
      // `newSession`（`--new`）要求跳过续接、开一条新会话
      await runTui({
        initialPrompt: invocation.initialPrompt,
        newSession: invocation.newSession,
      });
      return;
    }

    case "tui-rejected":
      // `--tui` 明确要求交互界面，但 stdin/stdout 不是 TTY（如被写进脚本或管道）：
      // 不悄悄降级成管道模式（那会把整屏界面内容写进管道），直接报错。
      process.stderr.write(
        "ai: --tui requires an interactive terminal (stdin and stdout must be TTYs)\n",
      );
      process.exitCode = 2;
      return;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n❌ Unexpected error: ${message}\n`);
  process.exitCode = 1;
});
