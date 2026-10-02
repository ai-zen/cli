// 由 src/tui/config-wizard.tsx 拆分而来 —— 模型 / 图片模型 列表与详情 / 新建
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { addImageModel, addModel, findEndpoint, findModel, removeImageModel, removeModel } from "../../config-editor.js";
import { NEW_MODEL, NEW_IMAGE_MODEL } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { PromptScreen } from "./prompt.js";

export function renderModelsStep(ctx: WizardContext): ReactNode {
  const { config, error, notice, activeStep, go, persist, setError, modelFields, imageModelFields, cols, rows } = ctx;
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

  return null;
}
