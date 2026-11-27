/**
 * 端到端：真 `node dist/index.js` → 真宿主进程 → 真 SDK → 真 HTTP 流 → 真 stdout / 退出码。
 *
 * 跑的是 `ai "<消息>"` 那一条路（stdio 模式）：它读连接设置 → 连上宿主（本机模式没有活的宿主
 * 就拉起一个）→ `runtime.agent.runOnce` 跑一轮 → 把答复写进 stdout。断言的是用户看得见的那几样：
 * stdout 的内容与纯净度、stderr 的错误、退出码。
 *
 * 本机拉起走 `npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`，而那个包还没发到
 * registry：真 npx 只会 404，而「能不能下载」不该由 e2e 去联网等（慢，还随网络与 npm 缓存浮动）。
 * 所以本机模式的用例把 `PATH` 前面的 `npx` 换成一个只会转发的假件（见 `localEnv` /
 * `makeFakeNpx`）：它吃掉 `-y` 与包坐标，剩下的原样交给本仓构建出来的宿主入口。
 *
 * 于是「命令行怎么拼 → detached 子进程 → 发现文件 → 握手」这条真实路径仍然被走一遍，而耗时与
 * 网络无关（多出来的只有起一个 node 进程的时间）。30～40 秒的超时是留给真宿主与假 LLM 的，
 * 与下载无关。
 *
 * 本机模式下宿主是 CLI 自己拉起来的 detached 进程。每个用例一个 `AI_ZEN_DIR`，不显式关掉
 * 就是一堆常驻进程与删不掉的临时目录（进程的 cwd 还留在里面）。判据用发现文件
 * `<aiZenDir>/run/host.json` 里的 `pid`。
 *
 * 收摊不再走 `host.shutdown`（那条 procedure 宿主已经没有了）：改成「发 SIGTERM 等它自己走」
 * 加「把发现文件删掉」。后者是兜底：宿主正常收尾时它自己就删了，但被 SIGKILL 掉的那一次会留下
 * 一个指向死 pid 的文件，下一轮读它的人会一直等到超时。
 *
 * 这一组需要构建产物（`dist/index.js`）与一个真宿主进程，所以它在 `vitest.e2e.config.ts`
 * 里单独跑（`npm run test:e2e` 会先 `build`）；默认的 `vitest run` 把它排除在外。
 */

import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeLlm, type FakeLlm } from "@ai-zen/fake-llm";

const CLI = join(process.cwd(), "dist", "index.js");
/**
 * `agents-host` 的 bin 入口（跨 `agents` 仓，与 `vitest.config.ts` / `rolldown.config.mjs`
 * 指 `@ai-zen/agents-client` 源码用的是同一种写法）。
 *
 * 只有一条用例自己拉起宿主（`--server-status` 那一条，它要一台持续活着的宿主），
 * 其余都让 `ai` 自己拉起 —— 那是它们要验的事。
 */
