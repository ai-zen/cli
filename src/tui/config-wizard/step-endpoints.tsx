// 由 src/tui/config-wizard.tsx 拆分而来 —— 端点列表 / 端点详情
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { findEndpoint, maskApiKey, modelsUsingEndpoint, removeEndpoint } from "../../config-editor.js";
import { NEW_ENDPOINT } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { t } from "../../i18n/index.js";

export function renderEndpointsStep(ctx: WizardContext): ReactNode {
  const { config, notice, draft, activeStep, go, persist, endpointFields, cols, rows } = ctx;
  // ---------- 端点管理（[新建端点] + 端点列表）----------
  if (activeStep.kind === "endpoints") {
    const items: SelectItem<string>[] = [
      { label: t("wiz.endpoints.newItem"), value: NEW_ENDPOINT, hint: t("wiz.endpoints.newItemHint") },
      ...config.endpoints.map((endpoint) => ({
        label: endpoint.name || endpoint.id,
        value: endpoint.id,
        hint: `${maskApiKey(endpoint.apiKey)} · ${endpoint.baseUrl}`,
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
            ? go({ kind: "new-endpoint", field: "name", draft })
            : go({ kind: "endpoint", endpointId: value })
        }
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }


  // ---------- 端点详情（就地编辑名称 / Base URL / API Key / 描述）----------
  if (activeStep.kind === "endpoint") {
    const endpoint = findEndpoint(config, activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;
    const modelCount = modelsUsingEndpoint(config, endpoint.id).length;
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
        action={{
          label: t("wiz.endpoints.delete"),
          run: async () => {
            const refs = modelsUsingEndpoint(config, endpoint.id);
            if (refs.length > 0) {
              return t("wiz.endpoints.deleteBlocked", {
                n: refs.length,
                models: refs.map((m) => m.name || m.id).join(t("common.listSep")),
              });
            }
            const failure = await persist(removeEndpoint(config, endpoint.id), t("wiz.endpoints.deleted", { name }));
            if (!failure) go({ kind: "endpoints" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "endpoints" })}
      />
    );
  }

  return null;
}
