// 由 src/tui/config-wizard.tsx 拆分而来 —— 向导主体（步骤机）
import { useRef, useState } from "react";
import { useWindowSize } from "ink";
import { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { SelectItem } from "../components.js";
import { mcpConfigPath, writeMcpConfigAt, McpConfig, McpScope, McpServerEntry } from "../../config.js";
import { agentKindLabel, agentList, createAgentStore, findAgentDefinition, AgentKind, AgentStore } from "../../agents-store.js";
import { addEndpoint, addImageModel, addMcpServer, addModel, apiKeyGuide, createAgentDefinition, createSubAgentDefinition, findEndpoint, findMcpServer, findModel, getAgentPrompt, isApiKeySet, maskApiKey, mcpServerIdTaken, modelsUsingEndpoint, removeEndpoint, removeImageModel, removeMcpServer, removeModel, setAgentPrompt, setDefaultAgent, setDefaultImageModel, setDefaultMigrationModel, setDefaultModel, setEndpointApiKey, setEndpointBaseUrl, setMaxToolOutput, uniqueAgentId, updateMcpServer } from "../../config-editor.js";
import { DefaultTarget, WizardStep, NewEndpointDraft, WizardCloseResult, McpSnapshot, ConfigWizardProps, NEW_ENDPOINT, NEW_MODEL, NEW_IMAGE_MODEL, SWITCH_SCOPE, NEW_MCP_SERVER, NEW_AGENT, NEW_SUBAGENT } from "./types.js";
import { PromptScreen } from "./prompt.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { KvEditorScreen } from "./kv-editor.js";
import { PromptEditorScreen } from "./prompt-editor.js";
import { MenuStep } from "./menu.js";
import { scopeLabel, mcpCount, mcpServerHint } from "./mcp-helpers.js";
import { createFieldBuilders } from "./fields.js";

// ==================== 向导主体 ====================

export function ConfigWizard(props: ConfigWizardProps) {
  const { columns, rows: terminalRows } = useWindowSize();
  const cols = columns ?? 80;
  const rows = terminalRows ?? 24;

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
      (current.kind === "agent" || current.kind === "agent-perms" || current.kind === "agent-prompt") &&
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

  // ---------- 配置中心菜单 ----------
  if (activeStep.kind === "menu") {
    return (
      <MenuStep
        columns={cols}
        rows={rows}
        config={config}
        mcp={mcp}
        agentStore={store}
        savedCount={acc.current.summary.length}
        notice={notice}
        onClose={() => props.onClose(snapshot())}
        onPick={(action) => {
          if (action === "endpoints") go({ kind: "endpoints" });
          else if (action === "models") go({ kind: "models" });
          else if (action === "imageModels") go({ kind: "image-models" });
          else if (action === "mcp") go({ kind: "mcp", scope: "global" });
          else if (action === "agents") go({ kind: "agents" });
          else if (action === "defaults") go({ kind: "defaults" });
          else if (action === "maxToolOutput") go({ kind: "max-tool-output" });
          else props.onClose(snapshot());
        }}
      />
    );
  }

  // ---------- 默认项子菜单 ----------
  if (activeStep.kind === "defaults") {
    const defaultImage = (config.imageModels ?? []).find((model) => model.id === config.defaultImageModel);
    const items: SelectItem<DefaultTarget>[] = [
      {
        label: "默认模型",
        value: "defaultModel",
        hint: findModel(config, config.defaultModel)?.name ?? config.defaultModel ?? "未设置",
      },
      {
        label: "默认图片模型",
        value: "defaultImageModel",
        hint: defaultImage?.name ?? config.defaultImageModel ?? "未设置",
      },
      { label: "默认 Agent", value: "defaultAgent", hint: config.defaultAgent ?? "未设置" },
      {
        label: "默认迁移模型",
        value: "defaultMigrationModel",
        hint: findModel(config, config.defaultMigrationModel)?.name ?? config.defaultMigrationModel ?? "未设置",
      },
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="默认项"
        subtitle="新会话 / 任务迁移使用的默认值"
        items={items}
        onPick={(target) => go({ kind: "pick-default", target })}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 选择某个默认项的值 ----------
  if (activeStep.kind === "pick-default") {
    const target = activeStep.target;
    let title = "默认项";
    let items: SelectItem<string>[] = [];
    if (target === "defaultModel" || target === "defaultMigrationModel") {
      title = target === "defaultModel" ? "默认模型" : "默认迁移模型";
      items = config.models.map((model) => {
        const endpoint = findEndpoint(config, model.endpointId);
        return {
          label: model.name || model.id,
          value: model.id,
          hint: `${endpoint?.name ?? model.endpointId} · ${isApiKeySet(endpoint?.apiKey) ? "密钥就绪" : "缺 API Key"}`,
        };
      });
    } else if (target === "defaultImageModel") {
      title = "默认图片模型";
      items = (config.imageModels ?? []).map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
      }));
    } else {
      title = "默认 Agent";
      const source = props.agentStore
        ? store.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id }))
        : (props.agents ?? []);
      items = source.map((agent) => ({ label: agent.name, value: agent.id, hint: agent.id }));
    }
    items = [...items, { label: "（未设置）", value: "" }];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={title}
        subtitle="选中后即时写盘"
        items={items}
        onPick={(value) => {
          const id = value || undefined;
          const label = value || "未设置";
          if (target === "defaultModel") void commit(setDefaultModel(config, id), `默认模型 → ${label}`, [], { kind: "defaults" });
          else if (target === "defaultMigrationModel")
            void commit(setDefaultMigrationModel(config, id), `默认迁移模型 → ${label}`, [], { kind: "defaults" });
          else if (target === "defaultImageModel")
            void commit(setDefaultImageModel(config, id), `默认图片模型 → ${label}`, [], { kind: "defaults" });
          else void commit(setDefaultAgent(config, id), `默认 Agent → ${label}`, [], { kind: "defaults" });
        }}
        onCancel={() => go({ kind: "defaults" })}
      />
    );
  }

  // ---------- 端点管理（[新建端点] + 端点列表）----------
  if (activeStep.kind === "endpoints") {
    const items: SelectItem<string>[] = [
      { label: "＋ 新建端点", value: NEW_ENDPOINT, hint: "自定义 OpenAI 兼容服务" },
      ...config.endpoints.map((endpoint) => ({
        label: endpoint.name || endpoint.id,
        value: endpoint.id,
        hint: `${maskApiKey(endpoint.apiKey)} · ${endpoint.baseUrl}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="端点管理"
        subtitle={`共 ${config.endpoints.length} 个端点 · 选中后可就地编辑 / 删除`}
        items={items}
        onPick={(value) =>
          value === NEW_ENDPOINT
            ? go({ kind: "new-endpoint", field: "name", draft })
            : go({ kind: "endpoint", endpointId: value })
        }
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 端点详情（就地编辑名称 / Base URL / API Key / 描述）----------
  if (activeStep.kind === "endpoint") {
    const endpoint = findEndpoint(config, activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;
    const modelCount = modelsUsingEndpoint(config, endpoint.id).length;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ 端点 · ${name}`}
        details={[`${endpoint.id}${modelCount > 0 ? ` · ${modelCount} 个模型引用` : ""}`, "↑ ↓ 移动 · Enter 编辑 · 改动即时写入磁盘"]}
        fields={endpointFields(endpoint)}
        notice={notice}
        action={{
          label: "删除端点",
          run: async () => {
            const refs = modelsUsingEndpoint(config, endpoint.id);
            if (refs.length > 0) {
              return `无法删除：仍被 ${refs.length} 个模型引用（${refs.map((m) => m.name || m.id).join("、")}），请先删除或改绑这些模型`;
            }
            const failure = await persist(removeEndpoint(config, endpoint.id), `已删除端点 ${name}`);
            if (!failure) go({ kind: "endpoints" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "endpoints" })}
      />
    );
  }

  // ---------- 模型管理 ----------
  if (activeStep.kind === "models") {
    const items: SelectItem<string>[] = [
      { label: "＋ 新建模型", value: NEW_MODEL, hint: "自动标记为自定义（custom）" },
      ...config.models.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: `${findEndpoint(config, model.endpointId)?.name ?? model.endpointId} · ${model.custom ? "自定义" : "出厂托管"}${model.vision ? " · 视觉" : ""}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="模型管理"
        subtitle={`共 ${config.models.length} 个模型 · 选中后可就地编辑 / 删除`}
        items={items}
        onPick={(value) => (value === NEW_MODEL ? go({ kind: "new-model" }) : go({ kind: "model", modelId: value }))}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 模型详情 ----------
  if (activeStep.kind === "model") {
    const model = findModel(config, activeStep.modelId)!;
    const name = model.name || model.id;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ 模型 · ${name}`}
        details={[`${model.id} · ${model.custom ? "自定义" : "出厂托管（编辑会自动转自定义）"}`, "↑ ↓ 移动 · Enter 编辑/切换 · 改动即时写入磁盘"]}
        fields={modelFields(model)}
        notice={notice}
        action={{
          label: "删除模型",
          run: async () => {
            const failure = await persist(removeModel(config, model.id), `已删除模型 ${name}`);
            if (!failure) go({ kind: "models" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "models" })}
      />
    );
  }

  // ---------- 图片模型列表 ----------
  if (activeStep.kind === "image-models") {
    const list = config.imageModels ?? [];
    const items: SelectItem<string>[] = [
      { label: "＋ 新建图片模型", value: NEW_IMAGE_MODEL, hint: "自动标记为自定义（custom）" },
      ...list.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: `${findEndpoint(config, model.endpointId)?.name ?? model.endpointId} · ${model.custom ? "自定义" : "出厂托管"}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="图片模型"
        subtitle={`共 ${list.length} 个 · 选中后可就地编辑 / 删除`}
        items={items}
        onPick={(value) => (value === NEW_IMAGE_MODEL ? go({ kind: "new-image-model" }) : go({ kind: "image-model", modelId: value }))}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 图片模型详情 ----------
  if (activeStep.kind === "image-model") {
    const model = (config.imageModels ?? []).find((m) => m.id === activeStep.modelId)!;
    const name = model.name || model.id;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ 图片模型 · ${name}`}
        details={[`${model.id} · ${model.custom ? "自定义" : "出厂托管（编辑会自动转自定义）"}`, "↑ ↓ 移动 · Enter 编辑/切换 · 改动即时写入磁盘"]}
        fields={imageModelFields(model)}
        notice={notice}
        action={{
          label: "删除图片模型",
          run: async () => {
            const failure = await persist(removeImageModel(config, model.id), `已删除图片模型 ${name}`);
            if (!failure) go({ kind: "image-models" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "image-models" })}
      />
    );
  }

  // ---------- MCP 服务器列表（含作用域切换）----------
  if (activeStep.kind === "mcp") {
    const scope = activeStep.scope;
    const other: McpScope = scope === "global" ? "project" : "global";
    const items: SelectItem<string>[] = [
      {
        label: `⇄ 切换到「${scopeLabel(other)}」作用域`,
        value: SWITCH_SCOPE,
        hint: `${mcpCount(mcp, other)} 个服务器`,
      },
      { label: "＋ 新建服务器", value: NEW_MCP_SERVER, hint: "stdio / http / sse" },
      ...Object.entries(mcp[scope].mcpServers).map(([id, entry]) => ({
        label: id,
        value: id,
        hint: mcpServerHint(entry),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={`◆ MCP 服务器 · ${scopeLabel(scope)}`}
        subtitle={`${mcpCount(mcp, scope)} 个 · ${mcpConfigPath(scope)}`}
        items={items}
        onPick={(value) => {
          if (value === SWITCH_SCOPE) go({ kind: "mcp", scope: other });
          else if (value === NEW_MCP_SERVER) go({ kind: "mcp-new", scope });
          else go({ kind: "mcp-server", scope, serverId: value });
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- MCP 服务器详情 ----------
  if (activeStep.kind === "mcp-server") {
    const { scope, serverId } = activeStep;
    const entry = findMcpServer(mcp[scope], serverId)!;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ MCP · ${serverId}`}
        details={[
          `${scopeLabel(scope)} · ${mcpConfigPath(scope)}`,
          `传输 ${entry.type ?? "stdio"} · ↑ ↓ 移动 · Enter 编辑/切换`,
        ]}
        fields={mcpServerFields(scope, serverId, entry)}
        notice={notice}
        action={{
          label: "删除服务器",
          run: async () => {
            const failure = await persistMcp(
              scope,
              removeMcpServer(mcp[scope], serverId),
              `已删除 MCP 服务器 ${serverId}（${scopeLabel(scope)}）`,
            );
            if (!failure) go({ kind: "mcp", scope });
            return failure;
          },
        }}
        onBack={() => go({ kind: "mcp", scope })}
      />
    );
  }

  // ---------- MCP 键值编辑（env / headers）----------
  if (activeStep.kind === "mcp-kv") {
    const { scope, serverId, field } = activeStep;
    const entry = findMcpServer(mcp[scope], serverId)!;
    const label = field === "env" ? "环境变量" : "请求头";
    const current = (entry[field] as Record<string, string> | undefined) ?? {};
    return (
      <KvEditorScreen
        columns={cols}
        rows={rows}
        title={`◆ MCP · ${serverId} · ${label}`}
        subtitle={`${scopeLabel(scope)} · ${Object.keys(current).length} 项`}
        map={current}
        notice={notice}
        onCommit={(next) => {
          const patch: Partial<McpServerEntry> =
            field === "env"
              ? { env: Object.keys(next).length ? next : undefined }
              : { headers: Object.keys(next).length ? next : undefined };
          return persistMcp(
            scope,
            updateMcpServer(mcp[scope], serverId, patch),
            `MCP ${serverId} 的${label}已更新（${scopeLabel(scope)}）`,
          );
        }}
        onBack={() => go({ kind: "mcp-server", scope, serverId })}
      />
    );
  }

  // ---------- 新建 MCP 服务器 ----------
  if (activeStep.kind === "mcp-new") {
    const scope = activeStep.scope;
    return (
      <PromptScreen
        key={`new:mcp:${scope}`}
        columns={cols}
        rows={rows}
        title={`新建 MCP 服务器 · 名称（${scopeLabel(scope)}）`}
        details={[
          "作为 mcpServers 的键，例如 github / chrome-devtools",
          "创建后默认 stdio，可编辑传输方式 / 命令 / 参数 / 环境变量等",
        ]}
        error={error}
        hints={[["Enter", "创建并编辑"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          if (mcpServerIdTaken(mcp[scope], name)) {
            setError(`已存在名为 ${name} 的服务器`);
            return;
          }
          const { mcp: next, id } = addMcpServer(mcp[scope], name);
          void (async () => {
            const failure = await persistMcp(scope, next, `已新建 MCP 服务器 ${id}（${scopeLabel(scope)}）`);
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "mcp-server", scope, serverId: id });
          })();
        }}
        onCancel={() => go({ kind: "mcp", scope })}
      />
    );
  }

  // ---------- Agent 定义列表 ----------
  if (activeStep.kind === "agents") {
    const items: SelectItem<string>[] = [
      { label: "＋ 新建 Agent", value: NEW_AGENT, hint: "顶层 Agent（可作为默认 Agent）" },
      { label: "＋ 新建 Sub-agent", value: NEW_SUBAGENT, hint: "可被委派的子 Agent" },
      ...store.agents.map((def) => ({
        label: def.name || def.id,
        value: `agent:${def.id}`,
        hint: `Agent · ${def.id}${def.custom ? "" : " · 出厂托管"}`,
      })),
      ...store.subAgents.map((def) => ({
        label: def.name || def.id,
        value: `subagent:${def.id}`,
        hint: `Sub-agent · ${def.id}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="◆ Agent 定义"
        subtitle={`Agent ${store.agents.length} · Sub-agent ${store.subAgents.length}`}
        items={items}
        onPick={(value) => {
          if (value === NEW_AGENT) go({ kind: "agent-new", agentKind: "agent" });
          else if (value === NEW_SUBAGENT) go({ kind: "agent-new", agentKind: "subagent" });
          else {
            const [kind, id] = value.split(":");
            go({ kind: "agent", agentKind: kind as AgentKind, agentId: id! });
          }
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- Agent 详情 ----------
  if (activeStep.kind === "agent") {
    const { agentKind, agentId } = activeStep;
    const def = findAgentDefinition(store, agentKind, agentId)!;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ ${agentKindLabel(agentKind)} · ${def.name || def.id}`}
        details={[
          `${def.id} · ${def.custom ? "自定义" : "出厂托管"}${agentKind === "subagent" ? " · Sub-agent" : ""}`,
          "↑ ↓ 移动 · Enter 编辑/切换/进入 · 改动即时写入磁盘",
        ]}
        fields={agentFields(agentKind, def)}
        notice={notice}
        action={{
          label: `删除${agentKindLabel(agentKind)}`,
          run: async () => {
            const failure = await deleteAgent(agentKind, def.id);
            if (!failure) go({ kind: "agents" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "agents" })}
      />
    );
  }

  // ---------- Agent 权限子屏 ----------
  if (activeStep.kind === "agent-perms") {
    const { agentKind, agentId } = activeStep;
    const def = findAgentDefinition(store, agentKind, agentId)!;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ ${agentKindLabel(agentKind)} · ${def.id} · 权限`}
        details={["格式：`allow: a, b` 或 `deny: x`（逗号分隔；留空清除该维）", "↑ ↓ 移动 · Enter 编辑 · Esc 返回"]}
        fields={agentPermFields(agentKind, def)}
        notice={notice}
        onBack={() => go({ kind: "agent", agentKind, agentId })}
      />
    );
  }

  // ---------- Agent 提示词编辑（系统编辑器）----------
  if (activeStep.kind === "agent-prompt") {
    const { agentKind, agentId } = activeStep;
    const def = findAgentDefinition(store, agentKind, agentId)!;
    return (
      <PromptEditorScreen
        columns={cols}
        rows={rows}
        title={`◆ ${agentKindLabel(agentKind)} · ${def.id} · 提示词`}
        subtitle="Enter 打开系统编辑器（$EDITOR / notepad）；改完保存即写盘"
        prompt={getAgentPrompt(def)}
        notice={notice}
        onSave={(text) => {
          const managed = agentKind === "agent" && !def.custom;
          const next = setAgentPrompt(managed ? { ...def, custom: true } : def, text);
          return saveAgent(agentKind, next, `${agentKindLabel(agentKind)} ${def.id} 的提示词已更新`);
        }}
        onBack={() => go({ kind: "agent", agentKind, agentId })}
      />
    );
  }

  // ---------- 新建 Agent / Sub-agent ----------
  if (activeStep.kind === "agent-new") {
    const kind = activeStep.agentKind;
    const kindName = agentKindLabel(kind);
    return (
      <PromptScreen
        key={`new:${kind}`}
        columns={cols}
        rows={rows}
        title={`新建 ${kindName} · 名称`}
        details={[
          "用于在列表与状态栏中标识该定义，例如 Coder",
          kind === "agent" ? "创建后可在「默认项 → 默认 Agent」中选为默认" : "创建后自动生成 function 骨架（可编辑）",
        ]}
        error={error}
        hints={[["Enter", "创建并编辑"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          const id = uniqueAgentId(
            agentList(store, kind).map((item) => item.id),
            name,
            kind === "agent" ? "agent" : "subagent",
          );
          const def = kind === "agent" ? createAgentDefinition({ id, name }) : createSubAgentDefinition({ id, name });
          void (async () => {
            const failure = await saveAgent(kind, def, `已新建 ${kindName} ${name}（${id}）`);
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "agent", agentKind: kind, agentId: id });
          })();
        }}
        onCancel={() => go({ kind: "agents" })}
      />
    );
  }

  // ---------- 工具输出上限 ----------
  if (activeStep.kind === "max-tool-output") {
    const current = config.maxToolOutput ?? 32768;
    return (
      <PromptScreen
        key="maxToolOutput"
        columns={cols}
        rows={rows}
        title="工具输出上限（字符数）"
        details={[`当前：${current}`, "工具单次输出超过该值时落盘或仅警告，避免撑爆上下文"]}
        initialValue={String(current)}
        error={error}
        hints={[["Enter", "保存"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const n = Number(value.trim());
          if (!Number.isFinite(n) || n <= 0) {
            setError("需为正整数");
            return;
          }
          void commit(setMaxToolOutput(config, Math.floor(n)), `工具输出上限 → ${Math.floor(n)} 字符`, [], { kind: "menu" });
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 新建模型（名称 → 创建并进入详情）----------
  if (activeStep.kind === "new-model") {
    const endpointId = config.endpoints[0]?.id ?? "";
    return (
      <PromptScreen
        key="new:model"
        columns={cols}
        rows={rows}
        title="新建模型 · 名称"
        details={[
          "用于在配置与状态栏中标识该模型，例如 My GPT",
          config.endpoints.length === 0
            ? "⚠ 尚未配置端点，创建后请先到「端点管理」添加端点"
            : `将默认绑定端点：${findEndpoint(config, endpointId)?.name ?? endpointId}`,
        ]}
        error={error}
        hints={[["Enter", "创建并编辑"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          const { config: next, model } = addModel(config, { name, endpointId });
          void (async () => {
            const failure = await persist(next, `已新建模型 ${model.name}（${model.id}，已标记为自定义）`);
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "model", modelId: model.id });
          })();
        }}
        onCancel={() => go({ kind: "models" })}
      />
    );
  }

  // ---------- 新建图片模型（名称 → 创建并进入详情）----------
  if (activeStep.kind === "new-image-model") {
    const endpointId = config.endpoints[0]?.id ?? "";
    return (
      <PromptScreen
        key="new:image-model"
        columns={cols}
        rows={rows}
        title="新建图片模型 · 名称"
        details={[
          "用于在配置与状态栏中标识该模型，例如 My Image",
          config.endpoints.length === 0
            ? "⚠ 尚未配置端点，创建后请先到「端点管理」添加端点"
            : `将默认绑定端点：${findEndpoint(config, endpointId)?.name ?? endpointId}`,
        ]}
        error={error}
        hints={[["Enter", "创建并编辑"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          const { config: next, model } = addImageModel(config, { name, endpointId });
          void (async () => {
            const failure = await persist(next, `已新建图片模型 ${model.name}（${model.id}，已标记为自定义）`);
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "image-model", modelId: model.id });
          })();
        }}
        onCancel={() => go({ kind: "image-models" })}
      />
    );
  }

  // ---------- 端点字段直达编辑（首启引导 / `/key`）----------
  if (activeStep.kind === "edit") {
    const endpoint = findEndpoint(config, activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;

    if (activeStep.field === "apiKey") {
      const guide = apiKeyGuide(endpoint.baseUrl);
      return (
        <PromptScreen
          key={`apiKey:${endpoint.id}`}
          columns={cols}
          rows={rows}
          title={props.onboarding ? `首次配置 · 设置 ${name} 的 API Key` : `设置 API Key · ${name}`}
          details={[
            `端点：${name} · ${endpoint.baseUrl}`,
            `当前：${maskApiKey(endpoint.apiKey)}`,
            guide.url
              ? `${guide.vendor} 申请地址：${guide.url}`
              : `${guide.vendor}：请向服务提供方获取 API Key`,
            props.onboarding ? "保存后立即进入对话（Esc 放弃并退出）。" : undefined,
          ].filter((line): line is string => Boolean(line))}
          mask
          error={error}
          hints={[
            ["Enter", props.onboarding ? "保存并进入对话" : "保存"],
            ["Tab", "明文/掩码"],
            ["Esc", props.closeOnSave ? "放弃" : "返回"],
          ]}
          onSubmit={(value) => {
            const key = value.trim();
            if (!key) {
              setError("API Key 不能为空");
              return;
            }
            void commit(setEndpointApiKey(config, endpoint.id, key), `端点 ${name} 的 API Key 已更新`, [endpoint.id]);
          }}
          onCancel={() => (props.closeOnSave ? props.onClose(snapshot()) : go({ kind: "menu" }))}
        />
      );
    }

    return (
      <PromptScreen
        key={`baseUrl:${endpoint.id}`}
        columns={cols}
        rows={rows}
        title={`设置 Base URL · ${name}`}
        details={[`当前：${endpoint.baseUrl}`, "需以 http:// 或 https:// 开头（OpenAI 兼容端点）"]}
        initialValue={endpoint.baseUrl}
        error={error}
        hints={[["Enter", "保存"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError("Base URL 需以 http:// 或 https:// 开头");
            return;
          }
          void commit(setEndpointBaseUrl(config, endpoint.id, baseUrl), `端点 ${name} 的 Base URL 已更新`, [endpoint.id]);
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 新建端点（名称 → Base URL → API Key）----------
  const field = activeStep.field;

  if (field === "name") {
    return (
      <PromptScreen
        key="new:name"
        columns={cols}
        rows={rows}
        title="新建端点 · 名称"
        details={["用于在配置与状态栏中标识该服务，例如 My Gateway"]}
        initialValue={draft.name}
        error={error}
        hints={[["Enter", "下一步"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          const next = { ...draft, name };
          setDraft(next);
          setError(null);
          setStep({ kind: "new-endpoint", field: "baseUrl", draft: next });
        }}
        onCancel={() => go({ kind: "endpoints" })}
      />
    );
  }

  if (field === "baseUrl") {
    return (
      <PromptScreen
        key="new:baseUrl"
        columns={cols}
        rows={rows}
        title="新建端点 · Base URL"
        details={["例如 https://api.openai.com/v1（须为 OpenAI 兼容接口）"]}
        initialValue={draft.baseUrl}
        error={error}
        hints={[["Enter", "下一步"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError("Base URL 需以 http:// 或 https:// 开头");
            return;
          }
          const next = { ...draft, baseUrl };
          setDraft(next);
          setError(null);
          setStep({ kind: "new-endpoint", field: "apiKey", draft: next });
        }}
        onCancel={() => {
          setError(null);
          setStep({ kind: "new-endpoint", field: "name", draft });
        }}
      />
    );
  }

  return (
    <PromptScreen
      key="new:apiKey"
      columns={cols}
      rows={rows}
      title="新建端点 · API Key"
      details={[
        `端点：${draft.name} · ${draft.baseUrl}`,
        "可留空稍后再补（留空时该端点暂不可用）",
        apiKeyGuide(draft.baseUrl).url
          ? `${apiKeyGuide(draft.baseUrl).vendor} 申请地址：${apiKeyGuide(draft.baseUrl).url}`
          : undefined,
      ].filter((line): line is string => Boolean(line))}
      mask
      error={error}
      hints={[["Enter", "保存端点"], ["Tab", "明文/掩码"], ["Esc", "返回"]]}
      onSubmit={(value) => {
        const apiKey = value.trim();
        const { config: next, endpoint } = addEndpoint(config, { ...draft, apiKey });
        void commit(
          next,
          `已添加端点 ${endpoint.name}（${endpoint.id}）${apiKey ? "" : " · API Key 待补充"}`,
          [endpoint.id],
          { kind: "endpoints" },
        );
      }}
      onCancel={() => {
        setError(null);
        setStep({ kind: "new-endpoint", field: "baseUrl", draft });
      }}
    />
  );
}

