/**
 * 配置**路径**与 MCP 配置的**纯类型** —— 客户端侧只剩这两样。
 *
 * ## 为什么不再有读写
 *
 * 读配置、写配置、初始化配置目录（`~/.ai-zen` 下的 `config.json` / 默认 Agent / 策略表）
 * 全是**服务端**的事：真相在那边，读写经 `ConfigPort`（`@ai-zen/agents-client`）
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

import { join } from "path";

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
 * 配置根目录 —— 本进程**唯一**一个还活着的模块级路径。
 *
 * 为什么它是 `let` 而不是 `const`：ESM 的 import 是**活绑定**，导入方每次取值都读到最新值
 * （实测：跨模块 import 的变量在 `refreshPaths()` 之后立刻是新目录），所以 `refreshPaths()`
 * 不需要召回任何引用点。
 *
 * **会失效的是快照**：在模块顶层把路径塞进常量或实例（`const FILE = join(AI_ZEN_DIR, …)`、
 * `new ConfigManager(AI_ZEN_DIR)`）—— 那个值在模块求值那一刻就定死了。这类地方一律改成
 * 函数（`sdkLogFile()` / `configManager()`），由调用时机决定读哪个目录。
 *
 * 别的路径都不再是模块级变量：项目级的在 `projectDirs(cwd)` 里（cwd 是入参），根下那些
 * （`config.json` / `agents/` / `mcp.json` …）根本不归本进程管 —— 它们经 `ConfigPort` 从
 * 服务端取。曾经这里还有 `CLI_DIR` / `CONFIG_FILE` / `AGENTS_DIR` / `SUB_AGENTS_DIR` /
 * `MCP_CONFIG_FILE`，全是这两件事搬走之后没人读的空壳，已删。
 */
export let AI_ZEN_DIR = resolveRoot();

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
}

// ==================== MCP 配置的形状 ====================

/**
 * MCP 配置的**词汇表**已在 `@ai-zen/agents-client` 里（`mcp.ts`）—— 那是客户端唯一的
 * 一份：读写它的两端（服务端落盘、客户端整形）必须共用同一份字段表，抄两份迟早对不上。
 *
 * 仍然在这里转出类型，是因为 CLI 里 `import { McpConfig } from "./config.js"` 的写法
 * 铺得很开，而那些调用点关心的就是这份词汇表。（`mcp.json` 的**路径**不属于本进程：
 * 两机部署时客户端那台与服务端那台本来就不是同一个文件，路径随 `McpReadResult` 一起从
 * 服务端回来。）
 */
export type {
  McpConfig,
  McpReadResult,
  McpScope,
  McpServerEntry,
  McpServersMap,
} from "@ai-zen/agents-client";

// 只取两个形状进来用（空配置回落要拿它们做参数/返回类型）。
// 上面 block 只负责**转出**，不建立本地绑定。
import type { McpConfig, McpReadResult } from "@ai-zen/agents-client";

/** 读失败时按空配置继续（仅用于「读来只为做判断」的场景；界面上要显示损坏由编辑屏负责） */
export function mcpConfigOrEmpty(result: McpReadResult): McpConfig {
  return result.ok ? result.config : { mcpServers: {} };
}
