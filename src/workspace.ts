/**
 * 工作区（`workspace.*`）在客户端这一侧的那一层：**进哪个、记住哪个、新建哪个**。
 *
 * ## 为什么这些事从会话层搬出来了
 *
 * 会话层原先自己解决「这次落在哪个目录」：拿 `process.cwd()` 去 `workspace.list` 里找同 cwd 的
 * 那条，找不到就 `workspace.create`。那一条只在本机宿主上成立 —— 宿主在别的机器上时，我们把
 * **这台机器**的 `/home/xx/project` 当成「宿主上的目录」登记了进去，而那个路径在宿主上可能
 * 根本不存在（PRD D30）。
 *
 * 现在「落在哪」是**进入工作区**这件事：列 / 选 / 建都是工作区自己的动作（`/ws`），三个入口
 * 共用本文件这一份判据 —— TUI 启动（`tui/index.tsx`）、一次性调用（`stdio.ts`）、
 * `/ws` 命令（`commands/handlers.ts`）。会话层只收一个 `workspaceId`，不再看 cwd。
 *
 * ## 本机与远端的分界只有一条判据
 *
 * 「这台宿主是不是本机」= 本机发现文件那条路（`mode: "local"`）或**地址的回环判定**
 * （{@link workspaceHost} 里的 `isLoopbackHost`）。后者就是「本机那串凭证对这台宿主有没有
 * 意义」用的同一条判据（`agents/packages/client/src/address.ts`），所以这里多出来的只是使用
 * 场景，不是第二套真相。
 *
 * 有了它，两类行为各归各位：
 *   · 本机 → 当前目录这条糖（有就复用、没有就登记）；
 *   · 远端 → 只认「上次进入的那个」；没有就进选择环节，**绝不**把客户端的路径递上去。
 *
 * ## 宿主给事实，客户端只显示
 *
 * 目录还在不在（`folder.exists`）、名称缺省成什么（宿主用目录名）、工作区还在不在（
 * `workspace.get` 的 `not_found`）—— 一条都不在这里算。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { LogSink } from "@ai-zen/agents-logger";
import { cliEnv } from "./env.js";
import { readMemoryFile } from "./local-memory.js";
import { t } from "./i18n/index.js";
import {
  isLoopbackHost,
  parseAddress,
  webSocketUrl,
  type ConnectionSettings,
} from "./server-client/index.js";
import type { HostConnection, WorkspaceSnapshot } from "./session/types.js";

/** 本文件只用到「问一句、写一笔」的那一面（命令层手上就是它） */
export type WorkspaceCaller = Pick<HostConnection, "api">;

/**
 * 「这次连的是哪台宿主」在两个地方用得上的两件事。
 *
 * 它们是同一件事的两面，所以收成一个对象：`local` 决定**行为**（能不能用当前目录这条糖），
 * `key` 决定**记忆落在哪一格**（两台宿主不许串味）。分开传的话，总有一处只传了一半。
 */
export interface WorkspaceHost {
  /** true = 本机。远端只能是「上次进入的那个」，本机才用当前目录 */
  local: boolean;
  /** `<aiZenDir>/cli/last-workspace.json` 里的键（本机一个，每台远端各一个） */
  key: string;
}

/**
 * 本机那一格的键。
 *
 * 远端一律用地址（见 {@link workspaceHost} 的 `webSocketUrl`），所以两者不会撞上；本机不走地址
 * 是因为它的地址来自发现文件里的随机端口 —— 每次拉起宿主都会变，拿它当键等于没有记忆。
 */
const LOCAL_HOST_KEY = "local";

/**
 * 一份连接设置 → 「是不是本机 + 记忆键」。
 *
 * 判据逐字来自连接层：`mode: "local"` 走的是本机的发现文件（`run/host.json` + `run/token`），
 * 那台宿主就在这台机器上；`mode: "remote"` 则看地址的 host 是不是回环 —— `isLoopbackHost`
 * 是包里那条唯一实现（`wss://your.domain/ai-zen` 不在其中，`127.0.0.1` / `::1` / `localhost` 在）。
 */
