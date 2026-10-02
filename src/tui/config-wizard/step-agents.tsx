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

export function renderAgentsStep(ctx: WizardContext): ReactNode {
  const { store, error, notice, activeStep, go, saveAgent, deleteAgent, setError, agentFields, agentPermFields, cols, rows } = ctx;
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
          title={`◆ ${agentKindLabel(agentKind)} · ${def.id} · 参数 schema`}
          subtitle="JSON 对象；Enter 打开系统编辑器，保存后立即校验并写盘"
          text={JSON.stringify(def.function?.parameters ?? {}, null, 2)}
          ext="json"
          notice={notice}
          onSave={(value) => {
            const parsed = parseFunctionParameters(value);
            if (typeof parsed === "string") return Promise.resolve(parsed);
            return saveAgent(agentKind, updateAgentFunction(target, { parameters: parsed }), `${name} 的参数 schema 已更新`);
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
          title={`◆ ${agentKindLabel(agentKind)} · ${def.id} · 函数说明`}
          subtitle="Enter 打开系统编辑器（$EDITOR / notepad）；改完保存即写盘"
          text={def.function?.description ?? ""}
          notice={notice}
          onSave={(value) => saveAgent(agentKind, updateAgentFunction(target, { description: value }), `${name} 的函数说明已更新`)}
          onBack={back}
        />
      );
    }

    // field === "prompt"
    return (
      <PromptEditorScreen
        columns={cols}
        rows={rows}
        title={`◆ ${agentKindLabel(agentKind)} · ${def.id} · 提示词`}
        subtitle="Enter 打开系统编辑器（$EDITOR / notepad）；改完保存即写盘"
        text={getAgentPrompt(def)}
        notice={notice}
        onSave={(value) => saveAgent(agentKind, setAgentPrompt(target, value), `${name} 的提示词已更新`)}
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

  return null;
}
