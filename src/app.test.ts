/**
 * `CliApp` —— 路由、退出码，以及「哪条路径拿到了哪份事实」。
 *
 * 改动前这些判定全在 `index.ts` 的 `main()` 里，它直接读 `process.argv`、直接写
 * `process.stdout`、直接设 `process.exitCode` —— 于是五条分支一条都验不了，只能靠
 * `src/__tests__/e2e.test.ts` 起真进程（「组装根改了……只有真跑才看得见」就是这条的代价）。
 *
 * 现在 argv / env / tty / 出口 / 四条重路径全是注入项，这一组用例用假件把每个格子钉住。
 * 真进程 e2e 仍然保留：它验的是另一个东西（`dist/index.js` 这个产物装出来能不能跑），
 * 不是路由逻辑 —— 两层都要有，少一层就有一类错没人看。
 */

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliApp, type CliAppDeps } from "./app.js";
import type { CliLog, CliLogOptions } from "./cli-log.js";
import type { LogRecord } from "@ai-zen/agents-logger";
import type { HostStatus } from "./connection.js";
import { applyCliEnv, cliEnv, resolveCliEnv, type CliEnv } from "./env.js";
import type { RunTuiOptions } from "./tui/index.js";
import type { StdioRunOptions } from "./stdio.js";

