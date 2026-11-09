/**
 * 配置**路径**与 MCP 配置的**纯类型** —— 客户端侧只剩这两样。
 *
 * ## 为什么不再有读写
 *
 * 读配置、写配置、初始化配置目录（`~/.ai-zen` 下的 `config.json` / 默认 Agent / 策略表）
 * 全是**服务端**的事：真相在那边，读写经 `ConfigPort`（`server-client/config-port.ts`）
 * 走 `config.*` / `agent.*`。客户端本地那套实现（`readConfig` / `saveConfig` /
 * `readMcpConfig` / `writeMcpConfig` / `ensureConfigDir`）曾经还在，作为「忘了注入」时的
 * 缺省值 —— 那正是最坏的一种：静默读客户端本机、写却写到服务端，界面上一切正常。
 *
 * 本文件剩下的东西只有两类：
 *   - 路径常量（`AI_ZEN_DIR` 等）与 `projectDirs()`：**本进程**的目录布局，给
 *     「SDK 日志落盘」「hook 安装」「临时目录隔离」这些真正本地的事情用；
 *   - MCP 配置的类型（`McpScope` / `McpConfig` / `McpReadResult`）：与协议同形的词汇表，
 *     编辑屏与命令层拿它做数据整形（不吃盘）。
 *
 * 默认配置、Agent、SubAgent 的定义与出厂值全部委托给 @ai-zen/agents-sdk。
 *
 * 目录结构：
 *   ~/.ai-zen/                    ← 共享根（AI_ZEN_DIR）
 *   ├── config.json               ← 全局配置（端点、模型等，CLI/Desktop 共享）
 *   ├── agents/                   ← Agent 定义（共享）
 *   ├── sub-agents/               ← SubAgent 定义（共享）
 *   ├── skills/                   ← Skill 目录（共享）
 *   ├── tools/                    ← 用户工具（共享）
 *   ├── mcp.json                  ← MCP 配置（共享）
 *   ├── mcp-oauth/                ← MCP OAuth token（共享）
 *   └── cli/                      ← CLI 的旧存档位置（**只剩迁移用**：会话已搬到 workspaces/）
 *       ├── conversations/        ← （旧）对话记录，启动时搬进 workspaces/<id>/ 后删除
 *       └── last-session.json     ← （旧）按 cwd 分键的续接指针，同上
 *
 *   ~/.ai-zen/workspaces/<workspaceId>/   ← 会话真正的位置（CLI / 桌面端共享）
 *   ├── workspace.json            ← 该工作区对应的原始路径（哈希不可逆，得留凭据）
 *   ├── sessions/                 ← 对话记录（每个会话一个 JSON）
 *   └── last-session.json         ← 「本工作区上一轮会话」指针 *
 *   项目/.ai-zen/                 ← 项目级配置与产物
 *   ├── skills/                   ← 项目级 Skill
 *   ├── tools/                    ← 项目级工具
 *   ├── sub-agents/               ← 项目级子 Agent
 *   ├── mcp.json                  ← 项目级 MCP 配置
 *   └── handoffs/                 ← 交接文档（任务交接的落盘产物）
 *
 *   ~/.agents/                    ← 业界通用规范（如 Cursor、Windsurf、Cline）
 *   ├── skills/                   ← 用户级 Skill
 *   └── mcp.json                  ← 用户级 MCP 配置
 *
 *   项目/.agents/                 ← 业界通用规范（如 Cursor、Windsurf、Cline）
 *   ├── skills/                   ← 项目级 Skill
 *   └── mcp.json                  ← 项目级 MCP 配置
 *
 *   MCP 配置合并优先级（高 → 低）：
 *     1. 项目/.mcp.json
 *     2. 项目/.ai-zen/mcp.json
 *     3. 项目/.agents/mcp.json
 *     4. ~/.ai-zen/mcp.json
 *     5. ~/.agents/mcp.json
 *
 *   Skills 目录优先级（高 → 低）：
 *     1. 项目/.ai-zen/skills/
 *     2. 项目/.agents/skills/
 *     3. ~/.ai-zen/skills/
 *     4. ~/.agents/skills/
 */

