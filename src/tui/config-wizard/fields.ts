import { AgentDefinition, AppConfig, Endpoint, ImageModel, Model, ReasoningPresets } from "@ai-zen/agents-sdk";
import { McpConfig, McpScope, McpServerEntry } from "../../config.js";
import { agentKindLabel, agentList, AgentKind, AgentStore } from "../../agents-store.js";
import { findEndpoint, findModel, formatAgentPermission, formatArgs, getAgentPrompt, kvSummary, maskApiKey, mcpServerIdTaken, mergeTokenThresholds, parseArgs, parsePermission, PERMISSION_DIMENSIONS, renameMcpServer, setAgentPermission, summarizePermissions, updateAgentDefinition, updateAgentFunction, updateEndpoint, updateImageModel, updateMcpServer, updateModel } from "../../config-editor.js";
import { WizardStep, McpSnapshot } from "./types.js";
import { t } from "../../i18n/index.js";
import { DetailField } from "./detail.js";
import { scopeLabel } from "./mcp-helpers.js";

// 由 src/tui/config-wizard.tsx 拆分而来 —— 详情屏字段构造器（工厂）

/** 多行文本在详情屏的**单行摘要**（避免换行撑破吸底布局）；内容一律走外部编辑器编辑 */
function summarizeMultiline(text: string): string {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) return t("common.emptyWithEditor");
  const lines = body.split("\n");
  return lines.length > 1
    ? t("common.linesWithEditor", { n: lines.length })
    : t("common.bodyWithEditor", { text: body });
}

export interface FieldBuilderContext {
  config: AppConfig;
  mcp: McpSnapshot;
  store: AgentStore;
  /** 思考策略表（模型详情页校验策略名用） */
  reasoningPresets: ReasoningPresets;
  persist: (next: AppConfig, message: string, changedEndpointIds?: string[]) => Promise<string | null>;
  persistMcp: (scope: McpScope, next: McpConfig, message: string) => Promise<string | null>;
  saveAgent: (kind: AgentKind, def: AgentDefinition, message: string) => Promise<string | null>;
  removeAgentQuiet: (kind: AgentKind, id: string) => Promise<string | null>;
  go: (next: WizardStep) => void;
}

