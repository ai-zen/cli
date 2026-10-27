// 由 src/tui/config-wizard.tsx 拆分而来 —— 模型 / 图片模型 列表与详情 / 新建
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { addImageModel, addModel, findEndpoint, findModel, removeImageModel, removeModel } from "../../config-editor.js";
import { NEW_MODEL, NEW_IMAGE_MODEL } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { PromptScreen } from "./prompt.js";
import { t } from "../../i18n/index.js";

/** 模型来源标签：`出厂托管` 在详情屏里要多带一句说明（改动会转自定义） */
function kindLabel(custom: boolean | undefined, withNote = false): string {
  if (custom) return t("wiz.kind.custom");
  return t(withNote ? "wiz.modelKind.factoryNote" : "wiz.kind.factory");
}

export function renderModelsStep(ctx: WizardContext): ReactNode {
  const { config, error, notice, activeStep, go, persist, setError, modelFields, imageModelFields, cols, rows } = ctx;
  // ---------- 模型管理 ----------
  if (activeStep.kind === "models") {
    const items: SelectItem<string>[] = [
      { label: t("wiz.models.newItem"), value: NEW_MODEL, hint: t("wiz.models.newItemHint") },
      ...config.models.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: t("wiz.modelItem.hint", {
          endpoint: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
          kind: kindLabel(model.custom),
          vision: model.vision ? t("wiz.modelKind.visionSuffix") : "",
        }),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.menu.models")}
        subtitle={t("wiz.models.subtitle", { n: config.models.length })}
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
        title={t("wiz.models.detailTitle", { name })}
        details={[t("wiz.models.detailLine", { id: model.id, kind: kindLabel(model.custom, true) }), t("wiz.detail.moveHint")]}
        fields={modelFields(model)}
        notice={notice}
        action={{
          label: t("wiz.models.delete"),
          run: async () => {
            const failure = await persist(removeModel(config, model.id), t("wiz.models.deleted", { name }));
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
      { label: t("wiz.imageModels.newItem"), value: NEW_IMAGE_MODEL, hint: t("wiz.models.newItemHint") },
      ...list.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: t("wiz.modelItem.hint", {
          endpoint: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
          kind: kindLabel(model.custom),
          vision: "",
        }),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.menu.imageModels")}
        subtitle={t("wiz.imageModels.subtitle", { n: list.length })}
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
        title={t("wiz.imageModels.detailTitle", { name })}
        details={[t("wiz.models.detailLine", { id: model.id, kind: kindLabel(model.custom, true) }), t("wiz.detail.moveHint")]}
        fields={imageModelFields(model)}
        notice={notice}
        action={{
          label: t("wiz.imageModels.delete"),
          run: async () => {
            const failure = await persist(removeImageModel(config, model.id), t("wiz.imageModels.deleted", { name }));
            if (!failure) go({ kind: "image-models" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "image-models" })}
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
        title={t("wiz.models.createTitle")}
        details={[
          t("wiz.models.createDesc", { example: "My GPT" }),
          config.endpoints.length === 0
            ? t("wiz.models.noEndpoint")
            : t("wiz.models.defaultEndpoint", { endpoint: findEndpoint(config, endpointId)?.name ?? endpointId }),
        ]}
        error={error}
        hints={[["Enter", t("wiz.createAndEdit")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError(t("err.nameRequired"));
            return;
          }
          const { config: next, model } = addModel(config, { name, endpointId });
          void (async () => {
            const failure = await persist(next, t("wiz.models.created", { name: model.name, id: model.id }));
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
        title={t("wiz.imageModels.createTitle")}
        details={[
          t("wiz.models.createDesc", { example: "My Image" }),
          config.endpoints.length === 0
            ? t("wiz.models.noEndpoint")
            : t("wiz.models.defaultEndpoint", { endpoint: findEndpoint(config, endpointId)?.name ?? endpointId }),
        ]}
        error={error}
        hints={[["Enter", t("wiz.createAndEdit")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError(t("err.nameRequired"));
            return;
          }
          const { config: next, model } = addImageModel(config, { name, endpointId });
          void (async () => {
            const failure = await persist(next, t("wiz.imageModels.created", { name: model.name, id: model.id }));
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

  return null;
}
