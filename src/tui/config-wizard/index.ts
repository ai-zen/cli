// 配置向导（config-wizard）—— 对外统一出口
//
// 原 src/tui/config-wizard.tsx（2659 行）已按职责拆分为本目录下的多个模块，
// 此处仅做 re-export，保持既有引用路径 `./config-wizard/index.js` 不变。

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