export function createFieldBuilders(context: FieldBuilderContext) {
  const { config, mcp, store, reasoningPresets, persist, persistMcp, saveAgent, removeAgentQuiet, go } = context;

  // ---------- 字段构造器 ----------

  /** 端点详情字段（editable：名称 / Base URL / API Key / 描述） */
  const endpointFields = (endpoint: Endpoint): DetailField[] => {
    const name = endpoint.name || endpoint.id;
    const save = (patch: Partial<Endpoint>, label: string) =>
      persist(updateEndpoint(config, endpoint.id, patch), t("wiz.endpointUpdated", { name, label }), [endpoint.id]);
    return [
      {
        key: "name",
        label: t("field.name"),
        kind: "text",
        value: name,
        initial: endpoint.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, t("field.name")) : Promise.resolve(t("err.nameRequired"))),
      },
      {
        key: "baseUrl",
        label: "Base URL",
        kind: "text",
        value: endpoint.baseUrl,
        initial: endpoint.baseUrl,
        commit: (raw) =>
          /^https?:\/\//i.test(raw) ? save({ baseUrl: raw }, "Base URL") : Promise.resolve(t("err.baseUrlScheme")),
      },
      {
        key: "apiKey",
        label: "API Key",
        kind: "secret",
        value: maskApiKey(endpoint.apiKey),
        initial: endpoint.apiKey ?? "",
        commit: (raw) => (raw ? save({ apiKey: raw }, "API Key") : Promise.resolve(t("err.apiKeyRequired"))),
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: endpoint.description ?? t("common.empty"),
        initial: endpoint.description ?? "",
        commit: (raw) => save({ description: raw || undefined }, t("field.description")),
      },
    ];
  };

  /** 模型详情页「思考策略」的展示文案：附上该策略的档位，免得用户还得去翻 JSON */
  const describePreset = (name?: string): string => {
    if (!name) return t("common.notAdjustable");
    const preset = Object.prototype.hasOwnProperty.call(reasoningPresets, name)
      ? reasoningPresets[name]
      : undefined;
    const levels = Object.keys(preset?.levels ?? {});
    return levels.length
      ? t("wiz.presetLevels", { name, levels: levels.join(" / ") })
      : t("wiz.presetMissingName", { name });
  };

  /** 模型详情字段；编辑「出厂托管」模型时自动标记 `custom: true`（否则改动会被 SDK 同步覆盖） */
  const modelFields = (model: Model): DetailField[] => {
    const managed = !model.custom;
    const save = (patch: Partial<Model>, label: string) => {
      const next = updateModel(config, model.id, managed ? { ...patch, custom: true } : patch);
      const suffix = managed ? t("common.customOnlyNote") : "";
      return persist(next, t("wiz.modelUpdated", { name: model.name || model.id, label, suffix }), [model.endpointId]);
    };
    return [
      {
        key: "name",
        label: t("field.name"),
        kind: "text",
        value: model.name || model.id,
        initial: model.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, t("field.name")) : Promise.resolve(t("err.nameRequired"))),
      },
      {
        key: "endpointId",
        label: t("field.endpoint"),
        kind: "enum",
        value: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
        options: config.endpoints.map((endpoint) => ({ label: endpoint.name || endpoint.id, value: endpoint.id })),
        commit: (raw) => (raw === model.endpointId ? Promise.resolve(null) : save({ endpointId: raw }, t("field.endpoint"))),
      },
      {
        key: "modelName",
        label: t("field.modelName"),
        kind: "text",
        value: model.modelName ?? t("common.sameAsId"),
        initial: model.modelName ?? "",
        commit: (raw) => save({ modelName: raw || undefined }, t("field.modelName")),
      },
      {
        key: "reasoningPreset",
        label: t("field.reasoningPreset"),
        kind: "text",
        value: describePreset(model.reasoningPreset),
        initial: model.reasoningPreset ?? "",
        commit: (raw) => {
          const name = raw.trim();
          if (!name) return save({ reasoningPreset: undefined }, t("field.reasoningPreset"));
          // 名字写错等于静默失去调档能力，当场拦住
          if (!Object.prototype.hasOwnProperty.call(reasoningPresets, name)) {
            const available = Object.keys(reasoningPresets);
            return Promise.resolve(
              available.length
                ? t("err.presetNotFound", { name, options: available.join(" / ") })
                : t("err.presetTableEmpty", { name }),
            );
          }
          return save({ reasoningPreset: name }, t("field.reasoningPreset"));
        },
      },
      {
        key: "handoffTokens",
        label: t("field.handoffThreshold"),
        kind: "number",
        value: String(model.tokenThresholds?.handoff ?? 0),
        initial: String(model.tokenThresholds?.handoff ?? 0),
        commit: (raw) => {
          const n = Number(raw.trim());
          if (!Number.isFinite(n) || n <= 0) return Promise.resolve(t("err.handoffPositive"));
          const guard = model.tokenThresholds?.guard ?? 0;
          // 软线不得越过硬线，否则一启动就被阻断
          if (guard > 0 && Math.floor(n) >= guard) return Promise.resolve(t("err.handoffLessThanGuard"));
          return save(
            { tokenThresholds: mergeTokenThresholds(model.tokenThresholds, { handoff: Math.floor(n) }) },
            t("field.handoffThreshold"),
          );
        },
      },
      {
        key: "guardTokens",
        label: t("field.guardThreshold"),
        kind: "number",
        value: String(model.tokenThresholds?.guard ?? 0),
        initial: String(model.tokenThresholds?.guard ?? 0),
        commit: (raw) => {
          const n = Number(raw.trim());
          if (!Number.isFinite(n) || n <= 0) return Promise.resolve(t("err.guardPositive"));
          const handoff = model.tokenThresholds?.handoff ?? 0;
          if (Math.floor(n) <= handoff) return Promise.resolve(t("err.guardGreaterThanHandoff"));
          return save(
            { tokenThresholds: mergeTokenThresholds(model.tokenThresholds, { guard: Math.floor(n) }) },
            t("field.guardThreshold"),
          );
        },
      },
      {
        key: "vision",
        label: t("field.vision"),
        kind: "bool",
        value: model.vision ? t("common.yes") : t("common.no"),
        toggle: () => save({ vision: !model.vision }, t("field.vision")),
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: model.description ?? t("common.empty"),
        initial: model.description ?? "",
        commit: (raw) => save({ description: raw || undefined }, t("field.description")),
      },
      {
        key: "custom",
        label: t("field.custom"),
        kind: "bool",
        value: model.custom ? t("common.yes") : t("common.factoryManaged"),
        toggle: () =>
          persist(
            updateModel(config, model.id, { custom: !model.custom }),
            t("wiz.modelCustomSet", {
              name: model.name || model.id,
              value: !model.custom ? t("common.yes") : t("common.no"),
            }),
            [model.endpointId],
          ),
      },
    ];
  };

  /** 图片模型详情字段（同样对托管条目自动标记 `custom: true`） */
  const imageModelFields = (model: ImageModel): DetailField[] => {
    const managed = !model.custom;
    const save = (patch: Partial<ImageModel>, label: string) => {
      const next = updateImageModel(config, model.id, managed ? { ...patch, custom: true } : patch);
      const suffix = managed ? t("common.customOnlyNote") : "";
      return persist(next, t("wiz.imageModelUpdated", { name: model.name || model.id, label, suffix }), [model.endpointId]);
    };
    return [
      {
        key: "name",
        label: t("field.name"),
        kind: "text",
        value: model.name || model.id,
        initial: model.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, t("field.name")) : Promise.resolve(t("err.nameRequired"))),
      },
      {
        key: "endpointId",
        label: t("field.endpoint"),
        kind: "enum",
        value: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
        options: config.endpoints.map((endpoint) => ({ label: endpoint.name || endpoint.id, value: endpoint.id })),
        commit: (raw) => (raw === model.endpointId ? Promise.resolve(null) : save({ endpointId: raw }, t("field.endpoint"))),
      },
      {
        key: "modelName",
        label: t("field.modelName"),
        kind: "text",
        value: model.modelName,
        initial: model.modelName,
        commit: (raw) => (raw.trim() ? save({ modelName: raw.trim() }, t("field.modelName")) : Promise.resolve(t("err.modelNameRequired"))),
      },
      {
        key: "defaultSize",
        label: t("field.size"),
        kind: "text",
        value: model.defaultSize ?? t("common.defaultInParens"),
        initial: model.defaultSize ?? "",
        commit: (raw) => save({ defaultSize: raw || undefined }, t("field.size")),
      },
      {
        key: "defaultQuality",
        label: t("field.quality"),
        kind: "text",
        value: model.defaultQuality ?? t("common.defaultInParens"),
        initial: model.defaultQuality ?? "",
        commit: (raw) => save({ defaultQuality: raw || undefined }, t("field.quality")),
      },
      {
        key: "custom",
        label: t("field.custom"),
        kind: "bool",
        value: model.custom ? t("common.yes") : t("common.factoryManaged"),
        toggle: () =>
          persist(
            updateImageModel(config, model.id, { custom: !model.custom }),
            t("wiz.imageModelCustomSet", {
              name: model.name || model.id,
              value: !model.custom ? t("common.yes") : t("common.no"),
            }),
            [model.endpointId],
          ),
      },
    ];
  };

  /** MCP 服务器详情字段（依 transport 呈现 stdio 或 http/sse 字段） */
  const mcpServerFields = (scope: McpScope, id: string, entry: McpServerEntry): DetailField[] => {
    const scopeName = scopeLabel(scope);
    const save = (patch: Partial<McpServerEntry>, label: string) =>
      persistMcp(
        scope,
        updateMcpServer(mcp[scope], id, patch),
        t("wiz.mcpFieldUpdated", { id, label, scope: scopeName }),
      );
    const type = entry.type ?? "stdio";
    const fields: DetailField[] = [
      {
        key: "id",
        label: t("field.name"),
        kind: "text",
        value: id,
        initial: id,
        commit: (raw) => {
          const name = raw.trim();
          if (!name) return Promise.resolve(t("err.nameRequired"));
          if (name === id) return Promise.resolve(null);
          if (mcpServerIdTaken(mcp[scope], name, id)) return Promise.resolve(t("err.mcpNameTaken", { name }));
          return persistMcp(
            scope,
            renameMcpServer(mcp[scope], id, name),
            t("wiz.mcpRenamed", { id, name, scope: scopeName }),
          ).then((failure) => {
            if (!failure) go({ kind: "mcp-server", scope, serverId: name });
            return failure;
          });
        },
      },
      {
        key: "type",
        label: t("field.transport"),
        kind: "enum",
        value: type,
        options: [
          { label: t("common.transportStdio"), value: "stdio" },
          { label: t("common.transportHttp"), value: "http" },
          { label: t("common.transportSse"), value: "sse" },
        ],
        commit: (raw) =>
          raw === type ? Promise.resolve(null) : save({ type: raw as McpServerEntry["type"] }, t("common.transportMode")),
      },
      {
        key: "enabled",
        label: t("field.enabled"),
        kind: "bool",
        value: entry.disabled === true ? t("common.disabledInParens") : t("common.yes"),
        toggle: () => save({ disabled: entry.disabled === true ? undefined : true }, t("common.enabledState")),
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: entry.description ?? t("common.empty"),
        initial: entry.description ?? "",
        commit: (raw) => save({ description: raw.trim() || undefined }, t("field.description")),
      },
    ];
    if (type === "stdio") {
      fields.push(
        {
          key: "command",
          label: t("field.command"),
          kind: "text",
          value: entry.command ?? t("common.empty"),
          initial: entry.command ?? "",
          commit: (raw) => save({ command: raw.trim() || undefined }, t("field.command")),
        },
        {
          key: "args",
          label: t("field.args"),
          kind: "text",
          value: formatArgs(entry.args) || t("common.empty"),
          initial: formatArgs(entry.args),
          commit: (raw) => {
            const args = parseArgs(raw.trim());
            return save({ args: args.length ? args : undefined }, t("field.args"));
          },
        },
        {
          key: "env",
          label: t("field.env"),
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
          value: entry.url ?? t("common.empty"),
          initial: entry.url ?? "",
          commit: (raw) => save({ url: raw.trim() || undefined }, "URL"),
        },
        {
          key: "headers",
          label: t("field.headers"),
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
      const suffix = managed ? t("common.customOnlyNote") : "";
      return saveAgent(kind, marked, t("wiz.agentFieldUpdated", { kind: kindName, id: def.id, label, suffix }));
    };
    const fields: DetailField[] = [
      {
        key: "name",
        label: t("field.name"),
        kind: "text",
        value: def.name || def.id,
        initial: def.name,
        commit: (raw) =>
          raw.trim()
            ? save(updateAgentDefinition(def, { name: raw.trim() }), t("field.name"))
            : Promise.resolve(t("err.nameRequired")),
      },
      {
        key: "id",
        label: t("field.id"),
        kind: "text",
        value: def.id,
        initial: def.id,
        commit: (raw) => {
          const name = raw.trim();
          if (!name) return Promise.resolve(t("err.idRequired"));
          if (name === def.id) return Promise.resolve(null);
          if (agentList(store, kind).some((item) => item.id === name)) return Promise.resolve(t("err.agentIdTaken", { name }));
          return (async () => {
            const failure = await saveAgent(kind, { ...def, id: name }, t("wiz.agentRenamed", { kind: kindName, id: def.id, name }));
            if (failure) return failure;
            await removeAgentQuiet(kind, def.id);
            go({ kind: "agent", agentKind: kind, agentId: name });
            return null;
          })();
        },
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: def.description ?? t("common.empty"),
        initial: def.description ?? "",
        commit: (raw) => save(updateAgentDefinition(def, { description: raw.trim() || undefined }), t("field.description")),
      },
      {
        key: "modelId",
        label: t("field.model"),
        kind: "enum",
        value: findModel(config, def.modelId)?.name ?? def.modelId ?? t("common.unset"),
        options: [
          ...config.models.map((model) => ({ label: model.name || model.id, value: model.id })),
          { label: t("common.unset"), value: "" },
        ],
        commit: (raw) => save(updateAgentDefinition(def, { modelId: raw || undefined }), t("field.model")),
      },
      {
        key: "prompt",
        label: t("field.prompt"),
        kind: "map",
        value: summarizeMultiline(getAgentPrompt(def)),
        open: () => go({ kind: "agent-text", agentKind: kind, agentId: def.id, field: "prompt" }),
      },
      {
        key: "permissions",
        label: t("field.permissions"),
        kind: "map",
        value: summarizePermissions(def.permissions),
        open: () => go({ kind: "agent-perms", agentKind: kind, agentId: def.id }),
      },
    ];
    if (kind === "agent") {
      fields.push({
        key: "custom",
        label: t("field.custom"),
        kind: "bool",
        value: def.custom ? t("common.yes") : t("common.factoryManaged"),
        toggle: () => save(updateAgentDefinition(def, { custom: !def.custom }), t("common.customQuoted")),
      });
    } else {
      fields.push(
        {
          key: "fnName",
          label: t("field.functionName"),
          kind: "text",
          value: def.function?.name ?? t("common.empty"),
          initial: def.function?.name ?? "",
          commit: (raw) =>
            raw.trim()
              ? save(updateAgentFunction(def, { name: raw.trim() }), t("field.functionName"))
              : Promise.resolve(t("err.functionNameRequired")),
        },
        {
          key: "fnDesc",
          label: t("field.functionDescription"),
          kind: "map",
          value: summarizeMultiline(def.function?.description ?? ""),
          open: () => go({ kind: "agent-text", agentKind: kind, agentId: def.id, field: "fnDesc" }),
        },
        {
          key: "fnParams",
          label: t("field.paramsSchema"),
          kind: "map",
          value: summarizeMultiline(JSON.stringify(def.function?.parameters ?? {}, null, 2)),
          open: () => go({ kind: "agent-text", agentKind: kind, agentId: def.id, field: "fnParams" }),
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
      value: formatAgentPermission(def.permissions, dim) || t("common.unset"),
      initial: formatAgentPermission(def.permissions, dim),
      commit: (raw: string) => {
        const parsed = parsePermission(raw);
        if (typeof parsed === "string") return Promise.resolve(parsed);
        const managed = kind === "agent" && !def.custom;
        const next = setAgentPermission(managed ? { ...def, custom: true } : def, dim, parsed);
        return saveAgent(kind, next, t("wiz.agentPermissionUpdated", { kind: agentKindLabel(kind), id: def.id, dim }));
      },
    }));

  return { endpointFields, modelFields, imageModelFields, mcpServerFields, agentFields, agentPermFields };
}