const HOST_ENTRY = join(process.cwd(), "..", "agents", "packages", "host", "dist", "cli.js");
const ANSI_RE = /\x1b\[[0-9;]*m/;
/** 假模型的固定答复（断言 stdout 用等号，不用「非空」） */
const CLI_REPLY = "这是假模型给出的答复。";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(
  args: string[],
  stdinInput?: string,
  extraEnv?: Record<string, string>,
): Promise<CliResult> {
  return new Promise((resolve) => {
    // 断言的是用户可见的中文文案（hook 用法 / 错误提示），而界面语言跟随偏好或
    // 系统 LANG；给临时 `AI_ZEN_DIR` 时没有 preferences.json，会落到英文 —— 显式锁语言，
    // 否则同一份断言在开发者机器上红、CI 上绿（或反之）。
    const env = {
      ...process.env,
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      ...extraEnv,
    };

    const proc = spawn("node", [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    // 始终关闭 stdin，避免管道悬挂；无输入时传空串
    proc.stdin.end(stdinInput ?? "");

    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    proc.on("error", () => resolve({ stdout, stderr, exitCode: -1 }));
  });
}

/**
 * 本机宿主在数据根里留下的发现文件（`<数据根>/run/host.json`：`pid` / `host` / `port`）。
 *
 * 路径与字段名是协议的一部分（连接层按同一份形状读它），用例这里直接拼 —— 要验的不是
 * 「路径对不对」，而是「拉起来的那台停没停」。
 */
function hostFileOf(aizDir: string): string {
  return join(aizDir, "run", "host.json");
}

let tmpDirs: string[] = [];
/** 本用例建的目录（`afterEach` 收掉它们里面被拉起的宿主进程） */
let liveDirs: string[] = [];
/** 用例自己拉起的宿主子进程（`--server-status` 那一条用；其余的靠发现文件里的 pid） */
let spawnedHosts: ChildProcess[] = [];

/**
 * 假 `npx` 所在的目录（第一次用到时造，`afterAll` 随临时目录一起收掉）。
 *
 * 脚本只做一件事：吃掉 `-y` 与包坐标，剩下的参数原样交给本仓构建出来的宿主入口 —— 这正是真 npx
 * 「装好之后」干的事。前提与 hook 那一组一样：POSIX shell。
 */
function makeFakeNpx(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-e2e-bin-"));
  tmpDirs.push(dir);
  const script = [
    "#!/bin/sh",
    "# 假 npx：e2e 不联网。参数形状是 `-y @ai-zen/agents-host@<range> serve --ai-zen-dir <目录>`。",
    "shift",
    "shift",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(HOST_ENTRY)} "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "npx"), script, { mode: 0o755 });
  return dir;
}

let fakeNpxDir: string | null = null;

/**
 * 本机模式的 env：数据根 + 把 `npx` 指到假件上。
 *
 * 每个本机用例都得用它：不用的话 CLI 会去 registry 拉一个还没发布的包，失败得毫无意义。
 */
function localEnv(aizDir: string): Record<string, string> {
  fakeNpxDir ??= makeFakeNpx();
  return {
    AI_ZEN_DIR: aizDir,
    PATH: `${fakeNpxDir}${delimiter}${process.env.PATH ?? ""}`,
  };
}

/** 一个 pid 还活着吗（`kill(pid, 0)` 只探存在，不投递信号） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 自己把真宿主拉起来，等到它写好了发现文件才返回。
 *
 * 为什么不用 `ai "…"` 预热：一次性调用结束后连接就没了，宿主自己的退出判据（没有连接、
 * 没有在跑的轮次）成立就收尾并把发现文件摘掉 —— 拿它当预热等于和宿主的退出赛跑。
 */
async function startHost(dataRoot: string): Promise<{ pid: number; port: number }> {
  if (!existsSync(HOST_ENTRY)) {
    throw new Error(`先构建宿主：${HOST_ENTRY} 不存在（pnpm -C ../agents build）`);
  }
  const child = spawn(process.execPath, [HOST_ENTRY, "serve", "--ai-zen-dir", dataRoot], {
    env: { ...process.env, AI_ZEN_DIR: dataRoot },
    stdio: "ignore",
  });
  spawnedHosts.push(child);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(hostFileOf(dataRoot))) {
      return JSON.parse(readFileSync(hostFileOf(dataRoot), "utf-8")) as {
        pid: number;
        port: number;
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`宿主 15 秒内没写出发现文件：${hostFileOf(dataRoot)}`);
}

/**
 * 收掉某个临时目录里由 `ai "…"` 拉起的宿主。
 *
 * 判据只用两样纯 Node 的东西：发现文件里的 `pid`（宿主自己写的），与 `SIGTERM`（宿主在
 * `cli.ts` 里已接管：收到就收尾并删掉发现文件）。不经过连接层 —— e2e 要的是「进程真的停了」，
 * 而不是再验证一遍客户端能不能连上。
 */
async function stopHost(aizDir: string): Promise<void> {
  let pid: number | undefined;
  try {
    const parsed = JSON.parse(readFileSync(hostFileOf(aizDir), "utf-8")) as { pid?: unknown };
    if (typeof parsed.pid === "number") pid = parsed.pid;
  } catch {
    return; // 文件不在 = 没有活着的宿主
  }
  if (pid === undefined || !isAlive(pid)) {
    // 进程已经没了：发现文件还留着就是一个指向死 pid 的坑，一并删掉
    rmSync(hostFileOf(aizDir), { force: true });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    rmSync(hostFileOf(aizDir), { force: true });
    return;
  }
  // 等它自己走：宿主收到信号会收尾（连库、删发现文件），SIGKILL 会留下半个数据根
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 刚好自己退了 */
    }
  }
  // 兜底：宿主没来得及删（或者被 SIGKILL 掉）时，这个文件不该留到下一轮
  rmSync(hostFileOf(aizDir), { force: true });
}

beforeEach(() => {
  liveDirs = [];
  spawnedHosts = [];
});

afterEach(async () => {
  for (const dir of liveDirs) await stopHost(dir).catch(() => {});
  // 自己拉起的那个：发过 SIGTERM 之后还要确认它真的走了（否则下一轮的 8790 会被占着）
  for (const child of spawnedHosts) {
    if (child.exitCode === null && child.pid !== undefined && isAlive(child.pid)) {
      child.kill("SIGKILL");
    }
  }
  liveDirs = [];
  spawnedHosts = [];
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 目录可能已经被上一轮清掉了 */
    }
  }
  tmpDirs = [];
});

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-e2e-"));
  tmpDirs.push(dir);
  liveDirs.push(dir);
  return dir;
}

