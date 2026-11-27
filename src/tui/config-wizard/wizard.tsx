import { useWindowSize } from "ink";
import { useWizardEngine, type WizardContext } from "./engine.js";
import type { ConfigWizardProps } from "./types.js";
import { renderMenuStep } from "./step-menu.js";
import { renderDefaultsStep } from "./step-defaults.js";
import { renderEndpointsStep } from "./step-endpoints.js";
import { renderModelsStep } from "./step-models.js";
import { renderMcpStep } from "./step-mcp.js";
import { renderAgentsStep } from "./step-agents.js";
import { renderSimpleStep } from "./step-simple.js";
import { renderNewEndpointStep } from "./step-new-endpoint.js";
import { renderOnboardingStep } from "./step-onboarding.js";

export function ConfigWizard(props: ConfigWizardProps) {
  const windowSize = useWindowSize();
  // 注入的尺寸用于测试固定帧高；未注入时按真实窗口尺寸，再退到 80×24
  const cols = props.terminalSize?.columns ?? windowSize.columns ?? 80;
  const rows = props.terminalSize?.rows ?? windowSize.rows ?? 24;

  const engine = useWizardEngine(props);
  const ctx: WizardContext = { ...engine, cols, rows, props };

  return (
    renderOnboardingStep(ctx) ??
    renderMenuStep(ctx) ??
    renderDefaultsStep(ctx) ??
    renderEndpointsStep(ctx) ??
    renderModelsStep(ctx) ??
    renderMcpStep(ctx) ??
    renderAgentsStep(ctx) ??
    renderSimpleStep(ctx) ??
    renderNewEndpointStep(ctx)
  );
}
