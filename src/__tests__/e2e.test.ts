import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDescriptor, workspaceIdFor } from "@ai-zen/agents-server";
import { SocketServerClient } from "../server-client/socket-server-client.js";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";

// ==================== Helpers ====================

const CLI = join(process.cwd(), "dist", "index.js");
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
    const env = { ...process.env, LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8", ...extraEnv };

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

let tmpDirs: string[] = [];
/** 本用例建的目录（`afterEach` 收掉它们里面被拉起的守护进程） */
let liveDirs: string[] = [];

/**
 * 收掉某个临时目录里被 `ai "…"` 顺手拉起的守护进程。
 *
 * 纯 stdio 模式现在**跑在服务端**（`ensureServer` 会 spawn 一个 detached 进程），而 e2e
 * 每个用例一个 `AI_ZEN_DIR` —— 不显式关掉就是一堆常驻进程与删不掉的临时目录（进程的
 * cwd 还留在里面）。
 *
 * 判据用发现文件：`Daemon.stop()` 退出前会删掉它，所以「文件没了」就是真停了。
 */
async function stopServer(aizDir: string): Promise<void> {
  const descriptor = await readDescriptor(aizDir);
  if (!descriptor) return;
  const client = await SocketServerClient.connect({
    address: { host: descriptor.host, port: descriptor.port },
    client: { name: "@ai-zen/cli-e2e", version: "0.0.0" },
  }).catch(() => null);
  if (!client) return;
  // 回执先到、进程后停：这条调用的 reject 不重要（socket 可能先被关）
  await client.call("shutdown").catch(() => {});
  client.close();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await readDescriptor(aizDir)) === null) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  liveDirs = [];
});

afterEach(async () => {
  for (const d of liveDirs) await stopServer(d).catch(() => {});
  liveDirs = [];
});

