/**
 * 配置面（ConfigPort）—— 配置中心、`/model`、`/agent`、`/think`、`/mcp` 与启动预检
 * 共用的那一个口子。
 *
 * ## 为什么要有这一层
 *
 * 这些动作以前在 TUI 里直接调 `readConfig` / `saveConfig` / `readAgentStore` 这些函数，
 * 而它们全是**本地磁盘**操作。两端在同一台机器时看不出问题；客户端搬到另一台机器上，
 * 「我在笔记本上改的配置」和「服务端 Agent 实际用的配置」就是两份互不相干的事实 ——
 * 界面上显示成功，跑起来还是旧模型（错得很安静）。
 *
 * 所以把「配置面」收成一个接口，两个实现：
 *
 *   · `createRemoteConfigPort()` —— 走服务端的 `config.*` / `agent.*`，落盘发生在服务端。
 *
 * 曾经还有一个 `createLocalConfigPort()`（包一层本地函数给进程内模式用）。会话执行搬到
 * 服务端之后进程内模式没有了，它也就没有调用方 —— 一起删掉，需要时看 git 历史。
 *
 * 签名刻意与本地函数**逐字对齐**（`readConfig` 之类），这样调用点只换注入值，
 * 不换写法：`deps.config.readConfig()` 在两种模式下是同一种读法。
 *
 * ## MCP 的「项目作用域」为什么不传路径
 *
 * 项目级 `mcp.json` 在 `<工作区>/.ai-zen/` 下，而「当前工作区」是**服务端**的事实。
 * 远程实现不带路径地 `workspace.resolve()`（服务端用它自己的目录），与会话开在哪里
 * 是同一个答案 —— 客户端再抄一份路径过去，就又多了一份会漂的真相。
 */

