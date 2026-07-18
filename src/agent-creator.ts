/**
 * Agent 创建 — CLI 层
 *
 * 委托给 @ai-zen/agents-sdk 的 Provider + Capabilities。
 * CLI 层负责：组装路径、构建 Provider 单例、注册默认插件。
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  Provider,
  createAgent as sdkCreateAgent,
  SdkAgent,
  McpConnectionManager,
  buildMigrationAgentDefinition,
} from "@ai-zen/agents-sdk";
import type { McpServerConfig } from "@ai-zen/agents-sdk";
import type { AgentNS } from "@ai-zen/agents-core";
import {
  AGENTS_DIR, SUB_AGENTS_DIR, SKILLS_DIR, TOOLS_DIR,
  CONVERSATIONS_DIR, DRAFTS_DIR, AI_ZEN_DIR,
  PROJECT_SUB_AGENTS_DIR, PROJECT_SKILLS_DIR, PROJECT_TOOLS_DIR,
} from "./config.js";
import { readConfig } from "./config.js";

// ==================== Provider 创建（单例）====================

let _provider: Provider | null = null;
let _mcpManager: McpConnectionManager | null = null;

/** existsSync 的别名，用于数组 .filter() 场景 */
const exists = existsSync;

/**
 * 从 mcpPaths 中读取 mcp.json，构建 McpServerConfig Map。
 * 按优先级从高到低传入路径列表，同名 server 靠前的文件优先（先到先得）。
 */
function buildMcpConfigs(mcpPaths: string[]): Map<string, { name: string; config: McpServerConfig }> {
  const configs = new Map<string, { name: string; config: McpServerConfig }>();
  for (const mcpPath of mcpPaths) {
    if (!existsSync(mcpPath)) continue;
    try {
      const raw = readFileSync(mcpPath, "utf-8");
      const json = JSON.parse(raw);
      const servers = json.servers ?? {};
      for (const [name, cfg] of Object.entries(servers)) {
        const raw = cfg as Record<string, unknown>;
        if (!configs.has(name)) {
          configs.set(name, {
            name,
            config: {
              id: (raw.id as string) || name,
              name: (raw.name as string) || name,
              transport: (raw.transport as McpServerConfig["transport"]) || "stdio",
              enabled: raw.enabled !== false,
              command: raw.command as string,
              args: raw.args as string[],
              env: raw.env as Record<string, string>,
              url: raw.url as string,
              headers: raw.headers as Record<string, string>,
            },
          });
        }
      }
    } catch { /* 跳过解析失败 */ }
  }
  return configs;
}

export function getProvider(): Provider {
  if (_provider) return _provider;

  const config = readConfig();

  _mcpManager = new McpConnectionManager();

  const mcpPaths = [join(process.cwd(), ".mcp.json"), join(process.cwd(), ".ai-zen", "mcp.json"), join(AI_ZEN_DIR, "mcp.json")].filter(exists);
  const mcpConfigs = buildMcpConfigs(mcpPaths);

  _provider = new Provider({
    config,
    agentsDir: AGENTS_DIR,
    subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, SUB_AGENTS_DIR].filter(exists),
    skillsPaths: [PROJECT_SKILLS_DIR, SKILLS_DIR].filter(exists),
    toolsPaths: [PROJECT_TOOLS_DIR, TOOLS_DIR].filter(exists),
    mcpPaths,
    conversationsDir: CONVERSATIONS_DIR,
    draftsDir: DRAFTS_DIR,
    mcpManager: _mcpManager,
    mcpConfigs,
  });

  return _provider;
}

export function resetProvider(): void {
  if (_mcpManager) { _mcpManager.disconnectAll().catch(() => {}); }
  _provider = null; _mcpManager = null;
}

// ==================== Agent 创建 ====================

export interface CreateAgentOptions {
  messages?: AgentNS.Message[];
  agentId?: string;
}

export function createAgent(options: CreateAgentOptions): SdkAgent {
  const { messages, agentId } = options;
  const provider = getProvider();

  // 始终从磁盘读取 Agent 定义（含 permissions、工具配置等）
  const agent = sdkCreateAgent(provider, agentId || "default");

  // 有历史消息时替换（恢复草稿/已保存对话）
  if (messages && messages.length > 0) {
    agent.messages = messages;
  }

  return agent;
}

// ==================== 迁移 Agent ====================

export function createMigrationAgent(modelId: string): SdkAgent {
  const provider = getProvider();
  const model = provider.createModel(modelId);
  const definition = buildMigrationAgentDefinition({ modelId });

  return new SdkAgent({
    provider,
    definition: {
      ...definition,
      id: "__migration__",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    model,
    messages: definition.messages,
    tools: [],
  });
}
