import { AgentDefinition, AppConfig, Endpoint, ImageModel, Model } from "@ai-zen/agents-sdk";
import { McpConfig, McpScope, McpServerEntry } from "../../config.js";
import { agentKindLabel, agentList, AgentKind, AgentStore } from "../../agents-store.js";
import { findEndpoint, findModel, formatAgentPermission, formatArgs, formatFunctionParameters, getAgentPrompt, kvSummary, maskApiKey, mcpServerIdTaken, parseArgs, parseFunctionParameters, parsePermission, PERMISSION_DIMENSIONS, renameMcpServer, setAgentPermission, summarizePermissions, updateAgentDefinition, updateAgentFunction, updateEndpoint, updateImageModel, updateMcpServer, updateModel } from "../../config-editor.js";
import { WizardStep, McpSnapshot } from "./types.js";
import { DetailField } from "./detail.js";
import { scopeLabel } from "./mcp-helpers.js";

// 由 src/tui/config-wizard.tsx 拆分而来 —— 详情屏字段构造器（工厂）

export interface FieldBuilderContext {
  config: AppConfig;
  mcp: McpSnapshot;
  store: AgentStore;
  persist: (next: AppConfig, message: string, changedEndpointIds?: string[]) => Promise<string | null>;
  persistMcp: (scope: McpScope, next: McpConfig, message: string) => Promise<string | null>;
  saveAgent: (kind: AgentKind, def: AgentDefinition, message: string) => Promise<string | null>;
  removeAgentQuiet: (kind: AgentKind, id: string) => Promise<string | null>;
  go: (next: WizardStep) => void;
}

