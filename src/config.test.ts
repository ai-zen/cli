/**
 * `projectDirs()` —— 项目级路径的唯一来源。
 *
 * 进程级事实（配置根、显式地址、显式凭证）的用例在 `env.test.ts`：那是另一件事，也是另一个
 * 文件（本文件不再读 `process.env`，一个断言都不用改环境）。
 */

import { describe, it, expect } from "vitest";
import { join } from "path";
import * as config from "./config.js";

describe("projectDirs（cwd 是参数，不是模块求值快照）", () => {
  // 为什么是函数：`export const PROJECT_* = join(process.cwd(), …)` 那套写法在模块求值
  // 那一刻就把启动目录焊死，之后换目录（测试换临时根、将来服务端一个进程服务多个工作区）
  // 全部悄悄落到启动时的那个目录里 —— 不报错，只是写错地方。
  it("传入不同 cwd → 拿到各自的路径（互不影响）", () => {
    const a = config.projectDirs("/work/proj-a");
    const b = config.projectDirs("/work/proj-b");

    expect(a.skills).toBe(join("/work/proj-a", ".ai-zen", "skills"));
    expect(b.skills).toBe(join("/work/proj-b", ".ai-zen", "skills"));
    expect(a.skills).not.toBe(b.skills);
  });

  it("三项项目级 MCP 配置都在同一个 cwd 下，顺序里的三处不会串", () => {
    const dirs = config.projectDirs("/p");
    expect(dirs.sharedMcpConfig).toBe(join("/p", ".mcp.json"));
    expect(dirs.mcpConfig).toBe(join("/p", ".ai-zen", "mcp.json"));
    expect(dirs.agentsMcpConfig).toBe(join("/p", ".agents", "mcp.json"));
  });

  it("不传参时取当前 cwd（全仓唯一一处读 process.cwd() 的缺省）", () => {
    expect(config.projectDirs().root).toBe(join(process.cwd(), ".ai-zen"));
    expect(config.projectDirs().handoffs).toBe(join(process.cwd(), ".ai-zen", "handoffs"));
  });
});
