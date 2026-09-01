/**
 * Agent 创建 — CLI 层
 *
 * 委托给 @ai-zen/agents-sdk 的 Provider。
 * CLI 层负责：组装路径、构建 Provider 单例、注册默认插件。
 */

import { existsSync } from "fs";
import { join } from "path";
import {
  Provider,
  createAgent as sdkCreateAgent,
  SdkAgent,
} from "@ai-zen/agents-sdk";
import type { AgentNS } from "@ai-zen/agents-core";
import {
  AGENTS_DIR, SUB_AGENTS_DIR, SKILLS_DIR, TOOLS_DIR,
  AI_ZEN_DIR,
  PROJECT_SUB_AGENTS_DIR, PROJECT_SKILLS_DIR, PROJECT_TOOLS_DIR,
  USER_AGENTS_SKILLS_DIR, USER_AGENTS_MCP_CONFIG_FILE,
  PROJECT_AGENTS_SKILLS_DIR, PROJECT_AGENTS_MCP_CONFIG_FILE,
} from "./config.js";
import { readConfig } from "./config.js";

// ==================== Provider 创建（单例）====================

let _provider: Provider | null = null;

/** existsSync 的别名，用于数组 .filter() 场景 */
const exists = existsSync;

export async function getProvider(): Promise<Provider> {
  if (_provider) return _provider;

  const config = await readConfig();

  // MCP 配置合并优先级（从高到低）：
  //   1. 项目/.mcp.json
  //   2. 项目/.ai-zen/mcp.json
  //   3. 项目/.agents/mcp.json           ← 业界通用规范
  //   4. ~/.ai-zen/mcp.json
  //   5. ~/.agents/mcp.json              ← 业界通用规范
  const mcpPaths = [
    join(process.cwd(), ".mcp.json"),
    join(process.cwd(), ".ai-zen", "mcp.json"),
    PROJECT_AGENTS_MCP_CONFIG_FILE,
    join(AI_ZEN_DIR, "mcp.json"),
    USER_AGENTS_MCP_CONFIG_FILE,
  ].filter(exists);

  // Skills 目录优先级（从高到低）：
  //   1. 项目/.ai-zen/skills/
  //   2. 项目/.agents/skills/            ← 业界通用规范
  //   3. ~/.ai-zen/skills/
  //   4. ~/.agents/skills/               ← 业界通用规范
  const skillsPaths = [
    PROJECT_SKILLS_DIR,
    PROJECT_AGENTS_SKILLS_DIR,
    SKILLS_DIR,
    USER_AGENTS_SKILLS_DIR,
  ].filter(exists);

  _provider = await Provider.create({
    config,
    agentsDir: AGENTS_DIR,
    subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, SUB_AGENTS_DIR].filter(exists),
    skillsPaths,
    toolsPaths: [PROJECT_TOOLS_DIR, TOOLS_DIR].filter(exists),
    mcpPaths,
  });

  return _provider;
}

export function resetProvider(): void {
  _provider = null;
}

// ==================== Agent 创建 ====================

export interface CreateAgentOptions {
  messages?: AgentNS.Message[];
  agentId?: string;
}

export async function createAgent(options: CreateAgentOptions): Promise<SdkAgent> {
  const { messages, agentId } = options;
  const provider = await getProvider();

  // 始终从磁盘读取 Agent 定义（含 permissions、工具配置等）
  const agent = await sdkCreateAgent(provider, agentId || "default");

  // 有历史消息时替换（恢复草稿/已保存对话）。
  // 拷贝而非直接引用：恢复的数组来自草稿/对话存档，直接引用会让后续 append 改写传入数组。
  if (messages && messages.length > 0) {
    agent.messages = [...messages];
  }

  return agent;
}
