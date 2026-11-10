// 配置向导（config-wizard）—— 对外统一出口
//
// 本目录按职责分成多个模块，此处只做 re-export —— 本目录只有这一个出口，外部
// （`tui/index.tsx` 等）一律写 `from "./config-wizard/index.js"`。

export { ConfigWizard } from "./wizard.js";
export { PromptScreen, promptLayout } from "./prompt.js";
export type { PromptLayoutInput, PromptLayout } from "./prompt.js";
export type {
  EndpointField,
  DefaultTarget,
  WizardStep,
  NewEndpointDraft,
  WizardCloseResult,
  McpSnapshot,
  ConfigWizardProps,
} from "./types.js";
export type { DetailFieldKind, DetailField, DetailAction } from "./detail.js";
