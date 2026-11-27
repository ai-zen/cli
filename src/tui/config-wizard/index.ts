// 配置向导（config-wizard）—— 对外统一出口
//
// 本目录按职责分成多个模块，此文件只做 re-export：外部（`tui/index.tsx`、
// `tui/screens/*` 等）的导入路径只有 `./config-wizard/index.js` 一个。

export { ConfigWizard } from "./wizard.js";
export { PromptScreen, promptLayout } from "./prompt.js";
export type { PromptLayoutInput, PromptLayout } from "./prompt.js";
export type {
  EndpointField,
  DefaultTarget,
  WizardStep,
  NewEndpointDraft,
  WizardCloseResult,
  WizardHost,
  ConfigWizardProps,
} from "./types.js";
export type { DetailFieldKind, DetailField, DetailAction } from "./detail.js";
