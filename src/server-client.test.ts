/**
 * 「服务端包坐标」的漂移检查。
 *
 * 这里只钉一件事：`SERVER_PACKAGE` 里的版本号必须等于仓库里 `@ai-zen/agents-server`
 * 的实际版本。它是**跨仓手工同步**的字符串（CLI 与 agents 是两个 git 仓），没有编译器
 * 会替我们检查 —— 而错了的表现是「第一次要拉起服务端时 npx 报 notarget」，用户看到的
 * 只是 CLI 起不来。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SERVER_PACKAGE } from "./server-client/index.js";

const require = createRequire(import.meta.url);

describe("SERVER_PACKAGE 与服务端包版本一致", () => {
  it("常量里的版本号 == `@ai-zen/agents-server/package.json` 的 version", () => {
    // 开发期它是 devDependency（`link:`），所以解析到的就是仓库里那一份
    const packageJsonPath = require.resolve("@ai-zen/agents-server/package.json");
    const { name, version } = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      name: string;
      version: string;
    };

    expect(SERVER_PACKAGE).toBe(`${name}@${version}`);
  });
});
