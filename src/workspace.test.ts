/**
 * `workspace.ts` 用例：**进哪个工作区**这条判据（PRD D30）。
 *
 * 这一层要钉的是三件事，每一件都曾经是一个真实的错：
 *
 *   1. 「这台宿主是不是本机」只有一条判据（`mode: "local"` 或地址回环）；
 *   2. 本机用当前目录（有就复用、没有就登记），远端**只用**上次进入的那个；
 *   3. 「上次进入的那个」按宿主分开记 —— 两台宿主不许串味，读坏了按「没记过」处理。
 *
 * 不用真宿主：这一层只把宿主的回执变成两条路里的某一条，起宿主只会把时间花在别人的测试上。
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogSink } from "@ai-zen/agents-logger";
import { setLocale } from "./i18n/index.js";
import type { WorkspaceSnapshot } from "./session/types.js";
import { useTempAiZenDir } from "./test-support/temp-dir.js";
import {
  enterWorkspace,
  listWorkspaces,
  recallWorkspace,
  rememberWorkspace,
  useOrRegisterWorkspace,
  workspaceById,
  workspaceHint,
  workspaceHost,
  type WorkspaceCaller,
  type WorkspaceHost,
} from "./workspace.js";

// ==================================================================
// 假宿主
// ==================================================================

/** 一个工作区的样子（CLI 那一份：`id` / `name` / 目录事实，只写用例关心的那几个字段） */
function view(id: string, cwd: string, exists: boolean | null = true): WorkspaceSnapshot {
  return { id, name: id, folder: { cwd, exists } };
}

/** 宿主 `workspace.list` 那一行（`cwd` 是它那台机器上的路径） */
function row(id: string, cwd: string) {
  return { id, name: id, cwd, createdAt: 0 };
}

interface FakeCaller {
  caller: WorkspaceCaller;
  calls: Array<{ method: string; params: unknown }>;
  /** 只看方法名的调用轨迹 */
  methods: () => string[];
}

/**
 * 一条假连接（只要 `api` 那一面）；`handler` 抛错就等于宿主回了错。
 *
 * 路径按 `Proxy` 拼成 procedure 名（`api.workspace.list.query` → `"workspace.list"`）：
 * 断言里那句 `methods()` 因此与旧版同名同序。
 */
function fakeCaller(
  handler: (method: string, params: unknown) => unknown = () => undefined,
): FakeCaller {
  const calls: Array<{ method: string; params: unknown }> = [];
  const make = (path: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, property: string) {
        if (property === "query" || property === "mutate") {
          const method = path.join(".");
          return async (params: unknown) => {
            calls.push({ method, params });
            const result = handler(method, params);
            if (result instanceof Error) throw result;
            return result;
          };
        }
        return make([...path, property]);
      },
    });
  const caller = { api: make([]) } as unknown as WorkspaceCaller;
  return { caller, calls, methods: () => calls.map((call) => call.method) };
}

/** 一台远端宿主（键是它的地址） */
const REMOTE: WorkspaceHost = { local: false, key: "ws://10.0.0.5:8790" };
/** 第二台远端宿主（「不许串味」的另一半） */
const OTHER_REMOTE: WorkspaceHost = { local: false, key: "ws://10.0.0.9:9000" };

const zen = useTempAiZenDir("aiz-workspace-");
afterAll(() => zen.cleanup());

/**
 * 本文件里报出去的话（记忆那两件事的日志出口 —— 从参数上递，不是进程级的全局日志器）。
 *
 * 用一个只记东西的日志器而不是让默认的 `console.warn` 打屏：「读不出来要报一句」是这一单的
 * 断言项，得看得见它，又不应该把一个正常的用例跑成一片红字。
 */
const warnings: string[] = [];

const logger: LogSink = {
  info: () => {},
  warn: (message) => void warnings.push(message),
  error: () => {},
};

