// 由 src/tui/config-wizard.tsx 拆分而来 —— 工具输出上限 / 端点字段直达编辑
import { ReactNode } from "react";
import { apiKeyGuide, findEndpoint, maskApiKey, setEndpointApiKey, setEndpointBaseUrl, setMaxToolOutput } from "../../config-editor.js";
import { WizardContext } from "./engine.js";
import { PromptScreen } from "./prompt.js";

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
        title="工具输出上限（字符数）"
        details={[`当前：${current}`, "工具单次输出超过该值时落盘或仅警告，避免撑爆上下文"]}
        initialValue={String(current)}
        error={error}
        hints={[["Enter", "保存"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const n = Number(value.trim());
          if (!Number.isFinite(n) || n <= 0) {
            setError("需为正整数");
            return;
          }
          void commit(setMaxToolOutput(config, Math.floor(n)), `工具输出上限 → ${Math.floor(n)} 字符`, [], { kind: "menu" });
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
          title={props.onboarding ? `首次配置 · 设置 ${name} 的 API Key` : `设置 API Key · ${name}`}
          details={[
            `端点：${name} · ${endpoint.baseUrl}`,
            `当前：${maskApiKey(endpoint.apiKey)}`,
            guide.url
              ? `${guide.vendor} 申请地址：${guide.url}`
              : `${guide.vendor}：请向服务提供方获取 API Key`,
            props.onboarding ? "保存后立即进入对话（Esc 放弃并退出）。" : undefined,
          ].filter((line): line is string => Boolean(line))}
          mask
          error={error}
          hints={[
            ["Enter", props.onboarding ? "保存并进入对话" : "保存"],
            ["Tab", "明文/掩码"],
            ["Esc", props.closeOnSave ? "放弃" : "返回"],
          ]}
          onSubmit={(value) => {
            const key = value.trim();
            if (!key) {
              setError("API Key 不能为空");
              return;
            }
            void commit(setEndpointApiKey(config, endpoint.id, key), `端点 ${name} 的 API Key 已更新`, [endpoint.id]);
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
        title={`设置 Base URL · ${name}`}
        details={[`当前：${endpoint.baseUrl}`, "需以 http:// 或 https:// 开头（OpenAI 兼容端点）"]}
        initialValue={endpoint.baseUrl}
        error={error}
        hints={[["Enter", "保存"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError("Base URL 需以 http:// 或 https:// 开头");
            return;
          }
          void commit(setEndpointBaseUrl(config, endpoint.id, baseUrl), `端点 ${name} 的 Base URL 已更新`, [endpoint.id]);
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  return null;
}