export function createFieldBuilders(context: FieldBuilderContext) {
  const { config, mcp, store, persist, persistMcp, saveAgent, removeAgentQuiet, go } = context;

  // ---------- 字段构造器 ----------

  /** 端点详情字段（editable：名称 / Base URL / API Key / 描述） */
  const endpointFields = (endpoint: Endpoint): DetailField[] => {
    const name = endpoint.name || endpoint.id;
    const save = (patch: Partial<Endpoint>, label: string) =>
      persist(updateEndpoint(config, endpoint.id, patch), `端点 ${name} 的 ${label} 已更新`, [endpoint.id]);
    return [
      {
        key: "name",
        label: "名称",
        kind: "text",
        value: name,
        initial: endpoint.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, "名称") : Promise.resolve("名称不能为空")),
      },
      {
        key: "baseUrl",
        label: "Base URL",
        kind: "text",
        value: endpoint.baseUrl,
        initial: endpoint.baseUrl,
        commit: (raw) =>
          /^https?:\/\//i.test(raw) ? save({ baseUrl: raw }, "Base URL") : Promise.resolve("Base URL 需以 http:// 或 https:// 开头"),
      },
      {
        key: "apiKey",
        label: "API Key",
        kind: "secret",
        value: maskApiKey(endpoint.apiKey),
        initial: endpoint.apiKey ?? "",
        commit: (raw) => (raw ? save({ apiKey: raw }, "API Key") : Promise.resolve("API Key 不能为空")),
      },
      {
        key: "description",
        label: "描述",
        kind: "text",
        value: endpoint.description ?? "（空）",
        initial: endpoint.description ?? "",
        commit: (raw) => save({ description: raw || undefined }, "描述"),
      },
    ];
  };

  /** 模型详情字段；编辑「出厂托管」模型时自动标记 `custom: true`（否则改动会被 SDK 同步覆盖） */
  const modelFields = (model: Model): DetailField[] => {
    const managed = !model.custom;
    const save = (patch: Partial<Model>, label: string) => {
      const next = updateModel(config, model.id, managed ? { ...patch, custom: true } : patch);
      const suffix = managed ? "（已标记为自定义，改动才会保留）" : "";
      return persist(next, `模型 ${model.name || model.id} 的 ${label} 已更新${suffix}`, [model.endpointId]);
    };
    return [
      {
        key: "name",
        label: "名称",
        kind: "text",
        value: model.name || model.id,
        initial: model.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, "名称") : Promise.resolve("名称不能为空")),
      },
      {
        key: "endpointId",
        label: "端点",
        kind: "enum",
        value: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
        options: config.endpoints.map((endpoint) => ({ label: endpoint.name || endpoint.id, value: endpoint.id })),
        commit: (raw) => (raw === model.endpointId ? Promise.resolve(null) : save({ endpointId: raw }, "端点")),
      },
      {
        key: "modelName",
        label: "模型名",
        kind: "text",
        value: model.modelName ?? "（同 id）",
        initial: model.modelName ?? "",
        commit: (raw) => save({ modelName: raw || undefined }, "模型名"),
      },
      {
        key: "maxContextTokens",
        label: "迁移阈值",
        kind: "number",
        value: String(model.maxContextTokens ?? 0),
        initial: String(model.maxContextTokens ?? 0),
        commit: (raw) => {
          const n = Number(raw.trim());
          return Number.isFinite(n) && n > 0 ? save({ maxContextTokens: Math.floor(n) }, "迁移阈值") : Promise.resolve("迁移阈值需为正整数");
        },
      },
      {
        key: "vision",
        label: "视觉",
        kind: "bool",
        value: model.vision ? "是" : "否",
        toggle: () => save({ vision: !model.vision }, "视觉"),
      },
      {
        key: "description",
        label: "描述",
        kind: "text",
        value: model.description ?? "（空）",
        initial: model.description ?? "",
        commit: (raw) => save({ description: raw || undefined }, "描述"),
      },
      {
        key: "custom",
        label: "自定义",
        kind: "bool",
        value: model.custom ? "是" : "否（出厂托管）",
        toggle: () =>
          persist(updateModel(config, model.id, { custom: !model.custom }), `模型 ${model.name || model.id} 的「自定义」已设为 ${!model.custom ? "是" : "否"}`, [model.endpointId]),
      },
    ];
  };

  /** 图片模型详情字段（同样对托管条目自动标记 `custom: true`） */
  const imageModelFields = (model: ImageModel): DetailField[] => {
    const managed = !model.custom;
    const save = (patch: Partial<ImageModel>, label: string) => {
      const next = updateImageModel(config, model.id, managed ? { ...patch, custom: true } : patch);
      const suffix = managed ? "（已标记为自定义，改动才会保留）" : "";
      return persist(next, `图片模型 ${model.name || model.id} 的 ${label} 已更新${suffix}`, [model.endpointId]);
    };
    return [
      {
        key: "name",
        label: "名称",
        kind: "text",
        value: model.name || model.id,
        initial: model.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, "名称") : Promise.resolve("名称不能为空")),
      },
      {
        key: "endpointId",
        label: "端点",
        kind: "enum",
        value: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
        options: config.endpoints.map((endpoint) => ({ label: endpoint.name || endpoint.id, value: endpoint.id })),
        commit: (raw) => (raw === model.endpointId ? Promise.resolve(null) : save({ endpointId: raw }, "端点")),
      },
      {
        key: "modelName",
        label: "模型名",
        kind: "text",
        value: model.modelName,
        initial: model.modelName,
        commit: (raw) => (raw.trim() ? save({ modelName: raw.trim() }, "模型名") : Promise.resolve("模型名不能为空")),
      },
      {
        key: "defaultSize",
        label: "尺寸",
        kind: "text",
        value: model.defaultSize ?? "（默认）",
        initial: model.defaultSize ?? "",
        commit: (raw) => save({ defaultSize: raw || undefined }, "尺寸"),
      },
      {
        key: "defaultQuality",
        label: "质量",
        kind: "text",
        value: model.defaultQuality ?? "（默认）",
        initial: model.defaultQuality ?? "",
        commit: (raw) => save({ defaultQuality: raw || undefined }, "质量"),
      },
      {
        key: "custom",
        label: "自定义",
        kind: "bool",
        value: model.custom ? "是" : "否（出厂托管）",
        toggle: () =>
          persist(updateImageModel(config, model.id, { custom: !model.custom }), `图片模型 ${model.name || model.id} 的「自定义」已设为 ${!model.custom ? "是" : "否"}`, [model.endpointId]),
      },
    ];
  };

  /** MCP 服务器详情字段（依 transport 呈现 stdio 或 http/sse 字段） */
  const mcpServerFields = (scope: McpScope, id: string, entry: McpServerEntry): DetailField[] => {
    const scopeName = scopeLabel(scope);
    const save = (patch: Partial<McpServerEntry>, label: string) =>
      persistMcp(scope, updateMcpServer(mcp[scope], id, patch), `MCP ${id} 的${label}已更新（${scopeName}）`);
    const type = entry.type ?? "stdio";
    const fields: DetailField[] = [
      {
        key: "id",
        label: "名称",
        kind: "text",
        value: id,
        initial: id,
        commit: (raw) => {
          const name = raw.trim();
          if (!name) return Promise.resolve("名称不能为空");
          if (name === id) return Promise.resolve(null);
          if (mcpServerIdTaken(mcp[scope], name, id)) return Promise.resolve(`已存在名为 ${name} 的服务器`);
          return persistMcp(
            scope,
            renameMcpServer(mcp[scope], id, name),
            `MCP ${id} 已重命名为 ${name}（${scopeName}）`,
          ).then((failure) => {
            if (!failure) go({ kind: "mcp-server", scope, serverId: name });
            return failure;
          });
        },
      },
      {
        key: "type",
        label: "传输",
        kind: "enum",
        value: type,
        options: [
          { label: "stdio（本地子进程）", value: "stdio" },
          { label: "http（Streamable HTTP）", value: "http" },
          { label: "sse（Server-Sent Events）", value: "sse" },
        ],
        commit: (raw) =>
          raw === type ? Promise.resolve(null) : save({ type: raw as McpServerEntry["type"] }, "传输方式"),
      },
      {
        key: "enabled",
        label: "启用",
        kind: "bool",
        value: entry.disabled === true ? "否（已禁用）" : "是",
        toggle: () => save({ disabled: entry.disabled === true ? undefined : true }, "启用状态"),
      },
      {
        key: "description",
        label: "描述",
        kind: "text",
        value: entry.description ?? "（空）",
        initial: entry.description ?? "",
        commit: (raw) => save({ description: raw.trim() || undefined }, "描述"),
      },
    ];
    if (type === "stdio") {
      fields.push(
        {
          key: "command",
          label: "命令",
          kind: "text",
          value: entry.command ?? "（空）",
          initial: entry.command ?? "",
          commit: (raw) => save({ command: raw.trim() || undefined }, "命令"),
        },
        {
          key: "args",
          label: "参数",
          kind: "text",
          value: formatArgs(entry.args) || "（空）",
          initial: formatArgs(entry.args),
          commit: (raw) => {
            const args = parseArgs(raw.trim());
            return save({ args: args.length ? args : undefined }, "参数");
          },
        },
        {
          key: "env",
          label: "环境变量",
          kind: "map",
          value: kvSummary(entry.env),
          open: () => go({ kind: "mcp-kv", scope, serverId: id, field: "env" }),
        },
      );
    } else {
      fields.push(
        {
          key: "url",
          label: "URL",
          kind: "text",
          value: entry.url ?? "（空）",
          initial: entry.url ?? "",
          commit: (raw) => save({ url: raw.trim() || undefined }, "URL"),
        },
        {
          key: "headers",
          label: "请求头",
          kind: "map",
          value: kvSummary(entry.headers),
          open: () => go({ kind: "mcp-kv", scope, serverId: id, field: "headers" }),
        },
      );
    }
    return fields;
  };

  /** Agent / Sub-agent 详情字段；编辑出厂托管 Agent（如 default）时自动标记 custom: true */
  const agentFields = (kind: AgentKind, def: AgentDefinition): DetailField[] => {
    const kindName = agentKindLabel(kind);
    const managed = kind === "agent" && !def.custom;
    const save = (nextDef: AgentDefinition, label: string) => {
      const marked = managed ? { ...nextDef, custom: true } : nextDef;
      const suffix = managed ? "（已标记为自定义，改动才会保留）" : "";
      return saveAgent(kind, marked, `${kindName} ${def.id} 的 ${label} 已更新${suffix}`);
    };
    const fields: DetailField[] = [
      {
        key: "name",
        label: "名称",
        kind: "text",
        value: def.name || def.id,
        initial: def.name,
        commit: (raw) =>
          raw.trim()
            ? save(updateAgentDefinition(def, { name: raw.trim() }), "名称")
            : Promise.resolve("名称不能为空"),
      },
      {
        key: "id",
        label: "标识",
        kind: "text",
        value: def.id,
        initial: def.id,
        commit: (raw) => {
          const name = raw.trim();
          if (!name) return Promise.resolve("标识不能为空");
          if (name === def.id) return Promise.resolve(null);
          if (agentList(store, kind).some((item) => item.id === name)) return Promise.resolve(`已存在标识 ${name} 的定义`);
          return (async () => {
            const failure = await saveAgent(kind, { ...def, id: name }, `${kindName} ${def.id} 已重命名为 ${name}`);
            if (failure) return failure;
            await removeAgentQuiet(kind, def.id);
            go({ kind: "agent", agentKind: kind, agentId: name });
            return null;
          })();
        },
      },
      {
        key: "description",
        label: "描述",
        kind: "text",
        value: def.description ?? "（空）",
        initial: def.description ?? "",
        commit: (raw) => save(updateAgentDefinition(def, { description: raw.trim() || undefined }), "描述"),
      },
      {
        key: "modelId",
        label: "模型",
        kind: "enum",
        value: findModel(config, def.modelId)?.name ?? def.modelId ?? "（未设置）",
        options: [
          ...config.models.map((model) => ({ label: model.name || model.id, value: model.id })),
          { label: "（未设置）", value: "" },
        ],
        commit: (raw) => save(updateAgentDefinition(def, { modelId: raw || undefined }), "模型"),
      },
      {
        key: "prompt",
        label: "提示词",
        kind: "map",
        value: `${getAgentPrompt(def).split("\n").length} 行 · Enter 打开编辑器`,
        open: () => go({ kind: "agent-prompt", agentKind: kind, agentId: def.id }),
      },
      {
        key: "permissions",
        label: "权限",
        kind: "map",
        value: summarizePermissions(def.permissions),
        open: () => go({ kind: "agent-perms", agentKind: kind, agentId: def.id }),
      },
    ];
    if (kind === "agent") {
      fields.push({
        key: "custom",
        label: "自定义",
        kind: "bool",
        value: def.custom ? "是" : "否（出厂托管）",
        toggle: () => save(updateAgentDefinition(def, { custom: !def.custom }), "「自定义」"),
      });
    } else {
      fields.push(
        {
          key: "fnName",
          label: "函数名",
          kind: "text",
          value: def.function?.name ?? "（空）",
          initial: def.function?.name ?? "",
          commit: (raw) =>
            raw.trim()
              ? save(updateAgentFunction(def, { name: raw.trim() }), "函数名")
              : Promise.resolve("函数名不能为空"),
        },
        {
          key: "fnDesc",
          label: "函数说明",
          kind: "text",
          value: def.function?.description ?? "（空）",
          initial: def.function?.description ?? "",
          commit: (raw) => save(updateAgentFunction(def, { description: raw }), "函数说明"),
        },
        {
          key: "fnParams",
          label: "参数 schema",
          kind: "text",
          value: formatFunctionParameters(def.function),
          initial: formatFunctionParameters(def.function),
          commit: (raw) => {
            const parsed = parseFunctionParameters(raw);
            return typeof parsed === "string"
              ? Promise.resolve(parsed)
              : save(updateAgentFunction(def, { parameters: parsed }), "参数 schema");
          },
        },
      );
    }
    return fields;
  };

  /** 四维权限子屏字段（`allow: a, b` / `deny: x`；留空清除该维） */
  const agentPermFields = (kind: AgentKind, def: AgentDefinition): DetailField[] =>
    PERMISSION_DIMENSIONS.map((dim) => ({
      key: dim,
      label: dim,
      kind: "text" as const,
      value: formatAgentPermission(def.permissions, dim) || "（未设置）",
      initial: formatAgentPermission(def.permissions, dim),
      commit: (raw: string) => {
        const parsed = parsePermission(raw);
        if (typeof parsed === "string") return Promise.resolve(parsed);
        const managed = kind === "agent" && !def.custom;
        const next = setAgentPermission(managed ? { ...def, custom: true } : def, dim, parsed);
        return saveAgent(kind, next, `${agentKindLabel(kind)} ${def.id} 的 ${dim} 权限已更新`);
      },
    }));

  return { endpointFields, modelFields, imageModelFields, mcpServerFields, agentFields, agentPermFields };
}
