// 配置向导引擎：本地快照 + 每次写都是一次 procedure 调用
//
// ## 这个文件不再「改配置」，它只发起改动
//
// 每条改动对应宿主的一条 procedure，而每个写口都回整份 `AppConfig`（`config.endpoints.*` /
// `config.models.*` / `config.imageModels.*` / `config.defaults.update` / `config.update` 都是
// `{ config }`）。于是：
//
//   - 本地快照只从返回值换一份整的，不自己拼「改一处、写回全量」；
//   - 删端点 / 删模型之后不必再读一次：宿主顺带改指的默认项就在它回的那一份里
//     （旧版要 `refreshConfig()` 补一刀，是因为旧写口只回被改的那一条）；
// - 一次改动一次调用：默认项走 `config.defaults.update`，上限与中断策略走
//     `config.update`，两件事两个口。
//
// 两个例外仍然要补读：`agentDefinition.remove` 只回 `{ agentId }`（默认 AgentDefinition 被清掉这件事在
// 配置那一侧），`agentDefinition.*` 写的是另一份文件（定义），配置本身不动。
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { agentListOf, findAgent, toDefinition, type AgentList } from "../../agents-store.js";
import { MCP_SCOPE_OF } from "../../config.js";
import type {
  AgentDefinition,
  AppConfig,
  EndpointDefinition,
  ImageModelDefinition,
  McpEditableScope,
  McpEntry,
  McpServerDefinition,
  ModelDefinition,
  ReasoningPresets,
} from "../../config.js";
import type {
  AgentDefinitionInput,
  ConfigWizardProps,
  DefaultsChange,
  GlobalChange,
  NewEndpointDraft,
  WizardCloseResult,
  WizardHost,
  WizardStep,
} from "./types.js";
import { createFieldBuilders, type FieldBuilders, type FieldWriters } from "./fields.js";
import { primaryModelOf } from "../../config-editor.js";
import { t } from "../../i18n/index.js";

/**
 * 一次写的统一出口：返回 `null` 表示成功，否则是给屏上看的一句话。
 *
 * `FieldWriters` 那几条（字段构造器要用的）在这里继承下来，剩下的都是步骤屏直接用的增删动作。
 * 名字与 procedure 一一对应，读一遍就知道每一屏调了契约里的哪一条。
 */
export interface WizardWriters extends FieldWriters {
  /** 新建端点（`config.endpoints.create`；`apiKey` 占一格，空串 = 先不配） */
  addEndpoint: (endpoint: EndpointDefinition, message: string) => Promise<string | null>;
  deleteEndpoint: (endpointId: string, message: string) => Promise<string | null>;
  /** 默认项五格（`config.defaults.update`；`null` = 清空那一项） */
  setDefaults: (change: DefaultsChange, message: string) => Promise<string | null>;
  /** 上限 + 中断策略两项（`config.update`） */
  setGlobal: (change: GlobalChange, message: string) => Promise<string | null>;
  createModel: (model: ModelDefinition, message: string) => Promise<string | null>;
  deleteModel: (modelId: string, message: string) => Promise<string | null>;
  /** 恢复出厂（`config.models.reset`） */
  resetModel: (modelId: string, message: string) => Promise<string | null>;
  createImageModel: (model: ImageModelDefinition, message: string) => Promise<string | null>;
  deleteImageModel: (modelId: string, message: string) => Promise<string | null>;
  createAgent: (definition: AgentDefinitionInput, message: string) => Promise<string | null>;
  deleteAgent: (agentId: string, message: string) => Promise<string | null>;
  /** 存一条 MCP（`mcp.save`）；`previousName` 与 `server.id` 不同时表示改名 */
  saveMcp: (
    scope: McpEditableScope,
    server: McpServerDefinition,
    message: string,
    previousName?: string,
  ) => Promise<string | null>;
  /** 删一条 MCP（`mcp.remove`） */
  deleteMcp: (scope: McpEditableScope, name: string, message: string) => Promise<string | null>;
  /**
   * 首启引导的那一次写：密钥落盘 → 那家端点的首要模型落成默认项 → 把模型记进关闭结果。
   *
   * 它把两件事写成一条路：`config.endpoints.update`（密钥）与 `config.defaults.update`
   * （首要模型）。分两屏做的话，用户填完密钥还得再选一次模型 —— 而那选择在配置里已经是
   * 事实（`ModelDefinition.primary`），把他再问一遍没有意义。
   *
   * 返回 `null` = 写成了（关闭由 `runWrite` 按 `closeOnSave` 完成）；否则是屏上那句话。
   *
   * `apiKey` 省略 = 「这家已经有钥匙了，只走定首要模型那一半」（用户选了已经配好的服务商）：
   * 那时一个字节都不回写，密钥还是他原来那把。
   */
  saveOnboardingKey: (endpointId: string, apiKey?: string) => Promise<string | null>;
}

