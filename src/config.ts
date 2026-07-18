/**
 * 配置管理 — CLI 层
 *
 * 负责配置文件的路径管理和初始化。
 * 配置数据的读写委托给 @ai-zen/agents-sdk。
 *
 * 目录结构：
 *   ~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
 *   ├── cli/                      ← CLI 运行时数据
 *   │   ├── config.json           ← CLI 的端点、模型配置
 *   │   ├── conversations/        ← 对话记录
 *   │   └── drafts/               ← 草稿
 *   ├── agents/                   ← Agent 定义（共享）
 *   ├── sub-agents/               ← SubAgent 定义（共享）
 *   ├── skills/                   ← Skill 目录（共享）
 *   ├── tools/                    ← 用户工具（共享）
 *   ├── mcp.json                  ← MCP 配置（共享）
 *   └── mcp-oauth/                ← MCP OAuth token（共享）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import {
  readConfig as sdkReadConfig,
  writeConfig as sdkWriteConfig,
  ensureConfigDirs,
} from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";

// ==================== 根目录 ====================

export const AI_ZEN_DIR = process.env.AI_ZEN_DIR || join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".ai-zen",
);

// ==================== CLI 运行时目录 ====================

export const CLI_DIR = join(AI_ZEN_DIR, "cli");
export const CONFIG_FILE = join(CLI_DIR, "config.json");
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

// ==================== MCP 配置 ====================

export const MCP_CONFIG_FILE = join(AI_ZEN_DIR, "mcp.json");
export const PROJECT_MCP_CONFIG_FILE = join(process.cwd(), ".ai-zen", "mcp.json");
export const SHARED_MCP_CONFIG_FILE = join(process.cwd(), ".mcp.json");

// ==================== 默认配置文件 ====================

/** 默认配置（第一次使用时写入） */
const DEFAULT_CONFIG: AppConfig = {
  endpoints: [
    { id: "openai", name: "OpenAI", apiKey: "", baseUrl: "https://api.openai.com/v1", description: "OpenAI API 端点" },
    { id: "bigmodelcn", name: "BigModelCN (智谱AI)", apiKey: "", baseUrl: "https://open.bigmodel.cn/api/paas/v4", description: "智谱AI大模型端点" },
    { id: "deepseek", name: "DeepSeek", apiKey: "", baseUrl: "https://api.deepseek.com/v1", description: "DeepSeek API 端点" },
  ],
  models: [
    { id: "gpt-5.5", name: "GPT-5.5", endpointId: "openai", modelName: "gpt-5.5", maxContextTokens: 250000, defaultParams: {}, description: "OpenAI 最新旗舰模型，擅长编程与代码调试、在线研究、数据分析" },
    { id: "glm-5.1", name: "GLM-5.1", endpointId: "bigmodelcn", modelName: "glm-5.1", maxContextTokens: 250000, defaultParams: {}, description: "智谱AI 最新旗舰模型，支持8小时长程Agent任务" },
    { id: "glm-5v-turbo", name: "GLM-5V-Turbo", endpointId: "bigmodelcn", modelName: "glm-5v-turbo", maxContextTokens: 250000, defaultParams: {}, description: "智谱AI 多模态Coding基座" },
    { id: "glm-4.7-flash", name: "GLM-4.7-Flash", endpointId: "bigmodelcn", modelName: "glm-4.7-flash", maxContextTokens: 250000, defaultParams: {}, description: "智谱AI 免费轻量模型" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", endpointId: "deepseek", modelName: "deepseek-v4-pro", maxContextTokens: 250000, defaultParams: { thinking: { type: "disabled" } }, description: "DeepSeek 旗舰模型，Agentic Coding开源第一" },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", endpointId: "deepseek", modelName: "deepseek-v4-flash", maxContextTokens: 250000, defaultParams: { thinking: { type: "disabled" } }, description: "DeepSeek 经济高效模型" },
  ],
  imageModels: [
    { id: "cogview-4", name: "CogView-4", endpointId: "bigmodelcn", modelName: "cogview-4", defaultSize: "1024x1024" },
    { id: "glm-image", name: "GLM-Image", endpointId: "bigmodelcn", modelName: "glm-image", defaultSize: "1280x1280", defaultQuality: "hd" },
    { id: "cogview-3-flash", name: "CogView-3-Flash", endpointId: "bigmodelcn", modelName: "cogview-3-flash", defaultSize: "1024x1024" },
  ],
  defaultModel: "deepseek-v4-flash",
  defaultImageModel: "cogview-4",
  defaultAgent: "default",
  defaultMigrationModel: "deepseek-v4-flash",
};