interface SetupOptions {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 一个此刻空着的本地端口（向系统要：绑 0，读回拿到的那个，再放开）。
 *
 * 为什么要它：宿主默认听 8790，而开发者机器上常常已经有一台在听（`pnpm dev`、或上一次
 * 手工起的宿主）。那时这一组每一条都会红在 `EADDRINUSE` 上 —— 看着像代码坏了，其实只是端口被
 * 别人占着。每个用例自带一个空端口之后，这一组就不再取决于「本机现在有没有在跑宿主」。
 *
 * 「绑了再放开」有一个窗口期（这几十毫秒里别人可能抢走），但对手只有本机的其它进程，而它们
 * 不会专门来抢一个刚放开的高位端口。
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port === 0 ? reject(new Error("拿不到空闲端口")) : resolve(port)));
    });
  });
}

/**
 * 建一个自带端口的用例数据根 —— 凡是会让 `ai` 拉起宿主的用例都用它。
 *
 * 端口写进 `<数据根>/host.json`（宿主的设置文件，优先级「启动参数 > 这个文件 > 出厂 8790」；
 * 客户端拉起时不带 `--port`，所以这一格就是最终答案），与本机有没有别的宿主无关。
 */
async function setupHostDir(options: SetupOptions = {}): Promise<string> {
  const dir = makeTestDir();
  setupConfigDir(dir, options);
  writeFileSync(
    join(dir, "host.json"),
    `${JSON.stringify({ port: await freePort() }, null, 2)}\n`,
    "utf-8",
  );
  return dir;
}

/**
 * 在测试目录里备好「这台机器已经配过」（连接设置 + 一份配置 + 一个默认 AgentDefinition）。
 *
 * 不写 `cli/connection.json` 的话，`ai "…"` 会按「没配过」直接失败（那是「没配过」那条
 * 用例要验的事）；本组其余用例要验的是「跑一轮」本身。
 */
