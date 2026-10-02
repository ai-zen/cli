// 由 src/tui/config-wizard.tsx 拆分而来 —— 端点列表 / 端点详情
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { findEndpoint, maskApiKey, modelsUsingEndpoint, removeEndpoint } from "../../config-editor.js";
import { NEW_ENDPOINT } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";

export function renderEndpointsStep(ctx: WizardContext): ReactNode {
  const { config, notice, draft, activeStep, go, persist, endpointFields, cols, rows } = ctx;
  // ---------- 端点管理（[新建端点] + 端点列表）----------
  if (activeStep.kind === "endpoints") {
    const items: SelectItem<string>[] = [
      { label: "＋ 新建端点", value: NEW_ENDPOINT, hint: "自定义 OpenAI 兼容服务" },
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
        title="端点管理"
        subtitle={`共 ${config.endpoints.length} 个端点 · 选中后可就地编辑 / 删除`}
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
        title={`◆ 端点 · ${name}`}
        details={[`${endpoint.id}${modelCount > 0 ? ` · ${modelCount} 个模型引用` : ""}`, "↑ ↓ 移动 · Enter 编辑 · 改动即时写入磁盘"]}
        fields={endpointFields(endpoint)}
        notice={notice}
        action={{
          label: "删除端点",
          run: async () => {
            const refs = modelsUsingEndpoint(config, endpoint.id);
            if (refs.length > 0) {
              return `无法删除：仍被 ${refs.length} 个模型引用（${refs.map((m) => m.name || m.id).join("、")}），请先删除或改绑这些模型`;
            }
            const failure = await persist(removeEndpoint(config, endpoint.id), `已删除端点 ${name}`);
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
