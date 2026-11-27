import { describe, it, expect } from "vitest";
import type { McpEntry, McpScope, McpServerDefinition } from "./config.js";
import { mcpEntriesOf, parseMcpScope, pickStartScope } from "./mcp-command.js";

/** 一条服务器（`mcp.list` 的一行里那半格） */
const serverOf = (id: string): McpServerDefinition => ({ id, transport: "stdio", command: "npx" });

/** `mcp.list` 的一行：这一条 + 它写在哪一层 */
const entryOf = (scope: McpScope, id: string): McpEntry => ({ scope, server: serverOf(id) });

/**
 * 宿主五层链的一个缩影：项目 `.mcp.json`(workspace) → 项目 `.ai-zen/mcp.json`(workspaceAiZen，
 * 宿主能写的那一层) → 项目 `.agents/mcp.json`(workspaceAgents) → 数据根 `mcp.json`(user) →
 * 家目录 `.agents/mcp.json`(userAgents)。
 *
 * 界面只有两个作用域，映射在 `config.ts` 的 `MCP_SCOPE_OF`：`workspace` → `workspaceAiZen`、
 * `user` → `user`。另外三层只读，界面不给（宿主对它们的写口一律 `unsupported`）。
 */
const fiveLayers = (projectEntries: string[], userEntries: string[]): McpEntry[] => [
  ...projectEntries.map((id) => entryOf("workspaceAiZen", id)),
  ...userEntries.map((id) => entryOf("user", id)),
  entryOf("workspace", "shared-by-other-tools"),
  entryOf("userAgents", "home-agents-layer"),
];

describe("parseMcpScope：/mcp 的作用域参数", () => {
  it("接受 user / workspace（大小写与首尾空白不敏感）", () => {
    expect(parseMcpScope("user")).toBe("user");
    expect(parseMcpScope("Workspace")).toBe("workspace");
    expect(parseMcpScope("  WORKSPACE ")).toBe("workspace");
  });

  it("接受单字母缩写（u / w，互不冲突）", () => {
    expect(parseMcpScope("u")).toBe("user");
    expect(parseMcpScope("w")).toBe("workspace");
  });

  it("旧词照旧认：global → user、project → workspace（词换了，指的是同一层）", () => {
    expect(parseMcpScope("global")).toBe("user");
    expect(parseMcpScope("Project")).toBe("workspace");
    expect(parseMcpScope("  GLOBAL ")).toBe("user");
  });

  it("无参数与非法值都返回 null（调用方据此区分「没给」和「给错了」）", () => {
    expect(parseMcpScope(undefined)).toBeNull();
    expect(parseMcpScope("")).toBeNull();
    expect(parseMcpScope("   ")).toBeNull();
    // 旧词接回来的是那两个词，不是旧缩写 g / p：多认一个字母就是多一处没人要的别名
    expect(parseMcpScope("g")).toBeNull();
    expect(parseMcpScope("nonsense")).toBeNull();
  });
});

describe("mcpEntriesOf：作用域 → 那一层的条目（`mcp.list` 的 scope 说了算）", () => {
  it("按每条自带的 scope 筛，与清单顺序无关", () => {
    const servers = fiveLayers(["a"], ["b"]);
    expect(mcpEntriesOf(servers, "workspace").map((server) => server.id)).toEqual(["a"]);
    expect(mcpEntriesOf(servers, "user").map((server) => server.id)).toEqual(["b"]);
  });

  it("不可写的三层不进界面（它们不在那两个作用域里）", () => {
    const servers = fiveLayers([], []);
    expect(mcpEntriesOf(servers, "workspace")).toEqual([]);
    expect(mcpEntriesOf(servers, "user")).toEqual([]);
    // 清单里确实有别的层：界面只是不给它们入口
    expect(servers.map((entry) => entry.scope)).toContain("workspace");
    expect(servers.map((entry) => entry.scope)).toContain("userAgents");
  });
});

describe("pickStartScope：无参数时进哪个作用域", () => {
  it("项目层有服务器就进项目层", () => {
    expect(pickStartScope(fiveLayers(["a"], ["b"]))).toBe("workspace");
  });

  it("项目层为空时进用户层（否则用户只会看到一个空列表）", () => {
    expect(pickStartScope(fiveLayers([], ["b"]))).toBe("user");
  });

  it("两边都空时进用户层：新建的落到共享位置，下次启动也还在", () => {
    expect(pickStartScope(fiveLayers([], []))).toBe("user");
  });

  it("只有别的层（不可写那些）有条目时也进用户层：那几层改不了", () => {
    expect(pickStartScope([entryOf("workspace", "shared"), entryOf("userAgents", "home")])).toBe(
      "user",
    );
  });
});
