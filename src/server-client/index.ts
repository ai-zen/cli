/**
 * CLI 对 `@ai-zen/agents-client` 的**绑定层**。
 *
 * ## 它现在只剩三件事
 *
 * 1. **一个入口**：CLI 的其余模块从这里取连接层，而不是各自 `import "@ai-zen/agents-client"` ——
 *    于是「CLI 到底向连接层要了哪些东西」在一屏里读得完，打包时内联进来的也是同一份（共享包
 *    `private: true`、不发版，构建时整包捆进产物）；
 * 2. **两样 CLI 自己造的东西**：{@link createLegacyCall}（`call` 那条旧路，见
 *    `methods.ts`）与 {@link SessionMirror}（一段会话的镜像，见 `mirror.ts`）。它们住在这里而
 *    不住在连接层：连接层只管「一条能用的 tRPC 连接」，镜像与旧方法名的对照都是**CLI 自己的
 *    账**；
 * 3. （原来还有）本进程的身份 `CLIENT_INFO`。**这一格没了**：新宿主的握手帧只带令牌与语言，
 *    `ensureHost` 也不再收 `clientInfo`，于是「我是谁、哪个版本」不再有一条出网的路。
 *
 * ## 旧的那几样为什么不在这里补
 *
 * | 旧 | 现在 |
 * |---|---|
 * | `ServerConnection`（懒连接 + 断了自建 + 重新订阅） | `HostClient`（`subscribe` / `reconnect` / `close`） |
 * | `ensureServer({ aiZenDir, … })` | `ensureHost({ dataRoot, launchLog, settings, versionRange })` |
 * | `Client.open(sessionId)` / `Client.resync()` / `SessionMirror` | CLI 自己的 `HostConnection.open` / `resync` + `mirror.ts`（新契约没有增量事件，攒的规则没了） |
 * | `call(method, params)` | 只剩两条已接的（`session.create` / `session.send` → `api.agent.send`），其余抛 `unsupported`（`methods.ts`） |
 *
 * 拉起宿主是一条**有两条路**的事（判据在连接层，不在这里）：调用方给了宿主入口就起那个入口
 * （桌面端把宿主捆进自己的产物随包分发）；没给就让 `npx` 现下现起 ——
 * `npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`。CLI 这边只能走后面那条路：
 * 宿主只住在 `devDependencies` 里（它不进包、消费者机器上也不会装它），运行期拿来用的是
 * **构建时**注入的那段 semver range（`version.ts` 的 `AGENTS_HOST_RANGE`，PRD L14）。
 *
 * ## 这里不许出现的东西
 *
 * 不要在这里写业务、不要在这里读 `process.env`、不要再导出一遍上游的某个常量：本文件的全部内容
 * 就是「透传 + 两样 CLI 自己的东西」，多一行都得先回答「它属于绑定，还是属于连接层」（后者该改包）。
 */

export * from "@ai-zen/agents-client";

export { LEGACY_METHODS, createLegacyCall, legacyRowOf } from "./methods.js";
export type { LegacyCall, LegacyMethodRow, LegacyStatus } from "./methods.js";
export { SessionMirror, sessionIdOf, toCoreMessages } from "./mirror.js";
export type {
  MirrorSessionRow,
  MirrorSnapshot,
  SessionOpenView,
  SubAgentColumn,
} from "./mirror.js";
