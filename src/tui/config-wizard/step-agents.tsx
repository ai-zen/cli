// Agent 列表 / 详情 / 权限 / 多行文本 / 新建
//
// ## 这一屏按 `AgentDefinition` 收窄
//
// `agentDefinition.list` 回来的是**定义本身**：名称 / 描述 / 模型 / 参数覆盖 / 权限四维 /
// `messages`（提示词）/ `function`（子 Agent 的函数定义）。旧契约那些「宿主算好的视图格」
// —— `isSubAgent` / `isDefault` / `available` / `thinking` —— 都不在里面：
//
//   · `isSubAgent` = `function` 在不在（`agents-store.ts`）；
//   · `isDefault` = `config.defaultAgent` 指着它；
//   · `available` 没有对应：「能不能跑」要解析模型、查端点密钥，那是宿主的判断，
//     客户端不重算（详情屏改为印「端点还没有 API Key」这一条**配置里的事实**）；
//   · `thinking` 由 `modelParams` + 档位表现查（`reasoning-effort.ts` 的 `agentThinkingOf`）。
//
// 提示词与函数定义是**多行**内容，本屏只负责把它们印成一行摘要（`fields.ts` 的 `agentFields`），
// 正文交给 `agent-text` 子屏（`$EDITOR`）。本文件只做一件事：把「哪段文本、写成什么补丁」
// 摊开写清楚 —— 三个字段三种形状，全在这一个分支里，读一遍就知道每次
// `agentDefinition.update` 发的是什么。
import { ReactNode } from "react";
import { Message } from "@ai-zen/agents-core";
import { SelectItem } from "../components.js";
import { agentKindLabel, subAgentList, topLevelAgents } from "../../agents-store.js";
import {
  agentPromptText,
  endpointKeyState,
  findModel,
  parseFunctionParameters,
  uniqueAgentId,
  withAgentFunction,
  withAgentPrompt,
} from "../../config-editor.js";
import { agentThinkingOf, isAdjustable, thinkingView } from "../../reasoning-effort.js";
import { NEW_AGENT } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { PromptScreen } from "./prompt.js";
import { PromptEditorScreen } from "./prompt-editor.js";
import { t } from "../../i18n/index.js";