import {
  AGENT_ADMIN_METHODS,
  AGENT_METHODS,
  CONFIG_METHODS,
  WORKSPACE_METHODS,
  type AgentListResult,
  type AgentRemoveParams,
  type AgentSaveParams,
  type ConfigGetResult,
  type ConfigMcpGetResult,
  type ConfigMcpSaveParams,
  type ConfigReasoningPresetsResult,
  type ConfigSaveParams,
  type WorkspaceResolveResult,
} from "@ai-zen/agents-server";
import type { AgentDefinition, AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { readAgentStore, type AgentKind, type AgentStore } from "../agents-store.js";
import {
  AI_ZEN_DIR,
  readConfig,
  readMcpConfig,
  readReasoningPresets,
  saveConfig,
  writeMcpConfig,
  type McpConfig,
  type McpReadResult,
  type McpScope,
} from "../config.js";
import { CLI_VERSION } from "../version.js";
import { ensureServer } from "./ensure-server.js";
import { clientWorkspacePath } from "./local-host.js";
import type { ClientInfo, ServerClient } from "./types.js";

export interface ConfigPort {
  /** 读全局配置（服务端侧读到即迁移；旧字段不会漏出来） */
  readConfig(): Promise<AppConfig>;
  /** 整份写回全局配置 */
  saveConfig(config: AppConfig): Promise<void>;
  /** 读思考策略表（文件缺失/损坏时回落出厂种子） */
  readReasoningPresets(): Promise<ReasoningPresets>;
  /** 读某个作用域的 MCP 配置；坏文件是「可展示的状态」而不是抛错 */
  readMcpConfig(scope?: McpScope): Promise<McpReadResult>;
  /** 写某个作用域的 MCP 配置 */
  writeMcpConfig(config: McpConfig, scope?: McpScope): Promise<void>;
  /** Agent / 子 Agent 定义的全量快照（配置中心的列表与 Agent 切换用） */
  readAgentStore(): Promise<AgentStore>;
  /**
   * 换模型：写 `AgentDefinition.modelId` 并清空思考参数。
   *
   * 为什么是专门一个方法而不是「读定义 → 改字段 → 写回」：思考参数是**模型相关**的
   * （GLM-5.3 不接受 `thinking.disabled` 这类），这条规则只该有一份实现。
   * 服务端 `agent.model.set` 就是那条实现，客户端不必自己再做一次。
   */
  setModel(agentId: string, modelId: string): Promise<void>;
}

// ==================================================================
// 客户端模式（唯一的实现：配置的真相源在服务端）
// ==================================================================

export interface RemoteConfigPortDeps {
  /** 注入连接（测试用）；不给则首次调用时自动 ensureServer + 连接 */
  client?: ServerClient;
  /** 注入「拿连接」的函数（可选，二者取一） */
  connect?: () => Promise<ServerClient>;
  /**
   * 项目作用域的路径来源（缺省：按 loopback 判据取客户端 cwd，见 `local-host.ts`）。
   *
   * 之所以可注入：「当前目录」在测试里是进程级全局（会往真实工作区写文件），
   * 而它与连接无关。注入一个函数比在用例里 `chdir` 干净，也不会串到别的用例。
   */
  workspacePath?: () => string | undefined;
}

/**
 * 客户端模式：所有配置读写都发生在**服务端**。
 *
 * ## 为什么是懒连接
 *
 * 配置面是**应用级**的，它可能在会话建立之前就要用：启动时的凭据预检（「有没有可用
 * 的端点 / 模型」）走的就是这里，而那一刻用户还没开任何会话。所以不能在构造时就把连接
 * 建起来（`createRemoteConfigPort()` 甚至可能在整个进程里一次都没被调用到），而是第一次
 * 真正要读配置时才建；建好之后缓存复用，一条连接服务后续所有读写。
 *
 * 连接死了（服务端重启、网络断）不必再来问一次：下次调用发现它已关闭就重建一条
 * —— 这正是「TUI 常驻、服务端可以随时重启」那个使用形态。
 *
 * ## 为什么工作区 id 也在这层解析
 *
 * 项目级 `mcp.json` 在 `<工作区>/.ai-zen/` 下，而「当前工作区」要用与开会话**同一套判据**
 * （见 `local-host.ts`）：本地就把客户端 cwd 递上去（这样项目级 mcp 改的确实是这个项目的
 * 那份文件），远端不说（客户端把本机目录递给远端服务端，等于替它决定会话跑在哪）。
 * 两处各自判断一次就会出现「会话在 A 项目、mcp 配置读的是别处」。接口里刻意没有
 * workspaceId 参数：那是服务端的返回，不是客户端的入参。
 *
 * ## 错误不包装
 *
 * 服务端回的错误帧带着机器可判别的 code（`bad-params` / `unknown-workspace` / `unknown-model`
 * …），客户端这一层原样往上抛：包一层自己的错误类型，界面就只能显示一句「读取失败」，
 * 而那串 code 正是排查与提示的依据。
 */
export function createRemoteConfigPort(deps: RemoteConfigPortDeps = {}): ConfigPort {
  /** 缓存的连接：`null` = 还没建过（或上次建失败） */
  let cached: ServerClient | null = null;
  /** 正在建的那条连接：并发调用只建一条，不是每人一条 */
  let pendingConnect: Promise<ServerClient> | null = null;
  /**
   * 项目作用域要的 `workspaceId`（promise 而不是值：并发调用只问服务端一次）。
   * 换连接时作废 —— 新连接可能是另一个服务端，它的工作区不一定还是同一个。
   */
  let cachedWorkspaceId: Promise<string> | null = null;

  /** 拿连接：注入的优先，其次自己建；建好缓存，关了重建 */
  const connection = async (): Promise<ServerClient> => {
    /**
     * 注入的连接由调用方负责生命周期：它在测试里指向测试 Daemon，我们变不出第二条，
     * 所以即便它已经关了也照原样交出去 —— 让 `call()` 如实报「连接已关闭」，
     * 而不是在这里凭空换一条来路不明的连接。
     */
    if (deps.client) return deps.client;

    if (cached && !isClosed(cached)) return cached;
    if (!pendingConnect) {
      const connect = deps.connect ?? connectToDefaultServer;
      pendingConnect = connect().then(
        (client) => {
          cached = client;
          pendingConnect = null;
          // 换了一条连接 = 可能换了服务端：工作区 id 不能再沿用旧的
          cachedWorkspaceId = null;
          return client;
        },
        (error: unknown) => {
          // 建连失败不缓存：下次调用重试（否则一次瞬时故障会让进程永久失能）
          pendingConnect = null;
          throw error;
        },
      );
    }
    return await pendingConnect;
  };

  const resolveWorkspacePath = (client: ServerClient): string | undefined =>
    deps.workspacePath ? deps.workspacePath() : clientWorkspacePath(client.address.host);

  /**
   * 项目作用域的 `workspaceId`：问服务端「这个目录对应哪个工作区」。
   *
   * 路径按与开会话**同一套判据**给（{@link clientWorkspacePath}）：本地递客户端 cwd、
   * 远端不递。分成两套判断就会出现「会话在 A 项目、项目级 mcp.json 读的却是别处」——
   * 用户改完那屏以为生效了，实际改到了与本会话无关的文件里。
   *
   * 缓存它是因为同一个进程的 cwd 不变（换连接时由 `connection()` 作废）。
   */
  const projectWorkspaceId = async (client: ServerClient): Promise<string> => {
    if (!cachedWorkspaceId) {
      const path = resolveWorkspacePath(client);
      cachedWorkspaceId = client
        .call<WorkspaceResolveResult>(WORKSPACE_METHODS.resolve, path ? { path } : {})
        .then((resolved) => resolved.workspaceId)
        .catch((error: unknown) => {
          // 问不到就别记着：一次瞬时故障不该让这个进程永久以为「没有工作区」
          cachedWorkspaceId = null;
          throw error;
        });
    }
    return await cachedWorkspaceId;
  };

  /** 每个方法都重新 `connection()`：连接换了一条时，这里自然用上新的那条 */
  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    const client = await connection();
    return await client.call<T>(method, params);
  };

  return {
    readConfig: async () => {
      const result = await call<ConfigGetResult>(CONFIG_METHODS.get);
      // 协议层刻意不解释 `config` 的形状（线上契约不认识 SDK），到这一层才回收成 AppConfig
      return result.config as AppConfig;
    },

    saveConfig: async (config) => {
      const params: ConfigSaveParams = { config };
      await call(CONFIG_METHODS.save, params);
    },

    readReasoningPresets: async () => {
      const result = await call<ConfigReasoningPresetsResult>(CONFIG_METHODS.reasoningPresets);
      return result.presets as ReasoningPresets;
    },

    /**
     * 读 MCP 配置。
     *
     * 服务端 `config.mcp.get` 的 `{ok:false,error}` **就是**本地 `McpReadResult` 的那一半：
     * 坏文件是「可展示的状态」（编辑屏要显示坏在哪，且不能当成空配置覆盖掉），
     * 不是一次调用失败，所以这里原样返回、不抛错。
     */
    readMcpConfig: async (scope = "global") => {
      const client = await connection();
      const params = {
        scope,
        // project 作用域才需要工作区：global 就是配置根下那一个文件
        ...(scope === "project" ? { workspaceId: await projectWorkspaceId(client) } : {}),
      };
      const result = await client.call<ConfigMcpGetResult>(CONFIG_METHODS.mcpGet, params);
      return result as McpReadResult;
    },

    writeMcpConfig: async (config, scope = "global") => {
      const client = await connection();
      const params: ConfigMcpSaveParams = {
        scope,
        config,
        ...(scope === "project" ? { workspaceId: await projectWorkspaceId(client) } : {}),
      };
      await client.call(CONFIG_METHODS.mcpSave, params);
    },

    /**
     * Agent 定义快照 + 读写能力。
     *
     * 写/删刻意走 `call()` 而不是复用上面那次 `list` 拿到的连接：这两个动作可能在很久
     * 之后才发生（用户编辑完才点保存），那时连接可能已经重建过了。
     */
    readAgentStore: async () => {
      const listed = await call<AgentListResult>(AGENT_ADMIN_METHODS.list);
      return {
        agents: listed.agents as AgentDefinition[],
        subAgents: listed.subAgents as AgentDefinition[],
        save: async (kind: AgentKind, definition: AgentDefinition) => {
          const params: AgentSaveParams = { kind, definition };
          await call(AGENT_ADMIN_METHODS.save, params);
        },
        remove: async (kind: AgentKind, id: string) => {
          const params: AgentRemoveParams = { kind, id };
          await call(AGENT_ADMIN_METHODS.remove, params);
        },
      };
    },

    /**
     * 换模型：服务端 `agent.model.set`（写
     * `definition.modelId` 并清空思考参数），客户端不再自己做一遍 —— 否则「换模型即
     * 重置思考强度」就有了两份实现。
     */
    setModel: async (agentId, modelId) => {
      await call(AGENT_METHODS.setModel, { agentId, modelId });
    },
  };
}

