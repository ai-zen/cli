/**
 * `mcp-helpers.ts` 的两件事：InboxEntry 那一行摘要、oauth 客户端密钥只印掩码。
 *
 * 这一版的密钥口径与端点同一条：`mcp.list` 给回来的是明文（宿主不再掩码），屏上只印
 * `maskSecret` 算出来的那一串。写回时带的是同一条里的原值 —— 「没改就不动」靠的是原样往返，
 * 不是省略（`McpServerDefinition` 没有 `extra` 那一格，写回时与磁盘上那一条的合并由宿主做）。
 */

import { describe, expect, it } from "vitest";

import type { McpServerDefinition } from "../../config.js";
import { setLocale } from "../../i18n/index.js";
import { mcpEntryHint, mcpOauthSecretHint, scopeLabel, otherScope } from "./mcp-helpers.js";

setLocale("zh");

/** 用例里的那串明文：只作为「不该整串出现在屏上」的那一串 */
const PLAINTEXT = "placeholder-oauth-secret-for-tests-only-9f3a";

/** 一条 http InboxEntry（带 oauth 密钥） */
function remoteServer(): McpServerDefinition {
  return {
    id: "remote",
    transport: "http",
    description: "远程",
    url: "https://api.example/mcp",
    headers: { Authorization: "Bearer t" },
    oauth: {
      authorizationUrl: "https://auth.example/a",
      tokenUrl: "https://auth.example/t",
      clientId: "client-1",
      scope: "mcp",
      clientSecret: PLAINTEXT,
    },
  };
}

describe("mcpOauthSecretHint", () => {
  it("配了密钥就印掩码，明文一个字符都不整串上屏", () => {
    const hint = mcpOauthSecretHint(remoteServer());
    expect(hint).toContain("pla…9f3a");
    expect(hint).not.toContain(PLAINTEXT);
  });

  it("没配就说没配", () => {
    const server = remoteServer();
    const { clientSecret: _drop, ...oauth } = server.oauth!;
    expect(mcpOauthSecretHint({ ...server, oauth })).toContain("未配置");
  });
});

describe("mcpEntryHint", () => {
  it("启用状态 · 传输方式与目标 · 描述（三段事实都在这一行里）", () => {
    expect(mcpEntryHint(remoteServer())).toBe("已启用 · http · https://api.example/mcp · 远程");
  });

  it("stdio 的条目带参数、停用的说停用", () => {
    const server: McpServerDefinition = {
      id: "pty",
      transport: "stdio",
      command: "npx",
      args: ["-y", "socket-pty"],
      disabled: true,
    };
    expect(mcpEntryHint(server)).toBe("已停用 · stdio · npx -y socket-pty");
  });
});

describe("作用域的显示名", () => {
  it("两个作用域各有一个名字，切换项指向另一个", () => {
    expect(scopeLabel("user")).toBe("用户");
    expect(scopeLabel("workspace")).toBe("工作区");
    expect(otherScope("user")).toBe("workspace");
    expect(otherScope("workspace")).toBe("user");
  });
});
