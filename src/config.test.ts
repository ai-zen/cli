import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 设置 AI_ZEN_DIR 为临时目录，隔离测试
const testDir = mkdtempSync(join(tmpdir(), "ai-zen-cli-config-"));
process.env.AI_ZEN_DIR = testDir;

import { readMcpConfig, writeMcpConfig, readProjectMcpConfig, MCP_CONFIG_FILE, AGENTS_DIR, SUB_AGENTS_DIR } from "./config.js";

describe("readMcpConfig / writeMcpConfig", () => {
  it("文件不存在时返回空结构", () => {
    try { rmSync(MCP_CONFIG_FILE); } catch {}
    const config = readMcpConfig();
    expect(config).toEqual({ servers: {} });
  });

  it("写入后再读取内容一致", () => {
    const config = {
      servers: {
        github: { transport: "stdio" as const, command: "gh" },
        slack: { transport: "http" as const, url: "https://slack.example.com" },
      },
    };
    writeMcpConfig(config);
    const read = readMcpConfig();
    expect(read).toEqual(config);
  });

  it("原子写入不损坏文件", () => {
    const config = {
      servers: {
        test: { transport: "stdio" as const, command: "echo" },
      },
    };
    writeMcpConfig(config);
    const read = readMcpConfig();
    expect(read.servers.test.command).toBe("echo");
  });

  it("损坏的 JSON 返回空结构", () => {
    writeFileSync(MCP_CONFIG_FILE, "{ bad json", "utf-8");
    const config = readMcpConfig();
    expect(config).toEqual({ servers: {} });
  });
});

describe("readProjectMcpConfig", () => {
  it("项目文件不存在时返回空结构", () => {
    const config = readProjectMcpConfig();
    expect(config).toEqual({ servers: {} });
  });
});