/**
 * 默认的连接来源：有服务端就上，没有就拉起一个（见 `ensure-server.ts`）。
 *
 * `AI_ZEN_DIR` 在**调用时**读（ESM 活绑定）：配置根是组装根的事，本模块不缓存它。
 */
async function connectToDefaultServer(): Promise<ServerClient> {
  const { client } = await ensureServer({
    aiZenDir: AI_ZEN_DIR,
    clientInfo: CONFIG_PORT_CLIENT_INFO,
  });
  return client;
}

/**
 * 握手里的客户端身份。
 *
 * 与 `REMOTE_CLIENT_INFO`（TUI 那份）是同一个身份，但**不 import 它**：
 * `tui/` 是上层，传输层反过来依赖上层会绕出一个环（TUI 迟早要 import 本文件）。
 * 身份只进日志与握手回执、不参与鉴权，版本号仍以 `CLI_VERSION` 为唯一来源。
 */
const CONFIG_PORT_CLIENT_INFO: ClientInfo = { name: "@ai-zen/cli", version: CLI_VERSION };

/**
 * 连接是否已经死了。
 *
 * `ServerClient` 接口上没有存活标志（它只需要 `call` / `on` / `close`），但
 * `SocketServerClient` 在连接断开时会置内部的 `closed`。这里做一次**结构化探测**：
 * 探得到就用，探不到（将来换传输、或测试里的假 client）就当它活着 —— 探测不出来时
 * 正确的做法是照常调用，让真错误从 `call()` 里原样冒出来，而不是在这儿先造一个。
 */
function isClosed(client: ServerClient): boolean {
  return client.closed;
}
