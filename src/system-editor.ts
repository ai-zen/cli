/**
 * 系统编辑器 —— `/editor` 与配置向导的多行编辑屏共用这一份。
 *
 * 两处原本各写一支：解析 `$EDITOR`、起进程、等它退出、报错。差别只在临时文件的
 * 内容与后缀，而那是调用方的事。合到一处后，「用哪个编辑器」「怎么等它」只有一份答案。
 */

import { spawn } from "node:child_process";

/** 打开系统编辑器的实现：给它命令与文件路径，等编辑器退出（测试注入假实现） */
export type OpenEditor = (editor: string, file: string) => void | Promise<void>;

/**
 * 系统编辑器命令：`$EDITOR` → `$VISUAL` → 平台默认。
 *
 * Windows 的默认值是 `notepad`：`vi` 在纯净 Windows 上并不存在。
 */
export function systemEditorCommand(): string {
  return (
    process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi")
  );
}

/**
 * 用系统编辑器打开 `file`，等它退出。
 *
 * **不能用 `spawnSync`**：用户对着编辑器敲字的那几分钟里，同步等待会把 Ink 的事件
 * 循环整个钉住 —— 与 `/update` 里 `npm` 那一笔同一条理由。
 *
 * 非零退出码不算失败：不保存直接 `:q!` 是最常见的用法。要不要落盘由调用方比对文件
 * 内容决定，不看退出码。
 */
export function openInSystemEditor(editor: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}
