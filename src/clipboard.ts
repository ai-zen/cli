/**
 * 系统剪贴板读取 —— `Ctrl+V` 粘贴图片 / 文本的唯一入口。
 *
 * ## 为什么必须主动去问系统
 *
 * 终端协议里没有「剪贴板内容」这一说：`Ctrl+V` 到进程的**只是一个按键事件**，
 * 图片数据不会自己流进来（终端自身的 `Cmd+V` 也只能贴文本）。所以图片必须去问
 * 系统剪贴板；问不到就退回「粘贴文本」—— 那才是用户按 `Ctrl+V` 的默认期待。
 *
 * ## 各平台怎么问
 *
 * | 平台 | 图片 | 文本 |
 * |---|---|---|
 * | macOS | `osascript -e "get the clipboard as «class PNGf»"`，stdout 是 `«data PNGf<HEX>»` | `pbpaste` |
 * | Linux | `wl-paste --type image/png`（Wayland）→ `xclip -t image/png -o`（X11） | `wl-paste --no-newline` → `xclip -o` |
 * | Windows | PowerShell `Get-Clipboard -Format Image` → PNG → base64 | `Get-Clipboard -Raw` |
 *
 * **一律不落盘**：macOS 那条给的是十六进制文本，Linux 给的是二进制，Windows 给的是
 * base64 —— 三者都能在内存里还原成 base64，而 SDK 的 `fileToContentSection()` 正好接受
 * `{ base64, mime }`，于是粘贴一张图片不需要写任何临时文件。
 *
 * 命令不存在 / 退出码非 0 / 输出为空，一律当作「没有」，由调用方回退到文本。
 * 这条约定让「没装 `wl-paste`」「剪贴板是文本」「剪贴板是图片」三种情况不会互相阻塞。
 */
import { execFile } from "node:child_process";

/** 一张剪贴板图片（已是 base64，未落盘） */
export interface ClipboardImage {
  base64: string;
  mime: string;
}

/**
 * 读取结果三态。
 *
 * 为什么要区分「没有」和「太大」：两者都要回退到粘贴文本，但提示不一样 ——
 * 「剪贴板里没有图片」是正常情况（用户就是想贴文本），「图片太大」是真问题
 * （用户以为贴上了，其实没有），不提示会让人莫名其妙。
 */
export type ClipboardImageResult =
  | { kind: "image"; image: ClipboardImage }
  | { kind: "too-large"; bytes: number }
  | { kind: "none" };

/** 单张粘贴图片上限：与 SDK 默认内联上限（8MB）同量级，留出 base64 膨胀余量 */
export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 单次粘贴文本上限 256KB。
 *
 * 超了**报错而不是截断**：半截代码 / 半截 JSON 粘进对话比不粘更坑（用户会以
 * 为粘全了，基于残缺内容提问）。需要大段内容时让他存成文件用 `@` 引用。
 */
export const MAX_CLIPBOARD_TEXT_BYTES = 256 * 1024;
/** 单次命令超时：剪贴板是本机操作，超过这个时间基本就是命令卡住了 */
const CMD_TIMEOUT_MS = 3000;
/** stdout 上限：20MB 图片在 macOS 上是 40MB 十六进制文本 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 执行命令；不可用（不存在 / 非零退出 / 超时）返回 null，成功返回 stdout 原始字节 */
  run?: (cmd: string, args: string[]) => Promise<Buffer | null>;
}

function defaultRun(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: CMD_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES, encoding: "buffer" },
      (error, stdout) => resolve(error ? null : (stdout as Buffer)),
    );
  });
}

/**
 * 解析 osascript 的输出 `«data PNGf89504E47…»`（PNGf 后面全是十六进制）。
 *
 * 格式不符（或没有图片时 osascript 直接非零退出）一律返回 null：
 * 这条路径上「猜」比「放弃」危险得多 —— 猜错就会把半截字节当成图片发出去。
 */
export function parseAppleScriptPng(stdout: string): Buffer | null {
  const matched = /«data PNGf([0-9A-Fa-f]+)»/.exec(stdout);
  if (!matched) return null;
  const hex = matched[1]!;
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}

interface ImageCommand {
  cmd: string;
  args: string[];
  mime: string;
  /** stdout → 原始字节；格式不符返回 null */
  parse: (stdout: Buffer) => Buffer | null;
}

/**
 * 候选命令列表（按优先级）。
 *
 * Linux 交换顺序的依据：Wayland 下 `xclip` 通常也能碰巧工作（XWayland），但反过来
 * Wayland 会话里 `wl-paste` 更可靠，且不会因为缺 X 授权而静默失败。
 */
function imageCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ImageCommand[] {
  if (platform === "darwin") {
    return [
      {
        cmd: "osascript",
        args: ["-e", "get the clipboard as «class PNGf»"],
        mime: "image/png",
        parse: (stdout) => parseAppleScriptPng(stdout.toString("utf8")),
      },
    ];
  }
  if (platform === "linux") {
    const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
    const wl: ImageCommand[] = [
      {
        cmd: "wl-paste",
        args: ["--type", "image/png"],
        mime: "image/png",
        parse: (stdout) => stdout,
      },
      {
        cmd: "wl-paste",
        args: ["--type", "image/jpeg"],
        mime: "image/jpeg",
        parse: (stdout) => stdout,
      },
    ];
    const x11: ImageCommand[] = [
      {
        cmd: "xclip",
        args: ["-selection", "clipboard", "-t", "image/png", "-o"],
        mime: "image/png",
        parse: (stdout) => stdout,
      },
      {
        cmd: "xclip",
        args: ["-selection", "clipboard", "-t", "image/jpeg", "-o"],
        mime: "image/jpeg",
        parse: (stdout) => stdout,
      },
    ];
    return wayland ? [...wl, ...x11] : [...x11, ...wl];
  }
  if (platform === "win32") {
    return [
      {
        cmd: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$img = Get-Clipboard -Format Image; " +
            "if ($img) { $ms = New-Object System.IO.MemoryStream; " +
            "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); " +
            "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray())) }",
        ],
        mime: "image/png",
        parse: (stdout) => {
          const base64 = stdout.toString("utf8").replace(/\s/g, "");
          return base64 ? Buffer.from(base64, "base64") : null;
        },
      },
    ];
  }
  return [];
}

interface TextCommand {
  cmd: string;
  args: string[];
}

function textCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): TextCommand[] {
  if (platform === "darwin") return [{ cmd: "pbpaste", args: [] }];
  if (platform === "linux") {
    const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
    // `--no-newline`：wl-paste 默认给文本补一个换行，粘进输入框会多出一行
    const wl: TextCommand[] = [{ cmd: "wl-paste", args: ["--no-newline"] }];
    const x11: TextCommand[] = [{ cmd: "xclip", args: ["-selection", "clipboard", "-o"] }];
    return wayland ? [...wl, ...x11] : [...x11, ...wl];
  }
  if (platform === "win32") {
    return [
      {
        cmd: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      },
    ];
  }
  return [];
}

/** 读剪贴板里的图片；没有图片时返回 `{ kind: "none" }`（调用方据此回退到文本） */
export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<ClipboardImageResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;

  for (const candidate of imageCommands(platform, env)) {
    const stdout = await run(candidate.cmd, candidate.args);
    if (!stdout || stdout.length === 0) continue;
    const bytes = candidate.parse(stdout);
    if (!bytes || bytes.length === 0) continue;
    if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) return { kind: "too-large", bytes: bytes.length };
    return { kind: "image", image: { base64: bytes.toString("base64"), mime: candidate.mime } };
  }
  return { kind: "none" };
}

/**
 * 读剪贴板文本的结果。
 *
 * 三态分开是因为提示文案各不相同：`unavailable` = 环境缺剪贴板工具，
 * `too-large` = 真问题（用户以为粘上了其实没有），空文本 = 剪贴板确实空着。
 */
export type ClipboardTextResult =
  { kind: "text"; text: string } | { kind: "too-large"; bytes: number } | { kind: "unavailable" };

/**
 * 读剪贴板里的文本。
 *
 * 返回 `unavailable` = 压根没有可用的剪贴板工具（区别于「剪贴板是空的」= 空文本），
 * 两者在提示上要分开：一个是环境缺依赖，一个是用户剪贴板确实空着。
 */
export async function readClipboardText(deps: ClipboardDeps = {}): Promise<ClipboardTextResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;

  for (const candidate of textCommands(platform, env)) {
    const stdout = await run(candidate.cmd, candidate.args);
    if (stdout == null) continue;
    // 统一换行：Windows 剪贴板给 CRLF，插进输入框会变成「多了个不可见字符」
    const text = stdout.toString("utf8").replace(/\r\n?/g, "\n");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CLIPBOARD_TEXT_BYTES) return { kind: "too-large", bytes };
    return { kind: "text", text };
  }
  return { kind: "unavailable" };
}
