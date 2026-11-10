/**
 * Agent / Sub-agent 定义的**词汇表 + 数据整形** —— CLI 层。
 *
 * ## 这里没有读写，也没有目录
 *
 * 定义的真相在**服务端**：客户端经 `ConfigPort.readAgentStore()` 拿一份快照
 * （`AgentStore`：`agents` / `subAgents` + 两个写操作），写走 `agent.save` / `agent.remove`。
 *
 * 曾经这里还有三样东西，现在都删了：
 *
 *   - `readAgentStore()`（直读 `~/.ai-zen/agents`，附带一次性的 `reasoningEffort` →
 *     `modelParams` 迁移）—— 配置面搬到服务端后失去调用方，而那份迁移归**持有定义的那一侧**；
 *   - `agentDir(kind)` 与两处目录常量 —— 只有下面那个函数在用；
 *   - `createAgentStore(agents, subAgents)` —— 自述「只给假件与测试用」，却在**生产**
 *     `src/` 里，而且它的 `save` / `remove` 真的会写 `~/.ai-zen/agents/*.json`。它不是
 *     死代码：`config-wizard/engine.ts` 的 `props.agentStore ?? createAgentStore([], [])`
 *     在**首启凭据屏**上是可达的生产路径（`CredentialGate` 当年没传 `agentStore`），于是
 *     「改 Agent 定义」会写进客户端自己那台机器 —— 而后端 Agent 用的是服务端那份。
 *     所以它不是「删掉」，是**先堵住那条缺省**（凭据屏改为注入 `configPort.readAgentStore()`），
 *     再删。测试要假件就在自己的用例文件里写一个对象字面量，那本来就是三行的事。
 *
 * 留下的是三件纯函数：`kind` 词表分派、显示名、按 id 查定义。它们不需要 IO，也不需要
 * 「目录在哪」这个客户端根本答不对的问题。
 */

import type { AgentDefinition } from "@ai-zen/agents-sdk";

/**
 * 两个「词汇表」类型在 `@ai-zen/agents-client` 里：
 *
 *   - `AgentKind` 就是协议里的 `AgentKind`（`agent.*` 方法的 `kind` 参数）；
 *   - `AgentStore` 是 `ConfigPort.readAgentStore()` 的返回形状。
 *
 * 以前它们各自定义在本文件 —— 于是「客户端从服务端拿回来的那份」与「本文件这份」是
 * 两个类型，只靠形状碰巧一致。包一层转出后，本文件只剩「词汇表 + 数据整形」。
 */
import type { AgentKind, AgentStore } from "@ai-zen/agents-client";
export type { AgentKind, AgentStore };

/**
 * kind 的显示名（`Agent` / `Sub-agent`）。
 *
 * 刻意**不本地化**：这两个词在配置中心的英文界面与中文界面里是同一个行业惯用写法，
 * 翻译成「代理 / 子代理」反而难认。真要本地化，应该走 `t()` 而不是在这里硬编码。
 */
export function agentKindLabel(kind: AgentKind): string {
  return kind === "agent" ? "Agent" : "Sub-agent";
}

/** 取某 kind 的定义列表 */
export function agentList(store: AgentStore, kind: AgentKind): AgentDefinition[] {
  return kind === "agent" ? store.agents : store.subAgents;
}

/** 按 id 查找某 kind 的定义 */
export function findAgentDefinition(
  store: AgentStore,
  kind: AgentKind,
  id: string | undefined,
): AgentDefinition | undefined {
  if (!id) return undefined;
  return agentList(store, kind).find((def) => def.id === id);
}
