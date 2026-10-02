// 由 src/tui/config-wizard.tsx 拆分而来 —— 向导入口（装配引擎 + 分发到各步骤模块）
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

/**
 * 配置向导主体 —— 装配引擎（`useWizardEngine`）后，把当前步骤分发给各 `step-*` 模块渲染。
 *
 * 每个 `renderXxx` 只处理自己负责的 step.kind，未命中时返回 `null`；`??` 串联即为步骤机。
 * 引擎与各步骤模块共享同一个 `WizardContext`（引擎状态 + 尺寸 + props）。
 */
export function ConfigWizard(props: ConfigWizardProps) {
  const { columns, rows: terminalRows } = useWindowSize();
  const cols = columns ?? 80;
  const rows = terminalRows ?? 24;

  const engine = useWizardEngine(props);
  const ctx: WizardContext = { ...engine, cols, rows, props };

  return (
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
