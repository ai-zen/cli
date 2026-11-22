// 端点列表 / 端点详情
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { maskSecret, modelsUsingEndpoint } from "../../config-editor.js";
import { NEW_ENDPOINT } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { t } from "../../i18n/index.js";

export function renderEndpointsStep(ctx: WizardContext): ReactNode {
  const { config, notice, activeStep, go, deleteEndpoint, endpointFields, cols, rows } = ctx;

  // ---------- 端点管理（[新建端点] + 端点列表）----------
  if (activeStep.kind === "endpoints") {
    const items: SelectItem<string>[] = [
      {
        label: t("wiz.endpoints.newItem"),
        value: NEW_ENDPOINT,
        hint: t("wiz.endpoints.newItemHint"),
      },
      ...config.endpoints.map((endpoint) => ({
        label: endpoint.name || endpoint.id,
        value: endpoint.id,
        // 密钥是明文存在配置里的，屏上只印掩码（`maskSecret`）
        hint: `${endpoint.apiKey ? maskSecret(endpoint.apiKey) : t("wiz.endpoint.noKey")} · ${endpoint.baseUrl}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.menu.endpoints")}
        subtitle={t("wiz.endpoints.subtitle", { n: config.endpoints.length })}
        items={items}
        onPick={(value) =>
          value === NEW_ENDPOINT
            ? go({ kind: "new-endpoint", field: "name", draft: ctx.draft })
            : go({ kind: "endpoint", endpointId: value })
        }
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 端点详情（就地编辑名称 / Base URL / API Key / 描述）----------
  if (activeStep.kind === "endpoint") {
    const endpoint = config.endpoints.find((item) => item.id === activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;
    const hangingModels = modelsUsingEndpoint(config, endpoint.id);
    const hangingImageModels = (config.imageModels ?? []).filter(
      (model) => model.endpointId === endpoint.id,
    );
    const modelCount = hangingModels.length;
    /**
     * 删之前的「代价」（PRD 3.4）：还有谁指它。
     *
     * 宿主的拒绝（一句「先把它们换走或删掉」）是**事后**；这里拿 `config.get` 那一份整份配置
     * 事先把它摆出来。名字用 id（模型标题可以重名，id 是配置里的键，删的时候就是认它）。
     */
    const deleteCost = [
      ...(modelCount > 0
        ? [
            t("wiz.endpoints.deleteCostModels", {
              n: modelCount,
              names: hangingModels.map((model) => model.id).join(t("common.listSep")),
            }),
          ]
        : []),
      ...(hangingImageModels.length > 0
        ? [
            t("wiz.endpoints.deleteCostImageModels", {
              n: hangingImageModels.length,
              names: hangingImageModels.map((model) => model.id).join(t("common.listSep")),
            }),
          ]
        : []),
      ...(modelCount === 0 && hangingImageModels.length === 0
        ? [t("wiz.endpoints.deleteCostNone")]
        : []),
    ];
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={t("wiz.endpoints.detailTitle", { name })}
        details={[
          t("wiz.endpoints.detailLine", {
            id: endpoint.id,
            refs: modelCount > 0 ? t("wiz.endpoints.refSuffix", { n: modelCount }) : "",
          }),
          t("wiz.endpoints.moveHint"),
        ]}
        fields={endpointFields(endpoint)}
        notice={notice}
        actions={[
          {
            label: t("wiz.endpoints.delete"),
            danger: true,
            cost: deleteCost,
            // 还有模型挂在它上面时宿主拒删，并说清挂着的是哪几条（那句话原样上屏）
            run: async () => {
              const failure = await deleteEndpoint(
                endpoint.id,
                t("wiz.endpoints.deleted", { name }),
              );
              if (!failure) go({ kind: "endpoints" });
              return failure;
            },
          },
        ]}
        onBack={() => go({ kind: "endpoints" })}
      />
    );
  }

  return null;
}
