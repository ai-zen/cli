import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { t } from "./i18n/index.js";

/** 当前标记（ai hook 时代）
 *
 * **不得翻译**：这两行是写进 rc 文件的代码块标记，靠它识别「哪段是本工具的」；
 * 翻了字面串就再也找不到旧块，用户会冒出一堆重复 hook。 */
const MARKER_START = "# === ai hook (开始) ===";
const MARKER_END = "# === ai hook (结束) ===";

/** 历史标记（aiz hook 时代，用于平滑迁移） */
const LEGACY_BLOCKS = [
  { start: "# === aiz hook (开始) ===", end: "# === aiz hook (结束) ===" },
];

function detectShell(): { rcFile: string; hookFn: string } | null {
  const shell = process.env.SHELL || "";
  const home = homedir();

  if (shell.includes("zsh")) {
    return { rcFile: join(home, ".zshrc"), hookFn: "command_not_found_handler" };
  }
  if (shell.includes("bash")) {
    return { rcFile: join(home, ".bashrc"), hookFn: "command_not_found_handle" };
  }
  return null;
}

/**
 * 生成被写入 rc 文件的钩子函数体。
 *
 * 关键：必须带 `--tui`。钩子的发起场景是「人坐在交互终端前把命令敲错了」，
 * 不是脚本调用——所以要把原命令带进 TUI 当首条消息（`ai --tui --new "$@"`），
 * 而不是落到管道模式吐一段字就退出（那样没有历史、不能追问）。
 *
 * 另带 `--new`：钩子会话**总是开新的一条对话**，不续接该目录的上一轮会话。
 * 敲错一次命令就把内容追加进原有的长对话里，上下文和会话名都会被打乱。
 * `"$@"` 保留分词，避免原本带空格的参数被拼坏。
 */
function hookCode(hookFn: string): string {
  return ["", MARKER_START, `${hookFn}() {`, '  ai --tui --new "$@"', "}", MARKER_END, ""].join(
    "\n",
  );
}

/** 规范化钩子块（去空行、逐行 trim），用于判断已安装的内容是否就是当前版本 */
function normalizeBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 取出文件中**全部**已安装的钩子块（含首尾标记），按出现顺序。
 *
 * 这里刻意返回数组而不是第一块：rc 里可能残留多个块（老版本 + 新版本各写了一次），
 * 只看第一块会出现「第一块恰好是最新版 → 判定为已安装 → 后面的旧块永远留着」。
 */
function readHookBlocks(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (start < 0) {
      if (trimmed === MARKER_START) start = index;
      continue;
    }
    if (trimmed === MARKER_END) {
      blocks.push(lines.slice(start, index + 1).join("\n"));
      start = -1;
    }
  }
  // 只有开头标记、没有结尾标记的残缺块不算「已安装」——交给安装路径整段清理
  return blocks;
}

/**
 * 移除文件中所有 hook 代码块（含历史 aiz 标记），返回清理后的内容；
 * `removed` 表示是否确有块被移除。
 */
function stripHookBlocks(content: string): { content: string; removed: boolean } {
  const blocks = [{ start: MARKER_START, end: MARKER_END }, ...LEGACY_BLOCKS];
  const lines = content.split("\n");
  const kept: string[] = [];
  let skipping = false;
  let removed = false;
  let matchedAny = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && blocks.some((b) => b.start === trimmed)) {
      skipping = true;
      removed = true;
      matchedAny = true;
      continue;
    }
    if (skipping && blocks.some((b) => b.end === trimmed)) {
      skipping = false;
      continue;
    }
    if (!skipping) kept.push(line);
  }

  return { content: kept.join("\n"), removed: matchedAny };
}

export async function installHook(): Promise<void> {
  const shell = detectShell();
  if (!shell) {
    console.error(t("hook.unsupportedShell"));
    process.exit(1);
  }

  let current = "";
  try {
    current = await fs.readFile(shell.rcFile, "utf-8");
  } catch {
    // 文件不存在：视为空内容
  }

  const desired = hookCode(shell.hookFn);

  // 已安装的判定条件是「**恰好一块**且内容与当前版本一致」。
  // 内容不一致（如升级后给钩子加了 `--new`）或残留多块（老版本 + 新版本各写过一次）
  // 都要走重写路径，否则用户升不上去、或者旧块永远留在 rc 里。
  const installedBlocks = readHookBlocks(current);
  if (installedBlocks.length === 1 && normalizeBlock(installedBlocks[0]!) === normalizeBlock(desired)) {
    console.log(t("hook.alreadyInstalled"));
    return;
  }
  const refreshed = installedBlocks.length > 0;

  // 统一走「先清掉所有已装块（含历史 aiz 块），再写入当前版本」
  const { content: cleaned, removed } = stripHookBlocks(current);
  const base = cleaned.replace(/\n+$/, "");
  await fs.writeFile(shell.rcFile, base + "\n" + desired, "utf-8");

  console.log(refreshed ? t("hook.updated", { file: shell.rcFile }) : t("hook.installed", { file: shell.rcFile }));
  if (removed) console.log(t("hook.upgraded"));
  console.log(t("hook.restartHint", { file: shell.rcFile }));
  console.log(t("hook.forwardHint"));
}

export async function uninstallHook(): Promise<void> {
  const shell = detectShell();
  if (!shell) {
    console.error(t("hook.unsupportedShell"));
    process.exit(1);
  }

  let content: string;
  try {
    content = await fs.readFile(shell.rcFile, "utf-8");
  } catch {
    console.log(t("hook.notInstalledNoFile"));
    return;
  }

  const { content: cleaned, removed } = stripHookBlocks(content);
  if (!removed) {
    console.log(t("hook.notInstalled"));
    return;
  }

  await fs.writeFile(shell.rcFile, cleaned, "utf-8");
  console.log(t("hook.uninstalled", { file: shell.rcFile }));
}
