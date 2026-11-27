// 模型 / 图片模型 列表与详情 / 新建
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import {
  endpointKeyState,
  findEndpoint,
  uniqueImageModelId,
  uniqueModelId,
} from "../../config-editor.js";
import type { TokenThresholds } from "../../config.js";
import { NEW_MODEL, NEW_IMAGE_MODEL } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailAction, DetailStep } from "./detail.js";
import { PromptScreen } from "./prompt.js";
import { t } from "../../i18n/index.js";

/**
 * 新建模型时先填的两条阈值。
 *
 * 宿主不补这两格：`config.models.create` 收的是整条 `ModelDefinition`，`ModelService` 写前就判「两条阈值
 * 都是数字」并且「交接线小于防护线」，缺了直接 `invalid_params`。所以「省略、让宿主套出厂默认」
 * 那句话不成立，客户端得给出一个起点；新建完立刻进详情屏，这两个数就在第一屏能改的地方。
 *
 * 取值照 SDK 给新模型定的兜底：`normalize.ts` 的 `DEFAULT_HANDOFF_THRESHOLD = 128_000`（那句
 * 注释写明「与 CLI 新建模型的默认值一致」），`guard` 按同一处的 2 倍口径算成 256_000 ——
 * 与出厂模型的比例同源（交接 40% / 阻断 80%，硬线恒在软线的 2 倍处）。模型真实窗口客户端
 * 不知道（那不是配置里的一格），所以这是一个能就地改的起点，不是对窗口的判断。
 */
const NEW_MODEL_THRESHOLDS: TokenThresholds = { handoff: 128_000, guard: 256_000 };

/** 来源标签：出厂托管 / 自定义（宿主在写的时候会把编辑过的转成自定义） */
function kindLabel(custom: boolean | undefined): string {
  return custom === true ? t("wiz.kind.custom") : t("wiz.kind.factory");
}

