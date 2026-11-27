// 详情屏字段构造器 —— 每个字段的提交 = 一次 procedure 调用
//
// ## 字段只做两件事
//
//   1. 把「用户敲进去的文本」变成 procedure 的入参（数字、argv、`KEY=VALUE`、权限策略）；
//   2. 发出那一次写（`config.endpoints.update` / `config.models.update` /
//      `agentDefinition.update` / `mcp.save`），失败原因原样上交详情屏。
//
// **不判断业务规则**：阈值是否越线、策略名是否存在、端点还在不在、模型能不能用，全是宿主的
// 判断（`invalid_params` / `conflict` 带着一句能直接上屏的话回来，`engine.ts` 的
// `explainFailure` 负责把它放到屏上）。客户端自己再判一遍只会得到第二套会漂的规则。
//
// ## 整体写入的三个例外，都是契约形状决定的
//
//   - 端点：`config.endpoints.update` 收的是 `{ id, change }`，`change` 是**合并**语义
//     （`{...当前, ...change}`），所以改一个字段只发那一个字段；`apiKey` 只在用户真的改了
//     输入框时出现在 `change` 里 —— 省略 = 保留原值（读回来的是明文，界面只显示掩码）。
//   - MCP：`mcp.save` 一次只管一条，所以改哪一项就发哪一项（其余字段从当前这一条带上），
//     层里别的 InboxEntry 不受影响。
//   - AgentDefinition 的提示词与函数定义：`agentDefinition.update` 对 `messages` 与 `function` 是**整份
//     替换**（不是深合并），所以那两处的补丁要把整串 / 整个对象带上（`withAgentPrompt` /
//     `withAgentFunction`），只发改的那一句会把兄弟字段冲掉；思考档位同理，整份
//     `modelParams` 一起发（`modelParamsWithLevel`）。
import type {
  AgentDefinition,
  AppConfig,
  EndpointDefinition,
  ImageModelDefinition,
  McpEditableScope,
  McpServerDefinition,
  ModelDefinition,
  ReasoningPresets,
} from "../../config.js";
import {
  agentPromptText,
  findEndpoint,
  findModel,
  formatArgs,
  kvSummary,
  maskSecret,
  parseArgs,
  patchPermission,
  PERMISSION_DIMENSIONS,
  formatAgentPermission,
  parsePermission,
  summarizePermissions,
} from "../../config-editor.js";
import {
  agentThinkingOf,
  isAdjustable,
  levelsOf,
  modelParamsWithLevel,
  presetOf,
  thinkingView,
} from "../../reasoning-effort.js";
import { agentKindLabel } from "../../agents-store.js";
import { t } from "../../i18n/index.js";
import type { DetailField } from "./detail.js";
import type {
  AgentChange,
  EndpointChange,
  ImageModelChange,
  ModelChange,
  WizardStep,
} from "./types.js";
import type { PermissionDimension } from "../../config-editor.js";
import { scopeLabel } from "./mcp-helpers.js";

/**
 * 权限四维的显示名。
 *
 * 维度名（`tools` / `skills` / …）是配置里的键，直接上屏等于把内部标识暴露给用户；
 * 这里映射到词条，`Record<PermissionDimension, …>` 保证四个维度都有对应文案。
 */
const PERMISSION_DIMENSION_LABEL_KEY: Record<PermissionDimension, string> = {
  tools: "perm.tools",
  skills: "perm.skills",
  mcps: "perm.mcps",
  subagents: "perm.subagents",
};

/**
 * 多行内容在详情屏那一行的**单行摘要**。
 *
 * 详情列表一行一个字段（帧高按行数算），正文里的换行会把吸底布局顶出可视区 —— 所以这里
 * 只说「空 / 多少行 / 是什么」，正文本身进 `agent-text` 屏（`$EDITOR`）看与改。
 */
function summarizeMultiline(text: string): string {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) return t("common.emptyWithEditor");
  const lines = body.split("\n");
  return lines.length > 1
    ? t("common.linesWithEditor", { n: lines.length })
    : t("common.bodyWithEditor", { text: body });
}

