import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 设置 AI_ZEN_DIR 为临时目录，隔离测试
const testDir = join(tmpdir(), `ai-zen-cli-config-${Date.now()}`);
process.env.AI_ZEN_DIR = testDir;

import { readMcpConfig, writeMcpConfig, readProjectMcpConfig, MCP_CONFIG_FILE, AGENTS_DIR, SUB_AGENTS_DIR } from "./config.js";

afterAll(async () => {
  try { await fs.rm(testDir, { recursive: true, force: true }); } catch {}
});

describe("readMcpConfig / writeMcpConfig", () => {
  it("文件不存在时返回空结构", async () => {
    try { await fs.rm(MCP_CONFIG_FILE); } catch {}
    const config = await readMcpConfig();
    expect(config).toEqual({ servers: {} });
  });

  it("写入后再读取内容一致", async () => {
    const config = {
      servers: {
        github: { transport: "stdio" as const, command: "gh" },
        slack: { transport: "http" as const, url: "https://slack.example.com" },
      },
    };
    await writeMcpConfig(config);
    const read = await readMcpConfig();
    expect(read).toEqual(config);
  });

  it("原子写入不损坏文件", async () => {
    const config = {
      servers: {
        test: { transport: "stdio" as const, command: "echo" },
      },
    };
    await writeMcpConfig(config);
    const read = await readMcpConfig();
    expect(read.servers.test.command).toBe("echo");
  });

  it("损坏的 JSON 返回空结构", async () => {
    await fs.writeFile(MCP_CONFIG_FILE, "{ bad json", "utf-8");
    const config = await readMcpConfig();
    expect(config).toEqual({ servers: {} });
  });
});

describe("readProjectMcpConfig", () => {
  it("项目文件不存在时返回空结构", async () => {
    const config = await readProjectMcpConfig();
    expect(config).toEqual({ servers: {} });
  });
});
