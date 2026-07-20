import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  readConfig: vi.fn(() => ({
    defaultModel: "gpt4",
    endpoints: [],
    models: [],
    defaultAgent: "default",
    agents: [],
    subAgents: [],
    imageModels: [],
  })),
  AI_ZEN_DIR: "/mock/.ai-zen",
  CLI_DIR: "/mock/.ai-zen/cli",
  AGENTS_DIR: "/mock/.ai-zen/agents",
  SUB_AGENTS_DIR: "/mock/.ai-zen/sub-agents",
  SKILLS_DIR: "/mock/.ai-zen/skills",
  TOOLS_DIR: "/mock/.ai-zen/tools",
  CONVERSATIONS_DIR: "/mock/.ai-zen/cli/conversations",
  DRAFTS_DIR: "/mock/.ai-zen/cli/drafts",
  PROJECT_SUB_AGENTS_DIR: "/mock/project/.ai-zen/sub-agents",
  PROJECT_SKILLS_DIR: "/mock/project/.ai-zen/skills",
  PROJECT_TOOLS_DIR: "/mock/project/.ai-zen/tools",
  USER_AGENTS_SKILLS_DIR: "/mock/.agents/skills",
  USER_AGENTS_MCP_CONFIG_FILE: "/mock/.agents/mcp.json",
  PROJECT_AGENTS_DIR: "/mock/project/.agents",
  PROJECT_AGENTS_SKILLS_DIR: "/mock/project/.agents/skills",
  PROJECT_AGENTS_MCP_CONFIG_FILE: "/mock/project/.agents/mcp.json",
}));

import { getProvider, resetProvider, createAgent } from "./agent-creator.js";

describe("getProvider", () => {
  afterEach(() => {
    resetProvider();
  });

  it("返回 Provider 单例", () => {
    const p1 = getProvider();
    const p2 = getProvider();
    expect(p1).toBe(p2);
  });

  it("resetProvider 后重新创建", () => {
    const p1 = getProvider();
    resetProvider();
    const p2 = getProvider();
    expect(p1).not.toBe(p2);
  });

  it("Provider 包含配置信息", () => {
    const provider = getProvider();
    expect(provider.config.defaultModel).toBe("gpt4");
    expect(provider.agentsDir).toBe("/mock/.ai-zen/agents");
  });
});

describe("createAgent", () => {
  afterEach(() => {
    resetProvider();
  });

  it("磁盘文件不存在时抛出错误", () => {
    // createAgent 始终从磁盘读取 Agent 定义，mock 环境没有磁盘文件
    expect(() => createAgent({})).toThrow();
  });
});