const DEFAULT_AGENT_JSON = JSON.stringify(
  {
    id: "default",
    name: "默认助手",
    description: "默认的 AI 助手，适用于日常问答和任务执行。",
    messages: [{
      role: "system",
      content: "你是一个AI助手，专门帮助用户回答问题和执行任务。请用中文回复。",
    }],
    permissions: {
      tools: { allow: ["*"] },
      skills: { allow: ["*"] },
      mcps: { allow: ["*"] },
      subagents: { allow: ["*"] },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  null, 2,
);

const DEFAULT_SUBAGENT_JSON = JSON.stringify(
  {
    id: "general-assistant",
    name: "通用助手",
    description: "一个通用的子 Agent，擅长独立完成各类任务。",
    messages: [
      { role: "system", content: "你是一个通用助手，擅长独立完成各类任务。请根据给定的任务描述，认真分析并完成任务。完成任务后直接返回结果，不要解释你的思考过程。" },
      { role: "user", content: "{{query}}" },
    ],
    function: {
      name: "general_assistant",
      description: "通用助手，可独立完成各类任务",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "任务描述" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    tools: ["cwd", "readFile", "writeFile", "batchEdit", "mkdir", "rm",
      "glob", "ls", "exist", "exec", "findText", "downloadFile",
      "generateImage", "rename", "copy"],
  },
  null, 2,
);

// ==================== 目录初始化 ====================

/**
 * 确保配置目录和默认文件存在。
 *
 * 共享目录（agents/、sub-agents/、skills/、tools/、mcp-oauth/）
 * 由 SDK 的 ensureConfigDirs 在 AI_ZEN_DIR 下创建。
 * CLI 运行时目录（cli/config.json、cli/conversations/、cli/drafts/）
 * 由本函数额外创建。
 *
 * 每次运行都检查默认文件是否存在，不存在则写入（兼容升级场景）。
 */
export function ensureConfigDir(): void {
  // 共享目录（SDK 层）
  ensureConfigDirs(AI_ZEN_DIR);

  // CLI 运行时目录
  const cliDirs = [CLI_DIR, CONVERSATIONS_DIR, DRAFTS_DIR];
  for (const dir of cliDirs) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); }
      catch { console.warn(chalk.yellow(`⚠️  无法创建目录: ${dir}`)); }
    }
  }

  // 默认 config.json（含预置端点 + 模型）
  if (!existsSync(CONFIG_FILE)) {
    try {
      sdkWriteConfig(CONFIG_FILE, DEFAULT_CONFIG);
    } catch { console.warn(chalk.yellow(`⚠️  无法写入默认配置`)); }
  }

  // 默认 Agent
  const agentPath = join(AGENTS_DIR, "default.json");
  if (!existsSync(agentPath)) {
    try { writeFileSync(agentPath, DEFAULT_AGENT_JSON, "utf-8"); }
    catch { console.warn(chalk.yellow(`⚠️  无法写入默认 Agent`)); }
  }

  // 默认 SubAgent
  const subPath = join(SUB_AGENTS_DIR, "general-assistant.json");
  if (!existsSync(subPath)) {
    try { writeFileSync(subPath, DEFAULT_SUBAGENT_JSON, "utf-8"); }
    catch { console.warn(chalk.yellow(`⚠️  无法写入默认子 Agent`)); }
  }
}

// ==================== 配置读写 ====================

export function readConfig(): AppConfig {
  ensureConfigDir();
  return sdkReadConfig(CONFIG_FILE);
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  sdkWriteConfig(CONFIG_FILE, config);
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
