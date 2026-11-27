// 首启引导：选服务商（端点）→ 填它的密钥 → 首要模型落成默认项
//
// 这一条链只在「初次使用、还没有钥匙」时走（`tui/index.tsx` 的 `ensureCredential` 把入口定为
// `{ kind: "onboarding" }`）。它与 `/model` 那条路共用同一套判据与同一屏密钥输入：
//   · 判据 —— `resolveCredential(config, modelId).configured`（`config-editor.ts`）；
//   · 密钥屏 —— 与 `{ kind: "edit", field: "apiKey" }` 同一个 `PromptScreen`，只是保存之后
//     多走一步「首要模型」（`saveOnboardingKey`）。
//
// 为什么不把「服务商」也做成一次 SelectStep 的临时状态：向导的步骤机已经是那个形状
// （`WizardStep` 判别联合），多一格状态就是第二处「现在在哪一步」的真相。
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import {
  apiKeyGuide,
  endpointHasKey,
  modelsUsingEndpoint,
  primaryModelOf,
} from "../../config-editor.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { PromptScreen } from "./prompt.js";
import { t } from "../../i18n/index.js";

export function renderOnboardingStep(ctx: WizardContext): ReactNode {
  const { config, activeStep, go, runWrite, setError, saveOnboardingKey, cols, rows, props } = ctx;

  /** 这一屏唯一的退出去向：首启引导里 Esc 就是「放弃」（与密钥屏同一套语义） */
  const leave = () => (props.closeOnSave ? props.onClose(ctx.snapshot()) : go({ kind: "menu" }));

  if (activeStep.kind === "onboarding") {
    // 没有对话模型的端点不出现：选了它也没有模型可落（与 `/model` 第一级同一口径）
    const endpoints = config.endpoints.filter(
      (endpoint) => modelsUsingEndpoint(config, endpoint.id).length > 0,
    );
    const items: SelectItem<string>[] = endpoints.map((endpoint) => {
      const name = endpoint.name || endpoint.id;
      const primary = primaryModelOf(config, endpoint.id);
      return {
        label: endpointHasKey(config, endpoint.id) ? `${name}${t("common.current")}` : name,
        value: endpoint.id,
        hint: t("wiz.onboard.endpointHint", {
          // 首要模型写在最前面：选服务商实质上是在选「拿到哪个模型」，而列表的提示栏
          // 只有半行宽（`components.tsx` 的 `fitItem`），排后面的会被截掉
          model: primary ? primary.name || primary.id : t("wiz.onboard.noPrimaryShort"),
          n: modelsUsingEndpoint(config, endpoint.id).length,
          key: endpointHasKey(config, endpoint.id)
            ? t("wiz.onboard.keyReady")
            : t("wiz.endpoint.noKey"),
        }),
      };
    });
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.onboard.title")}
        subtitle={t("wiz.onboard.desc")}
        items={items}
        onPick={(endpointId) => {
          // 已有密钥的服务商：不必再填一遍，直接走「定首要模型」那一半
          if (endpointHasKey(config, endpointId)) {
            void runWrite(() => saveOnboardingKey(endpointId, undefined));
            return;
          }
          go({ kind: "onboarding-key", endpointId });
        }}
        onCancel={leave}
      />
    );
  }

  if (activeStep.kind === "onboarding-key") {
    const endpoint = config.endpoints.find((item) => item.id === activeStep.endpointId);
    // 端点在这期间被删了（另一个客户端）：退回第一步，不留一块空屏
    if (!endpoint) {
      go({ kind: "onboarding" });
      return null;
    }
    const name = endpoint.name || endpoint.id;
    const guide = apiKeyGuide(endpoint.baseUrl);
    const primary = primaryModelOf(config, endpoint.id);
    return (
      <PromptScreen
        key={`onboard:apiKey:${endpoint.id}`}
        columns={cols}
        rows={rows}
        title={t("wiz.onboard.keyTitle", { name })}
        details={[
          t("wiz.apiKey.endpointLine", { name, url: endpoint.baseUrl }),
          primary
            ? t("wiz.onboard.primaryLine", { model: primary.name || primary.id })
            : t("wiz.onboard.noPrimary"),
          guide.url
            ? t("wiz.apiKey.guideUrl", { vendor: guide.vendor, url: guide.url })
            : t("wiz.apiKey.guideNoUrl", { vendor: guide.vendor }),
          t("wiz.onboard.escapeNote"),
        ].filter((line): line is string => Boolean(line))}
        mask
        error={ctx.error}
        hints={[
          ["Enter", t("wiz.apiKey.saveAndEnter")],
          ["Tab", t("ui.plainOrMasked")],
          ["Esc", t("ui.discard")],
        ]}
        onSubmit={(value) => {
          const apiKey = value.trim();
          if (!apiKey) {
            setError(t("err.apiKeyRequired"));
            return;
          }
          void runWrite(() => saveOnboardingKey(endpoint.id, apiKey));
        }}
        onCancel={leave}
      />
    );
  }

  return null;
}
