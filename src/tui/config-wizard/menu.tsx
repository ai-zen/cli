// 由 src/tui/config-wizard.tsx 拆分而来 —— 配置中心菜单 MenuStep
import { Box, useCursor, useInput } from "ink";
import { AppConfig } from "@ai-zen/agents-sdk";
import { theme } from "../theme.js";
import { SelectList, KeyHints, SelectItem } from "../components.js";
import { CONFIG_FILE } from "../../config.js";
import { AgentStore } from "../../agents-store.js";
import { findModel, summarizeEndpoints } from "../../config-editor.js";
import { McpSnapshot } from "./types.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";
import { mcpCount } from "./mcp-helpers.js";
import { t } from "../../i18n/index.js";

// ==================== 配置中心菜单 ====================

export interface MenuStepProps {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  config: AppConfig;
  mcp: McpSnapshot;
  agentStore: AgentStore;
  savedCount: number;
  /** 最近一次保存提示 */
  notice?: string | null;
  onPick: (action: string) => void;
  onClose: () => void;
}

export function MenuStep({ columns, rows, config, mcp, agentStore, savedCount, notice, onPick, onClose }: MenuStepProps) {
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined); // 无文本编辑：隐藏硬件光标
  useInput((_char, key) => {
    if (key.escape) onClose();
  });

  const defaultImage = (config.imageModels ?? []).find((model) => model.id === config.defaultImageModel);
  const items: SelectItem<string>[] = [
    {
      label: t("wiz.menu.endpoints"),
      value: "endpoints",
      hint: summarizeEndpoints(config),
    },
    {
      label: t("wiz.menu.models"),
      value: "models",
      hint: t("wiz.menu.count", { n: config.models.length }),
    },
    {
      label: t("wiz.menu.imageModels"),
      value: "imageModels",
      hint: t("wiz.menu.imageModelsSummary", {
        n: config.imageModels?.length ?? 0,
        name: defaultImage?.name ?? config.defaultImageModel ?? t("common.unsetPlain"),
      }),
    },
    {
      label: t("wiz.menu.mcp"),
      value: "mcp",
      hint: t("wiz.menu.mcpSummary", {
        global: mcpCount(mcp, "global"),
        project: mcpCount(mcp, "project"),
      }),
    },
    {
      label: t("wiz.menu.agents"),
      value: "agents",
      hint: t("wiz.menu.agentsSummary", {
        agent: agentStore.agents.length,
        sub: agentStore.subAgents.length,
      }),
    },
    {
      label: t("wiz.menu.defaults"),
      value: "defaults",
      hint: t("wiz.menu.defaultsSummary", {
        agent: config.defaultAgent ?? t("common.unsetPlain"),
        model: config.defaultMigrationModel ?? t("common.unsetPlain"),
      }),
    },
    {
      label: t("wiz.menu.maxToolOutput"),
      value: "maxToolOutput",
      hint: t("wiz.menu.maxToolOutputSummary", { n: config.maxToolOutput ?? 32768 }),
    },
    {
      label: t("wiz.menu.done"),
      value: "done",
      hint: savedCount > 0 ? t("wiz.menu.savedCount", { n: savedCount }) : t("wiz.menu.backToChat"),
    },
  ];

  const headerRows: Row[] = [
    ...textRows(t("wiz.menu.title"), columns, theme.highlight, true),
    ...textRows(t("wiz.menu.configFile", { path: CONFIG_FILE }), columns, theme.faint),
    ...textRows(t("wiz.menu.hint"), columns, theme.dim),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
  ];
  const contentLines = headerRows.length + 1 + items.length + 1;

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1}>
        <SelectList items={items} onSelect={onPick} columns={columns} />
      </Box>
      <KeyHints hints={[["↑ ↓", t("ui.select")], ["Enter", t("ui.confirm")], ["Esc", t("wiz.menu.doneReturn")]]} />
    </WizardFrame>
  );
}

