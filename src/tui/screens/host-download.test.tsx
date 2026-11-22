// 下载屏（PRD D31）的三条路：阶段一行行换、失败给真原因 + R 重试、Esc 折回连接屏。
//
// 这一组用 ink-testing-library 真渲染（`useInput` 的行为只有真按键能验），而结局用注入的
// `onResult` 接住 —— 不去动 ink 的退出通道。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { HostLaunchStage } from "../../server-client/index.js";
import { setLocale } from "../../i18n/index.js";
import { HostDownloadScreen, type HostDownloadScreenResult } from "./host-download.js";

setLocale("zh");

/**
 * 等到 `check()` 成立就返回；超时抛错，错误里说清等的是什么。
 *
 * **别用「睡够多少毫秒」代替它**：那是赌「够久」，而这里要的是「真的发生了」。全量跑时事件
 * 循环被别的用例占着，同一个固定时长有时够、有时不够 —— 同一份代码时红时绿，红的那次还只
 * 报个 `[] !== [{kind:'connected'}]`，看不出在等什么。上限 1000ms 是**失败上限**，不是等待时长。
 */
const until = async (check: () => boolean, what: string, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等不到：${what}（上限 ${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * 让出几拍宏任务 —— 让这一拍里**排在后面**的活先跑完。让的是执行顺序，不是一个时长。
 *
 * 为什么敲键之前要它：帧是在 commit 里画的，而 `useInput` 的订阅落在 passive effect 里，
 * 同一拍里排在画帧**之后**（React 的 Scheduler 在 Node 下走 `setImmediate`）。所以「帧里已经
 * 有这一屏」还不等于「按键有人接」：这一刻塞进去的键会被直接**丢掉**，不是延后处理，是永远不到。
 */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** 剧本里模拟「子进程那边的耗时」用；**不是**「等结果」—— 等结果一律用 `until` */
const flush = async (ms = 8) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 一个按剧本回答的 `connect`：每次被调都记一笔（含那一轮收到的阶段），按剧本推进。
 *
 * 剧本里的 `steps` 是**这一幕要报的阶段**，最后把 `reason` 交回去（`null` = 连上了）。
 */
function scriptedConnect(scenes: Array<{ stages?: HostLaunchStage[]; reason: string | null }>) {
  const calls: HostLaunchStage[][] = [];
  const connect = async (hooks: {
    onStage: (stage: HostLaunchStage) => void;
    signal: AbortSignal;
  }): Promise<string | null> => {
    const scene = scenes.shift();
    if (!scene) throw new Error("剧本用完了（屏不该再拉一次）");
    const reported: HostLaunchStage[] = [];
    calls.push(reported);
    for (const stage of scene.stages ?? []) {
      reported.push(stage);
      hooks.onStage(stage);
      await flush(2);
    }
    return scene.reason;
  };
  return { connect, calls };
}

function mountScreen(connect: Parameters<typeof HostDownloadScreen>[0]["connect"]) {
  const results: HostDownloadScreenResult[] = [];
  const view = render(
    <HostDownloadScreen connect={connect} onResult={(result) => results.push(result)} />,
  );
  return {
    results,
    stdin: view.stdin,
    frame: () => view.lastFrame() ?? "",
    /** 每一帧都记在假 stdout 里（debug 模式），可以用来验「某个阶段真的上过屏」 */
    frames: () => view.frames,
    unmount: view.unmount,
  };
}

describe("阶段：一行行往下换，不报百分比", () => {
  it("解析版本 → 下载并安装 → 启动宿主 → 连上，最后报 connected", async () => {
    const { connect } = scriptedConnect([
      { stages: ["resolving", "installing", "starting", "connected"], reason: null },
    ]);
    const screen = mountScreen(connect);

    // 等的是**结局**（一次异步结果），不是「200ms 大概够了」
    await until(() => screen.results.length > 0, "连上的结局回来");
    expect(screen.results).toEqual([{ kind: "connected" }]);
    screen.unmount();
  });

  it("每个阶段都在屏幕上真的出现过（不是一口气跳到结尾）", async () => {
    const connect = async (hooks: {
      onStage: (stage: HostLaunchStage) => void;
      signal: AbortSignal;
    }): Promise<string | null> => {
      for (const stage of ["resolving", "installing", "starting"] as HostLaunchStage[]) {
        hooks.onStage(stage);
        // 子进程那边每阶段都在干活，这条 sleep 就是在模拟那个耗时（不是「等渲染帧」）
        await flush(20);
      }
      return "拉不起来（这条只验阶段）";
    };
    const screen = mountScreen(connect);
    await until(() => screen.frame().includes("拉不起来"), "这条路的结局上屏");

    // 不去「每个阶段之后抓一帧」（那要猜那一刻画完没有）：假 stdout 把每一帧都记下来了，
    // 于是可以直接问「这三种字各自在某一帧上真的出现过，而且顺序没乱」。
    const frames = screen.frames();
    const at = (text: string) => frames.findIndex((frame) => frame.includes(text));
    expect(at("查询要下载的版本")).toBeGreaterThanOrEqual(0);
    expect(at("下载并安装宿主")).toBeGreaterThan(at("查询要下载的版本"));
    expect(at("启动宿主")).toBeGreaterThan(at("下载并安装宿主"));
    // 不确定进度：屏幕上没有百分比
    expect(frames.join("")).not.toMatch(/\d+%/);
    screen.unmount();
  });

  it("只来了 connected（宿主本来就在跑）→ 一个字节都不画，也不该闪一下", async () => {
    const connect = async (hooks: {
      onStage: (stage: HostLaunchStage) => void;
      signal: AbortSignal;
    }): Promise<string | null> => {
      // 「有就上」那条快路：没有任何拉起阶段，直接连上
      hooks.onStage("connected");
      await flush(20);
      return null;
    };
    const screen = mountScreen(connect);

    await flush(10);
    expect(screen.frame()).toBe("");
    // 「一个字节都不画」是负向断言：先等结局真的回来（这一趟确实跑完了），
    // 否则「什么都没画」也可能只是「什么都还没发生」—— 那就误绿了
    await until(() => screen.results.length > 0, "connected 的结局回来");
    expect(screen.frame()).toBe("");
    expect(screen.results).toEqual([{ kind: "connected" }]);
    screen.unmount();
  });
});

describe("失败：真原因 + R 重试", () => {
  it("失败 → 屏上是子进程说的那句原话；按 R 再拉一次（第二次成功）", async () => {
    const { connect, calls } = scriptedConnect([
      { stages: ["resolving", "installing"], reason: "npm error 404 not found" },
      { stages: ["resolving"], reason: null },
    ]);
    const screen = mountScreen(connect);

    // 等失败那句话**真的上屏**（一次异步结果），顺带也证明了这一次拉起已经跑完、没报结局
    await until(() => screen.frame().includes("npm error 404 not found"), "失败原因上屏");
    expect(screen.frame()).toContain("R");
    expect(screen.results).toEqual([]);

    await settle();
    screen.stdin.write("r");
    await until(() => screen.results.length > 0, "按 R 之后第二次拉起的结局回来");

    expect(calls).toHaveLength(2);
    expect(screen.results).toEqual([{ kind: "connected" }]);
    screen.unmount();
  });

  it("还没失败时按 R 不会重拉（那个键只在有原因的时候有意义）", async () => {
    /** 第一次拉就挂着，直到用例放开它 —— 好让「还没失败」那一下按键真的落在拉起中 */
    const gate: { open: (() => void) | null } = { open: null };
    let calls = 0;
    const connect = async (hooks: {
      onStage: (stage: HostLaunchStage) => void;
      signal: AbortSignal;
    }): Promise<string | null> => {
      calls += 1;
      if (calls > 1) return null;
      hooks.onStage("resolving");
      await new Promise<void>((resolve) => {
        gate.open = resolve;
      });
      return "第一条原因";
    };
    const screen = mountScreen(connect);

    // 先等「正在拉起」真的画出来，再让一拍：画完 ≠ 有人接键
    await until(() => screen.frame().includes("查询要下载的版本"), "「正在拉起」上屏");
    await settle();

    screen.stdin.write("r");
    await settle();
    // 拉起中按 R 什么都不发生：屏上还是那一次
    expect(calls).toBe(1);
    expect(screen.frame()).toContain("查询要下载的版本");

    gate.open?.();
    await until(() => screen.frame().includes("第一条原因"), "失败原因上屏");
    expect(calls).toBe(1);

    // 反证刚才那个 R **确实被处理过**：同一个键，在失败之后按下就该重拉。
    // 少了这一步，上面的 `calls === 1` 是「什么都没发生」—— 键被吞掉也会绿。
    screen.stdin.write("r");
    await until(() => calls === 2, "失败之后按 R 真的重拉了");
    await until(() => screen.results.length > 0, "第二次拉起的结局回来");
    screen.unmount();
  });
});

describe("Esc / Ctrl+C：折回连接屏，不退出程序", () => {
  it("拉起中按 Esc → 停手并折回（原因是一句「已取消」）", async () => {
    let aborted = false;
    const connect = async (hooks: {
      onStage: (stage: HostLaunchStage) => void;
      signal: AbortSignal;
    }): Promise<string | null> => {
      hooks.onStage("resolving");
      // 一直挂着，直到被取消（模拟 npx 还在下载）
      await new Promise<void>((resolve) => {
        hooks.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      return "已取消";
    };
    const screen = mountScreen(connect);

    await until(() => screen.frame().includes("查询要下载的版本"), "「正在拉起」上屏");
    await settle();
    screen.stdin.write("\u001b");
    // 单键 Esc 要等 ink 自己的序列判定（~20ms）才认成 Esc —— 等它认，不猜它多久
    await until(() => screen.results.length > 0, "Esc 被处理成「折回」");

    expect(aborted).toBe(true);
    expect(screen.results).toEqual([{ kind: "fallback", reason: "已取消，本机宿主没有启动" }]);
    screen.unmount();
  });

  it("失败之后按 Esc → 折回时带的是那句**真原因**（不是一句空话）", async () => {
    const { connect } = scriptedConnect([
      { stages: ["resolving"], reason: "npm error 404 not found" },
    ]);
    const screen = mountScreen(connect);

    await until(() => screen.frame().includes("npm error 404 not found"), "失败原因上屏");
    await settle();
    screen.stdin.write("\u001b");
    await until(() => screen.results.length > 0, "Esc 被处理成「折回」");

    expect(screen.results).toEqual([{ kind: "fallback", reason: "npm error 404 not found" }]);
    screen.unmount();
  });

  it("Ctrl+C 与 Esc 同义：回连接屏，不退出程序", async () => {
    const { connect } = scriptedConnect([{ stages: ["resolving"], reason: "连不上" }]);
    const screen = mountScreen(connect);

    await until(() => screen.frame().includes("连不上"), "失败原因上屏");
    await settle();
    screen.stdin.write("\u0003");
    await until(() => screen.results.length > 0, "Ctrl+C 被处理成「折回」");

    expect(screen.results).toEqual([{ kind: "fallback", reason: "连不上" }]);
    screen.unmount();
  });
});
