// 由 src/tui/config-wizard.tsx 拆分而来 —— 新建端点（名称 → Base URL → API Key）
import { ReactNode } from "react";
import { addEndpoint, apiKeyGuide } from "../../config-editor.js";
import { WizardContext } from "./engine.js";
import { PromptScreen } from "./prompt.js";
import { t } from "../../i18n/index.js";

export function renderNewEndpointStep(ctx: WizardContext): ReactNode {
  const { config, error, draft, activeStep, go, commit, setDraft, setError, setStep, cols, rows } = ctx;
  if (activeStep.kind !== "new-endpoint") return null;
  // ---------- 新建端点（名称 → Base URL → API Key）----------
  const field = activeStep.field;

  if (field === "name") {
    return (
      <PromptScreen
        key="new:name"
        columns={cols}
        rows={rows}
        title={t("wiz.newEndpoint.nameTitle")}
        details={[t("wiz.newEndpoint.nameDesc", { example: "My Gateway" })]}
        initialValue={draft.name}
        error={error}
        hints={[["Enter", t("ui.next")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError(t("err.nameRequired"));
            return;
          }
          const next = { ...draft, name };
          setDraft(next);
          setError(null);
          setStep({ kind: "new-endpoint", field: "baseUrl", draft: next });
        }}
        onCancel={() => go({ kind: "endpoints" })}
      />
    );
  }

  if (field === "baseUrl") {
    return (
      <PromptScreen
        key="new:baseUrl"
        columns={cols}
        rows={rows}
        title={t("wiz.newEndpoint.baseUrlTitle")}
        details={[t("wiz.newEndpoint.baseUrlDesc")]}
        initialValue={draft.baseUrl}
        error={error}
        hints={[["Enter", t("ui.next")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError(t("err.baseUrlScheme"));
            return;
          }
          const next = { ...draft, baseUrl };
          setDraft(next);
          setError(null);
          setStep({ kind: "new-endpoint", field: "apiKey", draft: next });
        }}
        onCancel={() => {
          setError(null);
          setStep({ kind: "new-endpoint", field: "name", draft });
        }}
      />
    );
  }

  const guide = apiKeyGuide(draft.baseUrl);
  return (
    <PromptScreen
      key="new:apiKey"
      columns={cols}
      rows={rows}
      title={t("wiz.newEndpoint.apiKeyTitle")}
      details={[
        t("wiz.apiKey.endpointLine", { name: draft.name, url: draft.baseUrl }),
        t("wiz.newEndpoint.apiKeyOptional"),
        guide.url ? t("wiz.apiKey.guideUrl", { vendor: guide.vendor, url: guide.url }) : undefined,
      ].filter((line): line is string => Boolean(line))}
      mask
      error={error}
      hints={[["Enter", t("wiz.newEndpoint.save")], ["Tab", t("ui.plainOrMasked")], ["Esc", t("ui.back")]]}
      onSubmit={(value) => {
        const apiKey = value.trim();
        const { config: next, endpoint } = addEndpoint(config, { ...draft, apiKey });
        void commit(
          next,
          t("wiz.newEndpoint.created", {
            name: endpoint.name,
            id: endpoint.id,
            suffix: apiKey ? "" : t("wiz.newEndpoint.keyPending"),
          }),
          [endpoint.id],
          { kind: "endpoints" },
        );
      }}
      onCancel={() => {
        setError(null);
        setStep({ kind: "new-endpoint", field: "baseUrl", draft });
      }}
    />
  );
}
