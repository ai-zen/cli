import { describe, it, expect, afterEach, afterAll } from "vitest";
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
mkdirSync(join(dir, "agents"), { recursive: true });
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify(
    {
      endpoints: [],
      // SDK alpha.1 起对「出厂模型清单」做托管同步：未标 `custom: true` 的模型会被
      // 出厂定义替换，悬空的 `defaultModel` 回退到出厂默认。这里必须标 `custom: true`，
      // 才能让 `defaultModel: "gpt4"` 原样保留（本用例只验证 Scope 是否携带配置与目录）。
      models: [{ id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextTokens: 1000, custom: true }],
      defaultModel: "gpt4",
      version: 4,
    },
    null,
    2,
  ),
);

// 必须在加载 config.ts 之前设置：AI_ZEN_DIR 在模块加载时读取
process.env.AI_ZEN_DIR = dir;

const { getScope, resetScope, createAgent } = await import("./agent-creator.js");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getScope", () => {
  afterEach(() => resetScope());

  it("返回 Scope 单例", async () => {
    const s1 = await getScope();
    const s2 = await getScope();
    expect(s1).toBe(s2);
  });

  it("resetScope 后重新创建", async () => {
    const s1 = await getScope();
    resetScope();
    const s2 = await getScope();
    expect(s1).not.toBe(s2);
  });

  it("Scope 携带配置与 agents 目录", async () => {
    const scope = await getScope();
    expect(scope.config.defaultModel).toBe("gpt4");
    expect(scope.agentsDir).toBe(join(dir, "agents"));
  });
});

describe("createAgent", () => {
  afterEach(() => resetScope());

  it("Agent 定义不存在时抛出错误", async () => {
    await expect(createAgent({ agentId: "does-not-exist" })).rejects.toThrow();
  });
});