/** 字段构造器要用的写函数（就是引擎上那几个，收窄成这一面便于单看） */
export interface FieldWriters {
  updateEndpoint: (id: string, change: EndpointChange, message: string) => Promise<string | null>;
  updateModel: (id: string, change: ModelChange, message: string) => Promise<string | null>;
  updateImageModel: (
    id: string,
    change: ImageModelChange,
    message: string,
  ) => Promise<string | null>;
  updateAgent: (agentId: string, change: AgentChange, message: string) => Promise<string | null>;
  setAgentModel: (agentId: string, modelId: string, message: string) => Promise<string | null>;
  /** 改定义的思考参数（`change.modelParams`：档位展开成参数，见 `modelParamsWithLevel`） */
  setAgentThinking: (
    agentId: string,
    change: AgentChange,
    message: string,
  ) => Promise<string | null>;
  /**
   * 存一条 MCP InboxEntry（`mcp.save`）：同名即改、没有即建。
   *
   * `previousName` 与 `server.id` 不同时表示这是改名：旧名字那一条随后删掉（`mcp.remove`），
   * 两次调用合成一条通知。
   */
  saveMcp: (
    scope: McpEditableScope,
    server: McpServerDefinition,
    message: string,
    previousName?: string,
  ) => Promise<string | null>;
}

export interface FieldBuilderDeps {
  config: AppConfig;
  presets: ReasoningPresets;
  writers: FieldWriters;
  go: (next: WizardStep) => void;
}

/** 详情屏要的那六个构造器 */
export interface FieldBuilders {
  endpointFields: (endpoint: EndpointDefinition) => DetailField[];
  modelFields: (model: ModelDefinition) => DetailField[];
  imageModelFields: (model: ImageModelDefinition) => DetailField[];
  /** `siblingIds` 是同一层里其余 InboxEntry 的名字（改名时用来拦下「撞上已有那一条」） */
  mcpServerFields: (
    scope: McpEditableScope,
    server: McpServerDefinition,
    siblingIds: readonly string[],
  ) => DetailField[];
  agentFields: (agent: AgentDefinition) => DetailField[];
  agentPermFields: (agent: AgentDefinition) => DetailField[];
}

