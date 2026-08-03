import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ==================== 使用动态 import 隔离测试 ====================
//
// 注意！这里不能用静态 import 加载 ./config.js，因为 ESM 的 import 会被提升到文件顶部执行，
// 导致 process.env.AI_ZEN_DIR 在 config.ts 加载时尚未设置，AI_ZEN_DIR 会指向真实的 ~/.ai-zen，
// 测试中的文件操作（删除/覆写）会破坏用户真实文件！
//
// 解决方案：在 beforeAll 中先设置环境变量，清除模块缓存，再通过动态 import() 加载 config.ts。

const testDir = join(tmpdir(), `ai-zen-cli-config-${Date.now()}`);

type ConfigModule = typeof import("./config.js");
let config: ConfigModule;

beforeAll(async () => {
  // 1. 先设置环境变量
  process.env.AI_ZEN_DIR = testDir;

  // 2. 清除模块缓存，确保 config.ts 被重新加载
  vi.resetModules();

  // 3. 创建临时目录结构（writeMcpConfig 不会自动创建父目录）
  await fs.mkdir(testDir, { recursive: true });

  // 4. 动态 import 加载 config.ts（此时 AI_ZEN_DIR 已指向临时目录）
  config = await import("./config.js");
});

afterAll(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
});

describe("readMcpConfig / writeMcpConfig", () => {
  it("文件不存在时返回空结构", async () => {
    try {
      await fs.rm(config.MCP_CONFIG_FILE);
    } catch {
      // 文件可能不存在，忽略
    }
    const result = await config.readMcpConfig();
    expect(result).toEqual({ mcpServers: {} });
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
    expect(read).toEqual(mcpConfig);
  });

  it("原子写入不损坏文件", async () => {
    const mcpConfig = {
      mcpServers: {
        test: { type: "stdio" as const, command: "echo" },
      },
    };
    await config.writeMcpConfig(mcpConfig);
    const read = await config.readMcpConfig();
    expect(read.mcpServers.test.command).toBe("echo");
  });

  it("损坏的 JSON 返回空结构", async () => {
    await fs.writeFile(config.MCP_CONFIG_FILE, "{ bad json", "utf-8");
    const result = await config.readMcpConfig();
    expect(result).toEqual({ mcpServers: {} });
  });
});

describe("readProjectMcpConfig", () => {
  it("项目文件不存在时返回空结构", async () => {
    const result = await config.readProjectMcpConfig();
    expect(result).toEqual({ mcpServers: {} });
  });
});
