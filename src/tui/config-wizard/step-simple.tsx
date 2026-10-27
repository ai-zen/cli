// 由 src/tui/config-wizard.tsx 拆分而来 —— 工具输出上限 / 端点字段直达编辑
import { ReactNode } from "react";
import { apiKeyGuide, findEndpoint, maskApiKey, setEndpointApiKey, setEndpointBaseUrl, setMaxToolOutput } from "../../config-editor.js";
import { WizardContext } from "./engine.js";
import { PromptScreen } from "./prompt.js";
import { t } from "../../i18n/index.js";

export function renderSimpleStep(ctx: WizardContext): ReactNode {
  const { config, error, activeStep, snapshot, go, commit, setError, cols, rows, props } = ctx;
  // ---------- 工具输出上限 ----------
  if (activeStep.kind === "max-tool-output") {
    const current = config.maxToolOutput ?? 32768;
    return (
      <PromptScreen
        key="maxToolOutput"
        columns={cols}
        rows={rows}
        title={t("wiz.maxToolOutput.title")}
        details={[t("wiz.currentLine", { value: current }), t("wiz.maxToolOutput.desc")]}
        initialValue={String(current)}
        error={error}
        hints={[["Enter", t("ui.save")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const n = Number(value.trim());
          if (!Number.isFinite(n) || n <= 0) {
            setError(t("err.positiveInteger"));
            return;
          }
          void commit(setMaxToolOutput(config, Math.floor(n)), t("wiz.maxToolOutput.updated", { n: Math.floor(n) }), [], { kind: "menu" });
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }


  // ---------- 端点字段直达编辑（首启引导 / `/key`）----------
  if (activeStep.kind === "edit") {
    const endpoint = findEndpoint(config, activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;

    if (activeStep.field === "apiKey") {
      const guide = apiKeyGuide(endpoint.baseUrl);
      return (
        <PromptScreen
          key={`apiKey:${endpoint.id}`}
          columns={cols}
          rows={rows}
          title={props.onboarding ? t("wiz.apiKey.titleOnboarding", { name }) : t("wiz.apiKey.title", { name })}
          details={[
            t("wiz.apiKey.endpointLine", { name, url: endpoint.baseUrl }),
            t("wiz.currentLine", { value: maskApiKey(endpoint.apiKey) }),
            guide.url
              ? t("wiz.apiKey.guideUrl", { vendor: guide.vendor, url: guide.url })
              : t("wiz.apiKey.guideNoUrl", { vendor: guide.vendor }),
            props.onboarding ? t("wiz.apiKey.onboardingNote") : undefined,
          ].filter((line): line is string => Boolean(line))}
          mask
          error={error}
          hints={[
            ["Enter", props.onboarding ? t("wiz.apiKey.saveAndEnter") : t("ui.save")],
            ["Tab", t("ui.plainOrMasked")],
            ["Esc", props.closeOnSave ? t("ui.discard") : t("ui.back")],
          ]}
          onSubmit={(value) => {
            const key = value.trim();
            if (!key) {
              setError(t("err.apiKeyRequired"));
              return;
            }
            void commit(setEndpointApiKey(config, endpoint.id, key), t("wiz.endpointUpdated", { name, label: "API Key" }), [endpoint.id]);
          }}
          onCancel={() => (props.closeOnSave ? props.onClose(snapshot()) : go({ kind: "menu" }))}
        />
      );
    }

    return (
      <PromptScreen
        key={`baseUrl:${endpoint.id}`}
        columns={cols}
        rows={rows}
        title={t("wiz.baseUrl.title", { name })}
        details={[t("wiz.currentLine", { value: endpoint.baseUrl }), t("wiz.baseUrl.hint")]}
        initialValue={endpoint.baseUrl}
        error={error}
        hints={[["Enter", t("ui.save")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError(t("err.baseUrlScheme"));
            return;
          }
          void commit(setEndpointBaseUrl(config, endpoint.id, baseUrl), t("wiz.endpointUpdated", { name, label: "Base URL" }), [endpoint.id]);
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  return null;
}