beforeEach(() => {
  zen.pin();
  setLocale("zh");
  warnings.length = 0;
  // 记忆是落盘的：每条用例从「本机没记过任何工作区」开始
  rmSync(join(zen.dir, "cli"), { recursive: true, force: true });
});

afterAll(() => {
  zen.cleanup();
});

/** 记忆文件（`<aiZenDir>/cli/last-workspace.json`） */
function memory(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(zen.dir, "cli", "last-workspace.json"), "utf-8"));
  } catch {
    return {};
  }
}

// ==================================================================
// 「这台宿主是不是本机」
// ==================================================================

describe("workspaceHost：本机与远端的分界", () => {
  it("本机模式（走发现文件）= 本机，键是 local", () => {
    expect(workspaceHost({ mode: "local" })).toEqual({ local: true, key: "local" });
  });

  it("远端地址指向回环 = 本机（与「本机凭证对这台宿主有没有意义」同一条判据）", () => {
    for (const url of ["ws://127.0.0.1:8790", "ws://localhost:8790", "wss://[::1]:8790"]) {
      expect(workspaceHost({ mode: "remote", url })).toMatchObject({ local: true });
    }
  });

  it("远端地址不是回环 = 远端，键是它的地址（子路径与加密都在里面）", () => {
    expect(workspaceHost({ mode: "remote", url: "wss://example.com/ai-zen" })).toEqual({
      local: false,
      key: "wss://example.com:443/ai-zen",
    });
    // 裸 host:port 按 ws:// 补（连接层同一套归一）
    expect(workspaceHost({ mode: "remote", url: "10.0.0.5:8790" })).toEqual({
      local: false,
      key: "ws://10.0.0.5:8790",
    });
  });

  // 这里原本还有一条「地址解析不出来时按远端算」的用例，它保护的是 `workspaceHost` 里
  // 那个 `catch` 分支 —— 分支与用例一起删了：`remote` 模式的地址到达那里之前一定过过同一个
  // `parseAddress`（落盘那份由客户端库的 `storedSettings` 判，坏地址读成 `null` 即「没配过」；
  // 命令行那份由入口的 `serverUrlError` 判；连接屏上选的那份在提交时判），而用例递的是手造的
  // `{ mode: "remote", url: "http://" }`，这种输入在任何一个真实入口上都进不来。
});

// ==================================================================
// 「这个目录的工作区」
// ==================================================================

describe("useOrRegisterWorkspace：本机当前目录这条糖", () => {
  it("同一个目录已经登记过就复用它（不再登记一次）", async () => {
    const { caller, methods, calls } = fakeCaller((method) =>
      method === "workspace.list" ? [row("ws-1", "/work/proj")] : undefined,
    );

    const workspace = await useOrRegisterWorkspace(caller, "/work/proj");

    expect(workspace.id).toBe("ws-1");
    expect(methods()).toEqual(["workspace.list"]);
    // `workspace.list` 这一版没有入参（旧的 `includeMissingFolders` 已退场）
    expect(calls[0]?.params).toBeUndefined();
  });

  it("没登记过就登记它（cwd 原样递上去，不在这里做路径运算）", async () => {
    const { caller, methods, calls } = fakeCaller((method) =>
      method === "workspace.list"
        ? [row("ws-other", "/elsewhere")]
        : { workspace: row("ws-new", "/srv/repo") },
    );

    const workspace = await useOrRegisterWorkspace(caller, "/srv/repo");

    expect(workspace.id).toBe("ws-new");
    expect(methods()).toEqual(["workspace.list", "workspace.create"]);
    // 远端宿主上的绝对路径在客户端这台机器上可能压根不存在 —— 一个字符都不许改
    expect(calls[1]?.params).toEqual({ cwd: "/srv/repo" });
  });

  it("listWorkspaces / workspaceById 原样转出宿主的回执", async () => {
    const listed = fakeCaller(() => [row("ws-1", "/a"), row("ws-2", "/b")]);
    expect((await listWorkspaces(listed.caller)).map((item) => item.id)).toEqual(["ws-1", "ws-2"]);

    const missing = fakeCaller(() => new Error("not_found"));
    expect(await workspaceById(missing.caller, "ws-gone")).toBeNull();
  });
});

