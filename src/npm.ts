/**
 * 跑 npm / npx。目前只有一个客户：`/upgrade`（`commands/handlers.ts` 的 `cmdUpgrade`）。
 *
 * 宿主由客户端按版本现拉现起（`npx -y @ai-zen/agents-host@<版本>`），所以升级宿主不装任何全局包，而
 * 是让 npx 把那一版拉进它自己的缓存：升级与拉起走同一条路，装到的就是下次启动会用的那一份。全局安装
 * 与 npx 缓存是两个位置，装到全局等于没装。
 *
 * 「查发布标签」与「把某一版拉进 npx 缓存」的收尾形状相同（退出码 + 两路输出），差别只在怎么解读，
 * 所以这里钉一个原语 {@link RunNpm}：命令层拿它当参数（`ChatCommandHost.runNpm`），用例喂一个假的，
 * 于是升级这条路不会真跑 npm —— 真去连 registry、真往 npx 缓存里拉包的话，用例就不再是验语义，而是
 * 赌网速与权限。
 *
 * 不用 `spawnSync`：`npm view` 走网络要 1–3 秒，`npx` 拉一版要几十秒，同步执行会把事件循环钉死，
 * Ink 的动画定时器跟着停摆，用户看到的是一个冻住的转圈。超时主动 kill，避免断网时命令永远不返回。
 *
 * 输出统一捕获，不 `stdio: inherit`：进度已由三阶段通知说了（`host-stage.ts`，与拉起宿主那块屏同一
 * 套句子），npm 自己那行滚动不再承载信息；而拉不下来要报一句能上屏的原因（`ETARGET` / `EAI_AGAIN` /
 * 断网），inherit 拿不到它 —— 旧版因此只能报一句 `exit 1`，用户不知道该换个版本还是该等网络。
 */

import { spawn } from "node:child_process";
import { truncate } from "./text.js";

/**
 * 一次调用的超时：断网或 registry 无响应时不能无限期挂着。
 *
 * 拉一版宿主本来就慢（首次要拉 tarball），所以给足两分钟而不是查询那种十几秒；超了就 kill 并按失败
 * 报，原因写明是超时。
 */
const NPM_TIMEOUT_MS = 120_000;

/** Windows 上 npm / npx 是 `.cmd`，而 `.cmd` 不过一层 shell 起不来（与 `npxHostArgv` 同一处理） */
const WINDOWS = process.platform === "win32";

/** 要跑哪个命令行：`npm` 只管查 registry，`npx` 只管把某一版拉进缓存 */
export type NpmCli = "npm" | "npx";

export interface NpmResult {
  /** 退出码；`null` = 压根没跑起来（PATH 里没有 npm / npx）或超时被杀 */
  code: number | null;
  /** stdout（`npm view --json` 的 JSON 走这里） */
  stdout: string;
  /** stderr（npm 的报错与警告都走这里） */
  stderr: string;
  /** 没跑起来 / 被超时杀掉的原因（`code` 为 `null` 时才有） */
  error?: string;
}

/**
 * 跑一次 npm / npx（argv 原样传，不拼 shell）。
 *
 * 生产侧：TUI 不给 `ChatCommandHost.runNpm` 时，`cmdUpgrade` 用的就是 {@link runNpm}；用例侧换成假的
 * （`commands/handlers-update.test.ts`），npm / npx 一次都不真跑。
 */
export type RunNpm = (cli: NpmCli, args: string[]) => Promise<NpmResult>;

/**
 * 缺省的调用（异步、有超时）。
 *
 * 只收 stdout/stderr，不看进度条：调用方要的是跑成了没，以及输出是什么。
 */
export function runNpm(cli: NpmCli, args: string[]): Promise<NpmResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(WINDOWS ? `${cli}.cmd` : cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(WINDOWS ? { shell: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    const done = (value: NpmResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk;
    });
    // `error` 与 `close` 可能都触发（`spawn` 失败时先 error 再 close），settled 保证只结算一次
    child.on("error", (error: Error) => done({ code: null, stdout, stderr, error: error.message }));
    child.on("close", (code) => done({ code, stdout, stderr }));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr, error: `${cli} 超时（${NPM_TIMEOUT_MS}ms 没有返回）` });
    }, NPM_TIMEOUT_MS);
  });
}

/**
 * 读包在 registry 上的全部 dist-tag（`{ latest, alpha, … }`）。
 *
 * 只拿 `latest` 不够：本项目的发布状态就是 alpha 比正式版新，只认 `latest` 会把正在跑 alpha 的用户
 * 降级回去。所以取全部 tag，交给 `pickNewest` 挑最高的那个。
 *
 * `--prefer-online`：npm 会缓存 packument，刚发版时 `npm view` 可能仍拿到旧 tag，把「有新版」误判成
 * 「已是最新」（发布当天踩过这个坑）。
 *
 * 失败（npm 不存在、网络不通、输出不是 JSON）返回 `undefined`，由调用方报「查不到」。
 */
export async function readDistTags(
  npm: RunNpm,
  pkg: string,
): Promise<Record<string, string> | undefined> {
  const result = await npm("npm", ["view", pkg, "dist-tags", "--json", "--prefer-online"]);
  if (result.code !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const tags: Record<string, string> = {};
    for (const [tag, version] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof version === "string") tags[tag] = version;
    }
    return tags;
  } catch {
    // 输出不是 JSON（npm 打了一行警告 / 被截断）：当作「查不到」，不猜
    return undefined;
  }
}

/**
 * 用 npx 把一版宿主拉进缓存，但不真起服务。
 *
 * 跑的是 `npx -y <spec> version`：`version` 是宿主 CLI 自己的子命令，打一行版本与协议版本就退出 0
 * （不碰端口、不写库、不建凭证）。于是这一步做完等于那一版已经在 npx 缓存里，下次
 * `npx -y <spec> serve` 不必再下载。
 *
 * `-y` 必须有：不带它，npx 在首次拉一个没缓存过的包时会停下来问「要装吗」，而这个子进程的 stdin 是
 * 关着的，问也问不到人，只会挂到超时。
 *
 * 成功返回 `undefined`，失败返回一句能上屏的原因：npx 的原话（`ETARGET` 是这一版从 registry 撤了，
 * `EAI_AGAIN` 是网断了）比任何转述都准。
 */
export async function prefetchHost(npm: RunNpm, spec: string): Promise<string | undefined> {
  const result = await npm("npx", ["-y", spec, "version"]);
  if (result.code === 0) return undefined;
  const outcome = result.error ?? `exit ${result.code ?? "unknown"}`;
  const reason = failureLine(result.stderr);
  return reason === undefined ? outcome : `${outcome}：${reason}`;
}

/**
 * 从 stderr 里挑一句能贴到通知栏的原因：优先 `npm error <话>`，否则第一行非空输出。
 *
 * 整段 stderr 塞进通知栏只会被折行截断（通知栏最多 8 行），读的人拿不到真正那句原因。
 */
function failureLine(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const line = lines.find((item) => /^npm (error|ERR!)/i.test(item)) ?? lines[0];
  return line === undefined ? undefined : truncate(line, 160);
}