export function createFieldBuilders(deps: FieldBuilderDeps): FieldBuilders {
  const { config, presets, writers, go } = deps;

  // ---------- 共享字段 ----------

  /**
   * 「名称」字段：端点 / 模型 / 图片模型 / AgentDefinition 四处的形状逐字相同，只有写回目标不同。
   * 空名称被拦下 —— 名称会进提示语与列表，写空等于把这一条「弄丢」。
   */
  const nameField = (
    id: string,
    name: string | undefined,
    save: (name: string, label: string) => string | null | Promise<string | null>,
  ): DetailField => ({
    key: "name",
    label: t("field.name"),
    kind: "text",
    value: name || id,
    initial: name,
    commit: (raw) => (raw.trim() ? save(raw.trim(), t("field.name")) : t("err.nameRequired")),
  });

  /** 「绑定端点」字段：模型 / 图片模型共用，选项是整份端点表 */
  const endpointIdField = (
    currentEndpointId: string,
    save: (endpointId: string, label: string) => string | null | Promise<string | null>,
  ): DetailField => ({
    key: "endpointId",
    label: t("field.endpoint"),
    kind: "enum",
    value: findEndpoint(config, currentEndpointId)?.name ?? currentEndpointId,
    options: config.endpoints.map((endpoint) => ({
      label: endpoint.name || endpoint.id,
      value: endpoint.id,
    })),
    // 选回原端点不算改动：否则会多发一次写
    commit: (raw) => (raw === currentEndpointId ? null : save(raw, t("field.endpoint"))),
  });

  /** 出厂托管 InboxEntry 的提示后缀：宿主会在写的时候把它转成自定义（PRD F-F3），这里只是告知 */
  const factoryNote = (custom: boolean | undefined) =>
    custom === true ? "" : t("wiz.factoryEditNote");

  // ---------- 端点 ----------

  /**
   * 端点详情字段（名称 / Base URL / API Key / 描述）。
   *
   * `config.endpoints.update` 是合并语义，所以每次提交只发改的那一项；`apiKey` 不提就不出现
   * （= 保留原密钥）。
   */
  const endpointFields = (endpoint: EndpointDefinition): DetailField[] => {
    const name = endpoint.name || endpoint.id;
    const save = (change: EndpointChange, label: string) =>
      writers.updateEndpoint(endpoint.id, change, t("wiz.endpointUpdated", { name, label }));
    return [
      nameField(endpoint.id, endpoint.name, (next, label) => save({ name: next }, label)),
      {
        key: "baseUrl",
        label: "Base URL",
        kind: "text",
        value: endpoint.baseUrl,
        initial: endpoint.baseUrl,
        commit: (raw) =>
          /^https?:\/\//i.test(raw) ? save({ baseUrl: raw }, "Base URL") : t("err.baseUrlScheme"),
      },
      {
        key: "apiKey",
        label: "API Key",
        kind: "secret",
        // 掩码只用于显示：初值留空，用户不动输入框就不会有写入
        value: endpoint.apiKey ? maskSecret(endpoint.apiKey) : t("wiz.endpoint.noKey"),
        initial: "",
        commit: (raw) => (raw ? save({ apiKey: raw }, "API Key") : null),
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: endpoint.description ?? t("common.empty"),
        initial: endpoint.description ?? "",
        // 空串是契约里「清掉描述」的写法（省略 = 不改这一项）
        commit: (raw) => save({ description: raw }, t("field.description")),
      },
    ];
  };

  // ---------- 模型 ----------

  /** 模型详情字段；每个字段一次 `config.models.update`（宿主负责打上 `custom: true`） */
  const modelFields = (model: ModelDefinition): DetailField[] => {
    const name = model.name || model.id;
    const save = (change: ModelChange, label: string) =>
      writers.updateModel(
        model.id,
        change,
        t("wiz.modelUpdated", { name, label, suffix: factoryNote(model.custom) }),
      );
    const thresholds = model.tokenThresholds;
    // 可选档位 = 模型引用的策略在档位表里的键（客户端不抄策略表，只查它）
    const levels = levelsOf(presetOf(presets, model.reasoningPreset));
    const presetValue = model.reasoningPreset
      ? t("wiz.presetLevels", {
          name: model.reasoningPreset,
          levels: levels.length ? levels.join(" / ") : t("common.empty"),
        })
      : t("common.notAdjustable");
    return [
      nameField(model.id, model.name, (next, label) => save({ name: next }, label)),
      endpointIdField(model.endpointId, (next, label) => save({ endpointId: next }, label)),
      {
        key: "modelName",
        label: t("field.modelName"),
        kind: "text",
        value: model.modelName ?? t("common.sameAsId"),
        initial: model.modelName ?? "",
        // 契约里 `modelName` 省略 = 不改，没有「清空」的表达；留空即不发写
        commit: (raw) => (raw ? save({ modelName: raw }, t("field.modelName")) : null),
      },
      {
        key: "reasoningPreset",
        label: t("field.reasoningPreset"),
        kind: "text",
        value: presetValue,
        initial: model.reasoningPreset ?? "",
        // 策略名是否存在由宿主判（`invalid_params` 带着一句能上屏的话回来）
        commit: (raw) => (raw ? save({ reasoningPreset: raw }, t("field.reasoningPreset")) : null),
      },
      {
        key: "handoffTokens",
        label: t("field.handoffThreshold"),
        kind: "number",
        value: String(thresholds.handoff),
        initial: String(thresholds.handoff),
        commit: (raw) => {
          const n = Math.floor(Number(raw.trim()));
          if (!Number.isFinite(n)) return t("err.positiveInteger");
          return save(
            { tokenThresholds: { ...thresholds, handoff: n } },
            t("field.handoffThreshold"),
          );
        },
      },
      {
        key: "guardTokens",
        label: t("field.guardThreshold"),
        kind: "number",
        value: String(thresholds.guard),
        initial: String(thresholds.guard),
        commit: (raw) => {
          const n = Math.floor(Number(raw.trim()));
          if (!Number.isFinite(n)) return t("err.positiveInteger");
          return save({ tokenThresholds: { ...thresholds, guard: n } }, t("field.guardThreshold"));
        },
      },
      {
        key: "vision",
        label: t("field.vision"),
        kind: "bool",
        value: model.vision ? t("common.yes") : t("common.no"),
        toggle: () => save({ vision: model.vision !== true }, t("field.vision")),
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: model.description ?? t("common.empty"),
        initial: model.description ?? "",
        commit: (raw) => save({ description: raw }, t("field.description")),
      },
    ];
  };

  // ---------- 图片模型 ----------

  /** 图片模型详情字段；每次提交都是那一项改动（`config.imageModels.update` 是合并语义） */
  const imageModelFields = (model: ImageModelDefinition): DetailField[] => {
    const name = model.name || model.id;
    const save = (change: ImageModelChange, label: string) =>
      writers.updateImageModel(
        model.id,
        change,
        t("wiz.imageModelUpdated", { name, label, suffix: factoryNote(model.custom) }),
      );
    return [
      nameField(model.id, model.name, (next, label) => save({ name: next }, label)),
      endpointIdField(model.endpointId, (next, label) => save({ endpointId: next }, label)),
      {
        key: "modelName",
        label: t("field.modelName"),
        kind: "text",
        value: model.modelName,
        initial: model.modelName,
        commit: (raw) =>
          raw.trim()
            ? save({ modelName: raw.trim() }, t("field.modelName"))
            : t("err.modelNameRequired"),
      },
      {
        key: "defaultSize",
        label: t("field.size"),
        kind: "text",
        value: model.defaultSize ?? t("common.defaultInParens"),
        initial: model.defaultSize ?? "",
        commit: (raw) => save({ defaultSize: raw }, t("field.size")),
      },
      {
        key: "defaultQuality",
        label: t("field.quality"),
        kind: "text",
        value: model.defaultQuality ?? t("common.defaultInParens"),
        initial: model.defaultQuality ?? "",
        commit: (raw) => save({ defaultQuality: raw }, t("field.quality")),
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: model.description ?? t("common.empty"),
        initial: model.description ?? "",
        commit: (raw) => save({ description: raw }, t("field.description")),
      },
    ];
  };

  // ---------- MCP ----------

  /**
   * MCP 服务器详情字段。
   *
   * `server` 就是 `mcp.list` 给回来的那一条（`McpServerDefinition`），也是 `mcp.save` 收的那一格 ——
   * 所以这里改哪一项就把那一项盖上去发一次写入，一次一条，层里别的 InboxEntry 不受影响
   * （PRD F-F6：按名字增删改）。未知键不在这里：契约里没有 `extra` 这一格，写回时的保全由
   * 宿主那侧与磁盘上那一条合并（`McpConfig.save`）。
   */
  const mcpServerFields = (
    scope: McpEditableScope,
    server: McpServerDefinition,
    siblingIds: readonly string[],
  ): DetailField[] => {
    const scopeName = scopeLabel(scope);
    const save = (change: Partial<McpServerDefinition>, label: string) =>
      writers.saveMcp(
        scope,
        { ...server, ...change },
        t("wiz.mcpFieldUpdated", { id: server.id, label, scope: scopeName }),
      );
    const fields: DetailField[] = [
      {
        key: "id",
        label: t("field.name"),
        kind: "text",
        value: server.id,
        initial: server.id,
        commit: (raw) => {
          const nextId = raw.trim();
          if (!nextId) return t("err.nameRequired");
          if (nextId === server.id) return null;
          // `mcp.save` 对已有的名字是「改那一条」，所以撞名在这里拦：否则会把那一条改掉
          if (siblingIds.includes(nextId)) return t("err.mcpNameTaken", { name: nextId });
          return (async () => {
            // 改名 = 新名字建一条 + 旧名字删一条（`id` 就是 mcpServers 里的键）
            const failure = await writers.saveMcp(
              scope,
              { ...server, id: nextId },
              t("wiz.mcpRenamed", { id: server.id, name: nextId, scope: scopeName }),
              server.id,
            );
            if (!failure) go({ kind: "mcp-server", scope, serverName: nextId });
            return failure;
          })();
        },
      },
      {
        key: "transport",
        label: t("field.transport"),
        kind: "enum",
        value: server.transport,
        options: [
          { label: t("common.transportStdio"), value: "stdio" },
          { label: t("common.transportHttp"), value: "http" },
          { label: t("common.transportSse"), value: "sse" },
        ],
        commit: (raw) =>
          raw === server.transport
            ? null
            : save(
                { transport: raw as McpServerDefinition["transport"] },
                t("common.transportMode"),
              ),
      },
      {
        key: "enabled",
        label: t("field.enabled"),
        kind: "bool",
        value: server.disabled === true ? t("common.disabledInParens") : t("common.yes"),
        toggle: () =>
          save({ disabled: server.disabled === true ? undefined : true }, t("common.enabledState")),
      },
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: server.description ?? t("common.empty"),
        initial: server.description ?? "",
        commit: (raw) => save({ description: raw.trim() || undefined }, t("field.description")),
      },
    ];
    if (server.transport === "stdio") {
      fields.push(
        {
          key: "command",
          label: t("field.command"),
          kind: "text",
          value: server.command ?? t("common.empty"),
          initial: server.command ?? "",
          commit: (raw) => save({ command: raw.trim() || undefined }, t("field.command")),
        },
        {
          key: "args",
          label: t("field.args"),
          kind: "text",
          value: formatArgs(server.args) || t("common.empty"),
          initial: formatArgs(server.args),
          commit: (raw) => {
            const args = parseArgs(raw.trim());
            return save({ args: args.length ? args : undefined }, t("field.args"));
          },
        },
        {
          key: "env",
          label: t("field.env"),
          kind: "open",
          value: kvSummary(server.env),
          open: () => go({ kind: "mcp-kv", scope, serverName: server.id, field: "env" }),
        },
      );
    } else {
      fields.push(
        {
          key: "url",
          label: "URL",
          kind: "text",
          value: server.url ?? t("common.empty"),
          initial: server.url ?? "",
          commit: (raw) => save({ url: raw.trim() || undefined }, "URL"),
        },
        {
          key: "headers",
          label: t("field.headers"),
          kind: "open",
          value: kvSummary(server.headers),
          open: () => go({ kind: "mcp-kv", scope, serverName: server.id, field: "headers" }),
        },
      );
    }
    return fields;
  };

  // ---------- AgentDefinition ----------

  /**
   * Agent / Sub-agent 详情字段。
   *
   * 名称 / 描述 / 模型 / 思考档位 / 权限四维都是单值，改一项就发一项的补丁（宿主按字段合并）。
   * 提示词与子 Agent 的函数说明 / 参数 schema 是**多行**内容：本屏只印一行摘要（正文换行
   * 会让帧高超出可视区），Enter 进 `agent-text` 屏（`$EDITOR`），改完才由 `agentDefinition.update`
   * 写回去。
   */
  const agentFields = (agent: AgentDefinition): DetailField[] => {
    const kindName = agentKindLabel(agent);
    const save = (change: AgentChange, label: string) =>
      writers.updateAgent(
        agent.id,
        change,
        t("wiz.agentFieldUpdated", { kind: kindName, id: agent.id, label, suffix: "" }),
      );
    const thinking = agentThinkingOf(agent, config, presets);
    const modelLabel = findModel(config, agent.modelId ?? config.defaultModel)?.name;
    const fields: DetailField[] = [
      nameField(agent.id, agent.name, (next, label) => save({ name: next }, label)),
      {
        key: "description",
        label: t("field.description"),
        kind: "text",
        value: agent.description ?? t("common.empty"),
        initial: agent.description ?? "",
        commit: (raw) => save({ description: raw }, t("field.description")),
      },
      {
        key: "modelId",
        label: t("field.model"),
        kind: "enum",
        // 定义没绑模型时显示它会落到的那一个（`AppConfig.defaultModel` 兜底，宿主按三级解析）
        value:
          (agent.modelId ? (modelLabel ?? agent.modelId) : t("common.unset")) || t("common.unset"),
        options: config.models.map((model) => ({ label: model.name || model.id, value: model.id })),
        commit: (raw) =>
          raw === agent.modelId
            ? null
            : writers.setAgentModel(
                agent.id,
                raw,
                t("wiz.agentFieldUpdated", {
                  kind: kindName,
                  id: agent.id,
                  label: t("field.model"),
                  suffix: "",
                }),
              ),
      },
    ];
    if (isAdjustable(thinking)) {
      fields.push({
        key: "thinking",
        label: t("field.thinking"),
        kind: "enum",
        value: thinkingView(thinking).text,
        options: thinking.levels.map((level) => ({ label: level, value: level })),
        commit: (raw) =>
          raw === thinking.selected
            ? null
            : writers.setAgentThinking(
                agent.id,
                {
                  modelParams: modelParamsWithLevel(
                    agent.modelParams,
                    presets,
                    presetOf(presets, thinking.preset),
                    raw,
                  ),
                },
                t("wiz.agentThinkingUpdated", { id: agent.id, level: raw }),
              ),
      });
    }
    fields.push({
      key: "prompt",
      label: t("field.prompt"),
      kind: "open",
      value: summarizeMultiline(agentPromptText(agent.messages)),
      open: () => go({ kind: "agent-text", agentId: agent.id, field: "prompt" }),
    });
    // 函数说明与参数 schema 只在子 Agent 上有（`function` 就是那一份定义）；没有就一个字段都不给
    const fn = agent.function;
    if (fn) {
      fields.push(
        {
          key: "functionDescription",
          label: t("field.functionDescription"),
          kind: "open",
          value: summarizeMultiline(fn.description),
          open: () => go({ kind: "agent-text", agentId: agent.id, field: "function-description" }),
        },
        {
          key: "parameters",
          label: t("field.paramsSchema"),
          kind: "open",
          // 格式化后的 JSON：摘要那边会变成「N 行」；编辑器里看到的是能读的那一份
          value: summarizeMultiline(JSON.stringify(fn.parameters ?? {}, null, 2)),
          open: () => go({ kind: "agent-text", agentId: agent.id, field: "function-parameters" }),
        },
      );
    }
    fields.push({
      key: "permissions",
      label: t("field.permissions"),
      kind: "open",
      value: summarizePermissions(agent.permissions),
      open: () => go({ kind: "agent-perms", agentId: agent.id }),
    });
    return fields;
  };

  /** 四维权限子屏字段（`allow: a, b` / `deny: x`；留空清除该维） */
  const agentPermFields = (agent: AgentDefinition): DetailField[] => {
    const kindName = agentKindLabel(agent);
    // 权限是**定义**的一部分：改一次，所有用这个 AgentDefinition 的会话都跟着变（PRD 1.6 / 4.2），
    // 所以四维共用一个写前确认 —— 摆的是影响面，不是字段名
    const confirm = { title: t("wiz.agentWrite.confirmTitle"), cost: [t("wiz.agentWrite.cost")] };
    return PERMISSION_DIMENSIONS.map((dim) => ({
      key: dim,
      label: t(PERMISSION_DIMENSION_LABEL_KEY[dim]),
      kind: "text" as const,
      value: formatAgentPermission(agent.permissions, dim) || t("common.unset"),
      initial: formatAgentPermission(agent.permissions, dim),
      confirm,
      commit: (raw: string) => {
        const parsed = parsePermission(raw);
        if (typeof parsed === "string") return parsed;
        return writers.updateAgent(
          agent.id,
          { permissions: patchPermission(agent.permissions, dim, parsed) },
          t("wiz.agentPermissionUpdated", { kind: kindName, id: agent.id, dim }),
        );
      },
    }));
  };

  return {
    endpointFields,
    modelFields,
    imageModelFields,
    mcpServerFields,
    agentFields,
    agentPermFields,
  };
}
