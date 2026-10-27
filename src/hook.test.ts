/**
 * shell 钩子安装 / 卸载测试。
 *
 * 全部在临时 HOME 下进行：`detectShell()` 读 `SHELL`，rc 路径来自 `homedir()`，
 * 所以改这两个环境变量就能完全隔离，**绝不触碰真实 `~/.bashrc`**。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHook, uninstallHook } from "./hook.js";

const MARKER_START = "# === ai hook (开始) ===";
const MARKER_END = "# === ai hook (结束) ===";

let home: string;
let rcFile: string;
const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "aiz-hook-test-"));
  rcFile = join(home, ".bashrc");
  process.env.HOME = home;
  process.env.SHELL = "/bin/bash";
  // 安装过程会打印提示，测试里静音（同时避免污染 vitest 输出）
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  await fs.rm(home, { recursive: true, force: true });
});

const read = () => fs.readFile(rcFile, "utf-8");
const countBlocks = (content: string) =>
  content.split(MARKER_START).length - 1;

describe("installHook", () => {
  it("写入 bash 钩子，函数体为 `ai --tui --new \"$@\"`", async () => {
    await installHook();
    const content = await read();
    expect(content).toContain(MARKER_START);
    expect(content).toContain(MARKER_END);
    expect(content).toContain("command_not_found_handle() {");
    expect(content).toContain('  ai --tui --new "$@"');
    // 钩子会话总是新开一条对话：不续接该目录的上一轮会话
    expect(countBlocks(content)).toBe(1);
  });

  it("保留 rc 文件原有内容", async () => {
    await fs.writeFile(rcFile, "export FOO=1\nalias ll='ls -l'\n", "utf-8");
    await installHook();
    const content = await read();
    expect(content).toContain("export FOO=1");
    expect(content).toContain("alias ll='ls -l'");
  });

  it("重复安装是幂等的（不重复追加块）", async () => {
    await installHook();
    const first = await read();
    await installHook();
    const second = await read();
    expect(second).toBe(first);
    expect(countBlocks(second)).toBe(1);
  });

  it("已装旧函数体（`ai --tui \"$@\"`）时原地升级到最新版本", async () => {
    // 模拟上一个版本装下的钩子（MARKER 未变，函数体是旧写法）
    await fs.writeFile(
      rcFile,
      [
        "export FOO=1",
        "",
        MARKER_START,
        "command_not_found_handle() {",
        '  ai --tui "$@"',
        "}",
        MARKER_END,
        "",
      ].join("\n"),
      "utf-8",
    );

    await installHook();
    const content = await read();
    expect(content).toContain('ai --tui --new "$@"');
    expect(content).not.toContain('ai --tui "$@"');
    expect(countBlocks(content)).toBe(1);
    expect(content).toContain("export FOO=1");
  });

  it("历史 aiz 块被迁移掉，只留一个新块", async () => {
    await fs.writeFile(
      rcFile,
      [
        "export FOO=1",
        "# === aiz hook (开始) ===",
        "command_not_found_handle() {",
        '  aiz "$@"',
        "}",
        "# === aiz hook (结束) ===",
        "",
      ].join("\n"),
      "utf-8",
    );

    await installHook();
    const content = await read();
    expect(content).not.toContain("aiz hook");
    expect(content).toContain('ai --tui --new "$@"');
    expect(countBlocks(content)).toBe(1);
  });

  it("zsh 用 command_not_found_handler 并写入 .zshrc", async () => {
    process.env.SHELL = "/usr/bin/zsh";
    rcFile = join(home, ".zshrc");
    await installHook();
    const content = await read();
    expect(content).toContain("command_not_found_handler() {");
    expect(content).toContain('ai --tui --new "$@"');
  });
});

describe("uninstallHook", () => {
  it("移除钩子块并保留其余内容", async () => {
    await fs.writeFile(rcFile, "export FOO=1\n", "utf-8");
    await installHook();
    await uninstallHook();
    const content = await read();
    expect(content).not.toContain(MARKER_START);
    expect(content).not.toContain("ai --tui");
    expect(content).toContain("export FOO=1");
  });

  it("未安装时不动文件", async () => {
    const original = "export FOO=1\n";
    await fs.writeFile(rcFile, original, "utf-8");
    await uninstallHook();
    expect(await read()).toBe(original);
  });

  it("rc 文件不存在时不报错", async () => {
    await expect(uninstallHook()).resolves.toBeUndefined();
  });
});
