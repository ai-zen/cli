/**
 * Agent 创建 — CLI 层
 *
 * 委托给 @ai-zen/agents-sdk 的 Scope。
 * CLI 层负责：组装路径、构建 Scope 单例、装配能力插件。
 */

import { existsSync } from "fs";
import { join } from "path";
import {
  Scope,
  allInOne,
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

// ==================== Scope 创建（单例）====================

/**
 * Scope 单例缓存的是 **Promise** 而非实例。
 *
 * 缓存实例时，`if (_scope) return _scope` 之后到赋值之间有一段 `await`（读配置、初始化），
 * 并发调用会一起穿透 → 建出两个 Scope（MCP 双连接、双份工具发现、双份子进程）。
 * 缓存 Promise 让并发调用共享同一次初始化。
 */
let _scopePromise: Promise<Scope> | null = null;

/** existsSync 的别名，用于数组 .filter() 场景 */
const exists = existsSync;

/**
 * Skill 目录列表（优先级从高到低）：
 *   1. 项目/.ai-zen/skills/
 *   2. 项目/.agents/skills/            ← 业界通用规范
 *   3. ~/.ai-zen/skills/
 *   4. ~/.agents/skills/               ← 业界通用规范
 *
 * 同时供 Scope 装配与交接服务（读取 `handoff` Skill 正文）使用，避免两处各算一遍。
 * 只返回**当前真实存在**的目录，不存在的不参与发现。
 */
export function listSkillDirs(): string[] {
  return [
    PROJECT_SKILLS_DIR,
    PROJECT_AGENTS_SKILLS_DIR,
    SKILLS_DIR,
    USER_AGENTS_SKILLS_DIR,
  ].filter(exists);
}

export async function getScope(): Promise<Scope> {
  if (!_scopePromise) {
    _scopePromise = createScopeOnce().catch((error) => {
      // 初始化失败不缓存：否则一次瞬时故障会让后续所有发送都拿到同一个已 reject 的 Promise
      _scopePromise = null;
      throw error;
    });
  }
  return _scopePromise;
}

async function createScopeOnce(): Promise<Scope> {
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

  // Skills 目录优先级（从高到低）：见 listSkillDirs()
  const skillsPaths = listSkillDirs();

  const scope = new Scope({
    config,
    agentsDir: AGENTS_DIR,
  }).use(
    ...allInOne({
      subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, SUB_AGENTS_DIR].filter(exists),
      skillsPaths,
      toolsPaths: [PROJECT_TOOLS_DIR, TOOLS_DIR].filter(exists),
      mcpPaths,
    }),
  );

  await scope.init();

  return scope;
}

/**
 * 重置 Scope 单例：释放当前 Scope（断开 MCP 连接等），下次 `getScope()` 按磁盘配置重建。
 *
 * 配置变更后（如 TUI 的 `/config` 改了端点凭据）必须调用：Scope 的 `config` 只在创建时
 * 读取一次，不重建则新配置不生效。`_scope` 是同步置空的，便于并发调用方立刻拿到新实例。
 */
export async function resetScope(): Promise<void> {
  // 同步置空，便于并发调用方立刻拿到新实例；若初始化仍在进行，等它落地后再释放
  const pending = _scopePromise;
  _scopePromise = null;
  if (!pending) return;
  try {
    const scope = await pending;
    await scope.dispose();
  } catch {
    /* 释放失败不影响后续重建 */
  }
}

// ==================== Agent 创建 ====================

export interface CreateAgentOptions {
  messages?: AgentNS.Message[];
  agentId?: string;
}

export async function createAgent(options: CreateAgentOptions): Promise<SdkAgent> {
  const { messages, agentId } = options;
  const scope = await getScope();

  // 始终从磁盘读取 Agent 定义（含 permissions、工具配置等）
  //
  // 中断策略（`abortedMessageStrategy` / `abortedToolRoundStrategy`）**故意不传**：
  // SDK 的 `createAgent()` 在不传时取 `scope.config`（即 `config.json`），于是配置中心
  // 改完 `/reload` 一下就是新策略。在这里写死值会盖掉用户的选择。
  const agent = await sdkCreateAgent(scope, agentId || "default");

  // 有历史消息时替换（恢复草稿/已保存对话）。
  // 拷贝而非直接引用：恢复的数组来自草稿/对话存档，直接引用会让后续 append 改写传入数组。
  if (messages && messages.length > 0) {
    agent.messages = [...messages];
  }

  return agent;
}
