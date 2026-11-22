/**
 * `cli-log.ts` —— CLI 自己的日志实例：**两档目的地**（落盘 / 管道模式写 stderr）与收尾。
 *
 * 这里钉的不是「日志格式」（那是 `@ai-zen/agents-logger` 自己的用例），而是本仓为它选的那几个
 * 参数：落在哪、几份、来源标签是哪个词，以及「一行都没写时磁盘上不留东西」这条懒开流的性质
 * —— 它是 `--version` 那种一行都不写的路由不该留下一个空文件的依据。
 */

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_LOG_MAX_BYTES, CLI_LOG_MAX_FILES, CLI_LOG_SOURCE, createCliLog } from "./cli-log.js";

/** 本文件创建过的临时根，`afterAll` 统一删（否则每跑一次就在 /tmp 留一堆） */
const roots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aiz-cli-log-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("createCliLog：落盘那一档", () => {
  it("写到 <dataRoot>/logs/cli/cli.log；一行都没写过时磁盘上什么都没有", async () => {
    const root = tmpRoot();
    const log = createCliLog({ dataRoot: root, persist: true, writeErr: () => {} });

    expect(log.filePath).toBe(join(root, "logs", "cli", "cli.log"));
    // 懒开流：造实例本身不该在磁盘上留下目录或空文件
    expect(existsSync(join(root, "logs"))).toBe(false);

    log.logger.info("第一行");
    log.logger.warn("第二行");
    log.logger.error("第三行");
    await log.close();

    const lines = readFileSync(log.filePath!, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(` INFO {2}${CLI_LOG_SOURCE} 第一行$`));
    expect(lines[1]).toMatch(new RegExp(` WARN {2}${CLI_LOG_SOURCE} 第二行$`));
    expect(lines[2]).toMatch(new RegExp(` ERROR ${CLI_LOG_SOURCE} 第三行$`));
  });

  it("单份 2MB、保留 2 份（布局那张表里 CLI 那一行）", () => {
    expect(CLI_LOG_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(CLI_LOG_MAX_FILES).toBe(2);
    expect(CLI_LOG_SOURCE).toBe("cli");
  });

  it("close 幂等；关掉之后的记录不再落到盘上", async () => {
    const root = tmpRoot();
    const log = createCliLog({ dataRoot: root, persist: true, writeErr: () => {} });
    log.logger.warn("关之前");
    await log.close();
    await log.close();
    log.logger.warn("关之后");

    const lines = readFileSync(log.filePath!, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("关之前");
  });
});

describe("createCliLog：管道那一档（persist: false）", () => {
  it("不建文件，三档写 writeErr（PRD 439：日志走 stderr、默认不落盘）", async () => {
    const root = tmpRoot();
    const written: string[] = [];
    const log = createCliLog({
      dataRoot: root,
      persist: false,
      writeErr: (text) => written.push(text),
    });

    expect(log.filePath).toBeNull();
    log.logger.info("你好");
    log.logger.warn("小心");
    log.logger.error("坏了");
    await log.close();

    expect(written).toHaveLength(3);
    // 行格式与落盘那一档同一条：变的只是目的地
    expect(written[0]).toContain("INFO");
    expect(written[0]).toContain("你好");
    expect(written[2]).toContain("ERROR");
    expect(written[2]).toContain("坏了");
    expect(existsSync(join(root, "logs"))).toBe(false);
  });

  it("这一档的 close 是 no-op（不落盘就没有待写的行）", async () => {
    const log = createCliLog({ dataRoot: tmpRoot(), persist: false, writeErr: () => {} });
    await expect(log.close()).resolves.toBeUndefined();
  });
});
