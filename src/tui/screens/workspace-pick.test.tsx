// 工作区屏（PRD D30）：远端宿主上「该进哪个工作区」的那个选择环节。
//
// 三条路：列出来按回车进；宿主上一个都没有就直接要路径；新建被拒时把原因留在屏上。
// 用 ink-testing-library 真渲染（`useInput` 的行为只有真按键能验），结局用注入的 `onResult`
// 接住 —— 不去动 ink 的退出通道。
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { setLocale, t } from "../../i18n/index.js";
import type { HostConnection, WorkspaceSnapshot } from "../../session/types.js";
import { useTempAiZenDir } from "../../test-support/temp-dir.js";
import { WorkspacePickScreen, type WorkspacePickResult } from "./workspace-pick.js";

setLocale("zh");

// 这一屏会写「上次进入的工作区」（`rememberWorkspace` → `<AI_ZEN_DIR>/cli/last-workspace.json`），
// 所以要像别处一样把本进程的数据根钉到临时目录：生产侧由 `CliApp` 钉，用例侧走这里。
const zen = useTempAiZenDir("aizen-ws-pick-");
beforeEach(() => zen.pin());
afterAll(() => zen.cleanup());

/**
 * 等到 `check()` 成立就返回；超时抛错，错误里说清等的是什么。
 *
 * **别用「睡够 20ms」代替它**：那是赌「够久」，而这里要的是「真的发生了」。全量跑时事件
 * 循环被别的用例占着，同一个 20ms 有时够、有时不够 —— 同一份代码时红时绿，红的那次还
 * 只报个「`[]` 不等于 `[{ kind: 'chosen' }]`」，看不出在等什么。
 *
 * 条件只读状态（帧 / 结局长不长），断言照旧写在后面：失败信息才指得准。
 */
const until = async (check: () => boolean, what: string, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等不到：${what}（上限 ${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * 让出几拍宏任务 —— 让这一拍里**排在后面**的活先跑完。让的是执行顺序，不是一个时长。
 *
 * 为什么敲键之前要它：屏幕的帧是在 commit 里画的，而 `useInput` 的订阅落在 passive
 * effect 里，同一拍里排在画帧**之后**（React 的 Scheduler 在 Node 下走 `setImmediate`）。
 * 所以「帧里已经有这一屏」还不等于「按键有人接」：在这一拍里塞一个键进去，那个键会被
 * 直接**丢掉** —— 不是延后处理，是永远不到，之后再睡多久都没用（这一点是实测出来的：
 * 重负载下「等 20ms 再敲回车」，`results` 之后一直空；敲键前让一拍，键就当场被处理）。
 */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** 帧里带选中标记（`SelectList` 的 `❯`）的那一行 —— 用来判断选中项挪没挪 */
const selectedLine = (frame: string): string =>
  frame.split("\n").find((line) => line.includes("❯")) ?? "";

/** 一个工作区的样子（CLI 那一份：`id` / `name` / 目录事实） */
function view(
  id: string,
  cwd: string,
  exists: boolean | null = true,
  name = id,
): WorkspaceSnapshot {
  return { id, name, folder: { cwd, exists } };
}

interface FakeHost {
  connection: Pick<HostConnection, "api">;
  calls: Array<{ method: string; params: unknown }>;
}

/**
 * 假宿主：`list` 是它的工作区表，`createFails` 让 `workspace.create` 回一句人话（宿主拒绝）。
 *
 * 打桩按方法名登记，没登记就抛 —— 屏偷偷调了第三个方法会当场红。
 */
function fakeHost(options: {
  workspaces?: WorkspaceSnapshot[];
  listed?: Error;
  createFails?: string;
}): FakeHost {
  const calls: Array<{ method: string; params: unknown }> = [];
  /** 路径按 `Proxy` 拼成 procedure 名（`api.workspace.list.query` → `"workspace.list"`） */
  const make = (path: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, property: string) {
        if (property === "query" || property === "mutate") {
          const method = path.join(".");
          return async (params: unknown) => {
            calls.push({ method, params });
            if (method === "workspace.list") {
              if (options.listed) throw options.listed;
              return (options.workspaces ?? []).map((workspace) => ({
                id: workspace.id,
                name: workspace.name,
                cwd: workspace.folder.cwd,
                createdAt: 0,
              }));
            }
            if (method === "workspace.create") {
              if (options.createFails) throw new Error(options.createFails);
              const { cwd } = params as { cwd: string };
              return { workspace: { id: "ws-new", name: "ws-new", cwd, createdAt: 0 } };
            }
            throw new Error(`用例没给 ${method} 打桩`);
          };
        }
        return make([...path, property]);
      },
    });
  const connection = { api: make([]) } as unknown as Pick<HostConnection, "api">;
  return { connection, calls };
}

function mountScreen(connection: Pick<HostConnection, "api">) {
  const results: WorkspacePickResult[] = [];
  const view = render(
    <WorkspacePickScreen
      connection={connection}
      onResult={(result) => results.push(result)}
      terminalSize={{ columns: 80, rows: 24 }}
    />,
  );
  return {
    results,
    stdin: view.stdin,
    frame: () => view.lastFrame() ?? "",
    unmount: view.unmount,
  };
}

