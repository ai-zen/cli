/**
 * 配置面的**词汇表** —— 形状全部来自 SDK（`@ai-zen/agents-sdk` 的 `types/index.ts`），一处不抄。
 *
 * ## 谁拥有配置
 *
 * 宿主。读写都走 procedure：读 `api.config.get.query()` 一次给全（`AppConfig` + 档位表），
 * 写各归各的门 —— `config.defaults.update` / `config.update` / `config.endpoints.*` /
 * `config.models.*` / `config.imageModels.*` / `config.presets.update`，AgentDefinition 走
 * `api.config.agents.*`，MCP 走 `api.mcp.*`。本进程既不持有第二份真相，也不在本地拼一份
 * 「整个配置」再整体写回 —— 而且**每个写口都回整份 `AppConfig`**，界面拿到的是改完之后那一份，
 * 不必自己把补丁叠到手里那份快照上。
 *
 * 于是这个文件只剩一件事：把界面要用的那几个形状与**契约里那两个常量**说清楚。形状本身不在这里
 * 定义，客户端也不能自己再抄一份 —— 抄出来的第二份迟早与宿主存下来的那份对不上。
 *
 * ## 数据根布局（唯一真相：宿主的 `HostPaths`，`agents/packages/host/src/config.ts`）
 *
 *   <dataRoot>/                     ← `AI_ZEN_DIR`，缺省 `~/.ai-zen`
 *   ├── ai-zen.db                   ← 库：会话、消息、通知、问题都在这里（没有「每条会话一个文件」）
 *   ├── assets/                     ← 附件与上传上来的 Asset
 *   ├── config.json                 ← SDK 的配置（端点 / 模型 / 默认项 / 上限 / 行为开关）
 *   ├── reasoning-presets.json      ← 档位表（模型上的 `reasoningPreset` 指它的键）
 *   ├── host.json                   ← 宿主自己的设置（端口、实例对外与否…）
 *   ├── run/host.json               ← 这台机器上谁在服务（发现文件，客户端按它找宿主）
 *   ├── run/token                   ← 本地凭证交付文件
 *   ├── logs/                       ← 日志：一个进程一格目录，一格只归一个进程写
 *   │   ├── host/                   ← 宿主进程（服务端）：host.log（5MB × 5）
 *   │   ├── cli/                    ← CLI 进程：cli.log（2MB × 2）
 *   │   │                             launch.log（每次拉起清空）
 *   │   │                             keys.log（默认关）
 *   │   └── desktop/                ← 将来的桌面端（今天只占名字，不建目录）
 *   ├── agents/                     ← AgentDefinition（一实体一文件）
 *   ├── sub-agents/                 ← 子 Agent 定义
 *   ├── skills/  tools/             ← 用户级 Skill 与工具
 *   └── mcp.json                    ← 用户级 MCP（MCP 五层链里的一层）
 *
 *   <cwd>/.mcp.json                 ← 项目侧 MCP（五层链最靠前，只读）
 *   <cwd>/.ai-zen/mcp.json          ← 项目侧 MCP（唯一可写的项目层，写它时 scope = "workspaceAiZen"）
 *   <cwd>/.agents/mcp.json          ← 项目侧 MCP（其它工具约定，只读）
 *   <cwd>/.ai-zen/{skills,tools,sub-agents}/、<cwd>/.agents/{skills,tools,sub-agents}/
 *
 * 这些路径**不由本进程推导**：客户端与服务端可能不是同一台机器，算出来的第二份答案会在两机
 * 部署时安静地错。要看某一层现在有什么，问 `api.config.mcp.list`（每条带 `scope`）；要问数据根在哪，
 * 那不在配置里 —— `config.get` 回来的 `AppConfig` 没有这一格（旧版那个 `configDir` 已随旧契约
 * 退场）。数据根是本进程自己的事实：`CliEnv.aiZenDir`（`--ai-zen-dir` / `AI_ZEN_DIR`）。
 *
 * 唯一例外是 `logs/cli/`：那一格归 CLI 自己写，三个文件都由本进程自己拼 —— `cli.log` 走
 * `cli-log.ts` 的 `cliLogFile(dataRoot)`，拉起宿主那一回的 `launch.log` 走 `connection.ts` 的
 * `launchLogFile(env)`，按键诊断的 `keys.log` 走 `tui/key-debug.ts` 的 `keyDebugFile()`
 * （`dataRoot` 就是 `CliEnv.aiZenDir`）。它们都不经宿主，也就不存在「两机部署时算错」这个问题。
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

/** `api.config.get.query()` 的全部出参：配置 + 档位表（一次给全，中间不夹第二次读） */
export interface ConfigSnapshot {
  config: AppConfig;
  presets: ReasoningPresets;
}

// ==================== MCP 的五层 ====================

/**
 * MCP 配置的五层（宿主 `McpConfig` 的 `McpScope`，`mcp.list` 每条都带着它）。
 *
 * 「每条写在哪一层」是宿主回答的事实，客户端不按目录反推：两个 `.agents/mcp.json`、项目里
 * 与其他工具共用的 `.mcp.json`、数据根那份 `mcp.json`，谁是近层只有它知道。
 */
export type McpScope = "workspace" | "workspaceAiZen" | "workspaceAgents" | "user" | "userAgents";

/**
 * CLI 界面上那两层 —— 五层里**可写**的只有这两个（宿主 `McpConfig` 的 `WRITABLE`）。
 *
 * 另外三层要么在别人的仓库里、要么在别的工具的目录里：替人写那种文件等于替人改他仓库里的
 * 内容，所以宿主对它们的写口一律 `unsupported`。界面因此也只给这两层，「切作用域」只在它们
 * 之间切。
 */
export type McpEditableScope = "user" | "workspace";

/**
 * 界面上的那一层 → 契约里的那一层。
 *
 * `workspace` 在契约里是**只读**的项目根 `.mcp.json`（别的工具也读它）；宿主能写的项目层是
 * `.ai-zen/mcp.json`，契约定名为 `workspaceAiZen`。界面上的「工作区」指的就是后者 —— 用户要的
 * 是「写进这个项目的配置」，不是「写进那个谁都能改的文件」。
 *
 * **映射只有这一处**：往外的每一格（`mcp.list` 的筛选、`mcp.save` / `mcp.remove` 的入参）都读它。
 */
export const MCP_SCOPE_OF: Record<McpEditableScope, McpScope> = {
  user: "user",
  workspace: "workspaceAiZen",
};

/** `api.config.mcp.list.query()` 的一行：这一条 + 它写在哪一层 */
export interface McpEntry {
  scope: McpScope;
  server: McpServerDefinition;
}
