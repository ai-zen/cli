// 工具输出上限 / 端点字段直达编辑
import { ReactNode } from "react";
import { apiKeyGuide, DEFAULT_MAX_TOOL_OUTPUT, maskSecret } from "../../config-editor.js";
import { WizardContext } from "./engine.js";
import { PromptScreen } from "./prompt.js";
import { t } from "../../i18n/index.js";

export function renderSimpleStep(ctx: WizardContext): ReactNode {
  const {
    config,
    error,
    activeStep,
    snapshot,
    go,
    updateEndpoint,
    setGlobal,
    runWrite,
    setError,
    cols,
    rows,
    props,
  } = ctx;

  // ---------- 工具输出上限（`config.setGlobal` 的一格）----------
  if (activeStep.kind === "max-tool-output") {
    // 缺省（没写过这一格）由宿主按 32768 算，见 SDK 的 `AppConfig.maxToolOutput`
    const current = config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
    return (
      <PromptScreen
        key="maxToolOutput"
        columns={cols}
        rows={rows}
        title={t("wiz.maxToolOutput.title")}
        details={[t("wiz.currentLine", { value: current }), t("wiz.maxToolOutput.desc")]}
        initialValue={String(current)}
        error={error}
        hints={[
          ["Enter", t("ui.save")],
          ["Esc", t("ui.back")],
        ]}
        onSubmit={(value) => {
          const n = Math.floor(Number(value.trim()));
          if (!Number.isFinite(n) || n <= 0) {
            setError(t("err.positiveInteger"));
            return;
          }
          void runWrite(
            () => setGlobal({ maxToolOutput: n }, t("wiz.maxToolOutput.updated", { n })),
            { kind: "menu" },
          );
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 端点字段直达编辑（首启引导 / `/key`）----------
  if (activeStep.kind === "edit") {
    const endpoint = config.endpoints.find((item) => item.id === activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;

    if (activeStep.field === "apiKey") {
      const guide = apiKeyGuide(endpoint.baseUrl);
      return (
        <PromptScreen
          key={`apiKey:${endpoint.id}`}
          columns={cols}
          rows={rows}
          title={
            props.onboarding
              ? t("wiz.apiKey.titleOnboarding", { name })
              : t("wiz.apiKey.title", { name })
          }
          details={[
            t("wiz.apiKey.endpointLine", { name, url: endpoint.baseUrl }),
            t("wiz.currentLine", {
              value: endpoint.apiKey ? maskSecret(endpoint.apiKey) : t("wiz.endpoint.noKey"),
            }),
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
            // 用户在这里敲的就是新密钥：`apiKey` 显式给出（省略才是「保留原值」）
            void runWrite(
              () =>
                updateEndpoint(
                  endpoint.id,
                  { apiKey: key },
                  t("wiz.endpointUpdated", { name, label: "API Key" }),
                ),
              { kind: "menu" },
            );
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
        hints={[
          ["Enter", t("ui.save")],
          ["Esc", t("ui.back")],
        ]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError(t("err.baseUrlScheme"));
            return;
          }
          void runWrite(
            () =>
              updateEndpoint(
                endpoint.id,
                { baseUrl },
                t("wiz.endpointUpdated", { name, label: "Base URL" }),
              ),
            { kind: "menu" },
          );
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  return null;
}
