/**
 * 配置管理 — CLI 层
 *
 * 负责配置文件的路径管理和初始化。
 * 默认配置、Agent、SubAgent 全部委托给 @ai-zen/agents-sdk。
 *
 * 目录结构：
 *   ~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
 *   ├── config.json               ← 全局配置（端点、模型等，CLI/Desktop 共享）
 *   ├── agents/                   ← Agent 定义（共享）
 *   ├── sub-agents/               ← SubAgent 定义（共享）
 *   ├── skills/                   ← Skill 目录（共享）
 *   ├── tools/                    ← 用户工具（共享）
 *   ├── mcp.json                  ← MCP 配置（共享）
 *   ├── mcp-oauth/                ← MCP OAuth token（共享）
 *   └── cli/                      ← CLI 运行时数据
 *       ├── conversations/        ← 对话记录
 *       └── drafts/               ← 草稿
 *
 *   ~/.agents/                    ← 业界通用规范（如 Cursor、Windsurf、Cline）
 *   ├── skills/                   ← 用户级 Skill
 *   └── mcp.json                  ← 用户级 MCP 配置
 *
 *   项目/.agents/                 ← 业界通用规范（如 Cursor、Windsurf、Cline）
 *   ├── skills/                   ← 项目级 Skill
 *   └── mcp.json                  ← 项目级 MCP 配置
 *
 *   MCP 配置合并优先级（高 → 低）：
 *     1. 项目/.mcp.json
 *     2. 项目/.ai-zen/mcp.json
 *     3. 项目/.agents/mcp.json
 *     4. ~/.ai-zen/mcp.json
 *     5. ~/.agents/mcp.json
 *
 *   Skills 目录优先级（高 → 低）：
 *     1. 项目/.ai-zen/skills/
 *     2. 项目/.agents/skills/
 *     3. ~/.ai-zen/skills/
 *     4. ~/.agents/skills/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { ConfigManager as SdkConfigManager } from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";

// ==================== 根目录 ====================

export const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".ai-zen",
);

// ==================== CLI 运行时目录 ====================

export const CLI_DIR = join(AI_ZEN_DIR, "cli");
export const CONFIG_FILE = join(AI_ZEN_DIR, "config.json");
export const CONVERSATIONS_DIR = join(CLI_DIR, "conversations");
export const DRAFTS_DIR = join(CLI_DIR, "drafts");

// ==================== 共享目录 ====================

export const AGENTS_DIR = join(AI_ZEN_DIR, "agents");
export const SUB_AGENTS_DIR = join(AI_ZEN_DIR, "sub-agents");
export const SKILLS_DIR = join(AI_ZEN_DIR, "skills");
export const TOOLS_DIR = join(AI_ZEN_DIR, "tools");

// ==================== 项目级目录（基于 CWD）====================

export const PROJECT_SUB_AGENTS_DIR = join(process.cwd(), ".ai-zen", "sub-agents");
export const PROJECT_SKILLS_DIR = join(process.cwd(), ".ai-zen", "skills");
export const PROJECT_TOOLS_DIR = join(process.cwd(), ".ai-zen", "tools");

// ==================== 业界通用规范 ~/.agents/ 目录 ====================

const USER_AGENTS_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".agents",
);

export const USER_AGENTS_SKILLS_DIR = join(USER_AGENTS_DIR, "skills");
export const USER_AGENTS_MCP_CONFIG_FILE = join(USER_AGENTS_DIR, "mcp.json");

// ==================== 业界通用规范 项目/.agents/ 目录 ====================

export const PROJECT_AGENTS_DIR = join(process.cwd(), ".agents");
export const PROJECT_AGENTS_SKILLS_DIR = join(PROJECT_AGENTS_DIR, "skills");
export const PROJECT_AGENTS_MCP_CONFIG_FILE = join(PROJECT_AGENTS_DIR, "mcp.json");

// ==================== MCP 配置 ====================

export const MCP_CONFIG_FILE = join(AI_ZEN_DIR, "mcp.json");
export const PROJECT_MCP_CONFIG_FILE = join(process.cwd(), ".ai-zen", "mcp.json");
export const SHARED_MCP_CONFIG_FILE = join(process.cwd(), ".mcp.json");

// ==================== SDK ConfigManager ====================

const sdkConfigMgr = new SdkConfigManager(CONFIG_FILE);

// ==================== 目录初始化 ====================

/**
 * 确保配置目录和默认文件存在。
 *
 * 共享实体（Agent、SubAgent、Skill 目录等）委托给 SDK 的 ConfigManager.bootstrap()。
 * CLI 自身的运行时目录（conversations/、drafts/）由本函数额外创建。
 * SDK 的出厂默认配置会自动写入 config.json（如果不存在）。
 */
export function ensureConfigDir(): void {
  // SDK bootstrap：目录 + config.json + default Agent + default SubAgent
  sdkConfigMgr.bootstrap();

  // CLI 运行时目录
  const cliDirs = [CLI_DIR, CONVERSATIONS_DIR, DRAFTS_DIR];
  for (const dir of cliDirs) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); }
      catch { console.warn(chalk.yellow(`⚠️  无法创建目录: ${dir}`)); }
    }
  }
}

// ==================== 配置读写 ====================

export function readConfig(): AppConfig {
  ensureConfigDir();
  return sdkConfigMgr.read();
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  sdkConfigMgr.write(config);
}

// ==================== MCP 配置读写 ====================

export interface McpServersMap {
  [name: string]: {
    transport: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
}

export interface McpConfig {
  servers: McpServersMap;
}

/**
 * 读取全局 ~/.ai-zen/mcp.json，不存在时返回空结构。
 */
export function readMcpConfig(): McpConfig {
  if (!existsSync(MCP_CONFIG_FILE)) return { servers: {} };
  try {
    return JSON.parse(readFileSync(MCP_CONFIG_FILE, "utf-8"));
  } catch {
    return { servers: {} };
  }
}

/**
 * 原子写入全局 ~/.ai-zen/mcp.json。
 */
export function writeMcpConfig(mcpConfig: McpConfig): void {
  const tmp = MCP_CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(mcpConfig, null, 2), "utf-8");
  renameSync(tmp, MCP_CONFIG_FILE);
}

export function readProjectMcpConfig(): McpConfig {
  const path = PROJECT_MCP_CONFIG_FILE;
  if (!existsSync(path)) return { servers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { servers: {} };
  }
}
