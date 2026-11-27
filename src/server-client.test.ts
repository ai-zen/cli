/**
 * 绑定层（`server-client/index.ts`）自己的两件事。
 *
 * 旧文件钉的是两样东西，如今都不在这里：
 *
 *   1. `SERVER_PACKAGE` 的版本漂移（`"@ai-zen/agents-server@0.1.0-alpha.0"` 必须等于仓库里那个包的
 *      `version`）—— 那个常量很久之前就消失了；现在本机拉起宿主是「`npx` 按 CLI 自己声明的
 *      semver range 拉一个最新版」，也就没有可漂移的字符串：范围只住在 `package.json`
 *      的 `devDependencies` 里，构建时注入（`rolldown.config.mjs`）；
 *   2. 「显式地址与凭证真的出现在了那条 socket 的 `hello` 上」—— 接线点搬到了 `connection.ts`
 *      （`connectHost` / `probeConnection`），用例跟着搬过去了（那边用注入的假件断言递下去的那份
 *      设置与凭证）。
 *
 * 留在这里的是三件事：
 *
 * 1. 绑定的就是包里那一份（逐个引用相等）—— 防止有人在这里再实现一份；
 * 2. 旧便利层一个都不留 —— 硬约束要求不留兼容层，这条把它钉成一条会红的断言；
 * 3. （原来还有）`CLIENT_INFO` 自报的版本 —— 这一格没了：新宿主的握手帧只带令牌与语言，
 *    `ensureHost` 也不再收 `clientInfo`，于是「我是谁、哪个版本」不再出网。
 *    留在这里的是一条反向断言：它不该以兼容导出的形式回来。
 */

import { describe, expect, it } from "vitest";
import * as lib from "@ai-zen/agents-client";
import * as binding from "./server-client/index.js";

/** 旧库有、新库没有的那些便利层：它们不该以兼容导出的形式回来 */
const REMOVED_FROM_LIB = [
  "Client",
  "CLIENT_INFO",
  "ServerConnection",
  "ensureServer",
  "createRemoteConfigPort",
  "ConfigPort",
  "ServerClient",
  "ServerTargetSource",
  "SocketServerClient",
  "AgentStore",
  "parseServerUrl",
  "normalizeServerAddress",
  "connectionSettingsPath",
  "readConnectionSettings",
  "writeConnectionSettings",
  "connectionSettingsToTarget",
  "explainUnauthorized",
  "resolveToken",
  "readDescriptor",
  "readServerStatus",
  "ServerStatus",
  "ServerStatusDeps",
] as const;

describe("透传：绑定的就是包里那一份，不是第二份实现", () => {
  it("连接、拉起、地址、设置这几样逐个引用相等", () => {
    expect(binding.connect).toBe(lib.connect);
    expect(binding.ensureHost).toBe(lib.ensureHost);
    // 拉起宿主的缺省实现（给了 `entry` 起它、没给就 npx）：CLI 不另写一份
    expect(binding.spawnHostByContext).toBe(lib.spawnHostByContext);
    expect(binding.parseAddress).toBe(lib.parseAddress);
    expect(binding.settingsPath).toBe(lib.settingsPath);
    expect(binding.readSettings).toBe(lib.readSettings);
    expect(binding.writeSettings).toBe(lib.writeSettings);
    expect(binding.uploadAsset).toBe(lib.uploadAsset);
  });

  it("旧便利层一个都不留（没有兼容导出）", () => {
    for (const name of REMOVED_FROM_LIB) {
      expect(Object.hasOwn(binding, name), `不该导出 ${name}`).toBe(false);
    }
  });
});

describe("CLI 自己造的那两样（镜像与旧路）跟着绑定层一起出去", () => {
  it("`SessionMirror` 可用；表里「已接」的只有那两条会话旧路 + 配置域那一批", () => {
    expect(typeof binding.SessionMirror).toBe("function");
    expect(typeof binding.createLegacyCall).toBe("function");
    const attached = binding.LEGACY_METHODS.filter((row) => row.status === "已接");
    // 真能在 `call` 里转成 `api.*` 调用的只有这两条（`createLegacyCall` 的两个分支）；
    // 其余「已接」记的是「这个旧名字今天走哪条 procedure」—— 调用点已经直接说 procedure 了
    expect(
      attached.filter((row) => row.legacy.startsWith("session.")).map((row) => row.legacy),
    ).toEqual(["session.create", "session.send"]);
    // 配置域搬完的那 24 条各自写明了今天的落点（表是这份迁移唯一的账）
    expect(attached.filter((row) => /^(config|agent|model)\./.test(row.legacy))).toHaveLength(24);
  });
});
