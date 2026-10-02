import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ==================== Helpers ====================

const CLI = join(process.cwd(), "dist", "index.js");
const ANSI_RE = /\x1b\[[0-9;]*m/;

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
    const env = { ...process.env, ...extraEnv };

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

afterAll(() => {
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
  return dir;
}

interface SetupOptions {
  apiKey?: string;
  baseUrl?: string;
}

/** 在测试目录中预设完整的配置文件 */
function setupConfigDir(aizDir: string, options: SetupOptions = {}): void {
  const { apiKey = "sk-test-fake-key", baseUrl = "https://api.deepseek.com/v1" } = options;

  mkdirSync(join(aizDir, "cli", "conversations"), { recursive: true });
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
            id: "deepseek-v4-flash",
            name: "DeepSeek-V4-Flash",
            endpointId: "deepseek",
            modelName: "deepseek-v4-flash",
            description: "DeepSeek 经济高效模型",
            defaultParams: { thinking: { type: "disabled" } },
            maxContextChars: 500000,
          },
        ],
        defaultModel: "deepseek-v4-flash",
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

  it("ai hook 不带参数时输出用法（stderr，退出码 1）", async () => {
    const aizDir = makeTestDir();
    const result = await runCli(["hook"], undefined, { AI_ZEN_DIR: aizDir });
    expect(result.stderr).toContain("用法");
    expect(result.exitCode).toBe(1);
  });
});

describe("E2E: 纯 stdio 模式", () => {
  it("无输入时退出码非 0，且提示只出现在 stderr", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir);
    const result = await runCli([], "", { AI_ZEN_DIR: aizDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("没有输入内容");
    expect(result.stdout).toBe("");
  });

  it("未配置 API Key 时退出码非 0，stdout 为空", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: "" });
    const result = await runCli(["你好"], undefined, { AI_ZEN_DIR: aizDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("API Key");
    expect(result.stdout).toBe("");
  });

  it("模型/网络报错时 stdout 保持纯净（无 ANSI），错误只走 stderr", async () => {
    const aizDir = makeTestDir();
    // 指向一个不可达地址，请求快速失败（不依赖外网）
    setupConfigDir(aizDir, { baseUrl: "http://127.0.0.1:9/v1" });
    const result = await runCli(["你好"], undefined, { AI_ZEN_DIR: aizDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("stdin 被重定向时也能触发 stdio 模式（无参数）", async () => {
    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { baseUrl: "http://127.0.0.1:9/v1" });
    const result = await runCli([], "这是来自管道的内容\n", { AI_ZEN_DIR: aizDir });
    // 无参数 + 管道 → stdio（不会进入 TUI）；这里以请求失败收尾，关键是 stdout 纯净
    expect(result.stdout).not.toMatch(ANSI_RE);
    expect(result.stdout).toBe("");
  });
});

describe("E2E: 真实 API 对话（纯 stdio）", () => {
  it("ai <消息> 结果写入 stdout、无 ANSI、退出码 0", async (ctx) => {
    if (!API_KEY) ctx.skip();

    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: API_KEY });

    const result = await runCli(["用一句话介绍你自己"], undefined, { AI_ZEN_DIR: aizDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(ANSI_RE);
    // 无 TUI 装饰：不应出现 ✅ 横幅 / emoji 前缀
    expect(result.stdout).not.toContain("对话已开始");
    // 默认不落盘（纯 stdio 模式不写会话、不更新「上一轮会话 id」指针）
    expect(existsSync(join(aizDir, "cli", "last-session.json"))).toBe(false);
  }, 60000);

  it("管道内容 + 指令（cat | ai '总结'）走 stdout", async (ctx) => {
    if (!API_KEY) ctx.skip();

    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: API_KEY });

    const result = await runCli(["用一句话总结"], "苹果是一种水果。\n", {
      AI_ZEN_DIR: aizDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(ANSI_RE);
  }, 60000);

  it("--save 时写对话存档", async (ctx) => {
    if (!API_KEY) ctx.skip();

    const aizDir = makeTestDir();
    setupConfigDir(aizDir, { apiKey: API_KEY });

    const result = await runCli(["--save", "说'好'就行"], undefined, { AI_ZEN_DIR: aizDir });
    expect(result.exitCode).toBe(0);

    // 断言至少有一个对话存档文件
    const convDir = join(aizDir, "cli", "conversations");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(convDir).length).toBeGreaterThan(0);
  }, 60000);
});
