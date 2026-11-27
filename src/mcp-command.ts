/**
 * `/mcp` 的入口决策：纯逻辑，可单测。
 *
 * `/mcp` 不自己做一套 MCP 编辑界面（那样删除与新增迟早长歪成两套实现），只负责把用户送进配置中心里已有
 * 的 MCP 界面（`{ kind: "mcp", scope }`）：增、删、改、启停、作用域切换都在那一个屏里，每次改一条走一条
 * procedure（`api.config.mcp.update` / `api.config.mcp.delete`），回来的是整份服务器清单（每条带它写在
 * 哪一层）。
 *
 * 于是这里只剩两个真问题：参数怎么认，以及无参数时默认进哪个作用域。
 */

import {
  MCP_SCOPE_OF,
  type McpEditableScope,
  type McpEntry,
  type McpServerDefinition,
} from "./config.js";

/**
 * 解析 `/mcp` 的作用域参数（`/mcp user`、`/mcp workspace`，大小写不敏感，可缩写为 `u` / `w`）。
 *
 * 旧词还认，是因为旧版把这两层叫 `global` / `project`：词换了，指的是同一层 —— `global` 是用户级（数据
 * 根那份 `mcp.json`，全机共享），`project` 是项目级（项目里 `.ai-zen/mcp.json`，只对这个目录生效），两
 * 者的落点与旧版一一对应。旧肌肉记忆不该换来一句「未知作用域」：用户要的是那一层，不是那个词。
 *
 * 映射只发生在这里：下游（`mcpEntriesOf` / `openWizard` / `api.config.mcp.update`）看到的永远是规范化
 * 的 `user` / `workspace`，再由 `config.ts` 的 `MCP_SCOPE_OF` 换成契约里的层名（`user` /
 * `workspaceAiZen`）。`global` / `project` 不放出去。
 *
 * 返回 `null` 表示没有可用值：没给参数和给错了都返回 null，调用方靠 `args[0]` 是否存在区分这两种情况
 * （前者走默认判断，后者报错）。
 */
export function parseMcpScope(raw?: string): McpEditableScope | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "user" || value === "u") return "user";
  if (value === "workspace" || value === "w") return "workspace";
  // 旧词（见上）：global 指用户级、project 指项目级
  if (value === "global") return "user";
  if (value === "project") return "workspace";
  return null;
}

/**
 * 某一层里有哪些服务器。
 *
 * `mcp.list` 每条都带着「它写在哪一层」（`scope`，宿主点名的事实），这里只按那一格筛：哪一层是 `user`、
 * 哪一层是项目可写的那个 `.ai-zen/mcp.json` 由 `MCP_SCOPE_OF` 说了算，客户端不按目录反推。写进别的层
 * 的实现不在这里露面 —— 它们不可写，宿主对它们的写口一律 `unsupported`。
 */
export function mcpEntriesOf(
  servers: readonly McpEntry[],
  scope: McpEditableScope,
): McpServerDefinition[] {
  const wireScope = MCP_SCOPE_OF[scope];
  return servers.filter((entry) => entry.scope === wireScope).map((entry) => entry.server);
}

/**
 * 无参数时挑一个入口作用域：
 *   - 项目层有服务器 → 进项目层（会话内临时加的 MCP 通常只对本项目生效，改它最常见）；
 *   - 否则进用户层（共享位置，多数人把 MCP 配在这里；项目层为空时进去只会看到空列表）。
 *
 * 两边都空时进用户层：新建的东西默认落在共享位置，比落在当前目录更容易被下一次启动用到。
 */
export function pickStartScope(servers: readonly McpEntry[]): McpEditableScope {
  return mcpEntriesOf(servers, "workspace").length > 0 ? "workspace" : "user";
}
