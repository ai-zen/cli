import { describe, expect, it } from "vitest";
import {
  parseAppleScriptPng,
  readClipboardImage,
  readClipboardText,
  MAX_CLIPBOARD_IMAGE_BYTES,
  type ClipboardDeps,
} from "./clipboard.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 造一个「命令 → stdout」的假执行器；未列出的命令视为不可用（null） */
function fakeRun(table: Record<string, Buffer | string | null>) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const key = [cmd, ...args].join(" ");
    const value = table[key] ?? table[cmd] ?? null;
    if (value == null) return null;
    return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  };
  return { run, calls };
}

const darwin = (run: ClipboardDeps["run"]): ClipboardDeps => ({ platform: "darwin", env: {}, run });
const linux = (run: ClipboardDeps["run"], env: NodeJS.ProcessEnv = { XDG_SESSION_TYPE: "x11" }): ClipboardDeps => ({
  platform: "linux",
  env,
  run,
});

describe("parseAppleScriptPng：解析 osascript 的 «data PNGf<HEX>»", () => {
  it("解出原始字节", () => {
    const hex = PNG_MAGIC.toString("hex").toUpperCase();
    const bytes = parseAppleScriptPng(`«data PNGf${hex}»`);
    expect(bytes?.equals(PNG_MAGIC)).toBe(true);
  });

  it("格式不符返回 null（宁可放弃，也不猜半截字节）", () => {
    expect(parseAppleScriptPng("hello")).toBeNull();
    expect(parseAppleScriptPng("«data PNGfZZZ»")).toBeNull();
    expect(parseAppleScriptPng("«data PNGf89504»")).toBeNull(); // 奇数长度
    expect(parseAppleScriptPng("«data PNGf»")).toBeNull(); // 空数据
  });
});

describe("readClipboardImage：有图片", () => {
  it("macOS：osascript 的十六进制 → base64（不落盘）", async () => {
    const hex = PNG_MAGIC.toString("hex").toUpperCase();
    const { run, calls } = fakeRun({
      "osascript -e get the clipboard as «class PNGf»": `«data PNGf${hex}»`,
    });
    const result = await readClipboardImage(darwin(run));
    expect(result).toEqual({
      kind: "image",
      image: { base64: PNG_MAGIC.toString("base64"), mime: "image/png" },
    });
    expect(calls[0]?.cmd).toBe("osascript");
  });

  it("Linux/Wayland：wl-paste 的二进制 → base64", async () => {
    const { run } = fakeRun({ "wl-paste --type image/png": PNG_MAGIC });
    const result = await readClipboardImage(linux(run, { WAYLAND_DISPLAY: "wayland-0" }));
    expect(result.kind).toBe("image");
    if (result.kind === "image") expect(result.image.base64).toBe(PNG_MAGIC.toString("base64"));
  });

  it("Linux/Wayland：wl-paste 不可用时落到 xclip", async () => {
    const { run, calls } = fakeRun({
      "xclip -selection clipboard -t image/png -o": PNG_MAGIC,
    });
    const result = await readClipboardImage(linux(run, { WAYLAND_DISPLAY: "wayland-0" }));
    expect(result.kind).toBe("image");
    // 先试 wl-paste（两条：png / jpeg），再试 xclip
    expect(calls.map((call) => call.cmd)).toEqual(["wl-paste", "wl-paste", "xclip"]);
  });

  it("X11 会话优先 xclip（wl-paste 常缺、缺了要早起落）", async () => {
    const { run, calls } = fakeRun({ "xclip -selection clipboard -t image/png -o": PNG_MAGIC });
    await readClipboardImage(linux(run));
    expect(calls[0]?.cmd).toBe("xclip");
  });

  it("超过上限时给出 too-large（提示用，而不是当成没有图片）", async () => {
    const huge = Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1, 0x89);
    const { run } = fakeRun({ "xclip -selection clipboard -t image/png -o": huge });
    const result = await readClipboardImage(linux(run));
    expect(result.kind).toBe("too-large");
    if (result.kind === "too-large") expect(result.bytes).toBe(huge.length);
  });
});

describe("readClipboardImage：没有图片", () => {
  it("命令全部不可用 → none", async () => {
    const { run } = fakeRun({});
    expect(await readClipboardImage(darwin(run))).toEqual({ kind: "none" });
  });

  it("输出为空 / 解析不出字节 → none（不把空数据当图片）", async () => {
    const { run } = fakeRun({
      "osascript -e get the clipboard as «class PNGf»": "",
    });
    expect(await readClipboardImage(darwin(run))).toEqual({ kind: "none" });

    const empty = fakeRun({ "osascript -e get the clipboard as «class PNGf»": "not-a-png" });
    expect(await readClipboardImage(darwin(empty.run))).toEqual({ kind: "none" });
  });

  it("未知平台 → none（不抛错）", async () => {
    const { run } = fakeRun({});
    expect(await readClipboardImage({ platform: "aix", env: {}, run })).toEqual({ kind: "none" });
  });
});

describe("readClipboardText：无图时回退到文本", () => {
  it("macOS 用 pbpaste", async () => {
    const { run, calls } = fakeRun({ pbpaste: "hello\nworld" });
    expect(await readClipboardText(darwin(run))).toBe("hello\nworld");
    expect(calls[0]?.cmd).toBe("pbpaste");
  });

  it("Linux 用 wl-paste --no-newline（避免多粘一行）", async () => {
    const { run, calls } = fakeRun({ "wl-paste --no-newline": "hi" });
    expect(await readClipboardText(linux(run, { WAYLAND_DISPLAY: "wayland-0" }))).toBe("hi");
    expect(calls[0]?.args).toContain("--no-newline");
  });

  it("CRLF 归一成 LF（Windows 剪贴板）", async () => {
    const { run } = fakeRun({ "xclip -selection clipboard -o": "a\r\nb\rc" });
    expect(await readClipboardText(linux(run))).toBe("a\nb\nc");
  });

  it("剪贴板是空的返回空串（区别于「没有工具」的 null）", async () => {
    const { run } = fakeRun({ pbpaste: "" });
    expect(await readClipboardText(darwin(run))).toBe("");
  });

  it("没有任何剪贴板工具 → null", async () => {
    const { run } = fakeRun({});
    expect(await readClipboardText(darwin(run))).toBeNull();
  });
});