function setupConfigDir(aizDir: string, options: SetupOptions = {}): void {
  const { apiKey = "sk-test-fake-key", baseUrl = "https://api.deepseek.com/v1" } = options;

  const connection = join(aizDir, "cli", "connection.json");
  mkdirSync(dirname(connection), { recursive: true });
  writeFileSync(connection, `${JSON.stringify({ mode: "local" })}\n`, "utf-8");

  mkdirSync(join(aizDir, "agents"), { recursive: true });

  writeFileSync(
    join(aizDir, "config.json"),
    JSON.stringify(
      {
        endpoints: [
          {
            id: "deepseek",
            name: "DeepSeek",
            apiKey,
            baseUrl,
            description: "DeepSeek API 端点",
          },
        ],
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek-Flash",
            endpointId: "deepseek",
            modelName: "deepseek-flash",
            description: "DeepSeek 旗舰模型",
            defaultParams: { thinking: { type: "disabled" } },
            tokenThresholds: { handoff: 250000, guard: 375000 },
            // custom: true → 用户自有，避免被 SDK「出厂模型清单同步」替换
            custom: true,
          },
        ],
        defaultModel: "deepseek-flash",
        // 缺省 AgentDefinition 由宿主从配置里答（`runtime.agent.runOnce` 不带 agentId 时就用它）：
        // 仅生成 `agents/default.json` 是不够的 —— 那是「候选清单」，选谁在这条默认项里
        defaultAgent: "default",
        version: 4,
      },
      null,
      2,
    ),
    "utf-8",
  );

  writeFileSync(
    join(aizDir, "agents", "default.json"),
    JSON.stringify({
      id: "default",
      name: "默认助手",
      description: "默认的 AI 助手",
      messages: [{ role: "system", content: "你是一个AI助手，请用中文回复。" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    "utf-8",
  );
}

function getApiKey(): string {
  try {
    const envContent = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    const match = envContent.match(/^DEEPSEEK_API_KEY=(.+)/m);
    if (match) return match[1].trim();
  } catch {
    /* 没有 .env.local 是正常的：真 key 那条路会自己跳过 */
  }
  return process.env.DEEPSEEK_API_KEY || "";
}

const API_KEY = getApiKey();

describe("E2E: 启动命令与子命令", () => {
  it("ai --version 输出版本号（stdout，退出码 0）", async () => {
    const result = await runCli(["--version"]);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

  it("ai --help 输出用法（stdout，退出码 0）", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("用法");
    expect(result.stdout).toContain("stdio");
    expect(result.exitCode).toBe(0);
  });
});

describe("E2E: 显式宿主地址（--server / AI_ZEN_SERVER_URL）", () => {
  it("--server 给了非法地址：启动早期一句人话 + 非 0 退出（stdout 干净，不去连接也不拉起）", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir);

    // 端口写成非数字：`parseAddress` 认不出，与「把 wss:// 敲丢了一部分」是同一类手误。
    // （裸 `host:port` 是合法的：连接层按 `ws://` 补全，所以不能拿它当反例。）
    const badAddress = "example.com:abc";
    const result = await runCli(["--server", badAddress, "你好"], undefined, {
      AI_ZEN_DIR: aizDir,
    });

    expect(result.exitCode).not.toBe(0);
    // 措辞来自连接层那份 `parseAddress`：带原值，用户能认出自己敲的那一行。
    // 两语言都接受：那张本地文案表是中英双份，而这个调用点（启动早期校验）没有把界面语言
    // 递下去，所以今天拿到的总是英文 —— 断言不把这一处缺口钉成预期行为。
    expect(result.stderr).toMatch(/合法的宿主地址|valid host address/);
    expect(result.stderr).toContain(badAddress);
    expect(result.stdout).toBe("");
    // 地址是坏的 → 一步都没走：既没连、也没拉起
    expect(existsSync(hostFileOf(aizDir))).toBe(false);
  }, 20_000);

  it("--server-status 给了显式地址：问的是那个地址，不是本机的发现文件", async () => {
    // 宿主跑在 A（发现文件与凭证都在 A），而客户端那侧是另一个空目录 B —— 这就是
    // 远程 / 隧道的形状：B 里既没有 `run/host.json`，也没有 `run/token`
    const serverDir = await setupHostDir();
    const clientDir = makeTestDir();

    // 宿主在 A 里自己起来并一直活着：一次性调用结束后它就会判空退出，
    // 而本用例要的是一台能被第二个客户端问到的宿主
    const facts = await startHost(serverDir);
    expect(typeof facts.port).toBe("number");
    const token = readFileSync(join(serverDir, "run", "token"), "utf-8").trim();

    const running = await runCli(
      ["--server-status", "--server", `ws://127.0.0.1:${facts.port}`],
      undefined,
      { AI_ZEN_DIR: clientDir, AI_ZEN_SERVER_TOKEN: token },
    );
    expect(running.exitCode).toBe(0);
    const answered = JSON.parse(running.stdout) as {
      running: boolean;
      host?: { version: string };
    };
    expect(answered.running).toBe(true);
    // `--server-status` 按新版 `host.version` 收窄成只剩版本这一格
    expect(typeof answered.host?.version).toBe("string");

    // 同一台宿主、不给地址：客户端只看自己那个目录 → 一句「没有发现文件」
    const blind = await runCli(["--server-status"], undefined, { AI_ZEN_DIR: clientDir });
    expect(blind.exitCode).toBe(1);
    expect(JSON.parse(blind.stdout).running).toBe(false);
  }, 40_000);
});

describe("E2E: 没配过宿主（一次性调用直接失败）", () => {
  it('ai "…" 退出码 2、一句指路的话、且**没有拉起任何宿主**', async () => {
    // 一台刚解压完的机器：没有 `cli/connection.json`，也没有 `run/`
    const aizDir = makeTestDir();

    // `AI_ZEN_SERVER_URL` 显式置空：开发者 shell 里若真有这一项，本用例就测不到「没配过」了
    const result = await runCli(["你好"], undefined, {
      ...localEnv(aizDir),
      AI_ZEN_SERVER_URL: "",
      AI_ZEN_SERVER_TOKEN: "",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no host configured yet");
    // 判据：真的一个宿主都没被拉起来（拉起一定会写发现文件）
    expect(existsSync(hostFileOf(aizDir))).toBe(false);
  }, 20_000);
});

describe("E2E: shell 兜底钩子", () => {
  it("ai hook install 安装钩子", async () => {
    const aizDir = makeTestDir();
    const result = await runCli(["hook", "install"], undefined, {
      AI_ZEN_DIR: aizDir,
      SHELL: "/bin/bash",
      HOME: aizDir,
      // Windows 上 os.homedir() 读取 USERPROFILE，需一并改写以保证隔离
      USERPROFILE: aizDir,
    });
    expect(result.stdout).toContain("ai hook 已安装到");
  });

  it("ai hook uninstall 卸载钩子", async () => {
    const aizDir = makeTestDir();
    const hookEnv = {
      AI_ZEN_DIR: aizDir,
      SHELL: "/bin/bash",
      HOME: aizDir,
      USERPROFILE: aizDir,
    };
    await runCli(["hook", "install"], undefined, hookEnv);
    const result = await runCli(["hook", "uninstall"], undefined, hookEnv);
    expect(result.stdout).toContain("ai hook 已从");
  });

  // 只有「认不出的子动作」才报错到 stderr、退出码 1；只想看用法是正常路径。
  // 断言不锁语言：这条输出跟随界面语言（偏好 / 系统 LANG），临时 AI_ZEN_DIR 里
  // 没有 preferences.json 时落到英文；锁「两种语言都会出现的那段」才不 flaky。
  it("ai hook 不带参数时输出用法（stdout，退出码 0）", async () => {
    const aizDir = makeTestDir();
    const result = await runCli(["hook"], undefined, { AI_ZEN_DIR: aizDir });
    expect(result.stdout).toMatch(/ai hook install\|uninstall/);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

describe("E2E: 纯 stdio 模式", () => {
  // stdio 模式刻意不做 i18n（见 index.ts：结果写 stdout、日志走 stderr，不给管道加语言依赖），
  // 所以这里的断言锁英文原文
  it("无输入时退出码非 0，且提示只出现在 stderr", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir);
    const result = await runCli([], "", localEnv(aizDir));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no input");
    expect(result.stdout).toBe("");
  }, 30_000);

  it("未配置 API Key 时退出码非 0，stdout 为空", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: "" });
    const result = await runCli(["你好"], undefined, localEnv(aizDir));
    expect(result.exitCode).not.toBe(0);
    /*
     * 这一格的口径变了：旧宿主把 SDK 那句「没配 API key」原样带出网，现在它是一条内部失败
     * （tRPC 的 `INTERNAL_SERVER_ERROR`，句子被折成「the call did not complete」）。客户端能保证
     * 的仍然是这一条 —— 失败要说出来、且 stdout 一个字都不许有；「为什么」这一半由宿主的日志说。
     */
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
  }, 30_000);

  it("模型/网络报错时 stdout 保持纯净（无 ANSI），错误只走 stderr", async () => {
    const aizDir = makeTestDir();
    // 指向一个不可达地址，请求快速失败（不依赖外网）
    setupConfigDir(aizDir, { baseUrl: "http://127.0.0.1:9/v1" });
    const result = await runCli(["你好"], undefined, localEnv(aizDir));
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 30_000);

  it("stdin 被重定向时也能触发 stdio 模式（无参数）", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: "http://127.0.0.1:9/v1" });
    const result = await runCli([], "这是来自管道的内容\n", localEnv(aizDir));
    // 无参数 + 管道 → stdio（不会进入 TUI）；这里以请求失败收尾，关键是 stdout 纯净
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stdout).toBe("");
  }, 30_000);
});