import { promises as fs } from "fs";
import { dirname, join } from "path";
import { ConfigManager as SdkConfigManager, getLogger } from "@ai-zen/agents-sdk";
import type { AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { t } from "./i18n/index.js";

// ==================== 根目录 ====================

/**
 * 解析配置根目录：显式 `AI_ZEN_DIR` 优先，否则 `$HOME/.ai-zen`。
 *
 * 单独抽成函数是为了让 {@link refreshPaths} 能在测试用例之间重算。
 */
function resolveRoot(): string {
  return (
    process.env.AI_ZEN_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".ai-zen")
  );
}

/**
 * 全部路径都导出为 `let`：ESM 的 import 是**活绑定**，导入方每次取值都读到最新值
 * （实测：跨模块 import 的常量在 `refreshPaths()` 之后立刻是新目录），所以 `refreshPaths()`
 * 不需要召回任何引用点。
 *
 * **会失效的是快照**：在模块顶层把路径塞进常量或实例（`const POINTER_FILE = join(CLI_DIR, …)`、
 * `new Repo(CONVERSATIONS_DIR)`、`new ConfigManager(CONFIG_FILE)`）—— 那个值在模块求值那一刻就定死了。
 * 这类地方一律改成函数（`pointerFile()` / `configManager()`），
 * 由调用时机决定读哪个目录。
 */
export let AI_ZEN_DIR = resolveRoot();

// ==================== CLI 运行时目录 ====================

/**
 * CLI 自己的目录。会话已搬到服务端的 `workspaces/`，这里**只剩旧存档**的位置：
 * 老布局搬迁已在服务端的 `legacyMigration` 里做过（迁移源就指向它），之后就能删。
 */
export let CLI_DIR = join(AI_ZEN_DIR, "cli");
export let CONFIG_FILE = join(AI_ZEN_DIR, "config.json");

// ==================== 共享目录 ====================

export let AGENTS_DIR = join(AI_ZEN_DIR, "agents");
export let SUB_AGENTS_DIR = join(AI_ZEN_DIR, "sub-agents");

// ==================== 项目级目录（基于 CWD）====================

/**
 * 某个工作目录下的全部项目级路径。
 *
 * **为什么是函数不是常量**：这些路径全部挂在 `process.cwd()` 上，而常量只在**模块求值
 * 那一刻**算一次。于是进程内一旦换目录（测试换临时根、将来服务端一个进程服务多个
 * 工作区），常量就永远指向启动时的那个目录 —— 而且错得很安静：路径存在、读写不报错，
 * 只是全落到别的工作区里。
 *
 * 参数默认 `process.cwd()` 只出现在**这一处**（config.ts 是组装根），调用点可以显式传。
 */
export interface ProjectDirs {
  /** `<cwd>/.ai-zen` */
  root: string;
  subAgents: string;
  skills: string;
  tools: string;
  /**
   * 交接文档目录：`<cwd>/.ai-zen/handoffs/`。
   *
   * 交接文档是「人也能直接读」的产物，放在项目内便于随仓库共享/评审；
   * 目录由交接时的 write 工具或服务落盘时自动创建，无需预先建立。
   */
  handoffs: string;
  mcpConfig: string;
  /** `<cwd>/.agents`（业界通用规范） */
  agentsRoot: string;
  agentsSkills: string;
  agentsMcpConfig: string;
  /** `<cwd>/.mcp.json`（业界通用规范优先级最高的一层） */
  sharedMcpConfig: string;
}

export function projectDirs(cwd: string = process.cwd()): ProjectDirs {
  const root = join(cwd, ".ai-zen");
  const agentsRoot = join(cwd, ".agents");
  return {
    root,
    subAgents: join(root, "sub-agents"),
    skills: join(root, "skills"),
    tools: join(root, "tools"),
    handoffs: join(root, "handoffs"),
    mcpConfig: join(root, "mcp.json"),
    agentsRoot,
    agentsSkills: join(agentsRoot, "skills"),
    agentsMcpConfig: join(agentsRoot, "mcp.json"),
    sharedMcpConfig: join(cwd, ".mcp.json"),
  };
}

