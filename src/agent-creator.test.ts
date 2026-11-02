import { describe, it, expect, afterEach, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 说明：本套件不使用 `vi.mock`。
 *
 * 在部分环境（如 vite 8 + vitest 4）下 `vi.mock` 的模块拦截会静默失效，
 * 导致被测模块读到真实用户配置、测试结果依赖机器状态。这里改用
 * 「临时 AI_ZEN_DIR + 动态 import」的方式，测试更贴近真实且完全隔离。
 */

const dir = mkdtempSync(join(tmpdir(), "aizen-agent-creator-"));
/** 本套件依赖的配置：每个用例前重写一次，不依赖「模块加载时写的那一份」 */
function writeConfig(): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify(
      {
        endpoints: [],
        // 对「出厂模型清单」做托管同步：未标 `custom: true` 的模型会被出厂定义替换。
        // 这里标 `custom: true` 才能让自定义模型原样保留（本用例只验证 Scope 携带的配置与目录）。
        models: [{ id: "gpt4", name: "GPT-4", endpointId: "openai", tokenThresholds: { handoff: 1000, guard: 1500 }, custom: true }],
        version: 4,
      },
      null,
      2,
    ),
  );
}
writeConfig();

// 必须在加载 config.ts 之前设置：AI_ZEN_DIR 在模块加载时读取
process.env.AI_ZEN_DIR = dir;

const { getScope, resetScope, createAgent } = await import("./agent-creator.js");
const { refreshPaths, ensureConfigDir } = await import("./config.js");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getScope", () => {
  // 进程内共享模块时其他文件会改写 AI_ZEN_DIR：每个用例前钉回本文件的目录并重算路径
  beforeEach(async () => {
    process.env.AI_ZEN_DIR = dir;
    // 配置文件由用例自己保证：no-isolate 下模块只加载一次，别指望「加载时写的那一份」还在
    writeConfig();
    refreshPaths();
    // 显式把目录初始化落到本用例的临时根上（`initPromise` 是进程级缓存，
    // 别的文件可能已经按自己的目录初始化过了）
    await ensureConfigDir();
    // `resetScope` 是异步的（等旧实例 dispose 完才释放）——不 await 会与下一个用例的
    // `getScope()` 抢同一个 `_scopePromise`，表现为偶尔读到上一轮的空配置。
    await resetScope();
  });
  afterEach(() => resetScope());

  it("返回 Scope 单例", async () => {
    const s1 = await getScope();
    const s2 = await getScope();
    expect(s1).toBe(s2);
  });

  it("resetScope 后重新创建", async () => {
    const s1 = await getScope();
    // 必须 await：`resetScope()` 会等旧实例 dispose 完，不 await 就会和下一个用例交叉
    await resetScope();
    const s2 = await getScope();
    expect(s1).not.toBe(s2);
  });

  it("Scope 携带配置与 agents 目录", async () => {
    const scope = await getScope();
    expect(scope.config.models.map((m) => m.id)).toContain("gpt4");
    expect(scope.agentsDir).toBe(join(dir, "agents"));
  });
});

describe("createAgent", () => {
  afterEach(() => resetScope());

  it("Agent 定义不存在时抛出错误", async () => {
    await expect(createAgent({ agentId: "does-not-exist" })).rejects.toThrow();
  });
});
