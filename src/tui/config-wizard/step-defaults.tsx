// 由 src/tui/config-wizard.tsx 拆分而来 —— 默认项子菜单 / 选择默认值
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { findEndpoint, findModel, isApiKeySet, setDefaultAgent, setDefaultImageModel, setDefaultMigrationModel, setDefaultModel } from "../../config-editor.js";
import { DefaultTarget } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";

export function renderDefaultsStep(ctx: WizardContext): ReactNode {
  const { config, store, activeStep, go, commit, cols, rows, props } = ctx;
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

  return null;
}
