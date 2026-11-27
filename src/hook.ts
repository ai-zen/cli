/**
 * shell 钩子：往用户的 rc 文件（`~/.bashrc` / `~/.zshrc`）里增删一段 `command_not_found_*`。
 *
 * rc 是用户内容，不是本工具的缓存：那个文件是用户手工编辑过的，没有资格猜它里面是什么。所以读它只有
 * 一种正常结局，即文件不存在（还没装过）；其余失败（`EACCES`、`EISDIR`…）一律原样抛出，命令失败并
 * 说清原因。
 *
 * 这一条不是洁癖：`installHook` 的写回是「读到的内容 → 去掉钩子块 → 写回去」，一旦把读不出来当成
 * 文件是空的，写回去的就只剩一段钩子，用户的整个 rc 被抹掉。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { t } from "./i18n/index.js";

/**
 * 当前标记。
 *
 * 不得翻译：这两行是写进 rc 文件的代码块标记，靠它识别哪段是本工具的；翻了字面串就再也找不到旧块，
 * 用户会冒出一堆重复 hook。
 */
const MARKER_START = "# === ai hook (开始) ===";
const MARKER_END = "# === ai hook (结束) ===";

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
 * 必须带 `--tui`：钩子的发起场景是人坐在交互终端前把命令敲错了，不是脚本调用，所以要把原命令带进
 * TUI 当首条消息（`ai --tui --new "$@"`），而不是落到管道模式吐一段字就退出 —— 那样没有历史，也不
 * 能追问。另带 `--new`：钩子总是开一条新会话，不续接该目录上一次的会话，否则敲错一次命令就把内容
 * 追加进原有的长会话，上下文与会话名都会被打乱。`"$@"` 保留分词，避免原本带空格的参数被拼坏。
 */
function hookCode(hookFn: string): string {
  return ["", MARKER_START, `${hookFn}() {`, '  ai --tui --new "$@"', "}", MARKER_END, ""].join(
    "\n",
  );
}

function normalizeBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 取出文件中全部已安装的钩子块（含首尾标记），按出现顺序。
 *
 * 这里刻意返回数组而不是第一块：rc 里可能残留多个块（老版本与新版本各写了一次），只看第一块会出现
 * 「第一块恰好是最新版 → 判定为已安装 → 后面的旧块永远留着」。
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

function stripHookBlocks(content: string): { content: string; removed: boolean } {
  const lines = content.split("\n");
  const kept: string[] = [];
  let skipping = false;
  let matchedAny = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && trimmed === MARKER_START) {
      skipping = true;
      matchedAny = true;
      continue;
    }
    if (skipping && trimmed === MARKER_END) {
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

  // 只有「rc 不存在」能当空内容；其它读失败原样抛（下面那句 `writeFile` 是整份覆盖，
  // 拿一份没读到的东西当底子写回去 = 替用户删掉他的 rc）
  let current = "";
  try {
    current = await fs.readFile(shell.rcFile, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const desired = hookCode(shell.hookFn);

  // 已安装的判定条件是「恰好一块」且内容与当前版本一致。
  // 内容不一致（如升级后给钩子加了 `--new`）或残留多块（老版本 + 新版本各写过一次）
  // 都要走重写路径，否则用户升不上去、或者旧块永远留在 rc 里。
  const installedBlocks = readHookBlocks(current);
  if (
    installedBlocks.length === 1 &&
    normalizeBlock(installedBlocks[0]!) === normalizeBlock(desired)
  ) {
    console.log(t("hook.alreadyInstalled"));
    return;
  }
  const refreshed = installedBlocks.length > 0;

  const { content: cleaned } = stripHookBlocks(current);
  const base = cleaned.replace(/\n+$/, "");
  await fs.writeFile(shell.rcFile, base + "\n" + desired, "utf-8");

  console.log(
    refreshed
      ? t("hook.updated", { file: shell.rcFile })
      : t("hook.installed", { file: shell.rcFile }),
  );
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
  } catch (error) {
    // 「没有这个文件」才等于「没装过」；`EACCES` 拿去说「文件不存在」是一句假话，如实抛
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
