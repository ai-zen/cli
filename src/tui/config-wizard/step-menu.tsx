// 由 src/tui/config-wizard.tsx 拆分而来 —— 配置中心菜单
import { ReactNode } from "react";
import { WizardContext } from "./engine.js";
import { MenuStep } from "./menu.js";

export function renderMenuStep(ctx: WizardContext): ReactNode {
  const { config, mcp, store, notice, activeStep, acc, snapshot, go, cols, rows, props } = ctx;
  // ---------- 配置中心菜单 ----------
  if (activeStep.kind === "menu") {
    return (
      <MenuStep
        columns={cols}
        rows={rows}
        config={config}
        mcp={mcp}
        agentStore={store}
        savedCount={acc.current.summary.length}
        notice={notice}
        onClose={() => props.onClose(snapshot())}
        onPick={(action) => {
          if (action === "endpoints") go({ kind: "endpoints" });
          else if (action === "models") go({ kind: "models" });
          else if (action === "imageModels") go({ kind: "image-models" });
          else if (action === "mcp") go({ kind: "mcp", scope: "global" });
          else if (action === "agents") go({ kind: "agents" });
          else if (action === "defaults") go({ kind: "defaults" });
          else if (action === "maxToolOutput") go({ kind: "max-tool-output" });
          else props.onClose(snapshot());
        }}
      />
    );
  }

  return null;
}
