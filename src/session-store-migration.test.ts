// 会话位置搬迁的**接线**测试（逻辑本身在 `@ai-zen/agents-server` 里单测过）。
//
// 这里只钉住 CLI 侧那三件事：旧路径找对了没有、当前工作区找对了没有、别的目录的会话
// 会不会串进来。
//
// 一个文件一个用例：迁移闸门按 `AI_ZEN_DIR` 缓存 Promise（同一进程内只搬一次），
// 多个用例共用同一个临时根时，第二个用例再写旧文件就搬不动了 —— 那不是 bug，
// 正是「只搬一次」的语义。
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceIdFor } from "@ai-zen/agents-server";
import { listSessions } from "./session-store.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";

const zen = useTempAiZenDir("aiz-migrate-wire-");
const legacyDir = () => join(zen.dir, "cli", "conversations");
const workspaceConvDir = (path: string) =>
  join(zen.dir, "workspaces", workspaceIdFor(path), "sessions");

beforeEach(() => {
  zen.pin();
  rmSync(zen.dir, { recursive: true, force: true });
});

afterAll(() => {
  zen.cleanup();
});

describe("老存档搬迁（CLI 侧接线）", () => {
  it("首次取用 store 时：本目录的会话搬进当前工作区，别的目录的搬到各自工作区", async () => {
    mkdirSync(legacyDir(), { recursive: true });
    for (const [id, cwd] of [
      ["chat_here", process.cwd()],
      ["chat_elsewhere", "/elsewhere/proj"],
    ] as const) {
      writeFileSync(
        join(legacyDir(), `${id}.json`),
        JSON.stringify({ id, agentId: "default", messages: [], cwd }),
        "utf-8",
      );
    }

    // `/load` 只看得见当前工作区的那条
    expect((await listSessions()).map((c) => c.id)).toEqual(["chat_here"]);

    // 两条都搬走了，旧目录不残留
    expect(existsSync(join(workspaceConvDir(process.cwd()), "chat_here.json"))).toBe(true);
    expect(existsSync(join(workspaceConvDir("/elsewhere/proj"), "chat_elsewhere.json"))).toBe(true);
    expect(existsSync(join(legacyDir(), "chat_here.json"))).toBe(false);
  });
});
