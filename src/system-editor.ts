/**
 * 系统程序 —— `/editor` 的多行编辑屏、以及「用本机默认程序打开一个文件」（图片那条路）
 * 共用这一份。
 *
 * 两处原本各写一支：解析 `$EDITOR`、起进程、等它退出、报错。差别只在临时文件的
 * 内容与后缀，而那是调用方的事。合到一处后，「用哪个编辑器」「怎么等它」只有一份答案；
 * 「本机用什么打开一个文件」同理只写一次：图片那条路不另造一套 spawn 与报错。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * 「用本机默认程序打开这个文件」的那个命令（与编辑器分开：那是「改」，这是「看」）。
 *
 * macOS 是 `open`，Windows 是 `cmd /c start`（`start` 是 cmd 的内建命令，没有单独的 exe），
 * 其余当 Linux 处理（`xdg-open` 是那一族里最通用的一个）。
 */
export interface OpenCommand {
  /** 程序名（也是「没这条命令」时该在提示里说的那个名字） */
  command: string;
  /** 拼在文件名**之前**的参数（Windows 的 `start` 要先给一个空标题） */
  args: readonly string[];
}

export function systemOpenCommand(platform: string = process.platform): OpenCommand {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
}

/**
 * 打开一个文件的结果：**三种，分得开**（调用方要把是哪一种说出来，不许静默当成功）。
 *
 * 做成值而不是异常，是因为这三件的“下一步”不一样：「没有打开命令」是这台机器的环境问题，
 * 「命令跑了但失败」是那个程序的问题，两者都应当把**文件路径**告诉用户（他已经拿到字节了，
 * 自己拖进看图器就行）；而“Asset 不在”根本不在这份结果的范围内（那在取字节那一步就已经失败了）。
 */
export type OpenFileResult =
  | { kind: "opened" }
  /** 本机没有可用的打开命令（`ENOENT`）：这台机器上打不开 */
  | { kind: "no-command"; command: string }
  /** 命令存在但没成功（非零退出码 / 起不来）：带上退出码 */
  | { kind: "failed"; command: string; code: number | null; reason: string };

/**
 * 用本机默认程序打开 `file`。
 *
 * 与 {@link openInSystemEditor} 同一形状（`spawn` + 等它结束，不用 `spawnSync`）—— 这是「看一张
 * 图」那一步，同步等会把 Ink 的事件循环钉住。等的是**它自己退出**：`open` / `xdg-open` 这类
 * 命令把活交给看图器就返回，不会等到人关窗口。
 *
 * `open` 缺省就是本机那一条命令（{@link systemOpenCommand}）；给一个就用那个 —— 用例拿它验
 * 「这台机器没有可用的打开命令」这一支（那件事只能靠一个真的不存在的命令名来碰）。
 */
export function openFileWithSystemApp(
  file: string,
  open: OpenCommand = systemOpenCommand(),
): Promise<OpenFileResult> {
  const { command, args } = open;
  return new Promise((resolve) => {
    const child = spawn(command, [...args, file], { stdio: "ignore" });
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve(
        error.code === "ENOENT"
          ? { kind: "no-command", command }
          : { kind: "failed", command, code: null, reason: error.message },
      );
    });
    child.once("close", (code) => {
      if (code === 0) resolve({ kind: "opened" });
      else resolve({ kind: "failed", command, code, reason: `exit ${code}` });
    });
  });
}

/** `image/png` → `png`（文件名后缀；不认识的 mime 用 `bin`） */
function extensionOf(mime: string): string {
  const slash = mime.indexOf("/");
  const ext = slash < 0 ? "" : mime.slice(slash + 1);
  return /^[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : "bin";
}

/**
 * 把一份 base64 写到临时文件，返回它的路径。
 *
 * 为什么落盘：终端打不开字节流，只能把一个**文件路径**交给本机程序。放 `$TMPDIR` 且不删：
 * 看图器可能在用户按完键之后很久才读它，而临时目录本来就是由系统收的 —— 删早了就是
 * “打开成功、看一眼却是空文件”。
 */
export async function writeTempImageFile(base64: string, mime: string): Promise<string> {
  const file = join(tmpdir(), `aizen-image-${randomBytes(6).toString("hex")}.${extensionOf(mime)}`);
  await writeFile(file, Buffer.from(base64, "base64"));
  return file;
}