/** 一个假件装配好的根 + 它走过的痕迹 */
interface Harness {
  app: CliApp;
  out: () => string;
  err: () => string;
  /** 每条重路径收到的入参（按调用顺序） */
  calls: {
    stdio: StdioRunOptions[];
    tui: RunTuiOptions[];
    status: CliEnv[];
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
    readStatus: async (env): Promise<HostStatus> => {
      calls.status.push(env);
      return { running: false, reason: "no host file" };
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
  it("在跑 → 0，不在跑 → 1（脚本据此判断），并且递下去的就是这一个进程的事实", async () => {
    const { app, calls } = makeApp(["--server-status"], {
      env: {
        AI_ZEN_DIR: "/tmp/aiz-status",
        AI_ZEN_SERVER_URL: "wss://example.com/ai-zen",
        AI_ZEN_SERVER_TOKEN: "tok",
      },
    });
    expect(await app.run()).toBe(1);
    expect(calls.status).toHaveLength(1);
    // 同一份 `CliEnv`，不是拆成几个值再拼一遍：地址与凭证必须同源
    expect(calls.status[0]).toBe(app.env);
    expect(calls.status[0]).toMatchObject({
      aiZenDir: "/tmp/aiz-status",
      serverUrl: "wss://example.com/ai-zen",
      serverToken: "tok",
    });

    const running = makeApp(["--server-status"], {
      readStatus: async (): Promise<HostStatus> => ({
        running: true,
        endpoint: "127.0.0.1:8790",
        // 新宿主只报版本这一格（`protocolVersion` / `startedAt` / `pid` 都没了）
        host: { version: "0.1.0-alpha.0" },
      }),
    });
    expect(await running.app.run()).toBe(0);
  });

  it("输出是 JSON（给脚本吃的，不翻译）", async () => {
    const { app, out, calls } = makeApp(["--server-status"]);
    await app.run();
    expect(JSON.parse(out())).toEqual({ running: false, reason: "no host file" });
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
    // 递下去的是同一个 env 对象：不是复制一份，也就不可能有第二个真相
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
    // `ftp:` 不是宿主认的四种 scheme（ws / wss / http / https），也不存在补全规则。
    // 判据与措辞都是连接层那一句 `parseAddress` 的（地址形状只有一个实现处）。
    const { app, err, out, calls } = makeApp(["--server", "ftp://example.com/ai-zen", "你好"]);
    expect(await app.run()).toBe(2);
    expect(err()).toContain("ftp://example.com/ai-zen");
    expect(err()).toContain("Not a valid host address");
    expect(out()).toBe("");
    expect(calls.stdio).toHaveLength(0);
  });

  it("裸 host:port 是合法地址（没写 scheme 按 ws:// 算，终端里最自然的写法）", async () => {
    const { app, err, calls } = makeApp(["--server", "example.com:8790", "你好"]);
    expect(await app.run()).toBe(0);
    expect(err()).toBe("");
    expect(calls.stdio).toHaveLength(1);
  });

  it("`--server` 给了却没值 → 一句「需要一个地址」，不是「空串不合法」", async () => {
    const { app, err, calls } = makeApp(["--server"]);
    expect(await app.run()).toBe(2);
    expect(err()).toBe("ai: --server 需要一个地址（例：--server wss://example.com/ai-zen）\n");
    expect(calls.stdio).toHaveLength(0);
  });

  it("--help 不被一个与本命令无关的坏地址拖住（`AI_ZEN_SERVER_URL` 写错时帮助仍须能出来）", async () => {
    const { app, out, err } = makeApp(["--help"], {
      env: { AI_ZEN_DIR: "/tmp/aiz-app-test", AI_ZEN_SERVER_URL: "ftp://example.com/ai-zen" },
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

/** 本文件那一组用例建出来的临时数据根（`afterAll` 统一删） */
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aiz-app-log-"));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

/** 一个记账用的假日志实例（只数 `close` 调了几次） */
function countedLog(counter: { closes: number }): CliLog {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    filePath: "/nonexistent/cli.log",
    close: async () => {
      counter.closes += 1;
    },
  };
}

describe("日志：开头造、收尾关（一个进程一格目录）", () => {
  it("界面那一档落 <dataRoot>/logs/cli/cli.log，`run()` 收尾必关", async () => {
    const seen: CliLogOptions[] = [];
    const counter = { closes: 0 };
    const { app } = makeApp([], {
      createLog: (options) => {
        seen.push(options);
        return countedLog(counter);
      },
    });

    expect(await app.run()).toBe(0);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.dataRoot).toBe("/tmp/aiz-app-test");
    expect(seen[0]!.persist).toBe(true);
    // 管道模式那一档要的出口也一并递进去（它是同一次进程的 stderr）
    expect(seen[0]!.writeErr).toBeTypeOf("function");
    expect(counter.closes).toBe(1);
  });

  it("管道那一档不落盘（PRD 439：日志走 stderr）", async () => {
    const seen: CliLogOptions[] = [];
    const counter = { closes: 0 };
    const { app } = makeApp(["你好"], {
      createLog: (options) => {
        seen.push(options);
        return countedLog(counter);
      },
    });

    await app.run();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.persist).toBe(false);
    expect(counter.closes).toBe(1);
  });

  it("路由抛了也关（finally：排队的行要写完）", async () => {
    const counter = { closes: 0 };
    const { app } = makeApp([], {
      runTui: async () => {
        throw new Error("界面炸了");
      },
      createLog: () => countedLog(counter),
    });

    await expect(app.run()).rejects.toThrow("界面炸了");
    expect(counter.closes).toBe(1);
  });

  it("一次都没跑过 `run()`：收尾是 no-op（不抛）", async () => {
    const { app } = makeApp([]);
    await expect(app.closeLog()).resolves.toBeUndefined();
  });

  it("一行日志都不写的路由（`--version`）：磁盘上连 `logs/` 都不建", async () => {
    const root = tempRoot();
    const { app, out } = makeApp(["--version"], { env: { AI_ZEN_DIR: root } });

    expect(await app.run()).toBe(0);
    expect(out()).toBe("9.9.9-test\n");
    // 造实例不等于建文件：`FileLogger` 懒开流，这一条路由没有任何一条记录
    expect(existsSync(join(root, "logs"))).toBe(false);
  });

  it("日志的 warn / error 接给本地通知那一格（info 不上栏）", async () => {
    let onRecord: ((record: LogRecord) => void) | undefined;
    const counter = { closes: 0 };
    const { app } = makeApp([], {
      createLog: (options) => {
        onRecord = options.onRecord;
        return countedLog(counter);
      },
    });
    await app.run();

    const seen: string[] = [];
    app.logNotices.setSink((level, message) => seen.push(`${level}:${message}`));
    const at = "2026-01-01T00:00:00.000Z";
    onRecord!({ level: "info", source: "cli", message: "只是记一笔", at });
    onRecord!({ level: "warn", source: "cli", message: "小心", at });

    expect(seen).toEqual(["warn:小心"]);
  });
});