afterAll(async () => {
  for (const d of tmpDirs) await stopServer(d).catch(() => {});
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function makeTestDir(): string {
  const dir = join(tmpdir(), `ai-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  liveDirs.push(dir);
  return dir;
}

interface SetupOptions {
  apiKey?: string;
  baseUrl?: string;
}

/** 在测试目录中预设完整的配置文件 */
function setupConfigDir(aizDir: string, options: SetupOptions = {}): void {
  const { apiKey = "sk-test-fake-key", baseUrl = "https://api.deepseek.com/v1" } = options;

  mkdirSync(join(aizDir, "agents"), { recursive: true });
  mkdirSync(join(aizDir, "sub-agents"), { recursive: true });

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
            // custom: true → 用户自有，避免被 SDK「出厂模型清单同步」替换（alpha.1）
            custom: true,
          },
        ],
        defaultModel: "deepseek-flash",
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
  } catch {}
  return process.env.DEEPSEEK_API_KEY || "";
}

const API_KEY = getApiKey();

// ==================== Tests ====================

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
    expect(result.stdout).toContain("✅ ai hook 已安装");
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
    expect(result.stdout).toContain("✅ ai hook 已从");
  });

  // 只有「认不出的子动作」才报错到 stderr、退出码 1；只想看用法是正常路径。
  // 断言**不锁语言**：这条输出跟随界面语言（偏好 / 系统 LANG），临时 AI_ZEN_DIR 里
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
    const result = await runCli([], "", { AI_ZEN_DIR: aizDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no input");
    expect(result.stdout).toBe("");
  });

  it("未配置 API Key 时退出码非 0，stdout 为空", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: "" });
    const result = await runCli(["你好"], undefined, { AI_ZEN_DIR: aizDir });
    expect(result.exitCode).not.toBe(0);
    // 这句现在由服务端的装配方（SDK `createModel`）说：`session.create` 失败，客户端转达
    expect(result.stderr).toMatch(/API key/i);
    expect(result.stdout).toBe("");
  }, 20000);

  it("模型/网络报错时 stdout 保持纯净（无 ANSI），错误只走 stderr", async () => {
    const aizDir = makeTestDir();
    // 指向一个不可达地址，请求快速失败（不依赖外网）
    setupConfigDir(aizDir, { baseUrl: "http://127.0.0.1:9/v1" });
    const result = await runCli(["你好"], undefined, { AI_ZEN_DIR: aizDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 20000);

  it("stdin 被重定向时也能触发 stdio 模式（无参数）", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: "http://127.0.0.1:9/v1" });
    const result = await runCli([], "这是来自管道的内容\n", { AI_ZEN_DIR: aizDir });
    // 无参数 + 管道 → stdio（不会进入 TUI）；这里以请求失败收尾，关键是 stdout 纯净
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stdout).toBe("");
  }, 20000);
});

describe("E2E: 真跑一轮（假 LLM 端点，不需要 key）", () => {
  /**
   * 这一组是「进程级」的冒烟：真 `node dist/index.js` → 真守护进程 → 真 SDK → 真 HTTP 流
   * → 真 stdout/退出码。模型换成一个本地的 OpenAI 兼容端点（`test-support/fake-llm.ts`），
   * 于是答复、分片、用量都确定，断言能写等号，CI 里也跑得起来。
   *
   * 真正连外网的用例留在下一组，有 key 才跑。
   */
  let llm: FakeLlm | null = null;

  afterEach(async () => {
    await llm?.close();
    llm = null;
  });

  it("ai <消息>：答案写 stdout、退出码 0、默认不落盘", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["你好"], undefined, { AI_ZEN_DIR: aizDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${CLI_REPLY}\n`);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(ANSI_RE);

    // 一次性调用（`persist:false`）：工作区里既没存档、也没「上一轮会话」指针
    const workspace = join(aizDir, "workspaces", workspaceIdFor(process.cwd()));
    expect(existsSync(join(workspace, "last-session.json"))).toBe(false);
    expect(existsSync(join(workspace, "sessions"))).toBe(false);
  }, 20000);

  it("管道内容 + 指令：合并后的 prompt 真的发给了模型", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["用一句话总结"], "苹果是一种水果。\n", { AI_ZEN_DIR: aizDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${CLI_REPLY}\n`);
    // 「stdin 当内容、参数当指令」只能从模型侧看到的请求里验：`指令\n\n内容`
    const sent = JSON.stringify(llm.requests.at(-1)!.body.messages);
    expect(sent).toContain("用一句话总结");
    expect(sent).toContain("苹果是一种水果。");
  }, 20000);

  it("--save：写存档但不挪续接指针", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["--save", "留一份"], undefined, { AI_ZEN_DIR: aizDir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Saved conversation:");
    const root = join(aizDir, "workspaces", workspaceIdFor(process.cwd()));
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(root, "sessions")).length).toBe(1);
    // 归档 ≠ 变成「上次聊过的那段」：下次 `ai` 不该续接到一条管道结果上
    expect(existsSync(join(root, "last-session.json"))).toBe(false);
  }, 20000);

  it("连跑两次：第二次的请求里没有上一轮的对话（一次性会话不带历史）", async () => {
    llm = await startFakeLlm({ reply: CLI_REPLY });
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    await runCli(["第一句"], undefined, { AI_ZEN_DIR: aizDir });
    const second = await runCli(["第二句"], undefined, { AI_ZEN_DIR: aizDir });

    expect(second.exitCode).toBe(0);
    const sent = JSON.stringify(llm.requests.at(-1)!.body.messages);
    expect(sent).toContain("第二句");
    expect(sent).not.toContain("第一句");
  }, 30000);

  it("服务端报错：stdout 为空、错误走 stderr、退出码非 0", async () => {
    llm = await startFakeLlm({ failWith: { status: 500, message: "fake upstream exploded" } });
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: llm.baseUrl, apiKey: "sk-fake" });

    const result = await runCli(["你好"], undefined, { AI_ZEN_DIR: aizDir });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 20000);
});

describe("E2E: 真实 API 对话（有 key 才跑）", () => {
  it("ai <消息> 结果写入 stdout、退出码 0、默认不落盘", async (ctx) => {
    if (!API_KEY) ctx.skip();

    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: API_KEY });

    const result = await runCli(["用一句话介绍你自己"], undefined, { AI_ZEN_DIR: aizDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stderr).toBe("");
    const workspace = join(aizDir, "workspaces", workspaceIdFor(process.cwd()));
    expect(existsSync(join(workspace, "last-session.json"))).toBe(false);
    expect(existsSync(join(workspace, "sessions"))).toBe(false);
  }, 60000);
});
