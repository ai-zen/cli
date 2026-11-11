/**
 * 目录**布局**与 MCP 配置的**词汇表** —— 客户端侧只剩这两类。
 *
 * ## 为什么这里不做读写
 *
 * 读配置、写配置、初始化配置目录（`~/.ai-zen` 下的 `config.json` / 默认 Agent / 策略表）
 * 全是**服务端**的事：真相在那边，读写经 `ConfigPort`（`@ai-zen/agents-client`）
 * 走 `config.*` / `agent.*`。本进程不提供任何本地缺省值：一个「忘了注入就读本机」的兜底
 * 是最坏的一种 —— 静默读客户端本机、写却写到服务端，界面上一切正常。
 *
 * ## 本进程的**事实**已经不在这里了
 *
 * 配置根（`AI_ZEN_DIR`）、显式服务端地址、显式凭证这三样是**事实**而不是**布局**：它们要么
 * 全都有答案、要么全都没有，并且「谁在哪一刻定下它们」必须有一个人负责。那份职责已经收到
 * `env.ts`（值 + 唯一解析点 + 唯一写点），由 `app.ts` 的 `CliApp` 在启动时钉下。
 *
 * 这个文件因此只剩**词汇表**加一处纯整形（`mcpConfigOrEmpty`）。
 *
 * 以前这里还有一份 `projectDirs(cwd)`：客户端按**自己的** cwd 推项目级路径。它已经删除 ——
 * 没有调用方了，而且「项目目录在哪」现在只由服务端回答（`workspace.resolve` 之后随快照回来，
 * 或者 `ConfigPort` 直接给路径）。留着它就是一份会漂的第二答案，而且是**会被抄**的那种。
 *
 * 目录结构：
 *   ~/.ai-zen/                    ← 共享根（`CliEnv.aiZenDir`）
 *   ├── config.json               ← 全局配置（端点、模型等，CLI/Desktop 共享）
 *   ├── agents/                   ← Agent 定义（共享）
 *   ├── sub-agents/               ← SubAgent 定义（共享）
 *   ├── skills/                   ← Skill 目录（共享）
 *   ├── tools/                    ← 用户工具（共享）
 *   ├── mcp.json                  ← MCP 配置（共享）
 *   ├── mcp-oauth/                ← MCP OAuth token（共享）
 *   └── cli/                      ← CLI 本地运行时数据
 *       ├── preferences.json      ← 界面语言等偏好（不值钱的东西）
 *       └── logs/sdk.log          ← SDK 日志（`sdk-log.ts`）
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
