#!/usr/bin/env node

/**
 * CLI 入口 —— **只有启动**：钉住 `NODE_ENV`、把 EPIPE 当正常结束、把进程交给 `CliApp`。
 *
 * 路由、本进程的事实（配置根 / 显式地址与凭证）、终端能力、四条路径的接线、退出码映射，全部
 * 在 `app.ts` 的 `CliApp` 里（那里也是唯一的 `process.argv` / `process.env` 读点）。
 *
 * 这个文件里剩下的两段都是**必须在任何模块求值之前**成立的副作用，所以它们不能搬进类：
 *
 *   1. `NODE_ENV ||= "production"` —— React 的两个入口靠它在**求值那一刻**选构建；
 *   2. EPIPE 处理器 —— `ai --help | head -1` 这类管道下游主动不读了，不是错误。
 */

// ⚠️ 必须在加载 React/Ink 之前把 NODE_ENV 定为 production。
//
// 背景（OOM 根因）：Node 官方分发版没有内置“production” React，react/react-reconciler
// 的入口用 `process.env.NODE_ENV !== "production"` 决定引用哪个构建。若此变量为空，
// 就会加载 *development* 版 reconciler —— 它每次渲染都会调用 `performance.measure()`
// （User Timing API），而 Node 的 performance 条目缓冲**无界且从不逐出**。长时间流式
// TUI 会话下条目数持续增长，约 55 分钟即把堆顶到 heap_size_limit（本机 ~1GB）触发 OOM。
//
// ESM 的静态 `import` 会被提升到模块体之前执行，所以这条赋值护不住任何**静态** import 的
// React；它护住的是 `CliApp` 里那句**动态** `await import("./tui/index.js")`。
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

import { CliApp } from "./app.js";

/**
 * 退出码只有一个出口：`CliApp.run()` 返回数字，这里交给 `process.exitCode`。
 *
 * 不用 `process.exit(code)`：那会砍掉还没落地的写入（stdout 是管道时尤其明显）。
 * `run()` 的 promise 也不浮空 —— 启动路径上失败只该变成一行可读的日志 + 退出码 1，
 * 而不是一条 unhandled rejection。
 */
void new CliApp()
  .run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n❌ Unexpected error: ${message}\n`);
    process.exitCode = 1;
  });
