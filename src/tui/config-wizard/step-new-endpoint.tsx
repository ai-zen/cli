// 由 src/tui/config-wizard.tsx 拆分而来 —— 新建端点（名称 → Base URL → API Key）
import { ReactNode } from "react";
import { addEndpoint, apiKeyGuide } from "../../config-editor.js";
import { WizardContext } from "./engine.js";
import { PromptScreen } from "./prompt.js";

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
        title="新建端点 · 名称"
        details={["用于在配置与状态栏中标识该服务，例如 My Gateway"]}
        initialValue={draft.name}
        error={error}
        hints={[["Enter", "下一步"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
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
        title="新建端点 · Base URL"
        details={["例如 https://api.openai.com/v1（须为 OpenAI 兼容接口）"]}
        initialValue={draft.baseUrl}
        error={error}
        hints={[["Enter", "下一步"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError("Base URL 需以 http:// 或 https:// 开头");
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

  return (
    <PromptScreen
      key="new:apiKey"
      columns={cols}
      rows={rows}
      title="新建端点 · API Key"
      details={[
        `端点：${draft.name} · ${draft.baseUrl}`,
        "可留空稍后再补（留空时该端点暂不可用）",
        apiKeyGuide(draft.baseUrl).url
          ? `${apiKeyGuide(draft.baseUrl).vendor} 申请地址：${apiKeyGuide(draft.baseUrl).url}`
          : undefined,
      ].filter((line): line is string => Boolean(line))}
      mask
      error={error}
      hints={[["Enter", "保存端点"], ["Tab", "明文/掩码"], ["Esc", "返回"]]}
      onSubmit={(value) => {
        const apiKey = value.trim();
        const { config: next, endpoint } = addEndpoint(config, { ...draft, apiKey });
        void commit(
          next,
          `已添加端点 ${endpoint.name}（${endpoint.id}）${apiKey ? "" : " · API Key 待补充"}`,
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
