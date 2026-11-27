/**
 * 系统编辑器：命令解析 + 启动。
 *
 * 这里钉的是两条判据，不是实现细节：
 *   · `$EDITOR` 优先于 `$VISUAL`，两者都没有才落到平台默认；
 *   · 编辑器起不来必须 reject —— 调用方要能把原因报给用户，不能静默当成功。
 *
 * 环境变量是进程级的，而本仓的用例共享一个进程（`isolate: false`）：改了就当场还原，
 * 不能指望别的文件替它收拾。
 */

import { describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openFileWithSystemApp,
  openInSystemEditor,
  systemEditorCommand,
  systemOpenCommand,
  writeTempImageFile,
} from "./system-editor.js";

/** 临时改环境变量（`undefined` = 删掉），跑完立即还原 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("systemEditorCommand", () => {
  it("`$EDITOR` 优先于 `$VISUAL`", () => {
    const got = withEnv({ EDITOR: "my-editor", VISUAL: "my-visual" }, systemEditorCommand);
    expect(got).toBe("my-editor");
  });

  it("没有 `$EDITOR` 时退到 `$VISUAL`", () => {
    const got = withEnv({ EDITOR: undefined, VISUAL: "my-visual" }, systemEditorCommand);
    expect(got).toBe("my-visual");
  });

  it("两者都没有才用平台默认（Windows 是 notepad：纯净 Windows 上没有 vi）", () => {
    const expected = process.platform === "win32" ? "notepad" : "vi";
    const got = withEnv({ EDITOR: undefined, VISUAL: undefined }, systemEditorCommand);
    expect(got).toBe(expected);
  });
});

describe("openInSystemEditor", () => {
  it("编辑器不存在：reject，而不是静默当成「用户没改」", async () => {
    await expect(
      openInSystemEditor("aizen-no-such-editor-xyz", join(tmpdir(), "aizen-x.md")),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("systemOpenCommand", () => {
  it("三个平台各一条命令（`start` 是 cmd 的内建命令，没有单独的 exe）", () => {
    expect(systemOpenCommand("darwin")).toEqual({ command: "open", args: [] });
    expect(systemOpenCommand("win32")).toEqual({ command: "cmd", args: ["/c", "start", ""] });
    expect(systemOpenCommand("linux")).toEqual({ command: "xdg-open", args: [] });
  });
});

describe("openFileWithSystemApp", () => {
  it("本机没有可用的打开命令（ENOENT）：回 `no-command`，不静默当成功", async () => {
    const result = await openFileWithSystemApp(join(tmpdir(), "aizen-x.png"), {
      command: "aizen-no-such-opener-xyz",
      args: [],
    });
    expect(result).toEqual({ kind: "no-command", command: "aizen-no-such-opener-xyz" });
  });

  it("命令跑了但没成（非零退出码）：回 `failed` 并带上退出码", async () => {
    // `false` 是 POSIX 上一定在、且一定以 1 退出的那个命令
    const result = await openFileWithSystemApp(join(tmpdir(), "aizen-x.png"), {
      command: "false",
      args: [],
    });
    expect(result).toMatchObject({ kind: "failed", command: "false", code: 1 });
  });
});

describe("writeTempImageFile", () => {
  it("把 base64 原样写进临时文件，后缀跟 mime 走", async () => {
    const file = await writeTempImageFile(Buffer.from("PNGDATA").toString("base64"), "image/png");
    try {
      expect(file.endsWith(".png")).toBe(true);
      expect(await readFile(file, "utf-8")).toBe("PNGDATA");
    } finally {
      await rm(file, { force: true });
    }
  });
});
