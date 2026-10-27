// 由 src/tui/config-wizard.tsx 拆分而来 —— MCP 列表 / 详情 / 键值 / 新建
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { mcpConfigPath, McpScope, McpServerEntry } from "../../config.js";
import { addMcpServer, findMcpServer, mcpServerIdTaken, removeMcpServer, updateMcpServer } from "../../config-editor.js";
import { SWITCH_SCOPE, NEW_MCP_SERVER } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { KvEditorScreen } from "./kv-editor.js";
import { PromptScreen } from "./prompt.js";
import { scopeLabel, mcpCount, mcpServerHint } from "./mcp-helpers.js";
import { t } from "../../i18n/index.js";

export function renderMcpStep(ctx: WizardContext): ReactNode {
  const { mcp, error, notice, activeStep, go, persistMcp, setError, mcpServerFields, cols, rows } = ctx;
  // ---------- MCP 服务器列表（含作用域切换）----------
  if (activeStep.kind === "mcp") {
    const scope = activeStep.scope;
    const other: McpScope = scope === "global" ? "project" : "global";
    const items: SelectItem<string>[] = [
      {
        label: t("wiz.mcp.switchScope", { scope: scopeLabel(other) }),
        value: SWITCH_SCOPE,
        hint: t("wiz.mcp.serverCount", { n: mcpCount(mcp, other) }),
      },
      { label: t("wiz.mcp.newItem"), value: NEW_MCP_SERVER, hint: "stdio / http / sse" },
      ...Object.entries(mcp[scope].mcpServers).map(([id, entry]) => ({
        label: id,
        value: id,
        hint: mcpServerHint(entry),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.listTitle", { scope: scopeLabel(scope) })}
        subtitle={t("wiz.mcp.listSubtitle", { n: mcpCount(mcp, scope), path: mcpConfigPath(scope) })}
        items={items}
        onPick={(value) => {
          if (value === SWITCH_SCOPE) go({ kind: "mcp", scope: other });
          else if (value === NEW_MCP_SERVER) go({ kind: "mcp-new", scope });
          else go({ kind: "mcp-server", scope, serverId: value });
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }


  // ---------- MCP 服务器详情 ----------
  if (activeStep.kind === "mcp-server") {
    const { scope, serverId } = activeStep;
    const entry = findMcpServer(mcp[scope], serverId)!;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.detailTitle", { id: serverId })}
        details={[
          t("wiz.scopePath", { scope: scopeLabel(scope), path: mcpConfigPath(scope) }),
          t("wiz.mcp.detailLine", { transport: entry.type ?? "stdio" }),
        ]}
        fields={mcpServerFields(scope, serverId, entry)}
        notice={notice}
        action={{
          label: t("wiz.mcp.delete"),
          run: async () => {
            const failure = await persistMcp(
              scope,
              removeMcpServer(mcp[scope], serverId),
              t("wiz.mcp.deleted", { id: serverId, scope: scopeLabel(scope) }),
            );
            if (!failure) go({ kind: "mcp", scope });
            return failure;
          },
        }}
        onBack={() => go({ kind: "mcp", scope })}
      />
    );
  }


  // ---------- MCP 键值编辑（env / headers）----------
  if (activeStep.kind === "mcp-kv") {
    const { scope, serverId, field } = activeStep;
    const entry = findMcpServer(mcp[scope], serverId)!;
    const label = field === "env" ? t("field.env") : t("field.headers");
    const current = (entry[field] as Record<string, string> | undefined) ?? {};
    return (
      <KvEditorScreen
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.kvTitle", { id: serverId, label })}
        subtitle={t("wiz.mcp.kvSubtitle", { scope: scopeLabel(scope), n: Object.keys(current).length })}
        map={current}
        notice={notice}
        onCommit={(next) => {
          const patch: Partial<McpServerEntry> =
            field === "env"
              ? { env: Object.keys(next).length ? next : undefined }
              : { headers: Object.keys(next).length ? next : undefined };
          return persistMcp(
            scope,
            updateMcpServer(mcp[scope], serverId, patch),
            t("wiz.mcpFieldUpdated", { id: serverId, label, scope: scopeLabel(scope) }),
          );
        }}
        onBack={() => go({ kind: "mcp-server", scope, serverId })}
      />
    );
  }


  // ---------- 新建 MCP 服务器 ----------
  if (activeStep.kind === "mcp-new") {
    const scope = activeStep.scope;
    return (
      <PromptScreen
        key={`new:mcp:${scope}`}
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.newTitle", { scope: scopeLabel(scope) })}
        details={[t("wiz.mcp.newDescKey"), t("wiz.mcp.newDescDefault")]}
        error={error}
        hints={[["Enter", t("wiz.createAndEdit")], ["Esc", t("ui.back")]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError(t("err.nameRequired"));
            return;
          }
          if (mcpServerIdTaken(mcp[scope], name)) {
            setError(t("err.mcpNameTaken", { name }));
            return;
          }
          const { mcp: next, id } = addMcpServer(mcp[scope], name);
          void (async () => {
            const failure = await persistMcp(scope, next, t("wiz.mcp.created", { id, scope: scopeLabel(scope) }));
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "mcp-server", scope, serverId: id });
          })();
        }}
        onCancel={() => go({ kind: "mcp", scope })}
      />
    );
  }

  return null;
}
