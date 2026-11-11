/**
 * 连接屏 —— 首启与「连不上」共用的一块屏。
 *
 * ## 两种形态只差一行字
 *
 * | 形态 | 触发 | 屏上多的那一行 |
 * |---|---|---|
 * | 首启 | 没配过任何连接（`<aiZenDir>/cli/connection.json` 不存在） | 一句「第一次用，先选一个服务端」 |
 * | 失败 | 上次那台这次没连上（或命令行给的地址连不上） | 本次尝试的原因（人话） |
 *
 * 其余完全一致：`本机` / `远程` / `重试` / `退出`。做成两个屏只会让两条路各修各的 bug
 * —— 而它们要修的是同一批。
 *
 * ## 它自己负责「再试一次」
 *
 * 「提交」= 调 `props.connect()` 试一次：通了就 `exit({kind:"connected"})` 交给宿主；不通就把
 * 原因留在屏上、回到选择（**不重建本屏**）。重试放在屏里而不是宿主那一层重挂一遍，是为了
 * 不闪屏：一次失败的尝试只该多一行原因。
 *
 * ## 退出只有一条路
 *
 * `Esc` / `Ctrl+C` / 选「退出」三者都调 `onExit()`，宿主据此收摊 farewell。没有「悄悄退化成
 * 本地连接」这条 —— 那正是这套东西要消灭的静默行为。
 */

import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { parseServerUrl, type ConnectionSettings } from "../../server-client/index.js";
import { connectionLabel } from "../../server-client/index.js";
import { normalizeServerAddress } from "../../connection.js";
import { t } from "../../i18n/index.js";
import { SelectList, Spinner, type SelectItem } from "../components.js";
import { theme } from "../theme.js";
import { PromptScreen } from "../config-wizard/index.js";

/** 屏的结局：连上了（带上那一份）/ 用户放弃 */
export type ConnectScreenResult =
  { kind: "connected"; settings: ConnectionSettings } | { kind: "exit" };

export interface ConnectScreenProps {
  /** 上次那份（预填远程表单、也是「重试」的对象）；首启是 `null` */
  initial: ConnectionSettings | null;
  /** 本次尝试的失败原因（首启形态没有） */
  reason?: string;
  /** 试连一次：`null` = 连上了 */
  connect: (settings: ConnectionSettings) => Promise<string | null>;
  /** 测试用的固定尺寸（缺省按真实窗口） */
  terminalSize?: { columns: number; rows: number };
}

/** 选择项的值 */
type Choice = "local" | "remote" | "retry" | "exit";

/** 屏内的阶段（`pending` 期间不接受选择） */
type Phase = "choice" | "address" | "token" | "pending";

