#!/usr/bin/env node

import { installHook, uninstallHook } from "./hook.js";
import { resolveInvocation } from "./mode.js";
import { runStdio } from "./stdio-runner.js";
import { runTui } from "./tui/index.js";
import { CLI_VERSION } from "./version.js";

/**
 * CLI 入口 —— 双模式路由
 *
 *   ai                      → TUI（仅当无参数且 stdin/stdout 均为 TTY）
 *   ai <提示词>              → 纯 stdio：结果写 stdout，日志写 stderr
 *   cat 文件 | ai "总结"      → 纯 stdio：stdin 为内容
 *   ai hook install         → 安装 shell 兜底钩子
 *   ai hook uninstall       → 卸载 shell 兜底钩子
 *   ai --help / --version   → 帮助 / 版本
 *
 * 模式判定与参数解析集中在 ./mode.ts（纯函数，单测覆盖），本文件只做分发。
 */

const HELP_TEXT = `ai — AI-Zen CLI v${CLI_VERSION}

用法:
  ai                      进入交互式界面（TUI，需 stdin/stdout 为 TTY）
  ai <提示词>              以纯 stdio 模式提问，结果写入 stdout
  cat 文件 | ai "总结要点"  通过管道传入内容，参数作为指令
  ai hook install         安装 shell 兜底钩子（命令不存在时转发给 AI）
  ai hook uninstall       卸载 shell 兜底钩子

选项:
  --save                  保存本次对话到存档（默认不落盘）
  -h, --help              显示本帮助
  -v, --version           显示版本号

说明:
  stdio 模式无任何交互，结果走 stdout、日志走 stderr，成功退出码 0。
`;

async function main(): Promise<void> {
  const tty = {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
  const invocation = resolveInvocation(process.argv.slice(2), tty);

  switch (invocation.kind) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return;

    case "version":
      process.stdout.write(`${CLI_VERSION}\n`);
      return;

    case "hook":
      if (invocation.action === "install") await installHook();
      else if (invocation.action === "uninstall") await uninstallHook();
      else {
        process.stderr.write("用法: ai hook install|uninstall\n");
        process.exitCode = 1;
      }
      return;

    case "stdio":
      process.exitCode = await runStdio({
        instruction: invocation.instruction,
        save: invocation.save,
      });
      return;

    case "tui":
      // 无参数且均为 TTY：进入全屏交互界面（Ink）
      await runTui();
      return;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n❌ 意外错误: ${message}\n`);
  process.exitCode = 1;
});
