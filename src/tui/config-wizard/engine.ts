// 由 src/tui/config-wizard.tsx 拆分而来 —— 配置向导引擎（状态 + 写盘/跳转处理器）
import { useRef, useState, Dispatch, SetStateAction } from "react";
import { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { mcpConfigPath, McpConfig, McpScope, writeMcpConfigAt } from "../../config.js";
import { agentKindLabel, agentList, AgentStore, AgentKind, findAgentDefinition, createAgentStore } from "../../agents-store.js";
import { findEndpoint, findMcpServer, findModel } from "../../config-editor.js";
import { WizardStep, NewEndpointDraft, WizardCloseResult, McpSnapshot, ConfigWizardProps } from "./types.js";
import { createFieldBuilders } from "./fields.js";

export interface WizardEngine extends ReturnType<typeof createFieldBuilders> {
  config: AppConfig;
  mcp: McpSnapshot;
  store: AgentStore;
  error: string | null;
  notice: string | null;
  draft: NewEndpointDraft;
  acc: { current: WizardCloseResult };
  step: WizardStep;
  activeStep: WizardStep;
  snapshot: () => WizardCloseResult;
  go: (next: WizardStep) => void;
  commit: (next: AppConfig, message: string, changedEndpointIds?: string[], after?: WizardStep | "stay") => Promise<void>;
  persist: (next: AppConfig, message: string, changedEndpointIds?: string[]) => Promise<string | null>;
  persistMcp: (scope: McpScope, next: McpConfig, message: string) => Promise<string | null>;
  saveAgent: (kind: AgentKind, def: AgentDefinition, message: string) => Promise<string | null>;
  deleteAgent: (kind: AgentKind, id: string) => Promise<string | null>;
  setDraft: Dispatch<SetStateAction<NewEndpointDraft>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setStep: Dispatch<SetStateAction<WizardStep>>;
}

export interface WizardContext extends WizardEngine {
  cols: number;
  rows: number;
  props: ConfigWizardProps;
}

export function useWizardEngine(props: ConfigWizardProps): WizardEngine {
  const [config, setConfig] = useState(props.config);
  const [step, setStep] = useState<WizardStep>(props.initialStep ?? { kind: "menu" });
  const [draft, setDraft] = useState<NewEndpointDraft>({ name: "", baseUrl: "", apiKey: "" });
  const [mcp, setMcp] = useState<McpSnapshot>(
    props.mcp ?? { global: { mcpServers: {} }, project: { mcpServers: {} } },
  );
  const [store, setStore] = useState<AgentStore>(() => props.agentStore ?? createAgentStore([], []));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 累加器放 ref：`commit()` 后需要立刻读到最新值再决定是否关闭
  const acc = useRef<WizardCloseResult>({ dirty: false, summary: [], changedEndpointIds: [] });

  const snapshot = (): WizardCloseResult => {
    const result: WizardCloseResult = {
      dirty: acc.current.dirty,
      summary: [...acc.current.summary],
      changedEndpointIds: [...acc.current.changedEndpointIds],
    };
    if (acc.current.mcpChanged) result.mcpChanged = true;
    if (acc.current.agentsChanged) result.agentsChanged = true;
    return result;
  };

  const go = (next: WizardStep) => {
    setError(null);
    setStep(next);
  };

  /** 记录一次成功写盘：更新配置快照、累加变更、刷新提示 */
  const record = (next: AppConfig, message: string, changedEndpointIds: string[] = []) => {
    setConfig(next);
    acc.current.dirty = true;
    acc.current.summary.push(message);
    for (const id of changedEndpointIds) {
      if (!acc.current.changedEndpointIds.includes(id)) acc.current.changedEndpointIds.push(id);
    }
    setNotice(message);
  };

  /** 写盘 + 记录变更，**原地停留**；返回错误信息或 `null`（供详情屏字段提交使用） */
  const persist = async (next: AppConfig, message: string, changedEndpointIds: string[] = []): Promise<string | null> => {
    try {
      await props.onSave(next);
    } catch (cause: any) {
      return `写入配置失败：${cause?.message ?? cause}`;
    }
    record(next, message, changedEndpointIds);
    return null;
  };

  /** 写盘 MCP 配置 + 记录变更，**原地停留**；返回错误信息或 `null` */
  const persistMcp = async (scope: McpScope, next: McpConfig, message: string): Promise<string | null> => {
    try {
      if (props.onSaveMcp) await props.onSaveMcp(scope, next);
      else await writeMcpConfigAt(mcpConfigPath(scope), next);
    } catch (cause: any) {
      return `写入 MCP 配置失败：${cause?.message ?? cause}`;
    }
    setMcp((prev) => ({ ...prev, [scope]: next }));
    acc.current.dirty = true;
    acc.current.mcpChanged = true;
    acc.current.summary.push(message);
    setNotice(message);
    return null;
  };

  /** 写盘某个 Agent / Sub-agent 定义（创建或更新），刷新本地快照并记录变更 */
  const saveAgent = async (kind: AgentKind, def: AgentDefinition, message: string): Promise<string | null> => {
    const next: AgentDefinition = { ...def, updatedAt: new Date().toISOString() };
    try {
      await store.save(kind, next);
    } catch (cause: any) {
      return `写入 Agent 定义失败：${cause?.message ?? cause}`;
    }
    setStore((prev) => {
      const list = [...agentList(prev, kind)];
      const index = list.findIndex((item) => item.id === next.id);
      if (index >= 0) list[index] = next;
      else list.push(next);
      return kind === "agent" ? { ...prev, agents: list } : { ...prev, subAgents: list };
    });
    acc.current.dirty = true;
    acc.current.agentsChanged = true;
    acc.current.summary.push(message);
    setNotice(message);
    return null;
  };

  /** 静默删除某个定义（用于重命名时清理旧文件；不记录变更） */
  const removeAgentQuiet = async (kind: AgentKind, id: string): Promise<string | null> => {
    try {
      await store.remove(kind, id);
    } catch (cause: any) {
      return `删除 Agent 定义失败：${cause?.message ?? cause}`;
    }
    setStore((prev) => {
      const list = agentList(prev, kind).filter((item) => item.id !== id);
      return kind === "agent" ? { ...prev, agents: list } : { ...prev, subAgents: list };
    });
    return null;
  };

  /** 删除某个定义并记录变更 */
  const deleteAgent = async (kind: AgentKind, id: string): Promise<string | null> => {
    const failure = await removeAgentQuiet(kind, id);
    if (failure) return failure;
    acc.current.dirty = true;
    acc.current.agentsChanged = true;
    acc.current.summary.push(`已删除 ${agentKindLabel(kind)} ${id}`);
    setNotice(`已删除 ${agentKindLabel(kind)} ${id}`);
    return null;
  };

  /** 写盘 + 记录变更 + 跳转；成功且 `closeOnSave` 时直接关闭，否则跳到 `after` 步骤（默认回菜单） */
  const commit = async (
    next: AppConfig,
    message: string,
    changedEndpointIds: string[] = [],
    after: WizardStep | "stay" = { kind: "menu" },
  ) => {
    setError(null);
    const failure = await persist(next, message, changedEndpointIds);
    if (failure) {
      setError(failure);
      return;
    }
    if (props.closeOnSave) props.onClose(snapshot());
    else if (after !== "stay") go(after);
  };

  // 条目可能在向导打开期间被外部删除：渲染前收敛回其列表，避免空指针
  const normalize = (current: WizardStep): WizardStep => {
    if ((current.kind === "edit" || current.kind === "endpoint") && !findEndpoint(config, current.endpointId)) {
      return { kind: "endpoints" };
    }
    if (current.kind === "model" && !findModel(config, current.modelId)) return { kind: "models" };
    if (
      current.kind === "image-model" &&
      !(config.imageModels ?? []).some((model) => model.id === current.modelId)
    ) {
      return { kind: "image-models" };
    }
    if (
      (current.kind === "mcp-server" || current.kind === "mcp-kv") &&
      !findMcpServer(mcp[current.scope], current.serverId)
    ) {
      return { kind: "mcp", scope: current.scope };
    }
    if (
      (current.kind === "agent" || current.kind === "agent-perms" || current.kind === "agent-text") &&
      !findAgentDefinition(store, current.agentKind, current.agentId)
    ) {
      return { kind: "agents" };
    }
    return current;
  };
  const activeStep = normalize(step);

  // 字段构造器已抽到 ./fields.js
  const { endpointFields, modelFields, imageModelFields, mcpServerFields, agentFields, agentPermFields } =
    createFieldBuilders({ config, mcp, store, persist, persistMcp, saveAgent, removeAgentQuiet, go });

  return {
    config,
    mcp,
    store,
    error,
    notice,
    draft,
    acc,
    step,
    activeStep,
    snapshot,
    go,
    commit,
    persist,
    persistMcp,
    saveAgent,
    deleteAgent,
    setDraft,
    setError,
    setStep,
    endpointFields,
    modelFields,
    imageModelFields,
    mcpServerFields,
    agentFields,
    agentPermFields,
  };
}