describe("工作区屏：列 / 选", () => {
  it("列出宿主的工作区（名字 + 目录），回车进第一个", async () => {
    const host = fakeHost({
      workspaces: [view("ws-1", "/srv/a", true, "甲"), view("ws-2", "/srv/b", false, "乙")],
    });
    const screen = mountScreen(host.connection);
    // 等列表真的画出来（而不是「睡 20ms 大概够了」）
    await until(() => screen.frame().includes("甲"), "工作区列表画出来");
    // 画出来 ≠ 有人接键：`useInput` 的订阅在这之后一拍才写进 messages
    await settle();

    const frame = screen.frame();
    expect(frame).toContain("甲");
    expect(frame).toContain("/srv/a");
    // 宿主这一版**不报**「那个目录还在不在」：客户端因此也不该编一句「目录已不在」
    expect(frame).not.toContain(t("ws.folderMissing"));

    screen.stdin.write("\r");
    await until(() => screen.results.length > 0, "回车被处理完");
    // 目录事实这一格是「不知道」（`exists: null`）；屏上交给上层的就是它
    expect(screen.results).toEqual([
      { kind: "chosen", workspace: view("ws-1", "/srv/a", null, "甲") },
    ]);
    screen.unmount();
  });

  it("Esc 退出（启动路径上的最后一道门）", async () => {
    const host = fakeHost({ workspaces: [view("ws-1", "/srv/a")] });
    const screen = mountScreen(host.connection);
    await until(() => screen.frame().includes("ws-1"), "工作区列表画出来");
    await settle();

    screen.stdin.write("\u001b");
    // 单键 Esc 要等 ink 自己的序列判定（~20ms）才认成 Esc —— 等它认，不猜它多久
    await until(() => screen.results.length > 0, "Esc 被处理完");

    expect(screen.results).toEqual([{ kind: "exit" }]);
    screen.unmount();
  });

  it("新建成一项：选中它之后就把路径交给宿主", async () => {
    const host = fakeHost({ workspaces: [view("ws-1", "/srv/a")] });
    const screen = mountScreen(host.connection);
    await until(() => screen.frame().includes("ws-1"), "工作区列表画出来");
    await settle();

    // 第二项是「新建工作区…」：按下键，等选中标记真的挪过去
    screen.stdin.write("\u001b[B");
    await until(
      () => selectedLine(screen.frame()).includes(t("ws.newLabel")),
      "选中项挪到「新建工作区…」",
    );
    screen.stdin.write("\r");
    await until(() => screen.frame().includes(t("ws.pathTitle")), "进到「要一个路径」那一屏");
    await settle();

    screen.stdin.write("/srv/repo");
    await until(() => screen.frame().includes("/srv/repo"), "路径打进了输入框");
    screen.stdin.write("\r");
    await until(() => screen.results.length > 0, "新建的结果回来");

    expect(host.calls.at(-1)).toEqual({ method: "workspace.create", params: { cwd: "/srv/repo" } });
    expect(screen.results).toEqual([
      { kind: "chosen", workspace: view("ws-new", "/srv/repo", null) },
    ]);
    screen.unmount();
  });
});

describe("工作区屏：新建的几条岔路", () => {
  it("宿主上一个工作区都没有：直接要路径（远端宿主上的目录只有用户知道）", async () => {
    const host = fakeHost({ workspaces: [] });
    const screen = mountScreen(host.connection);
    await until(() => screen.frame().includes(t("ws.pathTitle")), "直接进到「要一个路径」那一屏");
    await settle();

    const frame = screen.frame();
    expect(frame).toContain(t("ws.pathTitle"));
    expect(frame).toContain("/srv/repos/api");

    screen.stdin.write("/srv/repo");
    await until(() => screen.frame().includes("/srv/repo"), "路径打进了输入框");
    screen.stdin.write("\r");
    await until(() => screen.results.length > 0, "新建的结果回来");

    expect(screen.results).toEqual([
      { kind: "chosen", workspace: view("ws-new", "/srv/repo", null) },
    ]);
    screen.unmount();
  });

  it("空路径：说一句，不发请求", async () => {
    const host = fakeHost({ workspaces: [] });
    const screen = mountScreen(host.connection);
    await until(() => screen.frame().includes(t("ws.pathTitle")), "直接进到「要一个路径」那一屏");
    await settle();

    screen.stdin.write("\r");
    await until(() => screen.frame().includes(t("ws.pathEmpty")), "空路径的提示上屏");

    expect(screen.frame()).toContain(t("ws.pathEmpty"));
    expect(host.calls.map((call) => call.method)).not.toContain("workspace.create");
    screen.unmount();
  });

  it("宿主拒绝新建：原因留在屏上，屏不退出", async () => {
    const host = fakeHost({ workspaces: [], createFails: "cwd 不是绝对路径" });
    const screen = mountScreen(host.connection);
    await until(() => screen.frame().includes(t("ws.pathTitle")), "直接进到「要一个路径」那一屏");
    await settle();

    screen.stdin.write("relative/dir");
    await until(() => screen.frame().includes("relative/dir"), "路径打进了输入框");
    screen.stdin.write("\r");
    await until(() => screen.frame().includes("cwd 不是绝对路径"), "宿主拒绝的原因上屏");

    expect(screen.frame()).toContain("cwd 不是绝对路径");
    expect(screen.results).toEqual([]);
    screen.unmount();
  });

  it("读列表失败：说出原因，不假装「一个都没有」", async () => {
    const host = fakeHost({ listed: new Error("与宿主的连接断了") });
    const screen = mountScreen(host.connection);
    await until(() => screen.frame().includes("与宿主的连接断了"), "失败的原因上屏");

    expect(screen.frame()).toContain("与宿主的连接断了");
    // 不弹输入框（那会让用户以为是「还没有工作区」）
    expect(screen.frame()).not.toContain(t("ws.pathTitle"));
    screen.unmount();
  });
});
