// 由 src/tui/config-wizard.tsx 拆分而来 —— MCP 展示辅助
import { McpScope, McpServerEntry } from "../../config.js";
import { McpSnapshot } from "./types.js";
import { t } from "../../i18n/index.js";

// ==================== MCP 展示辅助 ====================

/** 作用域中文名 */
export function scopeLabel(scope: McpScope): string {
  return scope === "global" ? t("scope.global") : t("scope.project");
}

/** 某作用域下的服务器数量 */
export function mcpCount(mcp: McpSnapshot, scope: McpScope): number {
  return Object.keys(mcp[scope].mcpServers).length;
}

/** MCP 服务器列表项的一行摘要（stdio 显示命令 + 参数，http/sse 显示 URL） */
export function mcpServerHint(entry: McpServerEntry): string {
  const type = entry.type ?? "auto";
  const remote = entry.type === "http" || entry.type === "sse";
  const target = remote ? entry.url ?? t("common.noUrl") : entry.command ?? t("common.noCommand");
  const extra = !remote && entry.args?.length ? ` ${entry.args.join(" ")}` : "";
  const off = entry.disabled === true ? t("common.disabledSuffix") : "";
  return `${type} · ${target}${extra}${off}`;
}

