// 由 src/tui/config-wizard.tsx 拆分而来 —— 默认项子菜单 / 选择默认值
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { findEndpoint, findModel, isApiKeySet, setDefaultAgent, setDefaultImageModel, setDefaultMigrationModel } from "../../config-editor.js";
import { DefaultTarget } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { t } from "../../i18n/index.js";

export function renderDefaultsStep(ctx: WizardContext): ReactNode {
  const { config, store, activeStep, go, commit, cols, rows, props } = ctx;
  // ---------- 默认项子菜单 ----------
  if (activeStep.kind === "defaults") {
    const defaultImage = (config.imageModels ?? []).find((model) => model.id === config.defaultImageModel);
    const items: SelectItem<DefaultTarget>[] = [
      {
        label: t("wiz.defaults.imageModel"),
        value: "defaultImageModel",
        hint: defaultImage?.name ?? config.defaultImageModel ?? t("common.unsetPlain"),
      },
      { label: t("wiz.defaults.agent"), value: "defaultAgent", hint: config.defaultAgent ?? t("common.unsetPlain") },
      {
        label: t("wiz.defaults.migrationModel"),
        value: "defaultMigrationModel",
        hint: findModel(config, config.defaultMigrationModel)?.name ?? config.defaultMigrationModel ?? t("common.unsetPlain"),
      },
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.defaults.title")}
        subtitle={t("wiz.defaults.subtitle")}
        items={items}
        onPick={(target) => go({ kind: "pick-default", target })}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }


  // ---------- 选择某个默认项的值 ----------
  if (activeStep.kind === "pick-default") {
    const target = activeStep.target;
    let title = t("wiz.defaults.title");
    let items: SelectItem<string>[] = [];
    if (target === "defaultMigrationModel") {
      title = t("wiz.defaults.migrationModel");
      items = config.models.map((model) => {
        const endpoint = findEndpoint(config, model.endpointId);
        return {
          label: model.name || model.id,
          value: model.id,
          hint: t("wiz.defaults.itemHint", {
            endpoint: endpoint?.name ?? model.endpointId,
            state: isApiKeySet(endpoint?.apiKey) ? t("wiz.defaults.keyReady") : t("wiz.defaults.missingKey"),
          }),
        };
      });
    } else if (target === "defaultImageModel") {
      title = t("wiz.defaults.imageModel");
      items = (config.imageModels ?? []).map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
      }));
    } else {
      title = t("wiz.defaults.agent");
      const source = props.agentStore
        ? store.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id }))
        : (props.agents ?? []);
      items = source.map((agent) => ({ label: agent.name, value: agent.id, hint: agent.id }));
    }
    items = [...items, { label: t("common.unset"), value: "" }];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={title}
        subtitle={t("wiz.defaults.pickSubtitle")}
        items={items}
        onPick={(value) => {
          const id = value || undefined;
          const label = value || t("common.unsetPlain");
          if (target === "defaultMigrationModel")
            void commit(setDefaultMigrationModel(config, id), t("wiz.defaults.updated", { label: t("wiz.defaults.migrationModel"), value: label }), [], { kind: "defaults" });
          else if (target === "defaultImageModel")
            void commit(setDefaultImageModel(config, id), t("wiz.defaults.updated", { label: t("wiz.defaults.imageModel"), value: label }), [], { kind: "defaults" });
          else void commit(setDefaultAgent(config, id), t("wiz.defaults.updated", { label: t("wiz.defaults.agent"), value: label }), [], { kind: "defaults" });
        }}
        onCancel={() => go({ kind: "defaults" })}
      />
    );
  }

  return null;
}
