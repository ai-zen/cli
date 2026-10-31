import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fromGitList,
  invalidateFileIndex,
  listProjectPaths,
  INDEX_TTL_MS,
  type FileIndexDeps,
} from "./file-index.js";

describe("fromGitList：文件 → 文件 + 祖先目录", () => {
  it("从文件路径反推出全部祖先目录，且目录不重复", () => {
    const entries = fromGitList(["src/tui/chat.tsx", "src/tui/mouse.ts", "src/index.ts", "README.md"]);
    const dirs = entries.filter((entry) => entry.dir).map((entry) => entry.path).sort();
    const files = entries.filter((entry) => !entry.dir).map((entry) => entry.path).sort();
    expect(dirs).toEqual(["src", "src/tui"]);
    expect(files).toEqual(["README.md", "src/index.ts", "src/tui/chat.tsx", "src/tui/mouse.ts"]);
  });

  it("Windows 风格反斜杠统一成 `/`（候选与插入文本都用 `/`）", () => {
    expect(fromGitList(["src\\tui\\chat.tsx"]).map((entry) => entry.path)).toContain("src/tui/chat.tsx");
  });

  it("空行 / 空白被丢掉", () => {
    expect(fromGitList(["", "  ", "a.ts"]).map((entry) => entry.path)).toEqual(["a.ts"]);
  });
});

describe("listProjectPaths：来源与缓存", () => {
  beforeEach(() => {
    invalidateFileIndex();
  });

  const mkDeps = (gitPaths: FileIndexDeps["gitPaths"], clock = { t: 0 }): FileIndexDeps => ({
    gitPaths,
    globPaths: vi.fn(async () => [{ path: "glob-fallback.ts", dir: false }]),
    now: () => clock.t,
  });

  it("git 可用时用 git 清单（含目录条目）", async () => {
    const gitPaths = vi.fn(async () => ["src/tui/chat.tsx"]);
    const paths = await listProjectPaths("/repo", mkDeps(gitPaths));
    expect(gitPaths).toHaveBeenCalledWith("/repo");
    expect(paths.map((entry) => entry.path).sort()).toEqual(["src", "src/tui", "src/tui/chat.tsx"]);
  });

  it("TTL 内复用缓存（不重复扫），过期后重扫", async () => {
    const clock = { t: 0 };
    const gitPaths = vi.fn(async () => ["a.ts"]);
    const deps = mkDeps(gitPaths, clock);

    await listProjectPaths("/repo", deps);
    clock.t = INDEX_TTL_MS - 1;
    await listProjectPaths("/repo", deps);
    expect(gitPaths).toHaveBeenCalledTimes(1);

    clock.t = INDEX_TTL_MS + 1;
    await listProjectPaths("/repo", deps);
    expect(gitPaths).toHaveBeenCalledTimes(2);
  });

  it("cwd 变了要重扫（缓存按 cwd 区分）", async () => {
    const gitPaths = vi.fn(async (cwd: string) => [`${cwd}.ts`]);
    const deps = mkDeps(gitPaths);
    await listProjectPaths("/a", deps);
    await listProjectPaths("/b", deps);
    expect(gitPaths).toHaveBeenCalledTimes(2);
  });

  it("git 不可用（不是仓库）时落回 fs.glob", async () => {
    const deps = mkDeps(async () => null);
    const paths = await listProjectPaths("/not-a-repo", deps);
    expect(paths).toEqual([{ path: "glob-fallback.ts", dir: false }]);
  });

  it("git 抛错也收敛成空数组（补全挂了不影响发消息）", async () => {
    const deps = mkDeps(async () => {
      throw new Error("boom");
    });
    expect(await listProjectPaths("/repo", deps)).toEqual([]);
  });
});

describe("listProjectPaths：真实磁盘（非 git 目录走 fs.glob 兜底）", () => {
  let dir: string | null = null;

  beforeEach(() => {
    invalidateFileIndex();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("扫出子目录里的文件，且不带 `./` 前缀、不返回目录自身", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aizen-index-"));
    await mkdir(path.join(dir, "src", "ui"), { recursive: true });
    await writeFile(path.join(dir, "src", "ui", "button.tsx"), "");
    await writeFile(path.join(dir, "README.md"), "");

    // 强制走 fs.glob：注入一个「git 不可用」的依赖，其余用真实实现
    const paths = await listProjectPaths(dir, { gitPaths: async () => null });
    const files = paths.filter((entry) => !entry.dir).map((entry) => entry.path).sort();
    expect(files).toEqual(["README.md", "src/ui/button.tsx"]);
    expect(paths.some((entry) => entry.path.startsWith("./"))).toBe(false);
  });
});
