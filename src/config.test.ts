/**
 * `projectDirs()` —— 项目级路径的唯一来源。
 *
 * 这份用例留在客户端，是因为它验的是**本进程**的目录布局（客户端也可能真有「项目」
 * 这个概念：hook 安装、SDK 日志、临时目录隔离都用到它），而不是配置读写那套已经搬到
 * 服务端的行为 —— 后者的用例在 `@ai-zen/agents-server` 的 `ConfigService.test.ts`。
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

  it("不传参时取当前 cwd（组装根唯一一处读全局）", () => {
    expect(config.projectDirs().root).toBe(join(process.cwd(), ".ai-zen"));
    expect(config.projectDirs().handoffs).toBe(join(process.cwd(), ".ai-zen", "handoffs"));
  });
});
