---
title: MCP 支持
description: @ai-zen/cli 的 MCP 服务器配置、多级合并优先级、连接生命周期与 OAuth 现状。
outline: deep
---

# MCP 支持

CLI 通过 `@ai-zen/agents-sdk` 接入 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 服务器，并提供三个动态加载工具：`load_mcp`、`call_mcp_tool`、`read_mcp_resource`。连接生命周期（连接、指数退避重连、空闲超时）由 SDK 的 `McpConnectionManager` 全权管理。

## MCP 配置结构

MCP 服务器配置存放在 `mcp.json` 文件中，顶层字段统一采用业界标准的 `mcpServers`（CLI 的 `McpConfig` 顶层字段）。

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "xxx"
      }
    }
  }
}
```

服务器字段（CLI 通过配置菜单写入）：

- `type`：传输方式，`stdio` | `http` | `sse`。
- `stdio` 场景：`command`、`args`、`env`。
- `http`/`sse` 场景：`url`、`headers`。
- `disabled`：是否禁用（默认 `false`）。
- `description`：服务器描述（供 `load_mcp` 呈现给 LLM）。

> 底层 SDK 类型 `McpServerConfig` 使用 `transport` 表示传输方式，并在内部做归一化。CLI 自身读写全局 `mcp.json` 时以 `type` 字段存储（见 `src/config.ts` 的 `McpServersMap`）。README 中的示例使用 `transport`，与 CLI 源码字段略有出入，建议以源码为准。

## 配置文件与合并优先级

MCP 服务器配置会从多个来源**由高到低**合并，同名服务器以优先级更高者覆盖：

1. 项目共享 `./.mcp.json`
2. 项目个人 `./.ai-zen/mcp.json`
3. 项目规范 `./.agents/mcp.json`
4. 用户级 `~/.ai-zen/mcp.json`
5. 用户规范 `~/.agents/mcp.json`

> ⚠️ README 中的合并优先级描述（“项目 `.ai-zen/mcp.json` → 项目 `.mcp.json` → 用户级 `~/.ai-zen/mcp.json`”）与源码顺序**不一致**。以上顺序来自 `src/agent-creator.ts` 的 `getProvider()` 与 `src/config.ts` 的注释，源码为准。

## 动态加载工具

- **`load_mcp`**：连接 MCP 服务器并列出其工具/资源/提示（幂等，重复调用跳过重复连接）。服务器枚举由 `filteredMcps` 自动推导。
- **`call_mcp_tool`**：通过官方 `Client.callTool()` API 调用服务器上的工具。
- **`read_mcp_resource`**：读取服务器上的资源。

## OAuth（HTTP transport）— 暂不支持

MCP 的 OAuth 2.0 授权流程（`mcp.json` 中的 `oauth` 字段）在 SDK 类型中已定义，并预留了 `mcp-oauth/` 存储目录，但**尚未实现**。目前配置了 `oauth` 的 HTTP MCP 服务器会因缺少 token 而连接失败。

## 交互式管理

在主菜单 → **配置管理** → **管理 MCP 服务器** 中，可以：

- 查看所有 MCP 服务器（含传输方式、命令/URL）。
- 新增 MCP 服务器（stdio 或 HTTP/SSE）。
- 编辑/删除 MCP 服务器、重命名。

相关文件：`~/.ai-zen/mcp.json`（全局）与项目级 `./.mcp.json`、`./.ai-zen/mcp.json`、`./.agents/mcp.json`。
