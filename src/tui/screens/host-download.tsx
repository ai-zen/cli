/**
 * 下载屏 —— 本机拉起宿主时唯一的一块屏。
 *
 * 它画什么
 *
 * 阶段式、不确定进度：一行 spinner + 一行「现在在做什么」（解析版本 → 下载并安装 → 启动宿主 →
 * 连上）。不解析 npm 的输出，所以也就没有百分比 —— 报一个假的百分比比不报更让人以为快好了。
 * 阶段本身由连接层给（`HostLaunchStage`），这里只负责把它变成一行字；
 * 「阶段 → 句子」那一份表在 `../../host-stage.js`，`/upgrade` 的进度通知也取同一份。
 *
 * 三条路
 *
 * | 情形 | 屏上 | 结局 |
 * |---|---|---|
 * | 拉起来了 | 阶段一行行往下换；连上就换屏（不再补一帧「已连上」，那一帧就是白闪） | `{kind:"connected"}` → 继续启动 |
 * | 拉不起来 | 多一行子进程自己说的那句原因，并提示 `R` 重试 | 停在屏上，等 `R` 再拉一次 |
 * | `Esc` / `Ctrl+C` | 停手（杀掉正在拉起的那个子进程） | `{kind:"fallback"}` → 回连接屏改走远程 |
 *
 * `Ctrl+C` 与 `Esc` 同义（回连接屏），不退出程序：用户按这两个键的意思是「这条本机路我不想
 * 等了」，而不是「把刚敲的那条命令扔掉」。
 *
 * 没事可看的时候它一个字节都不画
 *
 * 「有就上」那条路上一个阶段都不会来（宿主本来就在跑，只有 `connected`），这时返回 `null`：启动
 * 时不该为了一次什么都没做的检查闪一下屏。挂载处也因此不擦屏（`mount(..., { clear: false })`）。
 *
 * 结局为什么能注入
 *
 * 缺省走 `useApp().exit`（与连接屏同一个出口，挂载处 `mount()` 的返回值接住它）；用例传入一个假的
 * `onResult` 就能验 `Esc` / `R` 的语义，不必去动 ink 的退出通道。
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { HostLaunchStage } from "../../server-client/index.js";
import { STAGE_TEXT, type ProgressStage } from "../../host-stage.js";
import { t } from "../../i18n/index.js";
import { Spinner } from "../components.js";
import { theme } from "../theme.js";

/** 屏的结局：连上了 / 用户折回连接屏 */
export type HostDownloadScreenResult =
  | { kind: "connected" }
  /** 折回连接屏去改走远程；`reason` 是折回时屏上那句话（上次的失败，或「已取消」） */
  | { kind: "fallback"; reason: string };

/** 一次拉起给屏的两个手柄（由连接层交给 `ensureHost`） */
export interface HostLaunchHooks {
  /** 阶段变了 */
  onStage: (stage: HostLaunchStage) => void;
  /** 取消（杀了正在拉起的那个子进程） */
  signal: AbortSignal;
}

export interface HostDownloadScreenProps {
  /** 拉一次；返回 `null` = 连上了，否则是能直接上屏的原因 */
  connect: (hooks: HostLaunchHooks) => Promise<string | null>;
  /** 结局出口（缺省 `useApp().exit`；用例传入一个假的） */
  onResult?: (result: HostDownloadScreenResult) => void;
}

export function HostDownloadScreen(props: HostDownloadScreenProps) {
  const { exit } = useApp();
  const finish = props.onResult ?? exit;

  /** 当前阶段；`null` = 还没有东西可说（什么都还没开始，或者刚按了 R） */
  const [stage, setStage] = useState<HostLaunchStage | null>(null);
  /** 上一次没能拉起来的那句话（有它才允许按 R） */
  const [failure, setFailure] = useState<string | null>(null);

  /** 手上正在跑的那一次（按 Esc / Ctrl+C 时 abort 它，子进程随之被杀） */
  const running = useRef<AbortController | null>(null);
  /** 卸载之后不再 setState、也不再报结局 */
  const alive = useRef(true);

  /** 拉一次（首次挂载与每次按 R 都走它） */
  const start = (): void => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setFailure(null);
    setStage(null);
    void (async () => {
      let reason: string | null;
      try {
        reason = await props.connect({
          onStage: (next) => {
            // 上一次的回声不画：按了 R 之后，前一次的阶段不该再往屏上冒
            if (alive.current && running.current === controller) setStage(next);
          },
          signal: controller.signal,
        });
      } catch (error) {
        // `connect` 通常不抛（探活已经把错误翻成句子），但抛了也只该多一行原因：
        // 一个没人接的 promise 会让屏停在 spinner 上永远转，而进程活着、什么都不说
        reason = error instanceof Error ? error.message : String(error);
      }
      if (!alive.current || running.current !== controller) return;
      running.current = null;
      if (reason === null) {
        finish({ kind: "connected" });
        return;
      }
      setFailure(reason);
    })();
  };

  /** 停手并折回连接屏（正在拉起的那一个当场杀掉） */
  const giveUp = (reason: string): void => {
    running.current?.abort();
    running.current = null;
    finish({ kind: "fallback", reason });
  };

  useEffect(() => {
    alive.current = true;
    start();
    return () => {
      alive.current = false;
      running.current?.abort();
    };
    // 只在挂载时拉一次：之后的「再拉一次」是用户按 R（或者挂载处换一块新屏）
  }, []);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      giveUp(failure ?? t("download.cancelled"));
      return;
    }
    if (failure !== null && (input === "r" || input === "R")) start();
  });

  // 没事可看的时候一个字节都不画：拉起真的在进行（三个阶段之一），或者已经失败了
  const drawing = failure !== null || (stage !== null && stage !== "connected");
  if (!drawing) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.accent} bold>
        {t("download.title")}
      </Text>
      {failure === null ? (
        <Spinner label={t(STAGE_TEXT[stage as ProgressStage])} />
      ) : (
        <Text color={theme.error} wrap="wrap">
          {`✖ ${failure}`}
        </Text>
      )}
      <Text> </Text>
      <Text color={theme.faint}>
        {t(failure === null ? "download.keysRunning" : "download.keysFailed")}
      </Text>
    </Box>
  );
}
