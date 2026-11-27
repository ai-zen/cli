/**
 * 配置面的词汇表：形状全部来自 SDK（`@ai-zen/agents-sdk` 的 `types/index.ts`），一处不抄。
 *
 * 配置归宿主所有。读写都走 procedure：读 `api.config.get.query()` 一次给全（`AppConfig` + 档位表），
 * 写各归各的门 —— `config.defaults.update` / `config.update` / `config.endpoints.*` /
 * `config.models.*` / `config.imageModels.*` / `config.presets.update`，AgentDefinition 走
 * `api.config.agents.*`，MCP 走 `api.mcp.*`。本进程既不持有第二份真相，也不在本地拼一份「整个配置」
 * 再整体写回；每个写口都回整份 `AppConfig`，界面拿到的是改完之后那一份，不必自己把补丁叠到手里的快照
 * 上。于是这个文件只剩一件事：把界面要用的那几个形状与契约里那两个常量说清楚。形状不在这里定义，客户
 * 端也不能再抄一份 —— 抄出来的第二份迟早与宿主存下来的那份对不上。
 *
 * 数据根的布局由宿主定义（`HostPaths`，`agents/packages/host/src/config.ts`），本进程不推导：客户端
 * 与服务端可能不是同一台机器，算出来的第二份答案会在两机部署时安静地错。要看某一层现在有什么，问
 * `api.config.mcp.list`（每条带 `scope`）。数据根在哪也不在配置里 —— `config.get` 回来的 `AppConfig`
 * 没有这一格，它是本进程自己的事实：`CliEnv.aiZenDir`（`--ai-zen-dir` / `AI_ZEN_DIR`）。
 *
 * 唯一例外是 `logs/cli/`：那一格归 CLI 自己写，三个文件都由本进程自己拼 —— `cli.log` 走
 * `cli-log.ts` 的 `cliLogFile(dataRoot)`，拉起宿主那一回的 `launch.log` 走 `connection.ts` 的
 * `launchLogFile(env)`，按键诊断的 `keys.log` 走 `tui/key-debug.ts` 的 `keyDebugFile()`。它们都不经
 * 宿主，也就不存在两机部署时算错这个问题。
 */

import type {
  AgentDefinition,
  AppConfig,
  EndpointDefinition,
  ImageModelDefinition,
  McpServerDefinition,
  ModelDefinition,
  ReasoningPreset,
  ReasoningPresets,
  TokenThresholds,
} from "@ai-zen/agents-sdk";

export type {
  AgentDefinition,
  AppConfig,
  EndpointDefinition,
  ImageModelDefinition,
  McpServerDefinition,
  ModelDefinition,
  ReasoningPreset,
  ReasoningPresets,
  TokenThresholds,
};

/** `api.config.get.query()` 的全部出参：配置加档位表，一次给全，中间不夹第二次读 */
export interface ConfigSnapshot {
  config: AppConfig;
  presets: ReasoningPresets;
}

// ==================== MCP 的五层 ====================

/**
 * MCP 配置的五层（宿主 `McpConfig` 的 `McpScope`，`mcp.list` 每条都带着它）。
 *
 * 每条写在哪一层是宿主回答的事实，客户端不按目录反推：两个 `.agents/mcp.json`、项目里与其他工具共用的
 * `.mcp.json`、数据根那份 `mcp.json`，谁是近层只有它知道。
 */
export type McpScope = "workspace" | "workspaceAiZen" | "workspaceAgents" | "user" | "userAgents";

/**
 * CLI 界面上那两层：五层里可写的只有这两个（宿主 `McpConfig` 的 `WRITABLE`）。
 *
 * 另外三层要么在别人的仓库里、要么在别的工具的目录里：替人写那种文件等于替人改他仓库里的内容，所以宿主
 * 对它们的写口一律 `unsupported`。界面因此也只给这两层，「切作用域」只在它们之间切。
 */
export type McpEditableScope = "user" | "workspace";

/**
 * 界面上的那一层换成契约里的那一层。
 *
 * `workspace` 在契约里是只读的项目根 `.mcp.json`（别的工具也读它）；宿主能写的项目层是
 * `.ai-zen/mcp.json`，契约定名为 `workspaceAiZen`。界面上的「工作区」指的就是后者 —— 用户要的是写进
 * 这个项目的配置，不是写进那个谁都能改的文件。
 *
 * 映射只有这一处：往外的每一格（`mcp.list` 的筛选、`mcp.save` / `mcp.remove` 的入参）都读它。
 */
export const MCP_SCOPE_OF: Record<McpEditableScope, McpScope> = {
  user: "user",
  workspace: "workspaceAiZen",
};

export interface McpEntry {
  scope: McpScope;
  server: McpServerDefinition;
}