export function renderAgentsStep(ctx: WizardContext): ReactNode {
  const {
    config,
    presets,
    agents,
    error,
    notice,
    activeStep,
    go,
    createAgent,
    deleteAgent,
    updateAgent,
    setError,
    agentFields,
    agentPermFields,
    sessionsByAgent,
    cols,
    rows,
    props,
  } = ctx;

  /**
   * 改助手**定义**（提示词 / 函数说明 / 参数 schema）之前那一次确认（PRD 1.6 / 4.2）。
   *
   * 文案说人话、说影响面（正在看的那段回答会断），不是字段名 —— 人关心的是「我正在看的那个
   * 会不会没」，不是「哪个字段被改了」。
   */
  const definitionConfirm = {
    title: t("wiz.agentWrite.confirmTitle"),
    cost: [t("wiz.agentWrite.cost")],
  };

  // ---------- Agent 定义列表 ----------
  if (activeStep.kind === "agents") {
    const items: SelectItem<string>[] = [
      { label: t("wiz.agents.new"), value: NEW_AGENT, hint: t("wiz.agents.newHint") },
      ...agents.agents.map((agent) => {
        const model = findModel(config, agent.modelId ?? config.defaultModel);
        return {
          label: agent.name || agent.id,
          value: agent.id,
          hint: t("wiz.agents.itemHint", {
            kind: agentKindLabel(agent),
            id: agent.id,
            factory: agent.custom === true ? "" : t("wiz.agent.factorySuffix"),
            default: agents.defaultAgentId === agent.id ? t("wiz.agents.defaultSuffix") : "",
            // 「能用吗」客户端不算：只说得出「模型还在不在」这一条配置事实
            state: model ? "" : t("wiz.agents.noModelSuffix"),
          }),
        };
      }),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.agents.title")}
        subtitle={t("wiz.menu.agentsSummary", {
          agent: topLevelAgents(agents).length,
          sub: subAgentList(agents).length,
          default: agents.defaultAgentId ?? t("common.unsetPlain"),
        })}
        warning={error ?? undefined}
        items={items}
        onPick={(value) =>
          value === NEW_AGENT ? go({ kind: "agent-new" }) : go({ kind: "agent", agentId: value })
        }
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- Agent 详情 ----------
  if (activeStep.kind === "agent") {
    const agent = agents.agents.find((item) => item.id === activeStep.agentId)!;
    const kindName = agentKindLabel(agent);
    const thinking = agentThinkingOf(agent, config, presets);
    const model = findModel(config, agent.modelId ?? config.defaultModel);
    const key = model ? endpointKeyState(config, model) : null;
    /**
     * 删之前摆的代价（PRD 3.4 / 4.2）：改助手定义影响的是**所有用它的会话**。
     *
     * 数字只来自手里已数过的那一份（向导宿主用 `workspace.list` + `session.list` 数的）；
     * 数不出来就只说影响面，不编一个数。
     */
    const sessionCount = sessionsByAgent?.[agent.id] ?? null;
    const deleteCost = [
      sessionCount === null
        ? t("wiz.agent.deleteCost")
        : sessionCount === 0
          ? t("wiz.agent.deleteCostZero")
          : t("wiz.agent.deleteCostCount", { n: sessionCount }),
      // 默认助手被删时宿主会把默认项一起清掉（同一次写盘）：这件事也得事前说
      ...(agents.defaultAgentId === agent.id ? [t("wiz.agent.deleteCostDefault")] : []),
    ];
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={t("wiz.agent.detailTitle", { kind: kindName, name: agent.name || agent.id })}
        details={[
          t("wiz.agent.detailLine", {
            id: agent.id,
            kind: agent.custom === true ? t("wiz.kind.custom") : t("wiz.kind.factory"),
            default: agents.defaultAgentId === agent.id ? t("wiz.agents.defaultSuffix") : "",
          }),
          ...(model
            ? key?.ready
              ? []
              : [t("wiz.model.endpointNoKey", { endpoint: key?.endpointName ?? model.endpointId })]
            : [t("wiz.agents.modelMissing")]),
          ...(isAdjustable(thinking)
            ? [
                t("wiz.agent.thinkingLine", {
                  preset: thinking.preset ?? "",
                  levels: thinking.levels.join(" / "),
                }),
              ]
            : [t("wiz.agent.thinkingFixed", { state: thinkingView(thinking).text })]),
          t("wiz.agent.moveHint"),
        ]}
        fields={agentFields(agent)}
        notice={notice}
        actions={[
          {
            label: t("wiz.agent.deleteAction", { kind: kindName }),
            danger: true,
            cost: deleteCost,
            // 删的是默认助手时宿主会顺带清掉默认（同一次写盘）：引擎会再读一次配置
            run: async () => {
              const failure = await deleteAgent(
                agent.id,
                t("wiz.agentDeleted", { kind: kindName, id: agent.id }),
              );
              if (!failure) go({ kind: "agents" });
              return failure;
            },
          },
        ]}
        onBack={() => go({ kind: "agents" })}
      />
    );
  }

  // ---------- Agent 权限子屏 ----------
  if (activeStep.kind === "agent-perms") {
    const agent = agents.agents.find((item) => item.id === activeStep.agentId)!;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={t("wiz.agent.subscreenTitle", {
          kind: agentKindLabel(agent),
          id: agent.id,
          label: t("field.permissions"),
        })}
        details={[t("wiz.agent.permHint"), t("wiz.agent.permMoveHint")]}
        fields={agentPermFields(agent)}
        notice={notice}
        onBack={() => go({ kind: "agent", agentId: agent.id })}
      />
    );
  }

  // ---------- 助手的多行文本子屏（提示词 / 函数说明 / 参数 schema）----------
  //
  // 三个字段三种写入形状，都在这里摊开：
  //   · 提示词：`messages` 是**整串**替换，所以补丁给整串（首条 system 换 content）；
  //   · 函数说明 / 参数 schema：`function` 是**整份**替换，所以补丁给整个对象
  //     （只发改的那一项会把兄弟字段冲掉）。
  // 空的提示词 / 空的说明是合法写入（清空是用户的正当操作）；参数 schema 非空且必须是
  // JSON 对象，非法时当场拦下、一次写都不发。
  if (activeStep.kind === "agent-text") {
    const { agentId, field } = activeStep;
    const agent = agents.agents.find((item) => item.id === agentId)!;
    const kindName = agentKindLabel(agent);
    const back = () => go({ kind: "agent", agentId: agent.id });
    /** 写成功那一句：与其它字段同一条口吻（`{kind} {id} 的{label}已更新`） */
    const message = (label: string) =>
      t("wiz.agentFieldUpdated", { kind: kindName, id: agent.id, label, suffix: "" });
    const fn = agent.function;

    if (field === "prompt") {
      return (
        <PromptEditorScreen
          openEditor={props.openEditor}
          columns={cols}
          rows={rows}
          title={t("wiz.agent.subscreenTitle", {
            kind: kindName,
            id: agent.id,
            label: t("field.prompt"),
          })}
          subtitle={t("wiz.agent.editorSubtitle")}
          // 只认首条 system 的纯文本（分段内容表达不了，见 `agentPromptText`）
          text={agentPromptText(agent.messages)}
          notice={notice}
          confirm={definitionConfirm}
          onSave={(value) =>
            updateAgent(
              agent.id,
              { messages: withAgentPrompt(agent.messages, value) },
              message(t("field.prompt")),
            )
          }
          onBack={back}
        />
      );
    }

    // 剩下两个都在函数定义上：不是子 Agent（没有 `function`）就没有可改的东西，
    // 详情屏也不会给这两个字段，这里只是兜住「有人直接把步骤指过来」这一种意外
    if (!fn) return null;

    if (field === "function-description") {
      return (
        <PromptEditorScreen
          openEditor={props.openEditor}
          columns={cols}
          rows={rows}
          title={t("wiz.agent.subscreenTitle", {
            kind: kindName,
            id: agent.id,
            label: t("field.functionDescription"),
          })}
          subtitle={t("wiz.agent.editorSubtitle")}
          text={fn.description}
          notice={notice}
          confirm={definitionConfirm}
          onSave={(value) =>
            updateAgent(
              agent.id,
              { function: withAgentFunction(fn, { description: value }) },
              message(t("field.functionDescription")),
            )
          }
          onBack={back}
        />
      );
    }

    return (
      <PromptEditorScreen
        openEditor={props.openEditor}
        columns={cols}
        rows={rows}
        title={t("wiz.agent.subscreenTitle", {
          kind: kindName,
          id: agent.id,
          label: t("field.paramsSchema"),
        })}
        subtitle={t("wiz.agent.fnParamsSubtitle")}
        // 格式化后再给编辑器：`json` 后缀能吃上语法高亮
        text={JSON.stringify(fn.parameters ?? {}, null, 2)}
        ext="json"
        notice={notice}
        confirm={definitionConfirm}
        onSave={(value) => {
          const parsed = parseFunctionParameters(value);
          // 非法 JSON：**不发请求**，把这句人话交回编辑器屏（它会把改动留住让人接着改）
          if (typeof parsed === "string") return Promise.resolve(parsed);
          return updateAgent(
            agent.id,
            { function: withAgentFunction(fn, { parameters: parsed }) },
            message(t("field.paramsSchema")),
          );
        }}
        onBack={back}
      />
    );
  }

  // ---------- 新建 Agent（顶层）----------
  if (activeStep.kind === "agent-new") {
    return (
      <PromptScreen
        key="new:agent"
        columns={cols}
        rows={rows}
        title={t("wiz.agent.newTitle", { kind: "Agent" })}
        details={[
          t("wiz.agent.newDesc", { example: "Coder" }),
          t("wiz.agent.newDescAgent"),
          t("wiz.agent.newPromptNote"),
        ]}
        error={error}
        hints={[
          ["Enter", t("wiz.createAndEdit")],
          ["Esc", t("ui.back")],
        ]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError(t("err.nameRequired"));
            return;
          }
          const id = uniqueAgentId(
            agents.agents.map((agent) => agent.id),
            name,
            "agent",
          );
          void (async () => {
            const failure = await createAgent(
              {
                id,
                name,
                // 提示词是 `agentDefinition.create` 的必填项（至少一条 system）；新建的这一条先是
                // 空的，建完就在「助手 → 系统提示词」里写（宿主只校验非空 + 有 system，空串合法）
                messages: [Message.System("")],
              },
              t("wiz.agent.created", { kind: "Agent", name, id }),
            );
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "agent", agentId: id });
          })();
        }}
        onCancel={() => go({ kind: "agents" })}
      />
    );
  }

  return null;
}
