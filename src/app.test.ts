/**
 * `CliApp` —— 路由、退出码，以及「哪条路径拿到了哪份事实」。
 *
 * ## 这个文件为什么存在
 *
 * 改动前这些判定全在 `index.ts` 的 `main()` 里，它直接读 `process.argv`、直接写
 * `process.stdout`、直接设 `process.exitCode` —— 于是五条分支**一条都验不了**，只能靠
 * `src/__tests__/e2e.test.ts` 起真进程（`AGENTS.md` 里那句「组装根改了……只有真跑才看得见」
 * 就是这条的代价）。
 *
 * 现在 argv / env / tty / 出口 / 四条重路径全是注入项，这一组用例用假件把每个格子咬死。
 * 真进程 e2e **仍然保留**：它验的是另一个东西（`dist/index.js` 这个产物装出来能不能跑），
 * 不是路由逻辑 —— 两层都要有，少一层就有一类错没人看。
 */

import { afterAll, describe, expect, it } from "vitest";
import { CliApp, type CliAppDeps } from "./app.js";
import { applyCliEnv, cliEnv, resolveCliEnv, type CliEnv } from "./env.js";
import type { RunTuiOptions } from "./tui/index.js";
import type { StdioRunOptions } from "./stdio.js";
import type { ServerStatus, ServerStatusDeps } from "./server-client/index.js";

/** 一个假件装配好的根 + 它走过的痕迹 */
interface Harness {
  app: CliApp;
  out: () => string;
  err: () => string;
  /** 每条重路径收到的入参（按调用顺序） */
  calls: {
    stdio: StdioRunOptions[];
    tui: RunTuiOptions[];
    status: ServerStatusDeps[];
    hooks: string[];
    locale: number;
  };
}

/**
 * 造一个根，四条重路径全换成假件。
 *
 * 默认 tty 是「两个都 TTY」（最接近人在终端里敲 `ai`），env 里给一个明确的配置根 ——
 * 让它跟真实进程里的 `.ai-zen` 扯不上关系，断言里出现的路径全都能一眼对上。
 */
function makeApp(argv: string[], overrides: CliAppDeps = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness["calls"] = { stdio: [], tui: [], status: [], hooks: [], locale: 0 };

  const app = new CliApp({
    argv,
    env: { AI_ZEN_DIR: "/tmp/aiz-app-test" },
    tty: { stdinIsTTY: true, stdoutIsTTY: true },
    writeOut: (text) => void out.push(text),
    writeErr: (text) => void err.push(text),
    runStdio: async (options) => {
      calls.stdio.push(options);
      return 0;
    },
    runTui: async (options) => {
      calls.tui.push(options);
    },
    readStatus: async (deps): Promise<ServerStatus> => {
      calls.status.push(deps);
      return { running: false, reason: "no descriptor" };
    },
    installHook: async () => void calls.hooks.push("install"),
    uninstallHook: async () => void calls.hooks.push("uninstall"),
    initLocale: async () => {
      calls.locale += 1;
      return "en";
    },
    version: "9.9.9-test",
    ...overrides,
  });

  return { app, out: () => out.join(""), err: () => err.join(""), calls };
}

afterAll(() => {
  // `isolate: false`：模块图是共享的，别把用例里钉下的假根留给后面的文件
  applyCliEnv(resolveCliEnv({ env: process.env }));
});

describe("CliApp 构造：本进程的事实只有一个主人", () => {
  it("构造就把事实钉进 env.ts —— `cliEnv()` 之后拿到的就是这一份", () => {
    const { app } = makeApp([], {
      env: { AI_ZEN_DIR: "/tmp/aiz-pinned", AI_ZEN_SERVER_TOKEN: " s3cret " },
    });

    expect(cliEnv()).toBe(app.env);
    expect(app.env.aiZenDir).toBe("/tmp/aiz-pinned");
    expect(app.env.serverToken).toBe("s3cret");
  });

  it("`--server` 从 argv 落到 env 上（只在这三条会连服务端的路径上）", () => {
    const { app } = makeApp(["--server", "wss://example.com/ai-zen", "你好"]);
    expect(app.env.serverUrl).toBe("wss://example.com/ai-zen");
  });

  it("AI_ZEN_SERVER_URL 只在路由**不带** `--server` 时才赢", () => {
    const { app } = makeApp(["你好"], {
      env: { AI_ZEN_DIR: "/tmp/aiz-app-test", AI_ZEN_SERVER_URL: "wss://from-env.example.com" },
    });
    expect(app.env.serverUrl).toBe("wss://from-env.example.com");
  });
});