export function workspaceHost(settings: ConnectionSettings): WorkspaceHost {
  if (settings.mode !== "remote") return { local: true, key: LOCAL_HOST_KEY };
  // 解析**不会失败**：`remote` 模式的地址在到达这里之前已经过同一个 `parseAddress` ——
  // 落盘那份由客户端库的 `storedSettings` 判（坏地址读成 `null`，即「没配过」），
  // 命令行那份由入口的 `serverUrlError` 判，连接屏上选的那份在提交时判。
  // （所以这里没有「解析不出来就按远端算」的分支：它只会是一条永远走不到的路。）
  const target = parseAddress(settings.url?.trim() ?? "");
  return { local: isLoopbackHost(target.host), key: webSocketUrl(target) };
}

/** 列出现有工作区：顺序由宿主定，客户端原样显示 */
export async function listWorkspaces(connection: WorkspaceCaller): Promise<WorkspaceSnapshot[]> {
  const workspaces = await connection.api.workspace.list.query();
  return workspaces.map(workspaceOf);
}

/**
 * 宿主的一行项目 → 界面的那一行。
 *
 * `folder.exists` 恒 `null`：宿主这一版只报 `cwd`，「那个目录还在不在」它不答（也不该由客户端
 * 凭自己的盘去猜 —— 两机部署时那是另一台机器的路径）。
 */
function workspaceOf(row: { id: string; name: string; cwd: string }): WorkspaceSnapshot {
  return { id: row.id, name: row.name, folder: { cwd: row.cwd, exists: null } };
}

/**
 * 按 id 取一个工作区；取不到返回 `null`。
 *
 * 只问宿主：记着的那个还在不在，客户端不缓存名单（另一台设备可能刚把它删了）。
 *
 * 谁会走到 `catch`：宿主答 `workspace.get` 失败时（记着的那个被删 / 宿主换了库 —— 宿主用
 * 一条错误回执说这件事，没有单独的「不存在」返回值），以及这条连接已经断开时。两件事在
 * 这一层都只能收成 `null`（`null` = 「按没记过处理」，由调用方进选择环节），因为
 * 客户端**分不出**「那段没了」与「这一问没送到」：把后者也当成「没了」的代价是用户要多选
 * 一次工作区，把它抛上去的代价是启动直接失败。
 */
