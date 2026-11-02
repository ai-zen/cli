import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Agent 定义迁移：旧版 `/think` 把档位名写在 `reasoningEffort` 上，
 * 现在档位在写入时就展开成参数（`modelParams`）。
 *
 * 通过把 `AI_ZEN_DIR` 钉到临时目录来驱动真实的读盘/写盘路径。
 */
import * as mod from "./agents-store.js";
import * as presetMod from "./reasoning-presets.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";

/** 临时根：`pin()` 把 env 与路径一起重算，`cleanup()` 收尾时连 env 一起还原 */
const zen = useTempAiZenDir("aiz-agent-mig-");
const dir = zen.dir;

const LEGACY_AGENT = {
  id: "default",
  name: "默认",
  messages: [{ role: "system", content: "hi" }],
  modelId: "glm-5.3",
  reasoningEffort: "high", // ← 旧字段
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const LEGACY_AGENT_NO_PRESET = {
  id: "plain",
  name: "Plain",
  messages: [{ role: "system", content: "hi" }],
  modelId: "glm-4.7-flash", // 没有策略
  reasoningEffort: "max",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const CONFIG = {
  defaultModel: "glm-5.3",
  endpoints: [{ id: "bigmodelcn", name: "智谱", baseUrl: "https://e/v1", apiKey: "k" }],
  models: [
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      endpointId: "bigmodelcn",
      tokenThresholds: { handoff: 1000, guard: 1500 },
      defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      reasoningPreset: "zhipu-5.3",
    },
    {
      id: "glm-4.7-flash",
      name: "GLM-4.7",
      endpointId: "bigmodelcn",
      tokenThresholds: { handoff: 1000, guard: 1500 },
    },
  ],
};

beforeEach(async () => {
  // 进程内共享模块：别的文件会改 `AI_ZEN_DIR`，每个用例前钉回本文件的临时根
  zen.pin();
  // 每例从空目录开始：上个用例写下的 Agent / config 不能漏进来
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(join(dir, "agents"), { recursive: true });
  await fs.writeFile(join(dir, "config.json"), JSON.stringify(CONFIG, null, 2), "utf-8");
});

afterAll(() => {
  zen.cleanup();
});

async function writeAgent(name: string, value: unknown): Promise<void> {
  await fs.writeFile(join(dir, "agents", `${name}.json`), JSON.stringify(value, null, 2), "utf-8");
}

async function readRaw(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(join(dir, "agents", `${name}.json`), "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("Agent 定义迁移：reasoningEffort → modelParams", () => {
  it("旧档位名被展开成参数，旧字段消失（并已写回磁盘）", async () => {
    await writeAgent("default", LEGACY_AGENT);
    const store = await mod.readAgentStore();
    const def = store.agents.find((a) => a.id === "default")!;

    expect(def).not.toHaveProperty("reasoningEffort");
    expect(def.modelParams).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });

    const onDisk = await readRaw("default");
    expect(onDisk).not.toHaveProperty("reasoningEffort");
    expect(onDisk.modelParams).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  });

  it("模型没有关联策略 → 只删旧字段，不瞎猜参数", async () => {
    await writeAgent("plain", LEGACY_AGENT_NO_PRESET);
    const store = await mod.readAgentStore();
    const def = store.agents.find((a) => a.id === "plain")!;

    expect(def).not.toHaveProperty("reasoningEffort");
    expect(def.modelParams).toBeUndefined();
    expect(await readRaw("plain")).not.toHaveProperty("reasoningEffort");
  });

  it("没有旧字段 → 不写盘、内容原样", async () => {
    const clean = { ...LEGACY_AGENT } as Record<string, unknown>;
    delete clean.reasoningEffort;
    await writeAgent("default", clean);
    const before = await fs.stat(join(dir, "agents", "default.json"));

    const store = await mod.readAgentStore();
    expect(store.agents[0]!.modelParams).toBeUndefined();
    const after = await fs.stat(join(dir, "agents", "default.json"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("迁移后的参数能被策略表反查回原档位（没有静默走样）", async () => {
    await writeAgent("default", LEGACY_AGENT);
    const store = await mod.readAgentStore();
    const def = store.agents.find((a) => a.id === "default")!;

    const presets = await (await import("./config.js")).readReasoningPresets();
    const preset = presetMod.presetFor("glm-5.3", "zhipu-5.3", presets);
    expect(presetMod.matchLevel(preset, def.modelParams)).toBe("high");
  });
});
