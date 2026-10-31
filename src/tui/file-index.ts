/**
 * 项目文件索引 —— 给 `@` 补全提供一份「候选路径清单」，带缓存。
 *
 * ## 为什么 git 优先、`fs.glob` 兜底
 *
 * `git ls-files -co --exclude-standard` 一次同时拿到**已跟踪 + 未跟踪**，且**尊重 .gitignore**
 * （本仓实测 166 条 / 约 30ms）。`fs.promises.glob` 更快（178 条 / 4ms）且不依赖外部进程，
 * 但它不认 .gitignore、也不返回隐藏文件（实测 `.gitignore`、`.ai-zen/` 全丢），所以只当
 * 「不在 git 仓库里」时的兜底。两者都不需要新增依赖：`fs.glob` 是 Node 22+ 内置的。
 *
 * ## 为什么缓存
 *
 * 索引只跟 cwd 有关：一次 `@` 补全里每敲一个键都要重新过滤一遍，不能每键都扫盘。
 * 缓存 15s 后过期（新建的文件能被看到），`invalidateFileIndex()` 供测试与显式刷新。
 *
 * ## 上限
 *
 * 大仓 / `$HOME` 下扫描可能上万条：`MAX_ENTRIES` 封顶、`SCAN_TIMEOUT_MS` 超时即放弃，
 * 拿到多少算多少 —— 补全失败远好过让输入框卡住。
 */
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { PathEntry } from "./mention.js";

/** 索引有效期：过期后下一次 `@` 重新扫 */
export const INDEX_TTL_MS = 15_000;
/** 扫描超时：到点就用手上已有的部分（git 子进程超时即失败 → 落回 fs.glob） */
export const SCAN_TIMEOUT_MS = 5_000;
/** 索引条数上限 */
export const MAX_ENTRIES = 20_000;
/**
 * `fs.glob` 兜底时的排除项。
 *
 * `node_modules` / `.git` 不是「代码」；`dist` 是本仓的构建产物（已在 .gitignore 里，
 * 走 git 时天然被排除，兜底路径要自己排除）。
 */
export const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**"];

/** 可注入的依赖：扫描是 IO，测试要能不起子进程、不碰真磁盘 */
export interface FileIndexDeps {
  /** git 清单（相对 cwd）。返回 `null` 表示 git 不可用（不是仓库 / 没装 git） */
  gitPaths?: (cwd: string) => Promise<string[] | null>;
  /** `fs.glob` 兜底 */
  globPaths?: (cwd: string) => Promise<PathEntry[]>;
  now?: () => number;
}

let cache: { cwd: string; paths: PathEntry[]; at: number } | null = null;

/** 清空缓存（测试 / 用户切目录后想强制重扫时用） */
export function invalidateFileIndex(): void {
  cache = null;
}

/**
 * 把 git 的文件清单补全成「文件 + 祖先目录」条目。
 *
 * git 只列文件，但补全也要能「钻目录」（`@src/tui/` → 继续列其下内容），
 * 所以从每个文件的路径里反推出所有祖先目录。`Set` 去重，顺序上目录在前更好读。
 */
export function fromGitList(names: readonly string[]): PathEntry[] {
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const raw of names) {
    // git 在 Windows 上可能给反斜杠（core.autocrlf 场景），统一成 `/`：候选与插入都用 `/`
    const file = raw.trim().replace(/\\/g, "/");
    if (!file) continue;
    files.push(file);
    let idx = file.lastIndexOf("/");
    while (idx > 0) {
      dirs.add(file.slice(0, idx));
      idx = file.lastIndexOf("/", idx - 1);
    }
    if (files.length + dirs.size >= MAX_ENTRIES) break;
  }
  const entries: PathEntry[] = [];
  for (const dir of dirs) entries.push({ path: dir, dir: true });
  for (const file of files) entries.push({ path: file, dir: false });
  return entries.slice(0, MAX_ENTRIES);
}

/** `git ls-files -co --exclude-standard`（路径相对 cwd）；失败返回 `null` */
function gitList(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-co", "--exclude-standard"],
      { cwd, timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.split("\n").filter(Boolean)),
    );
  });
}

/** 非 git 目录的兜底：`fs.glob` 递归 + 排除表 */
async function globList(cwd: string): Promise<PathEntry[]> {
  const entries: PathEntry[] = [];
  for await (const dirent of fsp.glob("**/*", {
    cwd,
    exclude: DEFAULT_EXCLUDES,
    withFileTypes: true,
  })) {
    const rel = path.relative(cwd, path.join(dirent.parentPath, dirent.name)).replace(/\\/g, "/");
    if (!rel) continue;
    entries.push({ path: rel, dir: dirent.isDirectory() });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

/**
 * 取当前项目（cwd）的候选路径，带 15s 缓存。
 *
 * 任何异常都收敛成空数组：补全挂了不该影响用户发消息。
 */
export async function listProjectPaths(cwd: string, deps: FileIndexDeps = {}): Promise<PathEntry[]> {
  const now = deps.now ?? Date.now;
  if (cache && cache.cwd === cwd && now() - cache.at < INDEX_TTL_MS) return cache.paths;

  const readGit = deps.gitPaths ?? gitList;
  const readGlob = deps.globPaths ?? globList;

  let paths: PathEntry[] = [];
  try {
    const tracked = await readGit(cwd);
    paths = tracked ? fromGitList(tracked) : await readGlob(cwd);
  } catch {
    paths = [];
  }
  cache = { cwd, paths, at: now() };
  return paths;
}
