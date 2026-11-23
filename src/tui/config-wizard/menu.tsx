// 配置中心菜单 MenuStep —— 每一行都是宿主给的现成事实，不在这里算
import { Box, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { SelectList, KeyHints, SelectItem } from "../components.js";
import { subAgentList, topLevelAgents, type AgentList } from "../../agents-store.js";
import { DEFAULT_MAX_TOOL_OUTPUT, summarizeEndpoints } from "../../config-editor.js";
import type { AppConfig, McpEntry } from "../../config.js";
import { mcpEntriesOf } from "../../mcp-command.js";
import { Header, WizardFrame, Row, textRows } from "./frame.js";
import { t } from "../../i18n/index.js";

// ==================== 配置中心菜单 ====================

export interface MenuStepProps {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  /** `config.get` 的那份配置 */
  config: AppConfig;
  /** AgentDefinition 清单（+ 默认 AgentDefinition id） */
  agents: AgentList;
  /** `mcp.list` 的那份服务器清单（每条带 `scope`，两层的条数从这里数） */
  servers: readonly McpEntry[];
  savedCount: number;
  /** 最近一次保存提示（已带上宿主的生效报告） */
  notice?: string | null;
  onPick: (action: string) => void;
  onClose: () => void;
}

export function MenuStep({
  columns,
  rows,
  config,
  agents,
  servers,
  savedCount,
  notice,
  onPick,
  onClose,
}: MenuStepProps) {
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined); // 无文本编辑：隐藏硬件光标
  useInput((_char, key) => {
    if (key.escape) onClose();
  });

  const imageModels = config.imageModels ?? [];
  const defaultImage = imageModels.find((model) => model.id === config.defaultImageModel);
  const defaultAgent = agents.agents.find((agent) => agent.id === agents.defaultAgentId);
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
        n: imageModels.length,
        name: defaultImage?.name ?? config.defaultImageModel ?? t("common.unsetPlain"),
      }),
    },
    {
      label: t("wiz.menu.mcp"),
      value: "mcp",
      hint: t("wiz.menu.mcpSummary", {
        user: mcpEntriesOf(servers, "user").length,
        workspace: mcpEntriesOf(servers, "workspace").length,
      }),
    },
    {
      label: t("wiz.menu.agents"),
      value: "agents",
      hint: t("wiz.menu.agentsSummary", {
        agent: topLevelAgents(agents).length,
        sub: subAgentList(agents).length,
        default: defaultAgent?.name ?? agents.defaultAgentId ?? t("common.unsetPlain"),
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
      hint: t("wiz.menu.maxToolOutputSummary", {
        n: config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT,
      }),
    },
    {
      label: t("wiz.menu.done"),
      value: "done",
      hint: savedCount > 0 ? t("wiz.menu.savedCount", { n: savedCount }) : t("wiz.menu.backToChat"),
    },
  ];

  const headerRows: Row[] = [
    ...textRows(t("wiz.menu.title"), columns, theme.highlight, true),
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
      <KeyHints
        hints={[
          ["↑ ↓", t("ui.select")],
          ["Enter", t("ui.confirm")],
          ["Esc", t("wiz.menu.doneReturn")],
        ]}
      />
    </WizardFrame>
  );
}
