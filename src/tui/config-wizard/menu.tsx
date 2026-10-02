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

  const defaultModel = findModel(config, config.defaultModel);
  const defaultImage = (config.imageModels ?? []).find((model) => model.id === config.defaultImageModel);
  const items: SelectItem<string>[] = [
    {
      label: "端点管理",
      value: "endpoints",
      hint: summarizeEndpoints(config),
    },
    {
      label: "模型管理",
      value: "models",
      hint: `${config.models.length} 个 · 默认 ${defaultModel?.name ?? config.defaultModel ?? "未设置"}`,
    },
    {
      label: "图片模型",
      value: "imageModels",
      hint: `${config.imageModels?.length ?? 0} 个 · 默认 ${defaultImage?.name ?? config.defaultImageModel ?? "未设置"}`,
    },
    {
      label: "MCP 服务器",
      value: "mcp",
      hint: `全局 ${mcpCount(mcp, "global")} · 项目 ${mcpCount(mcp, "project")}`,
    },
    {
      label: "Agent 定义",
      value: "agents",
      hint: `Agent ${agentStore.agents.length} · Sub-agent ${agentStore.subAgents.length}`,
    },
    {
      label: "默认项",
      value: "defaults",
      hint: `Agent ${config.defaultAgent ?? "未设置"} · 迁移 ${config.defaultMigrationModel ?? "未设置"}`,
    },
    {
      label: "工具输出上限",
      value: "maxToolOutput",
      hint: `${config.maxToolOutput ?? 32768} 字符`,
    },
    {
      label: "完成",
      value: "done",
      hint: savedCount > 0 ? `已保存 ${savedCount} 项改动` : "返回对话",
    },
  ];

  const headerRows: Row[] = [
    ...textRows("◆ 配置中心", columns, theme.highlight, true),
    ...textRows(`配置文件：${CONFIG_FILE}`, columns, theme.faint),
    ...textRows("改动即时写入磁盘；涉及当前端点的改动会重建会话（消息保留）。", columns, theme.dim),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
  ];
  const contentLines = headerRows.length + 1 + items.length + 1;

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1}>
        <SelectList items={items} onSelect={onPick} columns={columns} />
      </Box>
      <KeyHints hints={[["↑ ↓", "选择"], ["Enter", "确认"], ["Esc", "完成返回"]]} />
    </WizardFrame>
  );
}

