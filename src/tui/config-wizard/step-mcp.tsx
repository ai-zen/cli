// MCP 列表 / 详情 / 键值 / 新建
//
// ## 这一屏能做到哪
//
// 读是 `api.config.mcp.list.query({ workspaceId })`：**每条服务器 + 它写在哪一层**（`scope`）。写是
// `api.config.mcp.update` / `api.config.mcp.delete`，两条都回**整份**清单（不必再问一次）。于是：
//
//   · 看见：两个可写层各自有哪些服务器、每条启用没启用、传输方式与它的目标 —— 有；
//     「这一层的文件不存在 / 读不出来」这类**层的状态**没有：新契约只报 InboxEntry，不报文件；
//   · 改已有 InboxEntry：**有** —— InboxEntry 就是 `McpServerDefinition`，改哪一项就发哪一项；
//   · 增 / 改 / 删 / 启停 / 改作用域：都在这几屏里，每次改一条。
//
// 作用域只有两个（`user` / `workspace`）：契约里另有三个只读层（项目 `.mcp.json` 与两个
// `.agents/mcp.json`），宿主对它们的写口都是 `unsupported` —— 界面因此不给，也不假装能进。
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { SWITCH_SCOPE, NEW_MCP_SERVER } from "./types.js";
import { mcpEntriesOf } from "../../mcp-command.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { DetailStep } from "./detail.js";
import { KvEditorScreen } from "./kv-editor.js";
import { PromptScreen } from "./prompt.js";
import { mcpEntryHint, mcpOauthSecretHint, otherScope, scopeLabel } from "./mcp-helpers.js";
import { t } from "../../i18n/index.js";

export function renderMcpStep(ctx: WizardContext): ReactNode {
  const {
    servers,
    error,
    notice,
    activeStep,
    go,
    saveMcp,
    deleteMcp,
    setError,
    mcpServerFields,
    cols,
    rows,
  } = ctx;

  // ---------- MCP 服务器列表（含作用域切换）----------
  if (activeStep.kind === "mcp") {
    const scope = activeStep.scope;
    const other = otherScope(scope);
    const entries = mcpEntriesOf(servers, scope);
    const otherEntries = mcpEntriesOf(servers, other);
    const items: SelectItem<string>[] = [
      {
        label: t("wiz.mcp.switchScope", { scope: scopeLabel(other) }),
        value: SWITCH_SCOPE,
        hint: t("wiz.mcp.serverCount", { n: otherEntries.length }),
      },
      { label: t("wiz.mcp.newItem"), value: NEW_MCP_SERVER, hint: t("wiz.mcp.newItemHint") },
      ...entries.map((server) => ({
        label: server.id,
        value: server.id,
        hint: mcpEntryHint(server),
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.listTitle", { scope: scopeLabel(scope) })}
        subtitle={t("wiz.mcp.listSubtitle", { n: entries.length, scope: scopeLabel(scope) })}
        items={items}
        onPick={(value) => {
          if (value === SWITCH_SCOPE) go({ kind: "mcp", scope: other });
          else if (value === NEW_MCP_SERVER) go({ kind: "mcp-new", scope });
          else go({ kind: "mcp-server", scope, serverName: value });
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- MCP 服务器详情 ----------
  if (activeStep.kind === "mcp-server") {
    const { scope, serverName } = activeStep;
    const server = mcpEntriesOf(servers, scope).find((candidate) => candidate.id === serverName);
    if (!server) return null; // `normalize` 已经把这种情况收回列表了
    const scopeName = scopeLabel(scope);
    const facts = [
      t("wiz.scopePath", { scope: scopeName }),
      // 配了 oauth 的那一条把「客户端密钥」印在屏上：只有掩码，明文不整串留屏（见 `mcp-helpers`）
      ...(server.oauth ? [mcpOauthSecretHint(server)] : []),
    ];

    const siblingIds = mcpEntriesOf(servers, scope)
      .filter((candidate) => candidate.id !== serverName)
      .map((candidate) => candidate.id);

    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.detailTitle", { id: serverName })}
        details={[...facts, t("wiz.mcp.detailLine")]}
        fields={mcpServerFields(scope, server, siblingIds)}
        notice={notice}
        actions={[
          {
            label: t("wiz.mcp.delete"),
            danger: true,
            // 代价只说「断掉哪一台」：MCP 是会话启动时连上的工具服务器，删掉它这一台就没了
            cost: [t("wiz.mcp.deleteCost", { id: serverName, scope: scopeName })],
            run: async () => {
              const failure = await deleteMcp(
                scope,
                serverName,
                t("wiz.mcp.deleted", { id: serverName, scope: scopeName }),
              );
              if (!failure) go({ kind: "mcp", scope });
              return failure;
            },
          },
        ]}
        onBack={() => go({ kind: "mcp", scope })}
      />
    );
  }

  // ---------- MCP 键值编辑（env / headers）----------
  if (activeStep.kind === "mcp-kv") {
    const { scope, serverName, field } = activeStep;
    const server = mcpEntriesOf(servers, scope).find((candidate) => candidate.id === serverName);
    if (!server) return null; // 上面那几屏的门已经挡住了这条路
    const label = field === "env" ? t("field.env") : t("field.headers");
    const current = server[field] ?? {};
    return (
      <KvEditorScreen
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.kvTitle", { id: serverName, label })}
        subtitle={t("wiz.mcp.kvSubtitle", {
          scope: scopeLabel(scope),
          n: Object.keys(current).length,
        })}
        map={current}
        notice={notice}
        onCommit={(next) =>
          saveMcp(
            scope,
            { ...server, [field]: Object.keys(next).length > 0 ? next : undefined },
            t("wiz.mcpFieldUpdated", { id: serverName, label, scope: scopeLabel(scope) }),
          )
        }
        onBack={() => go({ kind: "mcp-server", scope, serverName })}
      />
    );
  }

  // ---------- 新建 MCP 服务器 ----------
  if (activeStep.kind === "mcp-new") {
    const scope = activeStep.scope;
    const existing = mcpEntriesOf(servers, scope);
    return (
      <PromptScreen
        key={`new:mcp:${scope}`}
        columns={cols}
        rows={rows}
        title={t("wiz.mcp.newTitle", { scope: scopeLabel(scope) })}
        details={[t("wiz.mcp.newDescKey"), t("wiz.mcp.newDescDefault")]}
        error={error}
        hints={[
          ["Enter", t("wiz.createAndEdit")],
          ["Esc", t("ui.back")],
        ]}
        onSubmit={(value) => {
          const id = value.trim();
          if (!id) {
            setError(t("err.nameRequired"));
            return;
          }
          if (existing.some((server) => server.id === id)) {
            setError(t("err.mcpNameTaken", { name: id }));
            return;
          }
          // 新建的默认是 stdio：命令 / 参数 / 环境变量在详情屏里接着填
          void (async () => {
            const failure = await saveMcp(
              scope,
              { id, transport: "stdio" },
              t("wiz.mcp.created", { id, scope: scopeLabel(scope) }),
            );
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "mcp-server", scope, serverName: id });
          })();
        }}
        onCancel={() => go({ kind: "mcp", scope })}
      />
    );
  }

  return null;
}