// ==================== MCP 配置 ====================

export let MCP_CONFIG_FILE = join(AI_ZEN_DIR, "mcp.json");

// ==================== 目录初始化 ====================

/**
 * 重新解析全部路径（**仅测试使用**）。
 *
 * 生产代码从不在运行期改 `AI_ZEN_DIR`，所以业务路径上不需要调用它。它存在只是因为
 * 测试会给每个用例换一个临时目录，而进程内共享模块（`vitest isolate: false`）时，
 * 模块顶层的路径常量只在首次加载时算过一次。
 *
 * 调用后：导入方靠活绑定自动看到新值（见文件顶部注释）；持有快照的模块由各自的
 * 工厂/重置负责 —— 测试侧统一走 `src/test-support/temp-dir.ts` 的 `useTempAiZenDir()`，
 * 它保证「设 env + 刷新路径 + 收尾还原」三件事一起做。
 */
export function refreshPaths(): void {
  AI_ZEN_DIR = resolveRoot();
  CLI_DIR = join(AI_ZEN_DIR, "cli");
  CONFIG_FILE = join(AI_ZEN_DIR, "config.json");
  AGENTS_DIR = join(AI_ZEN_DIR, "agents");
  SUB_AGENTS_DIR = join(AI_ZEN_DIR, "sub-agents");
  MCP_CONFIG_FILE = join(AI_ZEN_DIR, "mcp.json");
}

// ==================== MCP 配置读写 ====================

/** MCP 配置的作用域：全局（~/.ai-zen/mcp.json） / 项目（<cwd>/.ai-zen/mcp.json） */
export type McpScope = "global" | "project";

/**
 * 单个 MCP 服务器条目（业界标准字段，外加保留未知字段）。
 * 与 SDK `discoverMcpServers` 的解析一致：`type` 缺省时按 command/url 推断，`disabled: true` 会被跳过。
 */
export interface McpServerEntry {
  /** 传输方式，业界标准字段名 `type`（与 SDK normalizeConfig 一致，缺省按 command/url 推断） */
  type?: "stdio" | "http" | "sse";
  /** 是否禁用（true 时 SDK 会跳过该服务器） */
  disabled?: boolean;
  /** 描述（供 load_mcp 呈现给 LLM，非连接必需） */
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth 配置（本 CLI 暂不单独编辑，读写时原样保留） */
  oauth?: Record<string, unknown>;
  /** 其它未知字段原样保留，避免写回时丢字段（如 oauth 展开字段、厂商扩展） */
  [key: string]: unknown;
}

export interface McpServersMap {
  [name: string]: McpServerEntry;
}

export interface McpConfig {
  /** 业界标准 mcpServers 顶层字段（与 SDK @ai-zen/agents-sdk 保持一致） */
  mcpServers: McpServersMap;
}

/** 作用域对应的 mcp.json 路径 */
export function mcpConfigPath(scope: McpScope): string {
  return scope === "project" ? projectDirs().mcpConfig : MCP_CONFIG_FILE;
}

/**
 * 读一份 mcp.json 的结果 —— 与协议里的 `ConfigMcpGetResult` 同形。
 *
 * 「文件不存在」与「读取 / 解析失败」必须分开：前者是正常的空配置，后者是文件已损坏。
 * 以前两者都返回 `{ mcpServers: {} }`，于是损坏的文件在配置中心里看起来「没有服务器」，
 * 用户一保存就把原内容整个覆盖掉 —— 静默丢数据。
 *
 * `path` 是**那个文件在服务端的位置**（客户端只负责把它印在编辑屏上）：客户端的
 * `~/.ai-zen/mcp.json` 与服务端那份不是一个文件，两机部署时更可能根本不存在。
 */
export type McpReadResult =
  { ok: true; config: McpConfig; path: string } | { ok: false; error: string; path: string };

/** 读失败时按空配置继续（仅用于「读来只为做判断」的场景；界面上要显示损坏由编辑屏负责） */
export function mcpConfigOrEmpty(result: McpReadResult): McpConfig {
  return result.ok ? result.config : { mcpServers: {} };
}