export function ConnectScreen(props: ConnectScreenProps) {
  const windowSize = useWindowSize();
  const columns = props.terminalSize?.columns ?? windowSize.columns ?? 80;
  const rows = props.terminalSize?.rows ?? windowSize.rows ?? 24;
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>("choice");
  const [reason, setReason] = useState<string | undefined>(props.reason);
  /**
   * 最近一次**提交过**的那一份 —— 「重试」的对象与远程表单的预填都用它。
   *
   * 不能直接用 `props.initial`：用户在屏上改成另一个地址、试了一次没通，这时他要重试的是
   * **刚填的那个**，不是上次盘上那份。
   */
  const [lastTried, setLastTried] = useState<ConnectionSettings | null>(props.initial);
  const [addressError, setAddressError] = useState<string | null>(null);

  /** 卸载之后不许再 setState（探活是异步的，用户可能已经按 Esc 走了） */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const submit = async (settings: ConnectionSettings) => {
    setLastTried(settings);
    setPhase("pending");
    /**
     * 把拒绝也当成「一句原因」。
     *
     * `props.connect` 通常不抛（探活已经把错误翻成了人话），但**万一**它抛了，`void submit()`
     * 里那个 promise 就没人接 —— 屏会停在 spinner 上永远转，而进程活着、什么都不说（这个仓里
     * 最讨厌的那种错）。这里接住，它只是多一行原因。
     */
    let failure: string | null;
    try {
      failure = await props.connect(settings);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!alive.current) return;
    if (failure === null) {
      exit({ kind: "connected", settings } satisfies ConnectScreenResult);
      return;
    }
    setReason(failure);
    setPhase("choice");
  };

  // `Esc` / `Ctrl+C` 在**任何**阶段都是退出（包括输入到一半）：连接屏是启动路径上的最后一道
  // 门，这里没有「先保存再说」的东西要抢救。结局由宿主（`mount` 的返回值）接住。
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c"))
      exit({ kind: "exit" } satisfies ConnectScreenResult);
  });

  // ---------- 远程：地址 ----------
  if (phase === "address") {
    return (
      <PromptScreen
        // `key` 不能省：两个阶段渲染的是**同一个组件类型**，React 会复用它的内部 state
        // （`value` / `revealed`），于是令牌框里会带着上一屏敲的地址、并且以明文显示。
        // 配置向导那边用的是 `key={`apiKey:${endpoint.id}`}`，同一个理由。
        key="connect-address"
        columns={columns}
        rows={rows}
        title={t("connect.addressTitle")}
        details={[t("connect.addressHelp")]}
        initialValue={lastTried?.serverUrl ?? ""}
        error={addressError}
        hints={[
          ["Enter", t("connect.continue")],
          ["Esc", t("connect.back")],
        ]}
        onSubmit={(raw) => {
          const address = normalizeServerAddress(raw);
          try {
            // 形状判据只问包里那一份（占位符 / IPv6 / 子路径都在那里）
            parseServerUrl(address);
          } catch (error) {
            setAddressError((error as Error).message);
            return;
          }
          setAddressError(null);
          setLastTried({
            mode: "remote",
            serverUrl: address,
            ...(lastTried?.serverToken ? { serverToken: lastTried.serverToken } : {}),
          });
          setPhase("token");
        }}
        onCancel={() => setPhase("choice")}
      />
    );
  }

  // ---------- 远程：凭证 ----------
  if (phase === "token") {
    const address = lastTried?.serverUrl ?? "";
    return (
      <PromptScreen
        key="connect-token"
        columns={columns}
        rows={rows}
        title={t("connect.tokenTitle")}
        details={[t("connect.tokenHelp")]}
        initialValue={lastTried?.serverToken ?? ""}
        mask
        hints={[
          ["Enter", t("connect.connect")],
          ["Tab", t("ui.plainOrMasked")],
          ["Esc", t("connect.back")],
        ]}
        onSubmit={(raw) => {
          const serverToken = raw.trim();
          void submit({
            mode: "remote",
            serverUrl: address,
            ...(serverToken ? { serverToken } : {}),
          });
        }}
        onCancel={() => setPhase("choice")}
      />
    );
  }

  // ---------- 选择（含 pending） ----------
  const items: SelectItem<Choice>[] = [
    { value: "local", label: t("connect.local"), hint: t("connect.localHint") },
    { value: "remote", label: t("connect.remote"), hint: t("connect.remoteHint") },
    ...(reason && lastTried
      ? [
          {
            value: "retry" as const,
            label: t("connect.retry"),
            hint: connectionLabel(lastTried),
          },
        ]
      : []),
    { value: "exit", label: t("connect.exit"), hint: t("connect.exitHint") },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.accent} bold>
        {t("connect.title")}
      </Text>
      {reason ? (
        <Text color={theme.error} wrap="wrap">
          {`✖ ${reason}`}
        </Text>
      ) : (
        <Text color={theme.dim} wrap="wrap">
          {t("connect.firstRunHint")}
        </Text>
      )}
      <Text> </Text>
      {phase === "pending" ? (
        <Spinner label={t("connect.connecting")} />
      ) : (
        <SelectList
          items={items}
          columns={columns}
          onSelect={(choice) => {
            if (choice === "local") void submit({ mode: "local" });
            else if (choice === "remote") setPhase("address");
            else if (choice === "retry" && lastTried) void submit(lastTried);
            else exit({ kind: "exit" } satisfies ConnectScreenResult);
          }}
        />
      )}
      <Text> </Text>
      <Text color={theme.faint}>{t("connect.keys")}</Text>
    </Box>
  );
}