describe("E2E: 真跑一轮（假 LLM 端点，不需要 key）", () => {
  /**
   * 这一组是「进程级」的冒烟：真 `node dist/index.js` → 真宿主进程 → 真 SDK → 真 HTTP 流
   * → 真 stdout/退出码。模型换成一个本地的 OpenAI 兼容端点（`@ai-zen/fake-llm` 的
   * `startFakeLlm`），于是答复、分片、用量都确定，断言能写等号，CI 里也跑得起来。
   *
   * 真正连外网的用例留在下一组，有 key 才跑。
   */
  let llm: FakeLlm | null = null;

  afterEach(async () => {
    await llm?.close();
    llm = null;
  });

  it("ai <消息>：答案写 stdout、退出码 0", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = await setupHostDir({ baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["你好"], undefined, localEnv(aizDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${CLI_REPLY}\n`);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(ANSI_RE);
  }, 40_000);

  it("管道内容 + 指令：合并后的 prompt 真的发给了模型", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = await setupHostDir({ baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["用一句话总结"], "苹果是一种水果。\n", localEnv(aizDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${CLI_REPLY}\n`);
    // 「stdin 当内容、参数当指令」只能从模型侧看到的请求里验：` 指令\n\n 内容 `
    const sent = JSON.stringify(llm.requests.at(-1)!.body.messages);
    expect(sent).toContain("用一句话总结");
    expect(sent).toContain("苹果是一种水果。");
  }, 40_000);

  it("--save：建一段真会话并把 id 写到 stderr（一次性调用不落这段）", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = await setupHostDir({ baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["--save", "留一份"], undefined, localEnv(aizDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${CLI_REPLY}\n`);
    // 会话 id 由宿主分配：客户端只负责把它写出来
    expect(result.stderr).toContain("Saved session:");
  }, 40_000);

  it("连跑两次：第二次的请求里没有上一轮的会话（一次性会话不带历史）", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = await setupHostDir({ baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    await runCli(["第一句"], undefined, localEnv(aizDir));
    const second = await runCli(["第二句"], undefined, localEnv(aizDir));

    expect(second.exitCode).toBe(0);
    const sent = JSON.stringify(llm.requests.at(-1)!.body.messages);
    expect(sent).toContain("第二句");
    expect(sent).not.toContain("第一句");
  }, 60_000);

  it("宿主报错：stdout 为空、错误走 stderr、退出码非 0", async () => {
    llm = await startFakeLlm({ failWith: { status: 500, message: "fake upstream exploded" } });
    const aizDir = await setupHostDir({ baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["你好"], undefined, localEnv(aizDir));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 40_000);
});

describe("E2E: 真实 API 会话（有 key 才跑）", () => {
  it("ai <消息> 结果写入 stdout、退出码 0", async (ctx) => {
    if (!API_KEY) ctx.skip();

    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: API_KEY });

    const result = await runCli(["用一句话介绍你自己"], undefined, localEnv(aizDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stderr).toBe("");
  }, 90_000);
});

// 没 build 就明确说一句，而不是让每条用例各自超时（`npm run test:e2e` 会先 build）
it("构建产物存在（这一组测的是 dist/index.js）", () => {
  expect(existsSync(CLI)).toBe(true);
});