// ==================================================================
// 启动时进哪个（本机糖 / 远端上次 / 否则选择环节）
// ==================================================================

describe("enterWorkspace：启动时自动进入", () => {
  it("本机：用当前目录，并把它记成「上次进入的那个」", async () => {
    const { caller, calls } = fakeCaller((method) =>
      method === "workspace.list" ? [] : { workspace: row("ws-new", "/work/proj") },
    );

    const workspace = await enterWorkspace({
      connection: caller,
      host: { local: true, key: "local" },
      cwd: "/work/proj",
      logger,
    });

    expect(workspace?.id).toBe("ws-new");
    expect(calls.map((call) => call.method)).toEqual(["workspace.list", "workspace.create"]);
    expect(memory()).toEqual({ local: "ws-new" });
  });

  it("远端 + 上次进入的那个还在：用它，且不碰 workspace.create", async () => {
    await rememberWorkspace(REMOTE, "ws-remote", logger);
    // 宿主这一版没有 `workspace.get`：按 id 取 = 列一遍再挑
    const { caller, methods } = fakeCaller((method) =>
      method === "workspace.list" ? [row("ws-remote", "/srv/repo")] : undefined,
    );

    const workspace = await enterWorkspace({
      connection: caller,
      host: REMOTE,
      cwd: "/本机/目录",
      logger,
    });

    expect(workspace?.id).toBe("ws-remote");
    expect(methods()).toEqual(["workspace.list"]);
  });

  it("远端 + 从没记过：`null`（进选择环节），一条 workspace.create 都不发", async () => {
    const { caller, methods } = fakeCaller();

    const workspace = await enterWorkspace({
      connection: caller,
      host: REMOTE,
      cwd: "/本机/目录",
      logger,
    });

    expect(workspace).toBeNull();
    // 本机那条糖在远端上一次都不许走：拿 cwd 去登记就是 D30 那个错
    expect(methods()).toEqual([]);
  });

  it("远端 + 记着的那个已经被删了：按「没记过」处理，不报错", async () => {
    await rememberWorkspace(REMOTE, "ws-gone", logger);
    const { caller, methods } = fakeCaller(() => new Error("not_found"));

    const workspace = await enterWorkspace({
      connection: caller,
      host: REMOTE,
      cwd: "/本机/目录",
      logger,
    });

    expect(workspace).toBeNull();
    expect(methods()).toEqual(["workspace.list"]);
  });
});

// ==================================================================
// 记忆文件
// ==================================================================

describe("last-workspace.json：按宿主分开记", () => {
  it("两台宿主各记各的，互不串味", async () => {
    await rememberWorkspace(REMOTE, "ws-remote", logger);
    await rememberWorkspace(OTHER_REMOTE, "ws-other", logger);
    await rememberWorkspace({ local: true, key: "local" }, "ws-local", logger);

    // 同一份文件里三个键，一台宿主一格
    expect(memory()).toEqual({
      "ws://10.0.0.5:8790": "ws-remote",
      "ws://10.0.0.9:9000": "ws-other",
      local: "ws-local",
    });
    expect(await recallWorkspace(REMOTE, logger)).toBe("ws-remote");
    expect(await recallWorkspace(OTHER_REMOTE, logger)).toBe("ws-other");
    expect(await recallWorkspace({ local: true, key: "local" }, logger)).toBe("ws-local");
  });

  it("没记过的宿主读出来是 `null`", async () => {
    await rememberWorkspace(REMOTE, "ws-remote", logger);
    expect(await recallWorkspace(OTHER_REMOTE, logger)).toBeNull();
  });

  it("记的不是字符串：按「没记过」处理，下一次进入会写回一条干净的记忆", async () => {
    const path = join(zen.dir, "cli", "last-workspace.json");
    mkdirSync(join(zen.dir, "cli"), { recursive: true });
    // 表本身读得出来（只是个值不是字符串）：不归 `broken`，所以照常能合并写回
    writeFileSync(path, JSON.stringify({ [REMOTE.key]: 42 }), "utf-8");

    expect(await recallWorkspace(REMOTE, logger)).toBeNull();

    await rememberWorkspace(REMOTE, "ws-fresh", logger);
    expect(await recallWorkspace(REMOTE, logger)).toBe("ws-fresh");
  });
});

