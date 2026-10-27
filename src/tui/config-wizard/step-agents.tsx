// 由 src/tui/config-wizard.tsx 拆分而来 —— Agent 列表 / 详情 / 权限 / 提示词 / 新建
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { agentKindLabel, agentList, AgentKind, findAgentDefinition } from "../../agents-store.js";
import { createAgentDefinition, createSubAgentDefinition, getAgentPrompt, parseFunctionParameters, setAgentPrompt, uniqueAgentId, updateAgentFunction } from "../../config-editor.js";
import { NEW_AGENT, NEW_SUBAGENT } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { PromptEditorScreen } from "./prompt-editor.js";
import { PromptScreen } from "./prompt.js";
import { t } from "../../i18n/index.js";

export function renderAgentsStep(ctx: WizardContext): ReactNode {
  const { store, error, notice, activeStep, go, saveAgent, deleteAgent, setError, agentFields, agentPermFields, cols, rows } = ctx;
  // ---------- Agent 定义列表 ----------
  if (activeStep.kind === "agents") {
    const items: SelectItem<string>[] = [
      { label: t("wiz.agents.new"), value: NEW_AGENT, hint: t("wiz.agents.newHint") },
      { label: t("wiz.agents.newSub"), value: NEW_SUBAGENT, hint: t("wiz.agents.newSubHint") },
      ...store.agents.map((def) => ({
        label: def.name || def.id,
        value: `agent:${def.id}`,
        hint: t("wiz.agents.itemHint", {
          kind: agentKindLabel("agent"),
          id: def.id,
          factory: def.custom ? "" : t("wiz.agent.factorySuffix"),
        }),
      })),
      ...store.subAgents.map((def) => ({
        label: def.name || def.id,
        value: `subagent:${def.id}`,
        hint: t("wiz.agents.itemHint", { kind: agentKindLabel("subagent"), id: def.id, factory: "" }),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.agents.title")}
        subtitle={t("wiz.menu.agentsSummary", { agent: store.agents.length, sub: store.subAgents.length })}
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
        title={t("wiz.agent.detailTitle", { kind: agentKindLabel(agentKind), name: def.name || def.id })}
        details={[
          t("wiz.agent.detailLine", {
            id: def.id,
            kind: def.custom ? t("wiz.kind.custom") : t("wiz.kind.factory"),
            subSuffix: agentKind === "subagent" ? t("wiz.agent.subSuffix") : "",
          }),
          t("wiz.agent.moveHint"),
        ]}
        fields={agentFields(agentKind, def)}
        notice={notice}
        action={{
          label: t("wiz.agent.deleteAction", { kind: agentKindLabel(agentKind) }),
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
        title={t("wiz.agent.subscreenTitle", { kind: agentKindLabel(agentKind), id: def.id, label: t("field.permissions") })}
        details={[t("wiz.agent.permHint"), t("wiz.agent.permMoveHint")]}
        fields={agentPermFields(agentKind, def)}
        notice={notice}
        onBack={() => go({ kind: "agent", agentKind, agentId })}
      />
    );
  }


  // ---------- Agent / Sub-agent 多行文本编辑（提示词 / 函数说明 / 参数 schema，系统编辑器）----------
  if (activeStep.kind === "agent-text") {
    const { agentKind, agentId, field } = activeStep;
    const def = findAgentDefinition(store, agentKind, agentId)!;
    const managed = agentKind === "agent" && !def.custom;
    const target = managed ? { ...def, custom: true } : def;
    const name = `${agentKindLabel(agentKind)} ${def.id}`;
    const back = () => go({ kind: "agent", agentKind, agentId });

    if (field === "fnParams") {
      return (
        <PromptEditorScreen
          columns={cols}
          rows={rows}
          title={t("wiz.agent.subscreenTitle", { kind: agentKindLabel(agentKind), id: def.id, label: t("field.paramsSchema") })}
          subtitle={t("wiz.agent.fnParamsSubtitle")}
          text={JSON.stringify(def.function?.parameters ?? {}, null, 2)}
          ext="json"
          notice={notice}
          onSave={(value) => {
            const parsed = parseFunctionParameters(value);
            if (typeof parsed === "string") return Promise.resolve(parsed);
            return saveAgent(agentKind, updateAgentFunction(target, { parameters: parsed }), t("wiz.agent.fnParamsUpdated", { name }));
          }}
          onBack={back}
        />
      );
    }

    if (field === "fnDesc") {
      return (
        <PromptEditorScreen
          columns={cols}
          rows={rows}
          title={t("wiz.agent.subscreenTitle", { kind: agentKindLabel(agentKind), id: def.id, label: t("field.functionDescription") })}
          subtitle={t("wiz.agent.editorSubtitle")}
          text={def.function?.description ?? ""}
          notice={notice}
          onSave={(value) => saveAgent(agentKind, updateAgentFunction(target, { description: value }), t("wiz.agent.fnDescUpdated", { name }))}
          onBack={back}
        />
      );
    }

    // field === "prompt"
    return (
      <PromptEditorScreen
        columns={cols}
        rows={rows}
        title={t("wiz.agent.subscreenTitle", { kind: agentKindLabel(agentKind), id: def.id, label: t("field.prompt") })}
        subtitle={t("wiz.agent.editorSubtitle")}
        text={getAgentPrompt(def)}
        notice={notice}
        onSave={(value) => saveAgent(agentKind, setAgentPrompt(target, value), t("wiz.agent.promptUpdated", { name }))}
        onBack={back}
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
        title={t("wiz.agent.newTitle", { kind: kindName })}
        details={[
          t("wiz.agent.newDesc", { example: "Coder" }),
          kind === "agent" ? t("wiz.agent.newDescAgent") : t("wiz.agent.newDescSub"),
        ]}
        error={error}
        hints={[["Enter", t("wiz.createAndEdit")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError(t("err.nameRequired"));
            return;
          }
          const id = uniqueAgentId(
            agentList(store, kind).map((item) => item.id),
            name,
            kind === "agent" ? "agent" : "subagent",
          );
          const def = kind === "agent" ? createAgentDefinition({ id, name }) : createSubAgentDefinition({ id, name });
          void (async () => {
            const failure = await saveAgent(kind, def, t("wiz.agent.created", { kind: kindName, name, id }));
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

  return null;
}
