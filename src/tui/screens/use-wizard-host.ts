// 配置向导宿主 —— 「打开向导 / 读齐快照 / 关闭后让改动生效」的唯一实现
//
// 向导本身（`config-wizard/`）是独立状态机，而**宿主**的活儿（读齐快照、按当前状态决定关掉之后
// 要不要重启 / 重载会话）既不属于「会话」，也没法单测 —— 单独收在这里，从键盘一路打到向导关闭
// 才能碰到的路径才会有用例。
//
// 依赖方向是**注入**而非 import 会话：宿主要做的事（通知、重启、重载会话）都通过
// `WizardHostDeps` 传进来，于是 hook 可以在测试里用假依赖跑完整生命周期。
//
// 读快照只有三处 procedure（`api.config.get` / `api.config.agents.list` / `api.config.mcp.list`），
// 写全在向导屏里 —— 它拿的是**同一条** `api`，所以这里不必再有一份「保存」的接口。
import { useRef, useState } from "react";
import type { AppConfig, McpEntry, ReasoningPresets } from "../../config.js";
import { agentListOf, type AgentList } from "../../agents-store.js";
import { resolveCredential } from "../../config-editor.js";
import type { HostConnection } from "../../session/types.js";
import type { WizardCloseResult, WizardStep } from "../config-wizard/index.js";
import { t } from "../../i18n/index.js";
import type { Notice } from "./notice.js";

export interface WizardHostDeps {
  /** 调 procedure 的那一面（与向导屏拿的是同一个对象：读与写落在同一条连接上） */
  api: HostConnection["api"];
  /** 当前模型 id：`/key` 直达它所用端点的密钥 */
  modelId: string;
  /**
   * 这段会话属于哪个项目：`mcp.list` 要它才列得出服务器。
   *
   * 空串 = 还没有项目上下文（首启那一路在极端情况下会走到）。那时**不问** `mcp.list`
   * （宿主会回 `not_found`，而把它当成「配置读不出来」会把整个向导挡在门外），MCP 屏显示空
   * 清单；其它屏一样能用。
   */
  workspaceId: string;
  /** 通知出口（读写失败、变更摘要都从这里出去，不进转录） */
  notify: (text: string, tone?: Notice["tone"]) => void;
  /** 会话是否已建好（未建好时改配置只能重启） */
  hasSession: () => boolean;
  /** 会话还没建好 → 重启进程 */
  restart: () => void;
  /** 已经生效的改动 → 让会话重新读一遍它自己的事实（模型、档位、状态栏块） */
  reloadSession: () => void;
}

/** 向导在那块屏上要的全部事实；一次 `openWizard` 读齐，关闭时清空 */
export interface WizardHostState {
  wizardStep: WizardStep | null;
  /** `config.get` 的那份配置 */
  wizardConfig: AppConfig | null;
  /** 同一份出参里的档位表（模型上的 `reasoningPreset` 指它的键） */
  wizardPresets: ReasoningPresets | null;
  /** `agentDefinition.list` 的定义清单（+ 默认 AgentDefinition id，来自 `config.defaultAgent`） */
  wizardAgents: AgentList | null;
  /** `mcp.list` 的服务器清单（每条带 `scope`） */
  wizardServers: McpEntry[] | null;
  /**
   * 每个 AgentDefinition 上挂着几段会话（「删 AgentDefinition」那句代价里的数字）。
   *
   * `null` = 数不出来（读失败 / 还没读）：那时代价只说影响面，不给数字 —— 编一个数比不说更糟。
   */
  wizardSessionsByAgent: Record<string, number> | null;
  /**
   * 打开向导：先读齐快照再接管整屏（读失败则只报错、不进向导）。
   *
   * **回来的是它关闭时的事实**（`null` = 没打开 / 用户什么都没做成）：让命令层能写
   * `const r = await openWizard(...)`，与 `pick()` 同一个形状 —— 需要等价「打开、等它关掉、
   * 再按结果决定下一步」的动作（`/model` 切模型前的密钥检查）才写得成一句话。
   *
   * 里面那个 Promise 在前一个还没关闭时又开一次：前一个按「没结果」兑现，不把它永远挂着。
   */
  openWizard: (step: WizardStep) => Promise<WizardCloseResult | null>;
  /** `/key`：直达当前模型所用端点的 API Key 编辑步骤（与首启 / `/model` 共用同一个入口） */
  openKeyEditor: () => Promise<WizardCloseResult | null>;
  /** 向导关闭：渲染变更摘要，并按本地事实决定重启还是重载 */
  closeWizard: (result: WizardCloseResult) => void;
}

