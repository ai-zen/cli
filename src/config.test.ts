import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import * as config from "./config.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";

// ==================== 路径隔离方式 ====================
//
// 不再用 `vi.resetModules()` + 动态 import：重置模块注册表会连带影响同一进程里
// 其他测试文件已经持有的模块实例（进程内共享模块时尤其严重）。
// `useTempAiZenDir()` 在设好 `AI_ZEN_DIR` 后调 `refreshPaths()`，导入方靠 ESM 活绑定
// 自动读到新路径，收尾时把 env 一并还原。

const zen = useTempAiZenDir("ai-zen-cli-config-");
const testDir = zen.dir;

beforeAll(() => {
  zen.pin();
});

afterAll(() => {
  zen.cleanup();
});

describe("readMcpConfig / writeMcpConfig", () => {
  it("文件不存在时返回空结构", async () => {
    try {
      await fs.rm(config.MCP_CONFIG_FILE);
    } catch {
      // 文件可能不存在，忽略
    }
    const result = await config.readMcpConfig();
    expect(result).toEqual({ ok: true, config: { mcpServers: {} } });
  });

  it("写入后再读取内容一致", async () => {
    const mcpConfig = {
      mcpServers: {
        github: { type: "stdio" as const, command: "gh" },
        slack: { type: "http" as const, url: "https://slack.example.com" },
      },
    };
    await config.writeMcpConfig(mcpConfig);
    const read = await config.readMcpConfig();
    expect(read).toEqual({ ok: true, config: mcpConfig });
  });

  it("原子写入不损坏文件", async () => {
    const mcpConfig = {
      mcpServers: {
        test: { type: "stdio" as const, command: "echo" },
      },
    };
    await config.writeMcpConfig(mcpConfig);
    const read = await config.readMcpConfig();
    expect(read.ok && read.config.mcpServers.test!.command).toBe("echo");
  });

  it("损坏的 JSON 报告解析失败，不冒充「空配置」", async () => {
    await fs.writeFile(config.MCP_CONFIG_FILE, "{ bad json", "utf-8");
    const result = await config.readMcpConfig();
    expect(result.ok).toBe(false);
    // 错误原文要带上：编辑屏把它显示给用户，才知道这个文件坏在哪
    if (!result.ok) expect(result.error).toMatch(/JSON/i);
  });
});

describe("readProjectMcpConfig", () => {
  it("项目文件不存在时返回空结构", async () => {
    const result = await config.readProjectMcpConfig();
    expect(result).toEqual({ ok: true, config: { mcpServers: {} } });
  });
});

describe("MCP 作用域化读写", () => {
  it("mcpConfigPath 返回各作用域路径", () => {
    expect(config.mcpConfigPath("global")).toBe(config.MCP_CONFIG_FILE);
    expect(config.mcpConfigPath("project")).toBe(config.PROJECT_MCP_CONFIG_FILE);
  });

  it("按显式路径读写，且自动创建父目录", async () => {
    const path = join(testDir, "nested", "mcp.json");
    await config.writeMcpConfigAt(path, { mcpServers: { a: { type: "stdio", command: "x" } } });
    const read = await config.readMcpConfigAt(path);
    expect(read.ok && read.config.mcpServers.a!.command).toBe("x");
  });

  it("readMcpConfig(\"global\") 等价于默认作用域", async () => {
    await config.writeMcpConfig({ mcpServers: { g: { type: "http", url: "https://g" } } });
    expect(await config.readMcpConfig("global")).toEqual({
      ok: true,
      config: { mcpServers: { g: { type: "http", url: "https://g" } } },
    });
  });

  it("作用域化写入保留 disabled / description 等字段", async () => {
    await config.writeMcpConfig(
      { mcpServers: { s: { type: "stdio", disabled: true, description: "d" } } },
      "global",
    );
    const read = await config.readMcpConfig("global");
    expect(read.ok && read.config.mcpServers.s).toMatchObject({ disabled: true, description: "d" });
  });
});

describe("readConfig 顺带完成升级迁移", () => {
  it("老配置（有 defaultModel、Agent 无 modelId）→ 模型搬到 Agent 上，config 里字段清除", async () => {
    // 复刻升级现场：配置层有 defaultModel，Agent 定义还没绑定模型
    await fs.writeFile(
      join(testDir, "config.json"),
      JSON.stringify({ defaultModel: "deepseek-flash", endpoints: [], models: [] }, null, 2),
    );
    await fs.mkdir(join(testDir, "agents"), { recursive: true });
    await fs.writeFile(
      join(testDir, "agents", "default.json"),
      JSON.stringify(
        {
          id: "default",
          name: "默认助手",
          messages: [{ role: "system", content: "hi" }],
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    // 任何读到配置的入口都会触发 bootstrap —— 这是升级迁移的唯一时机。
    // 曾经 TUI 的「续接会话」路径绕过了它，导致升级后第一次启动直接报
    // 「Agent 未绑定模型」，所以这条链路必须有测试守着。
    await config.readConfig();

    const agent = JSON.parse(await fs.readFile(join(testDir, "agents", "default.json"), "utf-8"));
    expect(agent.modelId).toBe("deepseek-flash");

    const cfg = JSON.parse(await fs.readFile(join(testDir, "config.json"), "utf-8"));
    expect("defaultModel" in cfg).toBe(false);
  });
});
