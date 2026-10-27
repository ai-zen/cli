/**
 * `/mcp` 的入口决策 —— 纯逻辑，可单测
 *
 * `/mcp` 不自己做一套 MCP 编辑界面（那样「删除」和「新增」迟早长歪成两套实现），
 * 只负责把用户送进配置中心里已有的 MCP 界面（`{ kind: "mcp", scope }`）：
 * 增、删、改、启用/禁用、作用域切换都在那一个屏里，改完由宿主统一
 * `session.reload()` 让新工具生效。
 *
 * 于是这里只剩一个真问题：**默认进哪个作用域**。
 */

import type { McpConfig, McpScope } from "./config.js";

/** MCP 两个作用域的配置快照 */
export interface McpSnapshotLike {
  global: McpConfig;
  project: McpConfig;
}

/**
 * 解析 `/mcp` 的作用域参数（`/mcp global`、`/mcp project`，大小写不敏感，可缩写为 `g` / `p`）。
 *
 * 返回 `null` 表示「没有可用值」——**没给参数**和**给错了**都返回 null，
 * 调用方靠 `args[0]` 是否存在区分这两种情况（前者走默认判断，后者报错）。
 */
export function parseMcpScope(raw?: string): McpScope | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "global" || value === "g") return "global";
  if (value === "project" || value === "p") return "project";
  return null;
}

/**
 * 无参数时挑一个入口作用域：
 *   - 项目级有服务器 → 进项目级（会话内临时加的 MCP 通常只对本项目生效，改它最常见）；
 *   - 否则进全局（共享位置，多数人把 MCP 配在这里；项目级为空时进去只会看到空列表）。
 *
 * 两边都空时进全局：新建的东西默认落在共享位置，比落在当前目录更容易被下一次启动用到。
 */
export function pickStartScope(mcp: McpSnapshotLike): McpScope {
  return Object.keys(mcp.project.mcpServers).length > 0 ? "project" : "global";
}