// ==================================================================
// 读不出来 ≠ 没记过
// ==================================================================

describe("last-workspace.json：读不出来不是「没记过」", () => {
  /** 记忆文件路径（目录先建好） */
  const memoryPath = () => {
    mkdirSync(join(zen.dir, "cli"), { recursive: true });
    return join(zen.dir, "cli", "last-workspace.json");
  };

  it("报一句，并按「没记过」继续（多选一次工作区，而不是拦住启动）", async () => {
    const path = memoryPath();
    writeFileSync(path, JSON.stringify({ [OTHER_REMOTE.key]: "ws-other" }), "utf-8");
    // 只给写权限：读必定 EACCES，而「写」本来是能成的
    chmodSync(path, 0o200);

    expect(await recallWorkspace(REMOTE, logger)).toBeNull();
    expect(warnings.join("\n")).toContain(path);

    chmodSync(path, 0o600);
  });

  it("绝对不写回：那份没读到的文件里，别的宿主记着的工作区原样留着", async () => {
    const path = memoryPath();
    writeFileSync(path, JSON.stringify({ [OTHER_REMOTE.key]: "ws-other" }), "utf-8");
    chmodSync(path, 0o200);

    // 读不出来 → 不写。写下去的话，合并的底子是空的，别的宿主那一格当场没了
    await rememberWorkspace(REMOTE, "ws-remote", logger);

    chmodSync(path, 0o600);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ [OTHER_REMOTE.key]: "ws-other" });
    // 也不许一声不吭
    expect(warnings.join("\n")).toContain(path);
  });

  it("写不进去时说一句（下一次进这台宿主会重新选一次）", async () => {
    // `cli/` 只给读+进：读那份不存在的记忆是 ENOENT（正常的第一次用），而写进去是 EACCES
    const dir = join(zen.dir, "cli");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);

    await rememberWorkspace(REMOTE, "ws-remote", logger);

    chmodSync(dir, 0o700);
    expect(warnings.join("\n")).toContain("last-workspace.json");
  });

  it("不是「键 → 值」的表（数组 / 标量）与坏 JSON 同一个结局：报一句 + 不写回", async () => {
    const path = memoryPath();

    for (const content of ["{ 坏掉的 JSON", "[]", '"text"', "42"]) {
      writeFileSync(path, content, "utf-8");

      // 读不懂它 → 按「没记过」继续（多选一次工作区），但不许猜
      expect(await recallWorkspace(REMOTE, logger)).toBeNull();
      expect(warnings.join("\n")).toContain(path);

      // 更不许写回：合并的底子只能是一张「键 → 值」的表，把它当空表等于拿 `{}` 覆盖它
      await rememberWorkspace(REMOTE, "ws-remote", logger);
      expect(readFileSync(path, "utf-8")).toBe(content);
    }
  });
});

// ==================================================================
// 显示
// ==================================================================

describe("workspaceHint：只在宿主给的事实上排版", () => {
  it("目录还在就只给路径，不在就补一句", () => {
    expect(workspaceHint(view("ws-1", "/work/proj"))).toBe("/work/proj");
    expect(workspaceHint(view("ws-1", "/work/proj", false))).toBe("/work/proj（目录已不在）");
  });
});
