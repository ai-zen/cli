// 配置中心菜单（步骤分发）
import { ReactNode } from "react";
import { WizardContext } from "./engine.js";
import { MenuStep } from "./menu.js";

export function renderMenuStep(ctx: WizardContext): ReactNode {
  const { config, agents, servers, notice, activeStep, snapshot, go, cols, rows, close } = ctx;
  // ---------- 配置中心菜单 ----------
  if (activeStep.kind === "menu") {
    return (
      <MenuStep
        columns={cols}
        rows={rows}
        config={config}
        agents={agents}
        servers={servers}
        savedCount={snapshot().summary.length}
        notice={notice}
        onClose={close}
        onPick={(action) => {
          if (action === "endpoints") go({ kind: "endpoints" });
          else if (action === "models") go({ kind: "models" });
          else if (action === "imageModels") go({ kind: "image-models" });
          else if (action === "mcp") go({ kind: "mcp", scope: "user" });
          else if (action === "agents") go({ kind: "agents" });
          else if (action === "defaults") go({ kind: "defaults" });
          else if (action === "maxToolOutput") go({ kind: "max-tool-output" });
          else close();
        }}
      />
    );
  }

  return null;
}
