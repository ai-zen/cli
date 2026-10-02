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

export function renderMcpStep(ctx: WizardContext): ReactNode {
  const { mcp, error, notice, activeStep, go, persistMcp, setError, mcpServerFields, cols, rows } = ctx;
  // ---------- MCP 服务器列表（含作用域切换）----------
  if (activeStep.kind === "mcp") {
    const scope = activeStep.scope;
    const other: McpScope = scope === "global" ? "project" : "global";
    const items: SelectItem<string>[] = [
      {
        label: `⇄ 切换到「${scopeLabel(other)}」作用域`,
        value: SWITCH_SCOPE,
        hint: `${mcpCount(mcp, other)} 个服务器`,
      },
      { label: "＋ 新建服务器", value: NEW_MCP_SERVER, hint: "stdio / http / sse" },
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
        title={`◆ MCP 服务器 · ${scopeLabel(scope)}`}
        subtitle={`${mcpCount(mcp, scope)} 个 · ${mcpConfigPath(scope)}`}
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
        title={`◆ MCP · ${serverId}`}
        details={[
          `${scopeLabel(scope)} · ${mcpConfigPath(scope)}`,
          `传输 ${entry.type ?? "stdio"} · ↑ ↓ 移动 · Enter 编辑/切换`,
        ]}
        fields={mcpServerFields(scope, serverId, entry)}
        notice={notice}
        action={{
          label: "删除服务器",
          run: async () => {
            const failure = await persistMcp(
              scope,
              removeMcpServer(mcp[scope], serverId),
              `已删除 MCP 服务器 ${serverId}（${scopeLabel(scope)}）`,
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
    const label = field === "env" ? "环境变量" : "请求头";
    const current = (entry[field] as Record<string, string> | undefined) ?? {};
    return (
      <KvEditorScreen
        columns={cols}
        rows={rows}
        title={`◆ MCP · ${serverId} · ${label}`}
        subtitle={`${scopeLabel(scope)} · ${Object.keys(current).length} 项`}
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
            `MCP ${serverId} 的${label}已更新（${scopeLabel(scope)}）`,
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
        title={`新建 MCP 服务器 · 名称（${scopeLabel(scope)}）`}
        details={[
          "作为 mcpServers 的键，例如 github / chrome-devtools",
          "创建后默认 stdio，可编辑传输方式 / 命令 / 参数 / 环境变量等",
        ]}
        error={error}
        hints={[["Enter", "创建并编辑"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          if (mcpServerIdTaken(mcp[scope], name)) {
            setError(`已存在名为 ${name} 的服务器`);
            return;
          }
          const { mcp: next, id } = addMcpServer(mcp[scope], name);
          void (async () => {
            const failure = await persistMcp(scope, next, `已新建 MCP 服务器 ${id}（${scopeLabel(scope)}）`);
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
