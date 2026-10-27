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

function hookCode(hookFn: string): string {
  return ["", MARKER_START, `${hookFn}() {`, '  ai "$@"', "}", MARKER_END, ""].join(
    "\n",
  );
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

  if (current.includes(MARKER_START)) {
    console.log(t("hook.alreadyInstalled"));
    return;
  }

  // 迁移：先移除历史 aiz 块，再写入新块
  const { content: cleaned, removed } = stripHookBlocks(current);
  const base = cleaned.replace(/\n+$/, "");
  await fs.writeFile(shell.rcFile, base + "\n" + hookCode(shell.hookFn), "utf-8");

  console.log(t("hook.installed", { file: shell.rcFile }));
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
