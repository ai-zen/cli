// MCP 屏的展示
//
// ## 读写共用同一份 `McpServerDefinition`
//
// `mcp.list` 回来的每条就是 `McpServerDefinition` 本身（传输方式与它的参数、`disabled`、`oauth`），
// 而 `mcp.save` 收的也正是这一份 —— 于是「视图 → 写入入参」这一步**不需要存在**：屏上改哪一项
// 就把那一项盖上去。这一版不认识的键也不在客户端手上（契约里没有 `extra`）：写回时由宿主
// 那侧与磁盘上已有那一条合并（`McpConfig.save`），客户端读不到这些键。
//
// ## oauth 的客户端密钥只印掩码
//
// 契约给的 `oauth.clientSecret` 是**明文**（与端点的 `apiKey` 同一套口径：`config.get` 也不再
// 掩码）。屏上只印 {@link maskSecret} 算出来的那一串，而写回时带上的是同一条里的原值 ——
// 于是「没改就不动」这件事靠的是**原样往返**，不是省略。
import type { McpEditableScope, McpServerDefinition } from "../../config.js";
import { maskSecret } from "../../config-editor.js";
import { t } from "../../i18n/index.js";

/**
 * 作用域的显示名。
 *
 * 界面上只有两层（可写的那两层），显示名点明它是哪一层：`user` 是全机共享、`workspace`
 * 是这个项目。契约里项目那一层叫 `workspaceAiZen`（`.ai-zen/mcp.json`），界面沿用用户认得的
 * 「工作区」这个词。
 */
export function scopeLabel(scope: McpEditableScope): string {
  return scope === "user" ? t("scope.user") : t("scope.workspace");
}

/** 另一个作用域（`/mcp` 屏的「切换」项用） */
export function otherScope(scope: McpEditableScope): McpEditableScope {
  return scope === "user" ? "workspace" : "user";
}

/**
 * 详情屏那一行「客户端密钥」：只印掩码；没配就直说没配。
 *
 * 掩码由客户端现算（{@link maskSecret}）：契约给的是明文，而明文整串留在一个人正对着的终端里
 * 没有必要。这一屏不提供「改 oauth」的入口：oauth 属于 MCP 客户端注册的那一侧，改动频率低。
 */
export function mcpOauthSecretHint(server: McpServerDefinition): string {
  const secret = server.oauth?.clientSecret;
  return secret
    ? t("wiz.mcp.oauthSecret", { masked: maskSecret(secret) })
    : t("wiz.mcp.oauthSecretUnset");
}

/** `McpServerDefinition` 的一行摘要：启用状态 + 传输方式与它的目标 + 描述（三层事实，没有就少一段） */
export function mcpEntryHint(server: McpServerDefinition): string {
  const parts: string[] = [server.disabled === true ? t("wiz.mcp.disabled") : t("wiz.mcp.enabled")];
  const remote = server.transport === "http" || server.transport === "sse";
  const target = remote
    ? (server.url ?? t("common.noUrl"))
    : (server.command ?? t("common.noCommand"));
  const extra = !remote && server.args?.length ? ` ${server.args.join(" ")}` : "";
  parts.push(`${server.transport} · ${target}${extra}`);
  if (server.description) parts.push(server.description);
  return parts.join(" · ");
}