export function renderModelsStep(ctx: WizardContext): ReactNode {
  const {
    config,
    error,
    notice,
    activeStep,
    go,
    createModel,
    deleteModel,
    resetModel,
    createImageModel,
    deleteImageModel,
    setError,
    modelFields,
    imageModelFields,
    cols,
    rows,
  } = ctx;
  const imageModels = config.imageModels ?? [];

  /**
   * 模型管理是两级：先选供应商（端点），再看那一家底下的模型。
   *
   * 为什么不平铺：一家订阅式端点就带十几二十条模型，平铺之后既难找、也看不出「这是哪家的」；
   * 顺序也不用再靠 hint 里那个端点名去认。与 `/model` 的两级同一套读法。
   *
   * 没有模型的端点在第二级里什么都不显示，所以这里把它们列出来（它们是「还没有给这家厂商配上模型」的
   * 事实，也是新建模型该去的地方）；端点顺序就是配置里的顺序。
   */
  if (activeStep.kind === "models") {
    const noKey = config.models.filter((model) => !endpointKeyState(config, model).ready).length;
    const items: SelectItem<string>[] = config.endpoints.map((endpoint) => {
      const models = config.models.filter((model) => model.endpointId === endpoint.id);
      return {
        label: endpoint.name || endpoint.id,
        value: endpoint.id,
        hint:
          models.length === 0
            ? t("wiz.models.endpointEmpty")
            : t("wiz.models.endpointHint", {
                n: models.length,
                state: endpoint.apiKey ? "" : ` · ${t("wiz.defaults.missingKey")}`,
              }),
      };
    });
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.menu.models")}
        subtitle={
          noKey > 0
            ? t("wiz.menu.modelsSummary", { n: config.models.length, noKey })
            : t("wiz.models.subtitle", { n: config.models.length })
        }
        items={items}
        onPick={(endpointId) => go({ kind: "models-of-endpoint", endpointId })}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  if (activeStep.kind === "models-of-endpoint") {
    const endpoint = config.endpoints.find((item) => item.id === activeStep.endpointId);
    // 端点在这期间被删了（另一个客户端）：退回第一级，不留一块空屏
    if (!endpoint) {
      go({ kind: "models" });
      return null;
    }
    const name = endpoint.name || endpoint.id;
    const models = config.models.filter((model) => model.endpointId === endpoint.id);
    const items: SelectItem<string>[] = [
      { label: t("wiz.models.newItem"), value: NEW_MODEL, hint: t("wiz.models.newItemHint") },
      ...models.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: t("wiz.modelItem.hint", {
          endpoint: name,
          kind: kindLabel(model.custom),
          vision: model.vision ? t("wiz.modelKind.visionSuffix") : "",
          state: endpointKeyState(config, model).ready ? "" : ` · ${t("wiz.defaults.missingKey")}`,
        }),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.models.ofEndpoint", { endpoint: name })}
        subtitle={
          models.length === 0
            ? t("wiz.models.ofEndpointEmpty")
            : t("wiz.models.ofEndpointSubtitle", { n: models.length })
        }
        items={items}
        onPick={(value) =>
          value === NEW_MODEL
            ? go({ kind: "new-model", endpointId: endpoint.id })
            : go({ kind: "model", modelId: value })
        }
        onCancel={() => go({ kind: "models" })}
      />
    );
  }

  if (activeStep.kind === "model") {
    const model = config.models.find((item) => item.id === activeStep.modelId)!;
    const name = model.name || model.id;
    const key = endpointKeyState(config, model);
    /**
     * 删之前的「代价」：删模型要把指向它的默认项改指或清空。
     *
     * 宿主就是这么改的：同端点的第一条剩余模型，一条不剩就清空（`ModelService.remove`）。
     * 这里用 `config.get` 那一份配置把同一件事事前算一遍 —— 客户端不新造规则，只把宿主
     * 那一条摆给人看。
     */
    const remaining = config.models.filter((item) => item.id !== model.id);
    const replacement = remaining.find((item) => item.endpointId === model.endpointId);
    const defaultSlots: { label: string; value: string | undefined }[] = [
      { label: t("wiz.defaults.fallbackModel"), value: config.defaultModel },
      { label: t("wiz.defaults.migrationModel"), value: config.defaultMigrationModel },
      { label: t("wiz.defaults.namingModel"), value: config.namingModel },
    ];
    const affected = defaultSlots.filter((slot) => slot.value === model.id);
    const deleteCost = [
      ...affected.map((slot) =>
        replacement
          ? t("wiz.models.deleteCostRedirect", {
              slot: slot.label,
              target: replacement.name || replacement.id,
            })
          : t("wiz.models.deleteCostCleared", { slot: slot.label }),
      ),
      ...(affected.length === 0 ? [t("wiz.models.deleteCostNone")] : []),
    ];
    const actions: DetailAction[] = [
      {
        // 出厂清单在宿主，客户端不抄一份：不是出厂模型时宿主会拒（`not_found` 一句能上屏的话）
        label: t("wiz.models.restore"),
        run: async () => resetModel(model.id, t("wiz.models.restored", { name })),
      },
      {
        label: t("wiz.models.delete"),
        danger: true,
        cost: deleteCost,
        // 被 AgentDefinition 引用时宿主照删（它只改指默认项），这里不做额外拦截
        run: async () => {
          const failure = await deleteModel(model.id, t("wiz.models.deleted", { name }));
          // 删完回到它所属那一家（这一屏的原位置），而不是退回第一级
          if (!failure) go({ kind: "models-of-endpoint", endpointId: model.endpointId });
          return failure;
        },
      },
    ];
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={t("wiz.models.detailTitle", { name })}
        details={[
          t("wiz.models.detailLine", { id: model.id, kind: kindLabel(model.custom) }),
          ...(key.ready
            ? []
            : [
                t("wiz.model.endpointNoKey", {
                  endpoint: key.endpointName ?? model.endpointId,
                }),
              ]),
          t("wiz.detail.moveHint"),
        ]}
        fields={modelFields(model)}
        notice={notice}
        actions={actions}
        onBack={() => go({ kind: "models-of-endpoint", endpointId: model.endpointId })}
      />
    );
  }

  if (activeStep.kind === "image-models") {
    const items: SelectItem<string>[] = [
      {
        label: t("wiz.imageModels.newItem"),
        value: NEW_IMAGE_MODEL,
        hint: t("wiz.models.newItemHint"),
      },
      ...imageModels.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: t("wiz.modelItem.hint", {
          endpoint: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
          kind: kindLabel(model.custom),
          vision: "",
          state: "",
        }),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.menu.imageModels")}
        subtitle={t("wiz.imageModels.subtitle", { n: imageModels.length })}
        items={items}
        onPick={(value) =>
          value === NEW_IMAGE_MODEL
            ? go({ kind: "new-image-model" })
            : go({ kind: "image-model", modelId: value })
        }
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  if (activeStep.kind === "image-model") {
    const model = imageModels.find((item) => item.id === activeStep.modelId)!;
    const name = model.name || model.id;
    // 代价：默认图片模型指着它时会被改指到同端点的第一条剩余，一条不剩就清空（宿主那一条规则）
    const remaining = imageModels.filter((item) => item.id !== model.id);
    const replacement = remaining.find((item) => item.endpointId === model.endpointId);
    const deleteCost =
      config.defaultImageModel !== model.id
        ? [t("wiz.imageModels.deleteCostNone")]
        : [
            replacement
              ? t("wiz.imageModels.deleteCostRedirect", {
                  target: replacement.name || replacement.id,
                })
              : t("wiz.imageModels.deleteCostCleared"),
          ];
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={t("wiz.imageModels.detailTitle", { name })}
        details={[
          t("wiz.models.detailLine", { id: model.id, kind: kindLabel(model.custom) }),
          t("wiz.detail.moveHint"),
        ]}
        fields={imageModelFields(model)}
        notice={notice}
        actions={[
          {
            label: t("wiz.imageModels.delete"),
            danger: true,
            cost: deleteCost,
            // 正被「默认图片模型」指着时宿主会改去指向别的（改不了就拒），那句话原样上屏
            run: async () => {
              const failure = await deleteImageModel(
                model.id,
                t("wiz.imageModels.deleted", { name }),
              );
              if (!failure) go({ kind: "image-models" });
              return failure;
            },
          },
        ]}
        onBack={() => go({ kind: "image-models" })}
      />
    );
  }

  if (activeStep.kind === "new-model") {
    // 在哪一家下面建的，就绑哪一家（不再默认绑第一个端点）
    const endpoint = config.endpoints.find((item) => item.id === activeStep.endpointId);
    return (
      <PromptScreen
        key="new:model"
        columns={cols}
        rows={rows}
        title={t("wiz.models.createTitle")}
        details={[
          t("wiz.models.createDesc", { example: "My GPT" }),
          endpoint
            ? t("wiz.models.defaultEndpoint", { endpoint: endpoint.name || endpoint.id })
            : t("wiz.models.noEndpoint"),
          t("wiz.models.defaultThresholds", {
            handoff: NEW_MODEL_THRESHOLDS.handoff,
            guard: NEW_MODEL_THRESHOLDS.guard,
          }),
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
          if (!endpoint) {
            setError(t("err.noEndpoint"));
            return;
          }
          const id = uniqueModelId(config, name);
          void (async () => {
            const failure = await createModel(
              {
                id,
                name,
                endpointId: endpoint.id,
                tokenThresholds: NEW_MODEL_THRESHOLDS,
              },
              t("wiz.models.created", { name, id }),
            );
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "model", modelId: id });
          })();
        }}
        onCancel={() => go({ kind: "models-of-endpoint", endpointId: activeStep.endpointId })}
      />
    );
  }

  if (activeStep.kind === "new-image-model") {
    const endpoint = config.endpoints[0];
    return (
      <PromptScreen
        key="new:image-model"
        columns={cols}
        rows={rows}
        title={t("wiz.imageModels.createTitle")}
        details={[
          t("wiz.models.createDesc", { example: "My Image" }),
          endpoint
            ? t("wiz.models.defaultEndpoint", { endpoint: endpoint.name || endpoint.id })
            : t("wiz.models.noEndpoint"),
          t("wiz.imageModels.modelNameHint"),
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
          if (!endpoint) {
            setError(t("err.noEndpoint"));
            return;
          }
          const id = uniqueImageModelId(config, name);
          void (async () => {
            const failure = await createImageModel(
              { id, name, endpointId: endpoint.id, modelName: name },
              t("wiz.imageModels.created", { name, id }),
            );
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "image-model", modelId: id });
          })();
        }}
        onCancel={() => go({ kind: "image-models" })}
      />
    );
  }

  return null;
}