describe("退出码与出口", () => {
  it("--version → 一行版本、退出码 0，且**不**初始化语言（没有文案要翻译）", async () => {
    const { app, out, err, calls } = makeApp(["--version"]);
    expect(await app.run()).toBe(0);
    expect(out()).toBe("9.9.9-test\n");
    expect(err()).toBe("");
    expect(calls.locale).toBe(0);
  });

  it("--help → 先初始化语言再打印（帮助是用户可见的终端文案）", async () => {
    const { app, out, err, calls } = makeApp(["--help"]);
    expect(await app.run()).toBe(0);
    expect(out().length).toBeGreaterThan(0);
    expect(out()).toContain("9.9.9-test");
    expect(err()).toBe("");
    expect(calls.locale).toBe(1);
  });

  it("--tui 但终端不是 TTY → 退出码 2，绝不降级成管道模式", async () => {
    const { app, out, err, calls } = makeApp(["--tui"], {
      tty: { stdinIsTTY: false, stdoutIsTTY: false },
    });
    expect(await app.run()).toBe(2);
    expect(err()).toContain("--tui requires an interactive terminal");
    expect(out()).toBe("");
    expect(calls.tui).toHaveLength(0);
  });
});

describe("server-status：把这一次的事实递下去，退出码按「在不在跑」", () => {
  it("在跑 → 0，不在跑 → 1（脚本据此判断），并且三个事实一项不少", async () => {
    const { app, calls } = makeApp(["--server-status"], {
      env: {
        AI_ZEN_DIR: "/tmp/aiz-status",
        AI_ZEN_SERVER_URL: "wss://example.com/ai-zen",
        AI_ZEN_SERVER_TOKEN: "tok",
      },
    });
    expect(await app.run()).toBe(1);
    expect(calls.status).toHaveLength(1);
    expect(calls.status[0]).toMatchObject({
      aiZenDir: "/tmp/aiz-status",
      serverUrl: "wss://example.com/ai-zen",
      serverToken: "tok",
    });

    const running = makeApp(["--server-status"], {
      readStatus: async (): Promise<ServerStatus> => ({ running: true }) as ServerStatus,
    });
    expect(await running.app.run()).toBe(0);
  });

  it("输出是 JSON（给脚本吃的，不翻译）", async () => {
    const { app, out, calls } = makeApp(["--server-status"]);
    await app.run();
    expect(JSON.parse(out())).toEqual({ running: false, reason: "no descriptor" });
    expect(calls.locale).toBe(0);
  });
});

describe("hook 子动作", () => {
  it("install / uninstall → 真的调了，退出码 0", async () => {
    const install = makeApp(["hook", "install"]);
    expect(await install.app.run()).toBe(0);
    expect(install.calls.hooks).toEqual(["install"]);

    const uninstall = makeApp(["hook", "uninstall"]);
    expect(await uninstall.app.run()).toBe(0);
    expect(uninstall.calls.hooks).toEqual(["uninstall"]);
  });

  it("只想看用法 → 打印用法、退出码 0，什么都不装", async () => {
    const { app, out, calls } = makeApp(["hook"]);
    expect(await app.run()).toBe(0);
    expect(out().length).toBeGreaterThan(0);
    expect(calls.hooks).toEqual([]);
  });

  it("认不出的子动作 → 两句（错在哪 + 怎么用）、退出码 1，什么都不装", async () => {
    const { app, err, calls } = makeApp(["hook", "boom"]);
    expect(await app.run()).toBe(1);
    expect(err().split("\n").filter(Boolean).length).toBe(2);
    expect(calls.hooks).toEqual([]);
  });
});