export interface WizardEngine extends WizardWriters, FieldBuilders {
  config: AppConfig;
  presets: ReasoningPresets;
  /** AgentDefinition 清单（定义 + 默认 AgentDefinition id；后者来自 `config.defaultAgent`，每次现拼） */
  agents: AgentList;
  /** MCP 服务器清单（`mcp.list` 原样：每条带 `scope`） */
  servers: McpEntry[];
  /** 每个 AgentDefinition 上挂着几段会话（删除代价那一句里的数字）；`null` = 数不出来 */
  sessionsByAgent: Record<string, number> | null;
  workspaceId: string;
  error: string | null;
  notice: string | null;
  draft: NewEndpointDraft;
  step: WizardStep;
  activeStep: WizardStep;
  /** 已发生的改动事实（关闭时交给宿主） */
  snapshot: () => WizardCloseResult;
  go: (next: WizardStep) => void;
  /**
   * 执行一次写：失败把原因放上屏，成功按调用方要求跳转。
   *
   * `props.closeOnSave` 时改成直接关闭（首启引导 / `/key` 的两条路）。
   */
  runWrite: (write: () => Promise<string | null>, after?: WizardStep | "stay") => Promise<boolean>;
  close: () => void;
  setDraft: Dispatch<SetStateAction<NewEndpointDraft>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setStep: Dispatch<SetStateAction<WizardStep>>;
}

export interface WizardContext extends WizardEngine {
  cols: number;
  rows: number;
  props: ConfigWizardProps;
}

/** 按 id 换掉一条（不存在则追加） */
function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...list, item];
  return list.map((existing, at) => (at === index ? item : existing));
}

/**
 * 写失败 → 屏上那一句。
 *
 * 句子归宿主（`ClientError.message` 已按连接语言渲染好、也已把结构化原因写进那句话里：
 * 「端点 x 上还挂着模型 y，先把它们换走或删掉」「交接阈值与防护阈值都必须是数字」…）。
 * 客户端不再解析 `detail` 拼第二句：旧版那么做过，是因为旧宿主只回一份结构化原因、
 * 句子要客户端拼；这一版回的就是能直接上屏的话，再拼一遍只会得到两处会漂的措辞。
 */
export function explainFailure(cause: unknown): string {
  const failure = cause as { message?: unknown };
  return typeof failure?.message === "string" && failure.message ? failure.message : String(cause);
}

