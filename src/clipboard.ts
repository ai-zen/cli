/**
 * 系统剪贴板读取，是 `Ctrl+V` 粘贴图片与文本的唯一入口。
 *
 * 终端协议里没有「剪贴板内容」这一说：`Ctrl+V` 到进程的只是一个按键事件，图片数据不会自己流进来
 * （终端自身的 `Cmd+V` 也只能贴文本）。所以图片必须主动去问系统剪贴板，问不到再退回粘贴文本 ——
 * 那才是用户按 `Ctrl+V` 的默认期待。
 *
 * 各平台问法不同：macOS 用 `osascript -e "get the clipboard as «class PNGf»"`（stdout 是
 * `«data PNGf<HEX>»`）取图片、`pbpaste` 取文本；Linux 用 `wl-paste --type image/png`（Wayland）
 * 或 `xclip -t image/png -o`（X11）取图片、`wl-paste --no-newline` 或 `xclip -o` 取文本；Windows
 * 用 PowerShell 的 `Get-Clipboard -Format Image` / `Get-Clipboard -Raw`。三者都一律不落盘：macOS
 * 给十六进制文本、Linux 给二进制、Windows 给 base64，都能在内存里还原成 base64，而粘贴链路
 * （`buildUserContent`）把它解成字节经 `content.upload` 交给服务端。
 *
 * 命令不存在、退出码非 0、输出为空，一律当作「没有」，由调用方回退到文本。这条约定让「没装
 * `wl-paste`」「剪贴板是文本」「剪贴板是图片」三种情况不会互相阻塞。
 */
import { execFile } from "node:child_process";

/** 一张剪贴板图片（已是 base64，未落盘） */
export interface ClipboardImage {
  base64: string;
  mime: string;
}

/**
 * 「没有」与「太大」都要回退到粘贴文本，但提示不一样：剪贴板里没有图片是正常情况（用户就是想贴
 * 文本），图片太大是真问题（用户以为贴上了，其实没有）。
 */
export type ClipboardImageResult =
  | { kind: "image"; image: ClipboardImage }
  | { kind: "too-large"; bytes: number }
  | { kind: "none" };

/**
 * 单张粘贴图片上限的兜底值。
 *
 * 宿主这一版不再报附件上限（`session.open` 里没有 `limits` 那一格），于是
 * `ChatSessionLike.attachmentLimits` 恒为 `null`，粘贴时的预检落在这一格上。代价是这一份可能与宿主
 * 真实的上限不一致：宿主改了自己的上限，客户端仍按 20MB 提示与预检，症状是提示放得下而实际被拒，
 * 或者反过来白白拒掉一张能发的图。不改成「不检查」，是因为不检查的话大图会一路传到宿主才失败，用户
 * 等的是几十秒的上传换一句「太大了」。宿主把上限重新报出来那天，这里改回读宿主给的那份。
 */
export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 单次粘贴文本上限 256KB。
 *
 * 超了报错而不是截断：半截代码或半截 JSON 粘进会话比不粘更糟，用户会以为粘全了并基于残缺内容提问。
 * 需要大段内容时存成文件用 `@` 引用。
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
 * 格式不符（没有图片时 osascript 直接非零退出）一律返回 null：这条路径上猜比放弃危险得多，猜错就会
 * 把半截字节当成图片发出去。
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

/** 没有图片时返回 `{ kind: "none" }`，调用方据此回退到文本 */
export async function readClipboardImage(
  deps: ClipboardDeps = {},
  maxBytes: number = MAX_CLIPBOARD_IMAGE_BYTES,
): Promise<ClipboardImageResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;

  for (const candidate of imageCommands(platform, env)) {
    const stdout = await run(candidate.cmd, candidate.args);
    if (!stdout || stdout.length === 0) continue;
    const bytes = candidate.parse(stdout);
    if (!bytes || bytes.length === 0) continue;
    // 上限由调用方给：这一版是本地兜底常量，宿主不再报它（见 `MAX_CLIPBOARD_IMAGE_BYTES`）
    if (bytes.length > maxBytes) return { kind: "too-large", bytes: bytes.length };
    return { kind: "image", image: { base64: bytes.toString("base64"), mime: candidate.mime } };
  }
  return { kind: "none" };
}

/**
 * 读剪贴板文本的结果：`unavailable` = 环境缺剪贴板工具，`too-large` = 真问题（用户以为粘上了其实
 * 没有），空文本 = 剪贴板确实空着。三者的提示文案各不相同，所以不合成一格。
 */
export type ClipboardTextResult =
  { kind: "text"; text: string } | { kind: "too-large"; bytes: number } | { kind: "unavailable" };

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