export function useWizardHost({
  api,
  modelId,
  workspaceId,
  notify,
  hasSession,
  restart,
  reloadSession,
}: WizardHostDeps): WizardHostState {
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  const [wizardConfig, setWizardConfig] = useState<AppConfig | null>(null);
  const [wizardPresets, setWizardPresets] = useState<ReasoningPresets | null>(null);
  const [wizardAgents, setWizardAgents] = useState<AgentList | null>(null);
  const [wizardServers, setWizardServers] = useState<McpEntry[] | null>(null);
  const [wizardSessionsByAgent, setWizardSessionsByAgent] = useState<Record<string, number> | null>(
    null,
  );
  /**
   * 正在等这块屏关闭的那个人（`openWizard` 的 Promise）。
   *
   * 向导是**整屏接管**的：命令层把「打开它」交出去之后，唯一能推进下一步的时刻是它关闭。
   * 所以兑现点只有一个（`closeWizard`）—— 与 `useChatOverlays` 的选择器同一个套路。
   */
  const wizardResolver = useRef<((result: WizardCloseResult | null) => void) | null>(null);

  /** 兑现（并清空）等这一次关闭的人；没有人在等就是空操作 */
  const settleWizard = (result: WizardCloseResult | null) => {
    const resolve = wizardResolver.current;
    wizardResolver.current = null;
    resolve?.(result);
  };

  /**
   * 读齐那三份快照（配置 + 档位表 / AgentDefinition / MCP 清单）。
   *
   * **串行**不并行：三条请求并发时任何一条抛错，报出来的都是同一个 catch，「哪一份读不出来」就
   * 没影了。三份全拿到才画得出整屏 —— 向导屏是一个整体（菜单上同时印端点、模型、MCP 两层、AgentDefinition 与默认项），
   * 少一份就只能渲染半块屏。
   *
   * `config.get` 一次给配置**和**档位表：它们是两个文件，但界面要同时看见（模型上那一格
   * `reasoningPreset` 指的是表里的键），分两次取的话中间可能夹进另一处改动。
   */
  const readSnapshots = async () => {
    const { config, presets } = await api.config.get.query();
    // 清单原样交给 `agentListOf`：wire 上的定义只剩字段，转换只有那一处（`toDefinition`）
    const definitions = await api.config.agents.list.query();
    const servers =
      workspaceId === "" ? [] : (await api.config.mcp.list.query({ workspaceId })).servers;
    return { config, presets, agents: agentListOf(definitions, config), servers };
  };

  /**
   * 每个 AgentDefinition 上挂着几段会话（`workspace.list` → 逐个 `session.list`）。
   *
   * 只有「删 AgentDefinition」那一处要这个数（PRD 3.4 要删之前说清影响面）。两条都是已有的读 procedure，
   * 客户端编排：宿主这一版的 `session.list` 只按工作区列（与 `/load --all` 同一条路）。
   *
   * 数不出来就往 `null` 走：代价那一句改成一句人话，**不编数字**。也不把这个失败报上去 ——
   * 它只是没有额外的事实可说，不是一次用户要处理的事。
   */
  const countSessionsByAgent = async (): Promise<Record<string, number> | null> => {
    try {
      const workspaces = await api.workspace.list.query();
      const perWorkspace = await Promise.all(
        workspaces.map((workspace) => api.session.list.query({ workspaceId: workspace.id })),
      );
      const counts: Record<string, number> = {};
      for (const session of perWorkspace.flat()) {
        counts[session.agentId] = (counts[session.agentId] ?? 0) + 1;
      }
      return counts;
    } catch {
      return null;
    }
  };

  /**
   * 把那几份快照上屏、把步骤机推到 `step`，并返回一个「它关闭时才兑现」的 Promise。
   *
   * 两条入口（`openWizard` / `openKeyEditor`）共用这一处：它们差的是「读齐快照之后定哪一步」，
   * 而「整屏接管 + 谁在等它关闭」因此只在这一处 —— 两份就会出现一条路兑现、另一条把 Promise 永远挂着。
   */
  const takeover = (
    step: WizardStep,
    snapshots: {
      config: AppConfig;
      presets: ReasoningPresets;
      agents: AgentList;
      servers: McpEntry[];
    },
    sessionsByAgent: Record<string, number> | null = null,
  ): Promise<WizardCloseResult | null> => {
    setWizardConfig(snapshots.config);
    setWizardPresets(snapshots.presets);
    setWizardAgents(snapshots.agents);
    setWizardServers(snapshots.servers);
    setWizardSessionsByAgent(sessionsByAgent);
    // 上一位还在等（几乎不可能：向导整屏接管时命令层发不出第二条命令）：按「没结果」兑现
    settleWizard(null);
    const closed = new Promise<WizardCloseResult | null>((resolve) => {
      wizardResolver.current = resolve;
    });
    setWizardStep(step);
    return closed;
  };

  const openWizard = async (step: WizardStep): Promise<WizardCloseResult | null> => {
    try {
      // 会话计数与三份快照并行：它只是给「删 AgentDefinition」多一格事实，不该把整屏拖慢一拍
      const [snapshots, sessionsByAgent] = await Promise.all([
        readSnapshots(),
        countSessionsByAgent(),
      ]);
      return await takeover(step, snapshots, sessionsByAgent);
    } catch (error) {
      notify(t("chat.configReadFailed", { error: messageOf(error) }), "error");
      return null;
    }
  };

  const openKeyEditor = async (): Promise<WizardCloseResult | null> => {
    try {
      const snapshots = await readSnapshots();
      const credential = resolveCredential(snapshots.config, modelId);
      if (!credential) {
        notify(t("chat.modelNoEndpoint", { id: modelId }), "error");
        return null;
      }
      return await takeover(
        { kind: "edit", field: "apiKey", endpointId: credential.endpointId },
        snapshots,
      );
    } catch (error) {
      notify(t("chat.configReadFailed", { error: messageOf(error) }), "error");
      return null;
    }
  };

  /**
   * 向导关闭：说清改了什么，再按本地事实让改动落到这一段会话上。
   *
   * 判据只有一个，来自 `WizardCloseResult.dirty`（写成功就算生效：宿主改完即用，回的就是新的
   * 那一份 `AppConfig`，没有「要不要重启才生效」那一格了）。于是「怎么让它生效」只剩本地那一问：
   *   · 会话还没建好 → 重启进程（草稿会话之前改的模型 / 端点，只有新的这一次挂载才用得上）；
   *   · 已经建好 → 让它重读自己的事实（模型 / 档位 / 状态栏块）。
   * 没有 `dirty` 就什么都不做：屏幕上那条摘要已经说完话了。
   */
  const closeWizard = (result: WizardCloseResult) => {
    setWizardStep(null);
    setWizardConfig(null);
    setWizardPresets(null);
    setWizardAgents(null);
    setWizardServers(null);
    setWizardSessionsByAgent(null);
    // 先兑现再让改动生效：等在 `await openWizard(...)` 那一侧的人（`/model` 的密钥检查）
    // 读到的是自己的结论，而不是一件可能把屏幕重挂载掉的事
    settleWizard(result);
    // 同一批摘要合成**一条**（多行）：既能全部显示，又只占通知队列的一个槽位。
    // 逐条 push 会挤掉更早的进度提示（队列只留最近 MAX_NOTICE_HISTORY 条）。
    const { summary } = result;
    if (summary.length === 1) {
      notify(t("chat.configUpdated", { line: summary[0]! }));
    } else if (summary.length > 1) {
      // 子项缩进 = 一个汉字宽度（两个半角空格），不加 `·` 之类的项目符号：
      // 通知正文本身就左对齐于行首，子项只需要一点层级差，符号是多余装饰。
      notify(
        t("chat.configUpdatedMulti", { lines: summary.map((line) => `  ${line}`).join("\n") }),
      );
    }
    if (!result.dirty) return;

    if (!hasSession()) {
      restart();
      return;
    }
    reloadSession();
  };

  return {
    wizardStep,
    wizardConfig,
    wizardPresets,
    wizardAgents,
    wizardServers,
    wizardSessionsByAgent,
    openWizard,
    openKeyEditor,
    closeWizard,
  };
}

/** 抛出值 → 一句人话（宿主给的 `message` 本来就能上屏，非 `Error` 的兜一下） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
