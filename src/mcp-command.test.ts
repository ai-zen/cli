import { describe, it, expect } from "vitest";
import type { McpConfig, McpServerEntry } from "./config.js";
import { parseMcpScope, pickStartScope } from "./mcp-command.js";

const entry = (name: string): McpServerEntry => ({ command: "npx", args: ["-y", name] });
const mcpOf = (...names: string[]): McpConfig => ({
  mcpServers: Object.fromEntries(names.map((name) => [name, entry(name)])),
});

describe("parseMcpScope：/mcp 的作用域参数", () => {
  it("接受 global / project（大小写与首尾空白不敏感）", () => {
    expect(parseMcpScope("global")).toBe("global");
    expect(parseMcpScope("Project")).toBe("project");
    expect(parseMcpScope("  GLOBAL ")).toBe("global");
  });

  it("接受单字母缩写（不与其他键冲突）", () => {
    expect(parseMcpScope("g")).toBe("global");
    expect(parseMcpScope("p")).toBe("project");
  });

  it("无参数与非法值都返回 null（调用方据此区分「没给」和「给错了」）", () => {
    expect(parseMcpScope(undefined)).toBeNull();
    expect(parseMcpScope("")).toBeNull();
    expect(parseMcpScope("   ")).toBeNull();
    expect(parseMcpScope("local")).toBeNull();
  });
});

describe("pickStartScope：无参数时进哪个作用域", () => {
  it("项目级有服务器就进项目级", () => {
    expect(pickStartScope({ global: mcpOf("a", "b"), project: mcpOf("c") })).toBe("project");
  });

  it("项目级为空时进全局（否则用户只会看到一个空列表）", () => {
    expect(pickStartScope({ global: mcpOf("a"), project: mcpOf() })).toBe("global");
  });

  it("两边都空时进全局：新建的落到共享位置，下次启动也还在", () => {
    expect(pickStartScope({ global: mcpOf(), project: mcpOf() })).toBe("global");
  });
});
