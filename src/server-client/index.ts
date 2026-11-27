/**
 * CLI 对 `@ai-zen/agents-client` 的绑定层。
 *
 * CLI 的其余模块从这里取连接层，不各自 `import "@ai-zen/agents-client"`：这样「CLI 向连接层要了
 * 哪些东西」在一屏里读得完，打包时内联进来的也是同一份（共享包 `private: true`、不发版，构建时
 * 整包捆进产物）。
 *
 * `createLegacyCall` 与 `SessionMirror` 住在这里而不在连接层：连接层只管一条能用的 tRPC 连接，
 * 镜像与旧方法名的对照都是 CLI 自己的账。
 *
 * 本进程的身份 `CLIENT_INFO` 已经不存在：新宿主的握手帧只带令牌与语言，`ensureHost` 也不收
 * `clientInfo`，「我是谁、哪个版本」没有一条出网的路。
 *
 * 拉起宿主有两条路，判据在连接层：调用方给了宿主入口就起那个入口（桌面端把宿主捆进自己的产物
 * 随包分发）；没给就让 `npx` 现下现起，`npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`。
 * CLI 只能走后面那条：宿主只住在 `devDependencies` 里，不进包、消费者机器上也不会装它，运行期
 * 拿来用的是构建时注入的那段 semver range（`version.ts` 的 `AGENTS_HOST_RANGE`）。
 *
 * 因此这一层的全部内容是透传加两样 CLI 自己的东西；业务逻辑与 `process.env` 的读取都不在这里。
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