export async function workspaceById(
  connection: WorkspaceCaller,
  workspaceId: string,
): Promise<WorkspaceSnapshot | null> {
  try {
    // 宿主这一版没有 `workspace.get`：列一遍再挑那一条
    return (
      (await listWorkspaces(connection)).find((workspace) => workspace.id === workspaceId) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * 「这个目录的工作区」：有就复用、没有就登记（cwd 唯一，宿主不让重复登记）。
 *
 * `cwd` **原样递上去**：路径归一是宿主的事（`workspace.create` 要求绝对路径并自己 `resolve`），
 * 客户端不做路径运算 —— 否则远端宿主上的 `/srv/proj` 在一台 Windows 客户端上会被解析成另一个
 * 字符串，而那个字符串只存在于我们这台机器上。
 */
export async function useOrRegisterWorkspace(
  connection: WorkspaceCaller,
  cwd: string,
): Promise<WorkspaceSnapshot> {
  const existing = (await listWorkspaces(connection)).find(
    (workspace) => workspace.folder.cwd === cwd,
  );
  if (existing) return existing;
  const { workspace } = await connection.api.workspace.create.mutate({ cwd });
  return workspaceOf(workspace);
}

/** {@link enterWorkspace} 的入参 */
export interface EnterWorkspaceInput {
  connection: WorkspaceCaller;
  host: WorkspaceHost;
  /** 本机那条糖用的目录（`process.cwd()`）—— 由入口给，本模块不做「往哪落」的默认 */
  cwd: string;
  /** 记忆那两件事（读不出来 / 记不住）的日志出口：由入口从根手里收了再递进来 */
  logger: LogSink;
}

/**
 * 启动时自动进入工作区（D30）。
 *
 * | 这台宿主 | 进哪个 |
 * |---|---|
 * | 本机 | 当前目录（登记过就复用，没登记就登记一个） |
 * | 远端 | 上次进入的那个 —— 还在就用它 |
 * | 远端 + 没记过 / 记着的那个已不在 | `null`：由调用方进选择环节 |
 */
export async function enterWorkspace(
  input: EnterWorkspaceInput,
): Promise<WorkspaceSnapshot | null> {
  if (input.host.local) {
    const workspace = await useOrRegisterWorkspace(input.connection, input.cwd);
    await rememberWorkspace(input.host, workspace.id, input.logger);
    return workspace;
  }
  const remembered = await recallWorkspace(input.host, input.logger);
  if (remembered === null) return null;
  // 记着的那个已经没了（被删 / 宿主换了库）：按「没记过」处理 —— 那不是错误，进选择环节
  return await workspaceById(input.connection, remembered);
}

/**
 * 一行「这个工作区在哪、那个目录还在不在」。
 *
 * 两个都是宿主给的事实，这里只排版：目录没了照样能进（D12，历史照常可看），但那一行要说出来，
 * 否则用户会以为选错了。
 */
export function workspaceHint(workspace: WorkspaceSnapshot): string {
  // `exists === null` = 宿主这一版不报这一格：那就**什么都不说**（拿「不知道」当「目录没了」
  // 会吓人一跳）。只有真的知道 `false` 时才补那一句。
  const missing = workspace.folder.exists === false ? t("ws.folderMissing") : "";
  return `${workspace.folder.cwd}${missing}`;
}

// ---------------------------------------------------------------------------
// 「上次进入的那个工作区」—— 本机的一小块记忆（与 `last-session.json` 同目录、同风格）
// ---------------------------------------------------------------------------

/** 记忆文件：`<aiZenDir>/cli/last-workspace.json`（键是 {@link WorkspaceHost.key}） */
function memoryPath(): string {
  // `cliEnv()` 的「没设置就抛」是给**读不到事实**这件事用的：生产侧 `CliApp` 的构造函数
  // 第一句就把它钉下去（`app.ts`），用例侧走 `test-support/temp-dir.ts` —— 于是「没有根」
  // 在两种入口上都不可能发生，这里也就没有「兜一个空路径、静默不记忆」的分支。
  return join(cliEnv().aiZenDir, "cli", "last-workspace.json");
}

/**
 * 这台宿主上次进入的是哪个。
 *
 * `null` = 没有可用的记忆：从没记过、文件里没有这一格、或者**读不出来**（最后一类
 * `readMemoryFile` 已经报了一句）。三种都按「没记过」继续 —— 代价是多选一次工作区，
 * 比「为一份缓存拦住启动」小。
 */
export async function recallWorkspace(
  host: WorkspaceHost,
  logger: LogSink,
): Promise<string | null> {
  const read = await readMemoryFile(memoryPath(), logger);
  if (read.kind !== "value") return null;
  const value = read.entries[host.key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 记住这台宿主现在进入的是哪个。
 *
 * 写失败只是「下次重新选一次」，不拦这一次 —— 但要说一句，不许一声不吭（`logger`）。
 */
export async function rememberWorkspace(
  host: WorkspaceHost,
  workspaceId: string,
  logger: LogSink,
): Promise<void> {
  const path = memoryPath();
  const read = await readMemoryFile(path, logger);
  // 读不出来就不写：那一份里别的宿主记着的工作区我们没看到，写下去等于把它们抹掉
  if (read.kind === "broken") return;
  const entries = read.kind === "value" ? read.entries : {};
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ ...entries, [host.key]: workspaceId }, null, 2));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`记不住 ${path}：${reason}（下次进这台宿主时要重新选一次工作区）`);
  }
}
