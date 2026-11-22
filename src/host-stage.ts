/**
 * 「一步一步说清在干什么」的三个阶段 —— **一份文案，两处用**：
 *
 *   1. 拉起本机宿主时那块下载屏（`tui/screens/host-download.tsx`）把它画成一行 spinner；
 *   2. `/upgrade`（`commands/handlers.ts` 的 `cmdUpgrade`）只拿 `resolving` 那一格当第一句进度 ——
 *      它跑的是「挑哪一版」（客户端那一段），而把那一版弄到本机、把它起起来都归启动方式
 *      （`trd/host-infrastructure.md` 的三段分工）。
 *
 * 两边共用同一批句子而不是各写一套：同一个动作（拉得下来吗、装的是哪一版）在两块屏上说两种话，
 * 是接下来一定会漂的那种重复。命令层不许 import `tui/`（`npm run
 * check:imports` 的判据是产物图），所以这一份落在 `src/` 根上，两边都往下取。
 *
 * 阶段本身是连接层的 {@link HostLaunchStage}（拉起宿主时由 `ensureHost` 一阶段一阶段报上来）：
 * 这里只把「哪几个阶段会画出来」与「每个阶段对应哪条词条」定死，不另外造一套进度词汇。
 */

import type { HostLaunchStage } from "./server-client/index.js";

/**
 * 会画出来的阶段。
 *
 * `connected` 不算：拉起宿主那条路上它一到就换屏（画一帧反而是白闪），`/upgrade` 那条路上
 * 它的对应物是回连接屏时那句「宿主正在按 v{version} 重新拉起」—— 那件事有自己的去处
 * （`backToConnect`），不是进度条的一格。
 */
export type ProgressStage = Exclude<HostLaunchStage, "connected">;

/**
 * 阶段 → 词条。
 *
 * 值是**词条键**而不是句子：同一句中文/英文由 `t()` 在渲染那一刻取（`/lang` 一切就跟着变）。
 */
export const STAGE_TEXT: Record<ProgressStage, string> = {
  resolving: "download.stage.resolving",
  installing: "download.stage.installing",
  starting: "download.stage.starting",
};
