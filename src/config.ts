/**
 * 配置**路径**与 MCP 配置的**纯类型** —— 客户端侧只剩这两样。
 *
 * ## 为什么这里不做读写
 *
 * 读配置、写配置、初始化配置目录（`~/.ai-zen` 下的 `config.json` / 默认 Agent / 策略表）
 * 全是**服务端**的事：真相在那边，读写经 `ConfigPort`（`@ai-zen/agents-client`）
 * 走 `config.*` / `agent.*`。本进程不提供任何本地缺省值：一个「忘了注入就读本机」的兜底
 * 是最坏的一种 —— 静默读客户端本机、写却写到服务端，界面上一切正常。
 *
 * 本文件剩下的东西只有三类：
 *   - 路径常量（`AI_ZEN_DIR` 等）与 `projectDirs()`：**本进程**的目录布局，给
 *     「SDK 日志落盘」「hook 安装」「临时目录隔离」这些真正本地的事情用；
 *   - **显式**服务端地址与凭证（`--server` / `AI_ZEN_SERVER_URL`、`AI_ZEN_SERVER_TOKEN`）：
 *     同样是「本进程的事实」，argv / env 只在**这一处**读（用法与优先级见「服务端地址与
 *     凭证」那一节）；它之后接什么由 `@ai-zen/agents-client` 的 `resolve-target.ts` 决定，
 *     本文件不重复实现那套判据；
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
 *   └── cli/                      ← CLI 本地运行时数据
 *       └── preferences.json      ← 界面语言等偏好（不值钱的东西）
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
// 地址形状的**唯一**定义处（四种 scheme、IPv6、缺省端口）—— 校验不在这里再写一份，
// 否则「启动时能过、连的时候报错」这种两边判据分叉的错必然出现
import { parseServerUrl } from "@ai-zen/agents-client";

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
 * 别的路径都不是模块级变量：项目级的在 `projectDirs(cwd)` 里（cwd 是入参），根下那些
 * （`config.json` / `agents/` / `mcp.json` …）根本不归本进程管 —— 它们经 `ConfigPort` 从
 * 服务端取。
 */
export let AI_ZEN_DIR = resolveRoot();

// ==================== 服务端地址与凭证 ====================

/**
 * 「连哪台服务端 + 拿什么进门」里**显式的那一半**（`--server` / `AI_ZEN_SERVER_URL`、
 * `AI_ZEN_SERVER_TOKEN`）。与 `AI_ZEN_DIR` 放在同一个文件，理由也一样：它们是**本进程的
 * 事实**，只该有一处给出答案。
 *
 * ## 这里只捞「显式」的两级
 *
 * 地址：`--server` > `AI_ZEN_SERVER_URL` > 没有；凭证：`AI_ZEN_SERVER_TOKEN` > 没有。
 * 「没有」之后接什么（发现文件 `run/server.json`、凭证文件 `run/token`）不是本文件的事 ——
 * 那是 `@ai-zen/agents-client` 的 `resolve-target.ts`，它才是「连哪儿 + 拿什么进门」的
 * 唯一解析点。这里只把 argv / env 里那两份显式值捞出来递给它，判据不重复实现。
 *
 * ## 为什么 `--server` 是「存进来」而不是「模块求值时读一次」
 *
 * argv 在模块求值**之后**才解析（`index.ts` 先 import 本模块，再 `resolveInvocation`），
 * 所以它没有 `AI_ZEN_DIR` 那种「模块顶层算一次」的可能，只能有一个明确的注入点。
 *
 * ## 为什么**没有** `--token`（只有 `AI_ZEN_SERVER_TOKEN`）
 *
 * 地址不是秘密（进 argv 无所谓），凭证是：`ps` 的输出与 shell 历史都会留下 argv。
 * 服务端拉起时同理（那边的注释也写着凭证不进命令行）—— 命令行里永远不给凭证留口子。
 */
let serverUrlFlag: string | undefined;

/**
 * 记下 argv 里的 `--server <url>`（启动早期由 `index.ts` 从 `mode.ts` 的解析结果传进来）。
 *
 * `undefined` = 这次没给 `--server`，地址退回 `AI_ZEN_SERVER_URL`。
 * 空串 = 「`--server` 给了但没给值」（`ai --server` 结尾），那是拼错的调用，**不**当成
 * 「没给」：交给 {@link serverUrlError} 说一句对症的话，而不是静默地连回本机。
 */
export function setServerUrlFlag(url: string | undefined): void {
  serverUrlFlag = url;
}

/** 显式地址：`--server` > `AI_ZEN_SERVER_URL` > 没有（没有 = 走发现文件） */
export function explicitServerUrl(): string | undefined {
  if (serverUrlFlag !== undefined) return serverUrlFlag;
  return nonBlank(process.env.AI_ZEN_SERVER_URL);
}

/**
 * 显式凭证：`AI_ZEN_SERVER_TOKEN`；没设就返回 `undefined`，让客户端回落到
 * `<aiZenDir>/run/token`。
 *
 * 「不传」与「传空串」的区别是实的：包里的 `resolveToken` 第一句就是「显式凭证非空才算」，
 * 空串会落到下一级（读文件）；而服务端对「长度为 0 的凭证」只会回 `unauthorized`。
 * 所以空白一律算「没设」，不把一格空格当成一把锁。
 */
export function explicitServerToken(): string | undefined {
  return nonBlank(process.env.AI_ZEN_SERVER_TOKEN);
}

/**
 * 显式地址的**早期校验**（D12）：不合法时返回一句人话，合法（或压根没给）返回 `null`。
 *
 * 为什么必须在启动早期判：地址拼错时，唯一能把它说清楚的地方是入口。让它飘到
 * `ensureServer` / `readServerStatus` 那一层，用户看到的会是「连不上 example.com:80」或者
 * 一条栈 —— 而真正的原因是他把 `wss://example.com/ai-zen` 敲成了 `wss:/example.com`。
 *
 * 判据用包里导出的 `parseServerUrl`（四种 scheme 的映射、IPv6 方括号、缺省端口都在那里），
 * 不在这里写第二份：两套判据分叉的症状是「启动时过了、连的时候报错」。
 *
 * @returns 一句带原值的人话（由入口写到 stderr）；没有问题返回 `null`
 */
export function serverUrlError(): string | null {
  const raw = explicitServerUrl();
  if (raw === undefined) return null;
  // `--server` 给了却没给值：先给一句对症的话（要用户去猜 `"" 不是合法的服务端地址` 太刻薄）
  if (raw.trim() === "") {
    return "--server 需要一个地址（例：--server wss://example.com/ai-zen）";
  }
  try {
    parseServerUrl(raw);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** 空白 = 没有（`AI_ZEN_SERVER_URL=""` 是「别用它」的常见写法，不是一条非法地址） */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

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