export function useWizardEngine(props: ConfigWizardProps): WizardEngine {
  const host: WizardHost = props.host;
  const api = host.api;
  const workspaceId = props.workspaceId;

  const [config, setConfig] = useState<AppConfig>(props.config);
  const [presets, setPresets] = useState<ReasoningPresets>(props.presets);
  const [definitions, setDefinitions] = useState<AgentDefinition[]>(props.agents);
  const [servers, setServers] = useState<McpEntry[]>(props.servers);
  const [step, setStep] = useState<WizardStep>(props.initialStep ?? { kind: "menu" });
  const [draft, setDraft] = useState<NewEndpointDraft>({ name: "", baseUrl: "", apiKey: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 累加器放 ref：写完要立刻读到最新值，再决定关闭时交什么
  const acc = useRef<WizardCloseResult>({ dirty: false, summary: [] });

  const snapshot = (): WizardCloseResult => ({
    dirty: acc.current.dirty,
    summary: [...acc.current.summary],
    // 首启引导选定的模型也要跟着出去：它是「该落到哪一段会话上」的唯一答案
    ...(acc.current.onboardedModelId === undefined
      ? {}
      : { onboardedModelId: acc.current.onboardedModelId }),
  });

  const go = (next: WizardStep) => {
    setError(null);
    setStep(next);
  };

  /** 记一次成功写入：置脏、累加摘要 */
  const record = (message: string) => {
    acc.current.dirty = true;
    acc.current.summary.push(message);
    setNotice(message);
  };

  /** 调一次 procedure：失败收敛成一句能直接上屏的话，不往外抛（屏上显示，不崩） */
  const attempt = async <T>(
    write: () => Promise<T>,
  ): Promise<{ ok: true; result: T } | { ok: false; message: string }> => {
    try {
      return { ok: true, result: await write() };
    } catch (cause: unknown) {
      return { ok: false, message: explainFailure(cause) };
    }
  };

  /** 再读一次配置 + 档位表（AgentDefinition 删除会连带清掉默认 AgentDefinition，那件事在配置里） */
  const refreshConfig = async () => {
    const outcome = await attempt(() => api.config.get.query());
    if (!outcome.ok) return;
    setConfig(outcome.result.config);
    setPresets(outcome.result.presets);
  };

  const addEndpoint: WizardWriters["addEndpoint"] = async (endpoint, message) => {
    const outcome = await attempt(() => api.config.endpoints.create.mutate({ endpoint }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const updateEndpoint: FieldWriters["updateEndpoint"] = async (id, change, message) => {
    // 改密钥之外的字段时 `apiKey` 不出现在 `change` 里：`update` 是合并语义，省略即不动它
    const outcome = await attempt(() => api.config.endpoints.update.mutate({ id, change }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const deleteEndpoint: WizardWriters["deleteEndpoint"] = async (endpointId, message) => {
    const outcome = await attempt(() => api.config.endpoints.delete.mutate({ id: endpointId }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const setDefaults: WizardWriters["setDefaults"] = async (change, message) => {
    const outcome = await attempt(() => api.config.defaults.update.mutate(change));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const setGlobal: WizardWriters["setGlobal"] = async (change, message) => {
    const outcome = await attempt(() => api.config.update.mutate(change));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const createModel: WizardWriters["createModel"] = async (model, message) => {
    const outcome = await attempt(() => api.config.models.create.mutate({ model }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const updateModel: FieldWriters["updateModel"] = async (id, change, message) => {
    const outcome = await attempt(() => api.config.models.update.mutate({ id, change }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const deleteModel: WizardWriters["deleteModel"] = async (modelId, message) => {
    const outcome = await attempt(() => api.config.models.delete.mutate({ id: modelId }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const resetModel: WizardWriters["resetModel"] = async (modelId, message) => {
    const outcome = await attempt(() => api.config.models.reset.mutate({ id: modelId }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const createImageModel: WizardWriters["createImageModel"] = async (model, message) => {
    const outcome = await attempt(() => api.config.imageModels.create.mutate({ model }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const updateImageModel: FieldWriters["updateImageModel"] = async (id, change, message) => {
    const outcome = await attempt(() => api.config.imageModels.update.mutate({ id, change }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  const deleteImageModel: WizardWriters["deleteImageModel"] = async (modelId, message) => {
    const outcome = await attempt(() => api.config.imageModels.delete.mutate({ id: modelId }));
    if (!outcome.ok) return outcome.message;
    setConfig(outcome.result.config);
    record(message);
    return null;
  };

  /** 换掉清单里的一条（定义清单只由 `agentDefinition.*` 改） */
  const putDefinition = (definition: unknown) => {
    const converted = toDefinition(definition);
    setDefinitions((prev) => upsert(prev, converted));
  };

  const createAgent: WizardWriters["createAgent"] = async (definition, message) => {
    const outcome = await attempt(() => api.config.agents.create.mutate({ definition }));
    if (!outcome.ok) return outcome.message;
    putDefinition(outcome.result.definition);
    record(message);
    return null;
  };

  const updateAgent: FieldWriters["updateAgent"] = async (agentId, change, message) => {
    const outcome = await attempt(() => api.config.agents.update.mutate({ agentId, change }));
    if (!outcome.ok) return outcome.message;
    putDefinition(outcome.result.definition);
    record(message);
    return null;
  };

  const deleteAgent: WizardWriters["deleteAgent"] = async (agentId, message) => {
    const outcome = await attempt(() => api.config.agents.delete.mutate({ agentId }));
    if (!outcome.ok) return outcome.message;
    setDefinitions((prev) => prev.filter((definition) => definition.id !== agentId));
    record(message);
    // 删的正好是默认 AgentDefinition 时宿主会把 `defaultAgent` 一起清掉（同一次写盘，但那条出参只说
    // `{ agentId }`）：配置那一侧要再读一次，否则菜单上还指着一个已经没有的 AgentDefinition
    await refreshConfig();
    return null;
  };

  const setAgentModel: FieldWriters["setAgentModel"] = async (agentId, modelId, message) => {
    const outcome = await attempt(() =>
      api.config.agents.update.mutate({ agentId, change: { modelId } }),
    );
    if (!outcome.ok) return outcome.message;
    putDefinition(outcome.result.definition);
    record(message);
    return null;
  };

  const setAgentThinking: FieldWriters["setAgentThinking"] = async (agentId, change, message) => {
    const outcome = await attempt(() => api.config.agents.update.mutate({ agentId, change }));
    if (!outcome.ok) return outcome.message;
    putDefinition(outcome.result.definition);
    record(message);
    return null;
  };

  /** 把宿主写回的那份清单整份换进快照（每条自带 `scope`，不必自己拼层） */
  const putServers = (next: readonly McpEntry[]) => setServers([...next]);

  const saveMcp: WizardWriters["saveMcp"] = async (scope, server, message, previousName) => {
    const outcome = await attempt(() =>
      api.config.mcp.update.mutate({ workspaceId, scope: MCP_SCOPE_OF[scope], server }),
    );
    if (!outcome.ok) return outcome.message;
    putServers(outcome.result.servers);
    // 改名：新名字那条建好之后把旧名字删掉（`server.id` 就是文件里 mcpServers 的键）
    if (previousName !== undefined && previousName !== server.id) {
      const removal = await attempt(() =>
        api.config.mcp.delete.mutate({
          workspaceId,
          scope: MCP_SCOPE_OF[scope],
          name: previousName,
        }),
      );
      if (!removal.ok) return removal.message;
      putServers(removal.result.servers);
    }
    record(message);
    return null;
  };

  const deleteMcp: WizardWriters["deleteMcp"] = async (scope, name, message) => {
    const outcome = await attempt(() =>
      api.config.mcp.delete.mutate({ workspaceId, scope: MCP_SCOPE_OF[scope], name }),
    );
    if (!outcome.ok) return outcome.message;
    putServers(outcome.result.servers);
    record(message);
    return null;
  };

  /**
   * 密钥 + 首要模型，一次写完。
   *
   * 首要模型从当前这份快照里取（不是写完再读一次）：写密钥不会动模型表，所以快照里那份就是
   * 写完之后的那份。而取值的时点在 `updateEndpoint` 之后 —— 那一步本身可能失败，失败时不继续
   * 往下写默认项（否则用户改了一个不存在的端点的密钥）。
   *
   * 默认项写失败时不隐藏：密钥已经落盘了（它在 `summary` 里），但「首要模型没设成」是用户要
   * 知道的一件事，所以把原因回给屏上；按 Esc 退出时 `dirty` 仍然是 true，密钥不丢。
   */
  const saveOnboardingKey: WizardWriters["saveOnboardingKey"] = async (endpointId, apiKey) => {
    const endpoint = config.endpoints.find((item) => item.id === endpointId);
    const name = endpoint?.name || endpointId;
    const failure =
      apiKey === undefined
        ? null
        : await updateEndpoint(
            endpointId,
            { apiKey },
            t("wiz.endpointUpdated", { name, label: "API Key" }),
          );
    if (failure) return failure;

    const primary = primaryModelOf(config, endpointId);
    if (!primary) {
      // 合法状态：那家端点没标记首要模型（用户自建端点常见）。不替他挑一条。
      record(t("wiz.onboard.noPrimary", { name }));
      return null;
    }
    const modelName = primary.name || primary.id;
    const defaultsFailure = await setDefaults(
      { defaultModel: primary.id },
      t("wiz.onboard.primarySet", { model: modelName }),
    );
    if (defaultsFailure) return defaultsFailure;
    acc.current.onboardedModelId = primary.id;
    return null;
  };

  const runWrite = async (
    write: () => Promise<string | null>,
    after: WizardStep | "stay" = "stay",
  ): Promise<boolean> => {
    setError(null);
    const failure = await write();
    if (failure) {
      setError(failure);
      return false;
    }
    if (props.closeOnSave) {
      props.onClose(snapshot());
      return true;
    }
    if (after !== "stay") go(after);
    return true;
  };

  const close = () => props.onClose(snapshot());

  const agents = agentListOf(definitions, config);

  // InboxEntry 可能在向导打开期间被外部删掉：渲染前收敛回它所在的列表，避免空引用
  const normalize = (current: WizardStep): WizardStep => {
    if (
      (current.kind === "edit" || current.kind === "endpoint") &&
      !config.endpoints.some((endpoint) => endpoint.id === current.endpointId)
    ) {
      return { kind: "endpoints" };
    }
    if (current.kind === "model" && !config.models.some((model) => model.id === current.modelId)) {
      return { kind: "models" };
    }
    if (
      current.kind === "image-model" &&
      !(config.imageModels ?? []).some((model) => model.id === current.modelId)
    ) {
      return { kind: "image-models" };
    }
    if (current.kind === "mcp-server" || current.kind === "mcp-kv") {
      const scope = MCP_SCOPE_OF[current.scope];
      const exists = servers.some(
        (entry) => entry.scope === scope && entry.server.id === current.serverName,
      );
      if (!exists) return { kind: "mcp", scope: current.scope };
    }
    if (
      (current.kind === "agent" ||
        current.kind === "agent-perms" ||
        current.kind === "agent-text") &&
      !findAgent(agents, current.agentId)
    ) {
      return { kind: "agents" };
    }
    return current;
  };
  const activeStep = normalize(step);

  const writers: WizardWriters = {
    addEndpoint,
    updateEndpoint,
    deleteEndpoint,
    setDefaults,
    setGlobal,
    createModel,
    updateModel,
    deleteModel,
    resetModel,
    createImageModel,
    updateImageModel,
    deleteImageModel,
    createAgent,
    updateAgent,
    deleteAgent,
    setAgentModel,
    setAgentThinking,
    saveMcp,
    deleteMcp,
    saveOnboardingKey,
  };

  const fields = createFieldBuilders({ config, presets, writers, go });

  return {
    ...writers,
    ...fields,
    config,
    presets,
    agents,
    servers,
    sessionsByAgent: props.sessionsByAgent ?? null,
    workspaceId,
    error,
    notice,
    draft,
    step,
    activeStep,
    snapshot,
    go,
    runWrite,
    close,
    setDraft,
    setError,
    setStep,
  };
}
