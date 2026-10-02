import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";

/** 当前标记（ai hook 时代） */
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
    console.error("❌ 不支持的 shell（仅支持 bash / zsh）");
    process.exit(1);
  }

  let current = "";
  try {
    current = await fs.readFile(shell.rcFile, "utf-8");
  } catch {
    // 文件不存在：视为空内容
  }

  if (current.includes(MARKER_START)) {
    console.log("ℹ️  ai hook 已安装，无需重复操作");
    return;
  }

  // 迁移：先移除历史 aiz 块，再写入新块
  const { content: cleaned, removed } = stripHookBlocks(current);
  const base = cleaned.replace(/\n+$/, "");
  await fs.writeFile(shell.rcFile, base + "\n" + hookCode(shell.hookFn), "utf-8");

  console.log(`✅ ai hook 已安装到 ${shell.rcFile}`);
  if (removed) console.log("   （已自动升级旧版 aiz hook）");
  console.log(`   重启终端或执行 source ${shell.rcFile} 即可生效`);
  console.log(`   之后输入不存在的命令会自动转发给 AI 处理`);
}

export async function uninstallHook(): Promise<void> {
  const shell = detectShell();
  if (!shell) {
    console.error("❌ 不支持的 shell（仅支持 bash / zsh）");
    process.exit(1);
  }

  let content: string;
  try {
    content = await fs.readFile(shell.rcFile, "utf-8");
  } catch {
    console.log("ℹ️  ai hook 未安装（文件不存在）");
    return;
  }

  const { content: cleaned, removed } = stripHookBlocks(content);
  if (!removed) {
    console.log("ℹ️  ai hook 未安装");
    return;
  }

  await fs.writeFile(shell.rcFile, cleaned, "utf-8");
  console.log(`✅ ai hook 已从 ${shell.rcFile} 卸载`);
}