describe("stdio：把指令与这一次的事实一起递下去，退出码原样返回", () => {
  it("指令 + 默认不落盘；退出码来自 stdio 自己", async () => {
    const { app, calls } = makeApp(["解释一下", "这段代码"], {
      runStdio: async (options) => {
        calls.stdio.push(options);
        return 7; // 随便一个非 0：证明是「原样返回」而不是被映射成 0/1
      },
    });
    expect(await app.run()).toBe(7);
    expect(calls.stdio).toHaveLength(1);
    expect(calls.stdio[0].instruction).toBe("解释一下 这段代码");
    expect(calls.stdio[0].save).toBe(false);
    // 递下去的是**同一个** env 对象：不是复制一份，也就不可能有第二个真相
    expect(calls.stdio[0].env).toBe(app.env);
  });

  it("--save 落到 stdio 的入参上", async () => {
    const { app, calls } = makeApp(["--save", "留一份"]);
    await app.run();
    expect(calls.stdio[0].save).toBe(true);
  });
});

describe("tui：把首条消息与这一次的事实一起递下去", () => {
  it("无参数且两个 TTY → 进 TUI，退出码 0", async () => {
    const { app, calls } = makeApp([]);
    expect(await app.run()).toBe(0);
    expect(calls.tui).toHaveLength(1);
    expect(calls.tui[0].env).toBe(app.env);
    expect(calls.tui[0].initialPrompt).toBeUndefined();
  });

  it('--tui --new "$@"（shell 钩子那条）→ 首条消息 + 要求新会话', async () => {
    const { app, calls } = makeApp(["--tui", "--new", "git psu"]);
    await app.run();
    expect(calls.tui[0].initialPrompt).toBe("git psu");
    expect(calls.tui[0].newSession).toBe(true);
  });
});

describe("显式地址拼错：在启动早期说一句对症的话（D12）", () => {
  it("stdio 路径上地址不合法 → 退出码 2、**不**连也不跑，错误里带原值", async () => {
    const { app, err, out, calls } = makeApp(["--server", "example.com:8790", "你好"]);
    expect(await app.run()).toBe(2);
    expect(err()).toContain("example.com:8790");
    expect(err()).toContain("不是合法的服务端地址");
    expect(out()).toBe("");
    expect(calls.stdio).toHaveLength(0);
  });

  it("`--server` 给了却没值 → 一句「需要一个地址」，不是「空串不合法」", async () => {
    const { app, err, calls } = makeApp(["--server"]);
    expect(await app.run()).toBe(2);
    expect(err()).toBe("ai: --server 需要一个地址（例：--server wss://example.com/ai-zen）\n");
    expect(calls.stdio).toHaveLength(0);
  });

  it("--help 不被一个与本命令无关的坏地址拖住（`AI_ZEN_SERVER_URL` 写错时帮助仍须能出来）", async () => {
    const { app, out, err } = makeApp(["--help"], {
      env: { AI_ZEN_DIR: "/tmp/aiz-app-test", AI_ZEN_SERVER_URL: "example.com:8790" },
    });
    expect(await app.run()).toBe(0);
    expect(out()).toContain("9.9.9-test");
    expect(err()).toBe("");
  });
});

/**
 * 这一条不是路由，是「根真的写到了 `env.ts` 里」的那个副作用 —— 上面每条用例都建了根，
 * 所以这里顺便钉一句：`cliEnv()` 与 `app.env` 是同一个对象（别处读到的根不会漂）。
 */
describe("根与 env.ts 的接缝", () => {
  it("两次建根 → 后一次是当前值（一个进程只该建一次，建两次就是后一次赢）", () => {
    makeApp([], { env: { AI_ZEN_DIR: "/tmp/aiz-first" } });
    const second = makeApp([], { env: { AI_ZEN_DIR: "/tmp/aiz-second" } });
    expect(cliEnv().aiZenDir).toBe("/tmp/aiz-second");
    expect(cliEnv()).toBe<CliEnv>(second.app.env);
  });
});
